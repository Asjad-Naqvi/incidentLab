import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { createAuth,hashPassword,verifyPassword,normalizeUsername,SESSION_MS } from '../lib/auth.mjs';

const password = 'a-long-test-passphrase-2026';
const hash = value => createHash('sha256').update(value).digest('hex');
let passwordHash;
const ownerHash = async () => passwordHash ||= await hashPassword(password);
async function app(t,options = {}) {
  const store = createStore();
  await store.createOwner('owner',await ownerHash());
  const server = createApp(store,{ ingestionKey: 'ingestion-test-key-32-characters',...options });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await server.stopWorker(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function login() {
    const response = await fetch(base+'/api/auth/login',{ method: 'POST',body: JSON.stringify({ username: 'owner',password }) });
    assert.equal(response.status,200);
    const data = await response.json();
    return { cookie: response.headers.get('set-cookie').split(';')[0],csrf: data.csrfToken,data,response };
  }
  return { store,server,base,login };
}

test('passwords use salted scrypt; invalid inputs and malformed hashes fail safely', async () => {
  const first = await ownerHash(); const second = await hashPassword(password);
  assert.notEqual(first,second); assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password,first),true);
  assert.equal(await verifyPassword('incorrect-password',first),false);
  assert.equal(await verifyPassword(password,'scrypt$1000000000$8$1$x$x'),false);
  await assert.rejects(hashPassword('short'),/12/);
  assert.equal(normalizeUsername(' Owner '),'owner');
  assert.throws(() => normalizeUsername('<script>'));
});

test('dashboard, event stream, incident APIs and mutation routes require a session by default', async t => {
  const { base } = await app(t);
  const root = await fetch(base,{ redirect: 'manual' }); assert.equal(root.status,303); assert.equal(root.headers.get('location'),'/login');
  for (const route of ['/api/overview','/api/stream','/api/incidents/missing']) assert.equal((await fetch(base+route)).status,401);
  for (const route of ['/api/demo/traffic','/demo/checkout','/api/auth/logout']) assert.equal((await fetch(base+route,{ method: 'POST' })).status,401);
  assert.equal((await fetch(base+'/login')).status,200);
  assert.equal((await fetch(base+'/healthz')).status,200);
  const status = await (await fetch(base+'/api/auth/status')).json();
  assert.equal(status.authenticated,false); assert.equal(status.setupRequired,false); assert.equal(status.user,null);
});

test('sign-in rotates tokens, stores only hashes and requires CSRF for protected mutations', async t => {
  const { base,login,store } = await app(t);
  const first = await login();
  assert.match(first.response.headers.get('set-cookie'),/HttpOnly/); assert.match(first.response.headers.get('set-cookie'),/SameSite=Strict/);
  const token = first.cookie.split('=')[1];
  assert.equal(store.db.prepare('SELECT token_hash FROM auth_sessions').get().token_hash,hash(token));
  assert.ok(!JSON.stringify(first.data).includes(token));
  assert.ok(!JSON.stringify(first.data).includes(passwordHash));
  const authHeaders = { Cookie: first.cookie,'X-CSRF-Token': first.csrf };
  assert.equal((await fetch(base+'/api/overview',{ headers: authHeaders })).status,200);
  assert.equal((await fetch(base+'/api/demo/traffic',{ method: 'POST',headers: { Cookie: first.cookie } })).status,403);
  assert.equal((await fetch(base+'/api/demo/traffic',{ method: 'POST',headers: { Cookie: first.cookie,'X-CSRF-Token': 'é'.repeat(43) } })).status,403);
  assert.equal((await fetch(base+'/api/demo/traffic',{ method: 'POST',headers: authHeaders })).status,200);
  const second = await login(); assert.notEqual(second.cookie,first.cookie);
  assert.equal((await fetch(base+'/api/demo/fix',{ method: 'POST',headers: { Cookie: second.cookie,'X-CSRF-Token': first.csrf } })).status,403);
});

test('logout invalidates the session; ingestion keys cannot read the dashboard and sessions cannot submit telemetry', async t => {
  const { base,login } = await app(t); const signedIn = await login();
  assert.equal((await fetch(base+'/api/overview',{ headers: { Authorization: 'Bearer ingestion-test-key-32-characters' } })).status,401);
  assert.equal((await fetch(base+'/api/v1/events',{ method: 'POST',headers: { Cookie: signedIn.cookie },body: '{}' })).status,401);
  const logout = await fetch(base+'/api/auth/logout',{ method: 'POST',headers: { Cookie: signedIn.cookie,'X-CSRF-Token': signedIn.csrf } });
  assert.equal(logout.status,200); assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await fetch(base+'/api/overview',{ headers: { Cookie: signedIn.cookie } })).status,401);
});

test('foreign origins, forged sessions and duplicate cookies are rejected', async t => {
  const { base,login } = await app(t);
  assert.equal((await fetch(base+'/api/auth/login',{ method: 'POST',headers: { Origin: 'https://untrusted.example' },body: '{}' })).status,403);
  assert.equal((await fetch(base+'/api/auth/login',{ method: 'POST',headers: { 'sec-fetch-site': 'cross-site' },body: '{}' })).status,403);
  assert.equal((await fetch(base+'/api/overview',{ headers: { Cookie: 'incidentlab_session=forged' } })).status,401);
  const session = await login();
  assert.equal((await fetch(base+'/api/overview',{ headers: { Cookie: session.cookie+'; '+session.cookie } })).status,401);
});

test('shared login throttles survive service recreation and do not reveal unknown usernames', async () => {
  const store = createStore();
  try {
    await store.createOwner('owner',await ownerHash());
    const auth = createAuth(store);
    for (let i=0;i<5;i++) await assert.rejects(auth.login({ username: 'owner',password: 'incorrect-password' },'127.0.0.1'),{ status: 401,message: 'Invalid username or password' });
    await assert.rejects(createAuth(store).login({ username: 'owner',password },'different-ip'),{ status: 429 });
    await assert.rejects(auth.login({ username: 'missing-user',password },'other-ip'),{ status: 401,message: 'Invalid username or password' });
    const later = createAuth(store,{ now: () => Date.now()+16*60000 });
    assert.equal((await later.login({ username: 'owner',password },'127.0.0.1')).user.username,'owner');
  } finally { store.close(); }
});

test('sessions enforce idle and absolute expiry, cap active sessions and reject in-flight old-password logins', async () => {
  const store = createStore(); let time = Date.now();
  try {
    const initialHash = await ownerHash(); const user = await store.createOwner('owner',initialHash);
    const auth = createAuth(store,{ now: () => time });
    const signedIn = await auth.login({ username: 'owner',password },'local');
    const req = { headers: { cookie: signedIn.cookie.split(';')[0] } };
    assert.ok(await auth.session(req)); time += 31*60000; assert.equal(await auth.session(req),null);
    const absolute = await auth.login({ username: 'owner',password },'local');
    time += SESSION_MS+1;
    assert.equal(await auth.session({ headers: { cookie: absolute.cookie.split(';')[0] } }),null);
    for (let i=0;i<7;i++) await auth.login({ username: 'owner',password },'local');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,5);
    await store.replaceOwnerPassword('owner',await hashPassword('a-new-owner-passphrase-2026'));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,0);
    assert.throws(() => store.createSession(user.id,hash('stale-token'),time,time+SESSION_MS,initialHash),{ status: 401 });
  } finally { store.close(); }
});

test('HTTPS configuration sets secure host cookies and validates configured origins', async () => {
  const store = createStore();
  try {
    await store.createOwner('owner',await ownerHash());
    const auth = createAuth(store,{ publicOrigin: 'https://incidentlab.example' });
    const signedIn = await auth.login({ username: 'owner',password },'local');
    assert.match(signedIn.cookie,/^__Host-incidentlab_session=/); assert.match(signedIn.cookie,/; Secure/);
    assert.equal(auth.requestOrigin({ headers: { host: 'internal-proxy' } }),'https://incidentlab.example');
    assert.throws(() => createAuth(store,{ publicOrigin: 'https://name:password@example.com' }));
    assert.throws(() => createAuth(store,{ publicOrigin: 'http://incidentlab.example' }),/HTTPS/);
  } finally { store.close(); }
});

test('owner, session and password recovery persist across SQLite restart', async () => {
  const directory = mkdtempSync(join(tmpdir(),'incidentlab-auth-')); const file = join(directory,'auth.sqlite'); let cookie;
  try {
    const first = createStore(file);
    try { await first.createOwner('owner',await ownerHash()); cookie = (await createAuth(first).login({ username: 'owner',password },'local')).cookie; }
    finally { first.close(); }
    const second = createStore(file);
    try {
      assert.equal((await createAuth(second).session({ headers: { cookie: cookie.split(';')[0] } })).user.username,'owner');
      assert.throws(() => second.createOwner('other',passwordHash),{ status: 409 });
      await second.replaceOwnerPassword('owner',await hashPassword('replacement-owner-password-2026'));
      assert.equal(await createAuth(second).session({ headers: { cookie: cookie.split(';')[0] } }),null);
    } finally { second.close(); }
  } finally { rmSync(directory,{ recursive: true,force: true,maxRetries: 5,retryDelay: 100 }); }
});

test('logout closes the authenticated live-update stream', async t => {
  const { base,login } = await app(t); const session = await login();
  const stream = await fetch(base+'/api/stream',{ headers: { Cookie: session.cookie },signal: AbortSignal.timeout(5000) });
  assert.equal(stream.status,200);
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/connected/);
  const response = await fetch(base+'/api/auth/logout',{ method: 'POST',headers: { Cookie: session.cookie,'X-CSRF-Token': session.csrf } });
  assert.equal(response.status,200);
  assert.equal((await reader.read()).done,true);
});

test('uninitialized workspaces expose setup instructions but have no public owner-registration route', async t => {
  const store = createStore(); const server = createApp(store);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await server.stopWorker(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(base+'/api/auth/status')).json()).setupRequired,true);
  assert.match(await (await fetch(base+'/login')).text(),/auth:setup/);
  assert.equal((await fetch(base+'/api/auth/register',{ method: 'POST' })).status,401);
  assert.equal(store.ownerCount(),0);
});
