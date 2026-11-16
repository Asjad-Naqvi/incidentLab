const escape = value => String(value).replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const running = new Set();
const money = micros => `$${(micros/1000000).toFixed(4)}`;
const errors = {
  provider_unavailable: 'The provider request failed or timed out. No automatic retry was made.',
  provider_incomplete: 'The provider did not return a complete analysis.',
  provider_refused: 'The provider declined this analysis.',
  invalid_analysis: 'The response did not pass schema and evidence-citation checks.',
  interrupted: 'The request was interrupted. Its budget reservation is retained.',
  analysis_disabled: 'Configure analysis on the server before sending evidence.',
  analysis_request_budget_exceeded: 'This evidence snapshot exceeds the configured per-analysis budget.'
};

export async function mountAnalysis(incidentId) {
  const body = document.querySelector('#incident-detail .detail-body');
  if (!body) return;
  const panel = document.createElement('section'); panel.className = 'analysis-panel'; panel.setAttribute('aria-label','AI incident analysis');
  body.querySelector('.detail-description').insertAdjacentElement('afterend',panel);
  panel.innerHTML = '<h3>AI investigation</h3><p class="analysis-note">Loading saved analysis…</p>';
  const endpoint = `/api/incidents/${incidentId}/analysis`;
  async function read(method = 'GET',retry = false) {
    const response = await fetch(endpoint + (retry ? '?retry=1' : ''),{ method });
    const data = await response.json();
    if (!response.ok) throw new Error(errors[data.error] || data.error || 'Analysis unavailable');
    return data;
  }
  function render(data,message = null) {
    if (!panel.isConnected) return;
    const analysis = data.analysis;
    const pending = running.has(incidentId) || analysis?.status === 'pending';
    const retry = analysis?.status === 'failed' && !data.stale;
    const refs = list => list.map(ref => `<a class="evidence-link" href="#analysis-evidence-${escape(ref)}">${escape(ref)}</a>`).join(' ');
    const result = analysis?.result;
    panel.innerHTML = `<div class="analysis-heading"><h3>AI investigation</h3><span class="badge ${analysis?.status === 'succeeded' ? 'success' : 'neutral'}">${pending ? 'Analyzing' : analysis?.status === 'succeeded' ? 'Saved analysis' : data.enabled ? 'Ready' : 'Not configured'}</span></div>
      <p class="analysis-note">${data.enabled ? `On request, sends up to ${data.evidenceCount} sanitized failure records to OpenAI. Bodies, attributes, headers and raw messages are excluded.` : 'Analysis is disabled. Set a server-side API key and enable analysis to use this feature.'}</p>
      ${data.stale ? '<p class="analysis-warning">New evidence is available. The saved analysis below covers an older snapshot.</p>' : ''}
      ${message ? `<p class="analysis-warning" role="status">${escape(message)}</p>` : ''}
      ${analysis?.status === 'failed' ? `<p class="analysis-warning">${escape(errors[analysis.error_code] || 'Analysis could not be completed.')} Failed or uncertain requests retain their budget reservation.</p>` : ''}
      ${result && analysis.status === 'succeeded' ? `<div class="analysis-result"><h4>Summary</h4><p>${escape(result.summary.text)} ${refs(result.summary.evidenceIds)}</p><h4>Possible causes</h4>${result.hypotheses.map(h => `<article class="hypothesis"><span class="badge neutral">${escape(h.confidence)} confidence</span><p>${escape(h.cause)} ${refs(h.evidenceIds)}</p><small>To validate: ${escape(h.validation)}</small></article>`).join('')}<h4>Next steps</h4><ol>${result.nextSteps.map(s => `<li>${escape(s.action)} ${refs(s.evidenceIds)}</li>`).join('')}</ol><h4>Missing evidence</h4><ul>${result.missingEvidence.map(item => `<li>${escape(item)}</li>`).join('')}</ul><p class="analysis-note">AI-generated hypotheses, not a verified root cause or proof of a fix. Citations show relevant evidence, not causation.</p></div>` : ''}
      ${analysis ? `<details class="analysis-evidence"><summary>Evidence snapshot · ${analysis.evidence.evidence.length} records</summary><table class="request-table"><thead><tr><th>Ref</th><th>Route</th><th>Status</th><th>Time</th></tr></thead><tbody>${analysis.evidence.evidence.map(e => `<tr id="analysis-evidence-${escape(e.ref)}"><td>${escape(e.ref)}</td><td>${escape(e.method)} ${escape(e.route)}</td><td>${e.status}</td><td>${e.durationMs.toFixed(1)} ms</td></tr>`).join('')}</tbody></table></details><p class="analysis-note">${escape(analysis.model)} · ${new Date(analysis.created_at).toLocaleString()} · reserved ${money(analysis.reserved_microusd)}${analysis.usage ? ` · ${analysis.usage.inputTokens} input / ${analysis.usage.outputTokens} output tokens · estimated usage ${money(analysis.cost_microusd)}` : ''}</p>` : ''}
      <button class="primary analysis-button" ${!data.enabled || pending ? 'disabled' : ''}>${pending ? 'Analyzing…' : retry ? 'Retry analysis' : data.stale ? 'Analyze updated evidence' : result ? 'View saved analysis' : 'Analyze incident'}</button>
      <p class="analysis-note">Estimated limit $${data.maxUsd.toFixed(2)} per request · UTC daily reservations $${data.reservedTodayUsd.toFixed(4)} / $${data.dailyUsd.toFixed(2)}. Rates are estimates; provider billing may differ.</p>`;
    // Open evidence before following a citation into the expandable table.
    panel.querySelectorAll('.evidence-link').forEach(link => link.addEventListener('click',() => { panel.querySelector('.analysis-evidence').open = true; }));
    panel.querySelector('.analysis-button').addEventListener('click',async () => {
      if (running.has(incidentId)) return;
      running.add(incidentId); render(data);
      try { const updated = await read(result && !data.stale ? 'GET' : 'POST',retry); running.delete(incidentId); render(updated); }
      catch (error) { running.delete(incidentId); render(data,error.message); }
    });
  }
  try { render(await read()); }
  catch { if (panel.isConnected) panel.innerHTML = '<h3>AI investigation</h3><p class="analysis-note">Saved analysis is unavailable. Check database migrations and try reopening the incident.</p>'; }
}
