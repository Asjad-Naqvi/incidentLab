const escape = value => String(value).replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => new Date(value).toLocaleTimeString([], { hour: '2-digit',minute: '2-digit',second: '2-digit' });

export function replaySummary(replay) {
  if (replay.state === 'failed') return `Replay failed: ${escape(replay.errorCode)}`;
  const rates = `${replay.beforeErrorRate.toFixed(0)}% → ${replay.afterErrorRate.toFixed(0)}% server errors`;
  return replay.adapter ? `${rates} · isolated ${escape(replay.revision)}` : rates;
}

export function externalDetail(incident) {
  const supported = incident.service === 'checkout-sample' && incident.title === 'PaymentSessionExpired';
  const latest = incident.replays[0];
  return `<div class="detail-body"><span class="badge critical">${escape(incident.status.toUpperCase())} · ${escape(incident.service)}</span><h3 class="detail-title">${escape(incident.title)}</h3><p class="detail-description">${incident.events.length} captured failures from an independently running service.</p>
    ${supported ? `<section class="detail-section"><h3>Isolated sample replay</h3><p class="detail-description">Compare a fresh baseline against a candidate fix using the captured fixture inputs. The live sample service is unchanged.</p><div class="detail-actions"><button class="secondary" id="external-baseline">↻ Replay baseline</button><button class="primary" id="external-candidate">Test candidate fix</button></div><p class="disclaimer">Bundled checkout adapter · separate worker thread · up to 20 requests · 10-second deadline. A worker thread is not an OS security sandbox.</p></section>` : '<div class="evidence-card"><p>No replay adapter is registered for this service. Captured URLs and code are never executed.</p></div>'}
    ${latest ? replayEvidence(latest) : ''}
    <section class="detail-section"><h3>Captured requests · ${incident.events.length}</h3><table class="request-table"><thead><tr><th>Time</th><th>Route</th><th>Status</th><th>Duration</th></tr></thead><tbody>${incident.events.slice(0,20).map(e => `<tr><td>${date(e.created_at)}</td><td>${escape(e.method)} ${escape(e.path)}</td><td class="bad">${e.status}</td><td>${e.duration_ms.toFixed(1)} ms</td></tr>`).join('')}</tbody></table></section><p class="disclaimer">Replay results are saved separately from live metrics. Successful candidate verification does not resolve a live incident or prove a deployed fix.</p></div>`;
}

function replayEvidence(replay) {
  if (replay.state === 'failed') return `<section class="detail-section"><h3>Latest replay did not complete</h3><div class="evidence-card"><p>${escape(replay.errorCode)} · ${replay.count} selected requests. No successful verification was recorded.</p></div></section>`;
  return `<section class="detail-section"><h3>Latest isolated replay · ${replay.count} paired requests</h3><div class="comparison"><div>Fresh baseline · server errors<strong>${replay.beforeErrorRate.toFixed(0)}%</strong></div><div>${escape(replay.revision)} · server errors<strong>${replay.afterErrorRate.toFixed(0)}%</strong></div></div><div class="comparison"><div>Baseline p95<strong>${replay.beforeLatency.p95Ms.toFixed(1)}<small> ms</small></strong></div><div>Comparison p95<strong>${replay.afterLatency.p95Ms.toFixed(1)}<small> ms</small></strong></div></div><div class="evidence-card"><span class="badge ${replay.verificationPassed ? 'success' : 'warning'}">${replay.verificationPassed ? 'Candidate passed in adapter' : 'No candidate verification'}</span><p>${replay.reproduced} / ${replay.count} captured failures reproduced in the baseline. The handled expiry response is HTTP 409, not a completed purchase.</p></div><p class="disclaimer">${escape(replay.adapter)} · implementation ${escape(replay.implementationHash.slice(0,12))} · ${date(replay.created_at)}. These small, simulated workload measurements are not a production benchmark.</p><table class="request-table"><thead><tr><th>Captured</th><th>Baseline</th><th>Comparison</th><th>Timing pair</th></tr></thead><tbody>${replay.results.slice(0,10).map(r => `<tr><td>${r.capturedStatus}</td><td>${r.beforeStatus}</td><td>${r.afterStatus}</td><td>${r.beforeMs.toFixed(1)} → ${r.afterMs.toFixed(1)} ms</td></tr>`).join('')}</tbody></table></section>`;
}

export function wireExternalReplay(incident,{ api,action,refresh,toast }) {
  for (const revision of ['baseline','candidate']) {
    document.querySelector(`#external-${revision}`)?.addEventListener('click',event => action(event.currentTarget,async () => {
      const result = await api(`/api/incidents/${incident.id}/replay`,'POST',{ revision });
      toast(result.state === 'failed' ? `Replay failed: ${result.errorCode}` : result.verificationPassed ? 'Candidate passed in isolated adapter; live incident remains open' : 'Baseline replay saved');
      await refresh();
    }));
  }
}
