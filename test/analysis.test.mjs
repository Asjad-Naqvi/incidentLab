import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { createAnalysisService, evidenceSnapshot, validateAnalysis, ANALYSIS_MODEL } from '../lib/analysis.mjs';

const env = { INCIDENTLAB_AI_ENABLED: '1', OPENAI_API_KEY: 'test-provider-key-never-forward-to-browser' };
const result = () => ({ summary: { text: 'Captured checkout requests returned server errors.', evidenceIds: ['E01'] },
  hypotheses: [{ cause: 'Session expiry may be handled incorrectly.',confidence: 'low',evidenceIds: ['E01'],validation: 'Inspect the expiry handling code and reproduce an expired session.' }],
  nextSteps: [{ action: 'Compare application logs for the captured route.',evidenceIds: ['E01'] }],
  missingEvidence: ['Source code and application logs are not available in the snapshot.'] });
const response = (value = result(), extra = {}) => new Response(JSON.stringify({ status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text',text: JSON.stringify(value) }] }],
  usage: { input_tokens: 100,output_tokens: 200 },...extra }),{ status: 200 });
function incident(store, overrides = {}) {
  const recorded = store.record({ method: 'POST',path: '/checkout',status: 500,durationMs: 20,error: 'SessionExpired',service: 'orders',payload: { password: 'never-send-this' },...overrides });
  return store.incident(recorded.incidentId);
}

test('evidence excludes bodies, attributes, raw messages, headers and identifiers from request routes', () => {
  const store = createStore();
  try {
    const item = incident(store,{ path: '/orders/123456?token=private', error: 'private exception details person@example.com' });
    const { snapshot,evidenceHash } = evidenceSnapshot(item);
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes('never-send-this'));
    assert.ok(!serialized.includes('private'));
    assert.ok(!serialized.includes('person@example.com'));
    assert.equal(snapshot.evidence[0].route,'/orders/:redacted');
    assert.equal(snapshot.evidence[0].errorType,'UnclassifiedServerError');
    assert.equal(evidenceSnapshot(item).evidenceHash,evidenceHash);
    const credential = incident(store,{ service: 'sk-proj-hidden-secret',error: 'sk-proj-hidden-secret',path: '/orders/550e8400-e29b-41d4-a716-446655440000' });
    const cleaned = evidenceSnapshot(credential).snapshot;
    assert.ok(!JSON.stringify(cleaned).includes('sk-proj-hidden-secret'));
    assert.equal(cleaned.evidence[0].route,'/orders/:redacted');
    const bad = result(); bad.summary.evidenceIds = ['E99'];
    assert.throws(() => validateAnalysis(bad,snapshot),{ code: 'invalid_analysis' });
    const certain = result(); certain.hypotheses[0].confidence = 'high';
    assert.throws(() => validateAnalysis(certain,snapshot),{ code: 'invalid_analysis' });
  } finally { store.close(); }
});

test('analysis is disabled without explicit configuration and readonly views never call the provider', async () => {
  const store = createStore();
  try {
    const item = incident(store);
    const service = createAnalysisService(store,{ env: {},fetchImpl: () => { throw new Error('must not call'); } });
    assert.equal((await service.view(item)).enabled,false);
    await assert.rejects(service.analyze(item),{ code: 'analysis_disabled' });
    assert.equal(store.analysisSpend(new Date().toISOString().slice(0,10)),0);
    const malformed = createAnalysisService(store,{ env: { ...env, INCIDENTLAB_AI_MAX_USD: 'NaN' } });
    assert.equal(malformed.configuration().enabled,false);
  } finally { store.close(); }
});

test('provider requests are bounded, use strict structured output, omit payloads and are cached by evidence', async () => {
  const store = createStore(); let calls = 0;
  try {
    const item = incident(store);
    const service = createAnalysisService(store,{ env,fetchImpl: async (url,options) => {
      calls++;
      assert.equal(url,'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.model,ANALYSIS_MODEL);
      assert.equal(body.store,false);
      assert.equal(body.max_output_tokens,1800);
      assert.equal(body.text.format.strict,true);
      assert.ok(!options.body.includes('never-send-this'));
      assert.ok(!options.body.includes(item.events[0].id),'database event IDs stay local');
      assert.equal(body.tools,undefined);
      return response();
    } });
    const first = await service.analyze(item);
    assert.equal(first.analysis.status,'succeeded');
    assert.equal(first.analysis.usage.inputTokens,100);
    assert.equal((await service.analyze(item)).cached,true);
    assert.equal(calls,1);
    assert.equal((await service.view(item)).analysis.id,first.analysis.id);
    incident(store);
    const updated = store.incident(item.id);
    assert.equal((await service.view(updated)).stale,true);
    await service.analyze(updated); assert.equal(calls,2);
  } finally { store.close(); }
});

test('concurrent requests share a persistent reservation rather than spending twice', async () => {
  const store = createStore(); let release; let entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  try {
    const item = incident(store);
    const first = createAnalysisService(store,{ env,fetchImpl: async () => { calls++; entered(); await barrier; return response(); } });
    const second = createAnalysisService(store,{ env,fetchImpl: async () => { calls++; return response(); } });
    const pending = first.analyze(item); await started;
    const duplicate = await second.analyze(item);
    assert.equal(duplicate.cached,true); assert.equal(duplicate.analysis.status,'pending');
    release(); assert.equal((await pending).analysis.status,'succeeded'); assert.equal(calls,1);
  } finally { release(); store.close(); }
});

test('per-request and daily reservations fail closed, including across service instances', async () => {
  const store = createStore(); let calls = 0;
  try {
    const item = incident(store);
    const tiny = createAnalysisService(store,{ env: { ...env, INCIDENTLAB_AI_MAX_USD: '.000001' },fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(tiny.analyze(item),{ code: 'analysis_request_budget_exceeded' });
    assert.equal(calls,0);
    const one = createAnalysisService(store,{ env,fetchImpl: async () => { calls++; return response(); } });
    const saved = await one.analyze(item);
    incident(store,{ service: 'billing' });
    const billing = store.incidents().find(i => i.service === 'billing');
    const daily = createAnalysisService(store,{ env: { ...env, INCIDENTLAB_AI_DAILY_USD: String(saved.analysis.reserved_microusd/1000000) },fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(daily.analyze(store.incident(billing.id)),/Daily analysis budget/);
    assert.equal(calls,1);
  } finally { store.close(); }
});

test('invalid citations and provider failures are saved with no automatic retry or leaked provider details', async () => {
  const store = createStore(); let calls = 0;
  try {
    const item = incident(store);
    const bad = result(); bad.summary.evidenceIds = ['fabricated-event'];
    const service = createAnalysisService(store,{ env,fetchImpl: async () => { calls++; return response(bad); } });
    const failed = await service.analyze(item);
    assert.equal(failed.analysis.status,'failed'); assert.equal(failed.analysis.error_code,'invalid_analysis');
    await service.analyze(item); assert.equal(calls,1);
    await service.analyze(item,{ retry: true }); assert.equal(calls,2);
    await service.analyze(item,{ retry: true }); assert.equal(calls,3);
    await assert.rejects(service.analyze(item,{ retry: true }),/Maximum attempts/);
    const other = incident(store,{ service: 'payments' });
    const failing = createAnalysisService(store,{ env,fetchImpl: async () => new Response('secret-provider-error',{ status: 500 }) });
    const error = await failing.analyze(other);
    assert.equal(error.analysis.error_code,'provider_unavailable');
    assert.ok(!JSON.stringify(error).includes('secret-provider-error'));
    assert.ok(error.analysis.reserved_microusd > 0);
  } finally { store.close(); }
});

test('incomplete and refused responses are never presented as successful analyses', async () => {
  const store = createStore();
  try {
    const item = incident(store);
    const incomplete = createAnalysisService(store,{ env,fetchImpl: async () => response(result(),{ status: 'incomplete' }) });
    assert.equal((await incomplete.analyze(item)).analysis.error_code,'provider_incomplete');
    const refusal = createAnalysisService(store,{ env,fetchImpl: async () => response(result(),{ output: [{ type: 'message',content: [{ type: 'refusal',refusal: 'no' }] }] }) });
    assert.equal((await refusal.analyze(item,{ retry: true })).analysis.error_code,'provider_refused');
  } finally { store.close(); }
});

test('saved evidence and results survive SQLite restart; interrupted reservations can be retried explicitly', async () => {
  const directory = mkdtempSync(join(tmpdir(),'incidentlab-analysis-')); const file = join(directory,'db.sqlite');
  let id;
  try {
    const first = createStore(file);
    try { const item = incident(first); id = item.id;
      await createAnalysisService(first,{ env,fetchImpl: async () => response() }).analyze(item); }
    finally { first.close(); }
    const second = createStore(file);
    try {
      const service = createAnalysisService(second,{ env,fetchImpl: () => { throw new Error('must be cached'); } });
      assert.equal((await service.analyze(second.incident(id))).analysis.status,'succeeded');
      const input = { incidentId: id,baseKey: 'interrupted-key',evidenceHash: 'hash',evidence: { evidence: [] },model: ANALYSIS_MODEL,reservedMicros: 100,day: '2026-01-01',dailyMicros: 1000 };
      const reserved = second.reserveAnalysis(input);
      second.db.prepare('UPDATE incident_analyses SET created_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z',reserved.analysis.id);
      second.expireAnalyses(); assert.equal(second.analysisByKey(input.baseKey).status,'failed');
      assert.equal(second.reserveAnalysis({ ...input,retry: true }).analysis.attempt,2);
    } finally { second.close(); }
  } finally { rmSync(directory,{ recursive: true,force: true,maxRetries: 5,retryDelay: 100 }); }
});

test('HTTP analysis flow returns saved evidence and rejects foreign origins without exposing credentials', async t => {
  const store = createStore(); const item = incident(store); let calls = 0;
  const server = createApp(store,{ analysisOptions: { env,fetchImpl: async () => { calls++; return response(); } } });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await server.stopWorker(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/incidents/${item.id}/analysis`;
  assert.equal((await fetch(endpoint)).status,200); assert.equal(calls,0);
  assert.equal((await fetch(endpoint,{ method: 'POST',headers: { Origin: 'https://evil.example' } })).status,403);
  assert.equal((await fetch(endpoint,{ method: 'POST',headers: { 'sec-fetch-site': 'cross-site' } })).status,403);
  const generated = await (await fetch(endpoint,{ method: 'POST' })).json();
  assert.equal(generated.analysis.status,'succeeded');
  assert.ok(!JSON.stringify(generated).includes(env.OPENAI_API_KEY));
  await fetch(endpoint); assert.equal(calls,1);
  assert.equal((await fetch(`${base}/api/incidents/missing/analysis`)).status,404);
});
