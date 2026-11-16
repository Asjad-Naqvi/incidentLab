import { mountAnalysis } from './analysis.js';
const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null;
let selected = null;
let currentView = 'overview';
let toastTimer;
const date = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function api(path, method = 'GET') {
  const response = await fetch(path, { method });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 4500);
}
async function action(button, fn) {
  button.disabled = true;
  try { await fn(); } catch (error) { toast(error.message); } finally { button.disabled = false; }
}
async function refresh() {
  try {
    state = await api('/api/overview');
    $('#metric-open').textContent = state.metrics.open;
    $('#nav-count').textContent = state.metrics.open;
    $('#metric-total').textContent = state.metrics.total.toLocaleString();
    $('#metric-errors').innerHTML = `${state.metrics.errorRate.toFixed(1)}<span>%</span>`;
    $('#metric-p95').innerHTML = `${Math.round(state.metrics.p95)}<span>ms</span>`;
    $('#fixture-status').className = `badge ${state.fixed ? 'success' : 'warning'}`;
    $('#fixture-status').textContent = state.fixed ? 'Fix applied' : 'Bug enabled';
    $('#toggle-fix').innerHTML = `${state.fixed ? 'Reintroduce demo bug' : 'Apply demo fix'} <span>↗</span>`;
    $('#last-updated').textContent = `Updated ${date(new Date())}`;
    renderList(); renderChart(); renderIntegrations();
    if (currentView === 'replays') await renderHistory();
    if (selected && $('#incident-dialog').open) await renderDetail(selected);
  } catch (error) { toast(`Unable to refresh: ${error.message}`); }
}
function renderChart() {
  const max = Math.max(1, ...state.timeline.map(b => b.total));
  const any = state.timeline.some(b => b.total);
  $('#chart').innerHTML = state.timeline.map(b => `<div class="chart-bar" style="height:${Math.max(1, b.total / max * 92)}%" title="${date(b.time)}: ${b.total} requests, ${b.errors} errors"><div class="err" style="height:${b.total ? b.errors / b.total * 100 : 0}%"></div><div class="ok" style="height:${b.total ? (b.total - b.errors) / b.total * 100 : 0}%"></div></div>`).join('') + (!any ? '<span class="chart-empty">Your first requests will appear here</span>' : '');
}
function renderList() {
  const search = $('#search').value.toLowerCase();
  const status = $('#status-filter').value;
  const items = state.incidents.filter(i => `${i.title} ${i.service}`.toLowerCase().includes(search) && (status === 'all' || i.status === status));
  $('#list-count').textContent = items.length;
  $('#incident-list').innerHTML = items.length ? items.map(i => `<button class="incident-row ${escape(i.status)}" data-incident="${escape(i.id)}"><span class="indicator"></span><span class="incident-info"><strong>${escape(i.title)}</strong><small>${escape(i.service)} · ${i.occurrences} captured failures</small></span><span class="incident-meta"><span class="badge ${i.status === 'resolved' ? 'success' : 'critical'}">${i.status === 'resolved' ? 'Resolved' : 'Critical · Open'}</span><span>${date(i.updated_at)} ↗</span></span></button>`).join('') : `<div class="empty-state"><div class="empty-icon">◎</div><h3>${state.incidents.length ? 'No matching incidents' : 'All quiet. Let’s break something.'}</h3><p>${state.incidents.length ? 'Try a different search or status filter.' : 'Generate demo traffic to capture your first checkout failure and start investigating.'}</p>${!state.incidents.length ? '<button class="text-button" id="empty-generate">Generate your first incident →</button>' : ''}</div>`;
  document.querySelectorAll('[data-incident]').forEach(button => button.addEventListener('click', () => openIncident(button.dataset.incident)));
  $('#empty-generate')?.addEventListener('click', () => $('#generate').click());
}
async function openIncident(id) {
  selected = id;
  try { await renderDetail(id); if (!$('#incident-dialog').open) $('#incident-dialog').showModal(); }
  catch (error) { toast(error.message); }
}
async function renderDetail(id) {
  const incident = await api(`/api/incidents/${id}`);
  $('.drawer-header h2').textContent = incident.service === 'checkout-api' ? 'Checkout failure' : 'Service incident';
  const latest = incident.replays[0];
  if (incident.service !== 'checkout-api') { renderExternalDetail(incident); void mountAnalysis(incident.id); return; }
  $('#incident-detail').innerHTML = `<div class="detail-body"><span class="badge ${incident.status === 'resolved' ? 'success' : 'critical'}">${escape(incident.status.toUpperCase())} · CHECKOUT-API</span><h3 class="detail-title">${escape(incident.title)}</h3><p class="detail-description">Captured evidence shows expired-session fixture requests returning HTTP 500. The demo fix handles expiry explicitly and returns a recoverable HTTP 409.</p><div class="detail-section"><h3>Investigation notes</h3><div class="evidence-card"><code>lib/service.mjs → checkout(payload, fixed)</code><p>This explanation is deterministic and specific to the included fixture. AI analysis runs only when requested.</p></div></div><div class="detail-actions"><button class="primary" id="replay">↻ Replay captured requests</button><button class="secondary" id="detail-fix">${state.fixed ? 'Reintroduce demo bug' : 'Apply demo fix'}</button>${incident.status !== 'resolved' ? '<button class="secondary" id="resolve">Mark resolved</button>' : ''}</div>${latest ? `<div class="detail-section"><h3>Latest replay · ${latest.count} requests · ${date(latest.created_at)}</h3><div class="comparison"><div>Before · server error rate<strong>${latest.beforeErrorRate.toFixed(0)}%</strong></div><div>After · server error rate<strong>${latest.afterErrorRate.toFixed(0)}%</strong></div></div><p class="disclaimer">${latest.afterErrors === 0 ? 'No server errors in this replay. Expired sessions still return 409; this is handled failure, not a completed purchase.' : 'The failure is still reproducible. Apply the fixture fix and replay again.'} Replay uses the local fixture only, up to 100 captured failures.</p><div class="evidence-card"><table class="request-table"><thead><tr><th>Request</th><th>Before</th><th>After</th><th>After time</th></tr></thead><tbody>${latest.results.slice(0, 10).map((r, i) => `<tr><td>#${i + 1}</td><td class="bad">${r.beforeStatus}</td><td>${r.afterStatus}</td><td>${r.afterMs.toFixed(1)} ms</td></tr>`).join('')}</tbody></table></div></div>` : ''}<div class="detail-section"><h3>Captured requests · ${incident.events.length}</h3><table class="request-table"><thead><tr><th>Time</th><th>Endpoint</th><th>Status</th><th>Duration</th></tr></thead><tbody>${incident.events.slice(0, 20).map(e => `<tr><td>${date(e.created_at)}</td><td>POST /demo/checkout</td><td class="bad">${e.status}</td><td>${e.duration_ms.toFixed(1)} ms</td></tr>`).join('')}</tbody></table></div><p class="disclaimer">Only allowlisted demo fields are stored. Authorization headers, payment credentials, and arbitrary payloads are never captured.</p></div>`;
  $('#replay').addEventListener('click', event => action(event.currentTarget, async () => {
    const result = await api(`/api/incidents/${id}/replay`, 'POST');
    toast(`Replayed ${result.count} requests · ${result.afterErrors} server errors`); await refresh();
  }));
  $('#detail-fix').addEventListener('click', event => action(event.currentTarget, toggleFix));
  $('#resolve')?.addEventListener('click', event => action(event.currentTarget, async () => {
    await api(`/api/incidents/${id}/resolve`, 'POST'); toast('Incident resolved with replay evidence'); await refresh();
  }));
  void mountAnalysis(incident.id);
}
function renderExternalDetail(incident) {
  const paths = [...new Set(incident.events.map(e => `${e.method} ${e.path}`))];
  $('#incident-detail').innerHTML = `<div class="detail-body"><span class="badge critical">${escape(incident.status.toUpperCase())} · ${escape(incident.service)}</span><h3 class="detail-title">${escape(incident.title)}</h3><p class="detail-description">An independently running service reported ${incident.events.length} captured server errors through the authenticated ingestion SDK.</p><div class="detail-section"><h3>Captured evidence</h3><div class="evidence-card"><code>${paths.map(escape).join('<br>')}</code><p>Error class: ${escape(incident.title)}. Inspect application logs and code to establish the cause. Telemetry alone does not prove a root cause.</p></div><div class="evidence-card"><p>Replay is available for the built-in checkout fixture. External services need an isolated replay adapter before requests can be executed or a fix verified here.</p></div></div><div class="detail-section"><h3>Captured requests · ${incident.events.length}</h3><table class="request-table"><thead><tr><th>Time</th><th>Route</th><th>Status</th><th>Duration</th></tr></thead><tbody>${incident.events.slice(0, 20).map(e => `<tr><td>${date(e.created_at)}</td><td>${escape(e.method)} ${escape(e.path)}</td><td class="bad">${e.status}</td><td>${e.duration_ms.toFixed(1)} ms</td></tr>`).join('')}</tbody></table></div><div class="detail-section"><h3>Latest sanitized attributes</h3><pre class="payload-preview">${escape(JSON.stringify(incident.events[0]?.payload ?? {}, null, 2))}</pre></div><p class="disclaimer">Only explicitly selected SDK payload fields are sent. The collector applies additional redaction. Never opt personal data or secrets into telemetry. AI analysis runs only when requested.</p></div>`;
}
function renderIntegrations() {
  const ingestion = state.ingestion;
  $('#ingestion-status').textContent = ingestion.enabled ? 'Authenticated ingestion ready' : 'Ingestion disabled';
  $('#ingestion-status').className = `badge ${ingestion.enabled ? 'success' : 'warning'}`;
  const queue = ingestion.queue;
  $('#queue-status').textContent = `${ingestion.storage || 'sqlite'} · ${ingestion.workerMode || 'embedded'} worker · ${queue.queued} queued · ${queue.processing} processing · ${queue.complete} processed · ${queue.dead} failed`;
  $('#connected-services').innerHTML = ingestion.services.length ? ingestion.services.map(s => `<div class="connected-service"><div class="service-avatar">${escape(s.service[0].toUpperCase())}</div><div class="connected-name"><strong>${escape(s.service)}</strong><small>${s.service === 'checkout-api' ? 'Built-in replay fixture' : 'Server-side SDK'} · last received ${date(s.last_seen)}</small></div><span>${s.requests} requests</span><span class="badge ${s.errors ? 'warning' : 'success'}">${s.errors} server errors</span></div>`).join('') : '<div class="connected-empty">No telemetry yet. Generate fixture traffic or connect the separate sample service.</div>';
}
async function toggleFix() {
  await api(`/api/demo/${state.fixed ? 'break' : 'fix'}`, 'POST');
  toast(state.fixed ? 'Demo bug reintroduced' : 'Demo fix applied. Replay an incident to verify it.'); await refresh();
}
async function renderHistory() {
  const details = await Promise.all(state.incidents.map(i => api(`/api/incidents/${i.id}`)));
  const replays = details.flatMap(i => i.replays.map(r => ({ ...r, incident: i }))).sort((a, b) => b.created_at.localeCompare(a.created_at));
  $('#history-content').innerHTML = replays.length ? replays.map(r => `<div class="history-row"><div>${escape(r.incident.title)}<small>${new Date(r.created_at).toLocaleString()} · ${r.count} requests · ${r.fixed ? 'fix enabled' : 'bug enabled'}</small></div><span class="badge ${r.afterErrors ? 'critical' : 'success'}">${r.beforeErrorRate.toFixed(0)}% → ${r.afterErrorRate.toFixed(0)}% server errors</span></div>`).join('') : '<div class="empty-state"><div class="empty-icon">↻</div><h3>No replays yet</h3><p>Open an incident and replay its captured requests. Your results will be saved here.</p></div>';
}
$('#generate').addEventListener('click', event => action(event.currentTarget, async () => {
  await api('/api/demo/traffic', 'POST'); toast('12 real demo requests captured'); await refresh();
}));
$('#toggle-fix').addEventListener('click', event => action(event.currentTarget, toggleFix));
$('#search').addEventListener('input', () => state && renderList());
$('#status-filter').addEventListener('change', () => state && renderList());
$('#close-dialog').addEventListener('click', () => $('#incident-dialog').close());
$('#incident-dialog').addEventListener('close', () => { selected = null; });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', async () => {
  currentView = button.dataset.view;
  document.body.classList.remove('view-overview', 'view-incidents', 'view-replays');
  document.body.classList.add(`view-${currentView}`);
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button));
  $('#breadcrumb').textContent = { overview: 'Overview', incidents: 'Incidents', replays: 'Replay history' }[currentView];
  $('#page-title').textContent = { overview: 'A clearer view of what broke.', incidents: 'Every failure has a story.', replays: 'Put your fix to the test.' }[currentView];
  $('#page-subtitle').textContent = { overview: 'From the first error to a fix you can prove.', incidents: 'Inspect the evidence behind your service failures.', replays: 'Compare captured failures with measured replay results.' }[currentView];
  $('#replay-history').classList.toggle('hidden', currentView !== 'replays');
  if (currentView === 'replays' && state) try { await renderHistory(); } catch (error) { toast(error.message); }
}));
const stream = new EventSource('/api/stream');
stream.onopen = () => { $('#connection-label').textContent = 'Live connection'; };
stream.onmessage = () => refresh();
stream.onerror = () => { $('#connection-label').textContent = 'Reconnecting…'; };
refresh();
