import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoServer } from '../lib/demo.mjs';
import { deploymentOrigin,shutdown } from '../lib/http-security.mjs';

async function fixture(t, options = {}) {
  const server = createDemoServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => shutdown(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = async () => {
    const response = await fetch(base+'/api/demo/session', {method:'POST',headers:{'X-Demo-Request':'1','Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,201);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const session = await (await fetch(base+'/api/auth/status',{headers:{Cookie:cookie}})).json();
    return {cookie,csrf:session.csrfToken,session};
  };
  const request = (visitor,path,method='GET',body) => fetch(base+path,{method,headers:{Cookie:visitor.cookie,...(method==='POST'?{'X-CSRF-Token':visitor.csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {server,base,start,request};
}

test('public demo serves an honest landing page and a protected, isolated replay workflow',async t=>{
  const {base,start,request}=await fixture(t);
  const landing=await fetch(base); assert.equal(landing.status,200); assert.match(await landing.text(),/Start my demo/);
  assert.match(landing.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  for(const path of ['/demo.js','/demo.css','/auth.css']) assert.equal((await fetch(base+path)).status,200);
  assert.equal((await fetch(base+'/api/overview')).status,401);
  const first=await start(); const second=await start();
  assert.equal(first.session.demo,true); assert.notEqual(first.cookie,second.cookie);
  assert.equal((await request(first,'/')).status,200);
  assert.equal((await request(first,'/api/demo/traffic','POST')).status,200);
  const overview=await(await request(first,'/api/overview')).json();
  assert.equal(overview.metrics.total,12); assert.equal(overview.ingestion.enabled,false);
  const id=overview.incidents[0].id;
  assert.equal((await(await request(second,'/api/overview')).json()).metrics.total,0);
  assert.equal((await request(second,`/api/incidents/${id}`)).status,404);
  assert.equal((await(await request(first,`/api/incidents/${id}/replay`,'POST')).json()).afterErrors,4);
  await request(first,'/api/demo/fix','POST');
  assert.equal((await(await request(first,`/api/incidents/${id}/replay`,'POST')).json()).afterErrors,0);
  assert.equal((await request(first,`/api/incidents/${id}/resolve`,'POST')).status,200);
  assert.equal((await(await request(second,'/api/overview')).json()).fixed,false);
  assert.equal((await request(first,'/api/auth/logout','POST')).status,200);
  assert.equal((await request(first,'/api/overview')).status,401);
  assert.equal((await request(second,'/api/overview')).status,200);
});

test('public demo rejects cross-origin requests, forged cookies, owner APIs, ingestion and arbitrary data',async t=>{
  const {base,start,request}=await fixture(t); const visitor=await start();
  assert.equal((await fetch(base+'/api/demo/session',{method:'POST'})).status,403);
  assert.equal((await fetch(base+'/api/demo/session',{method:'POST',headers:{Origin:'https://evil.example','X-Demo-Request':'1','Content-Type':'application/json'}})).status,403);
  assert.equal((await fetch(base+'/api/demo/traffic',{method:'POST',headers:{Cookie:visitor.cookie}})).status,403);
  assert.equal((await fetch(base+'/api/demo/traffic',{method:'POST',headers:{Cookie:visitor.cookie,'X-CSRF-Token':visitor.csrf,Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/api/overview',{headers:{Cookie:visitor.cookie+'; '+visitor.cookie}})).status,401);
  assert.equal((await fetch(base+'/api/overview',{headers:{Cookie:'incidentlab_demo='+'a'.repeat(64)}})).status,401);
  for(const path of ['/api/auth/login','/api/v1/events','/demo/checkout','/api/demo/reset']) assert.equal((await request(visitor,path,'POST')).status,404);
  assert.equal((await request(visitor,'/api/demo/traffic','POST',{token:'sensitive',fixture:'arbitrary'})).status,400);
  assert.equal((await(await request(visitor,'/api/overview')).json()).metrics.total,0);
});

test('expiry releases capacity, and event/replay quotas bound each visitor database',async t=>{
  let clock=0; const {start,request,base}=await fixture(t,{now:()=>clock,ttlMs:1000,maxSessions:1,maxEvents:12,maxReplays:1});
  const visitor=await start();
  assert.equal((await fetch(base+'/api/demo/session',{method:'POST',headers:{'X-Demo-Request':'1','Content-Type':'application/json'}})).status,503);
  await request(visitor,'/api/demo/traffic','POST');
  assert.equal((await request(visitor,'/api/demo/traffic','POST')).status,429);
  const overview=await(await request(visitor,'/api/overview')).json(); assert.equal(overview.metrics.total,12);
  const id=overview.incidents[0].id;
  assert.equal((await request(visitor,`/api/incidents/${id}/replay`,'POST')).status,200);
  assert.equal((await request(visitor,`/api/incidents/${id}/replay`,'POST')).status,429);
  clock=1001;
  assert.equal((await request(visitor,'/api/overview')).status,401);
  const fresh=await start(); assert.notEqual(fresh.cookie,visitor.cookie);
});

test('per-visitor and process-wide start limits return bounded retries',async t=>{
  const {start,request,base}=await fixture(t,{maxRequestsPerMinute:2,maxMutationsPerMinute:1,maxStartsPerMinute:1});
  const visitor=await start();
  await request(visitor,'/api/demo/fix','POST');
  const limited=await request(visitor,'/api/demo/break','POST');assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');
  assert.equal((await request(visitor,'/api/overview')).status,429);
  assert.equal((await fetch(base+'/api/demo/session',{method:'POST',headers:{'X-Demo-Request':'1','Content-Type':'application/json'}})).status,429);
});

test('hosted demo uses the exact origin and secure host cookies, ignoring forwarded headers',async t=>{
  const {base}=await fixture(t,{publicOrigin:'https://demo.example'});
  assert.equal((await fetch(base+'/healthz')).status,200);
  assert.equal((await fetch(base+'/')).status,421);
  // Host and HTTPS behavior are also exercised through an actual HTTP request below.
  const {request}=await import('node:http');
  const send=(path,headers={},method='GET')=>new Promise((resolve,reject)=>{
    const req=request(base+path,{method,headers:{Host:'demo.example',...headers}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();
  });
  const started=await send('/api/demo/session',{'X-Demo-Request':'1','Content-Type':'application/json',Origin:'https://demo.example'},'POST');
  assert.equal(started.status,201);
  assert.match(started.headers['set-cookie'][0],/^__Host-incidentlab_demo=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1200; Secure$/);
  assert.equal(started.headers['strict-transport-security'],'max-age=31536000');
  assert.equal((await send('/api/demo/session',{'X-Demo-Request':'1','Content-Type':'application/json',Origin:'https://evil.example','X-Forwarded-Host':'evil.example'},'POST')).status,403);
  assert.equal(deploymentOrigin({RENDER:'true',RENDER_EXTERNAL_URL:'https://demo.onrender.com'}),'https://demo.onrender.com');
  assert.throws(()=>deploymentOrigin({RENDER:'true'}));
  assert.throws(()=>deploymentOrigin({INCIDENTLAB_PUBLIC_ORIGIN:'http://public.example'}));
});

test('ending a demo closes its event streams and shutdown drains resources',async t=>{
  const {start,request,server}=await fixture(t); const visitor=await start();
  const first=await request(visitor,'/api/stream');const reader=first.body.getReader();await reader.read();
  const second=await request(visitor,'/api/stream'); const other=second.body.getReader(); await other.read();
  assert.equal((await request(visitor,'/api/stream')).status,429);
  await request(visitor,'/api/auth/logout','POST');
  assert.equal((await reader.read()).done,true);assert.equal((await other.read()).done,true);
  assert.equal(server.requestTimeout,15000);assert.equal(server.maxConnections,128);
});

test('production entry point ignores owner database credentials and shuts down cleanly',{timeout:10000},async t=>{
  const {spawn}=await import('node:child_process');
  const child=spawn(process.execPath,['demo-server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PORT:'0',NODE_ENV:'production',RENDER:'true',RENDER_EXTERNAL_URL:'https://demo.example',INCIDENTLAB_PUBLIC_ORIGIN:'',DATABASE_URL:'postgresql://unreachable.invalid/owner',SQLITE_PATH:'/forbidden/owner.sqlite'}});
  let output='';let diagnostics='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>diagnostics+=chunk);
  const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await exited;});
  let ready;
  for(let i=0;i<100;i++){ready=output.split('\n').find(line=>line.includes('"event":"ready"'));if(ready)break;await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,diagnostics);const {port}=JSON.parse(ready);
  const health=await fetch(`http://127.0.0.1:${port}/healthz`);assert.equal(health.status,200);
  assert.equal(health.headers.get('strict-transport-security'),'max-age=31536000');
  if(process.platform==='win32')child.send('shutdown');else child.kill('SIGTERM');
  assert.deepEqual(await exited,{code:0,signal:null});
  assert.ok(!output.includes('unreachable.invalid'));
});
