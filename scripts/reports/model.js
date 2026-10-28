/* Shared browser/VM model. Missing measurements remain null, never invented as zero. */
globalThis.ReportModel = (() => {
  const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  function metricTotal(metrics, name) {
    if (!Array.isArray(metrics) || !metrics.length) return null;
    let total = 0, found = false;
    for (const text of metrics) for (const line of String(text).split('\n')) {
      if (line.startsWith(name + '{') || line.startsWith(name + ' ')) {
        const value = number(Number(line.trim().split(/\s+/).at(-1)));
        if (value !== null) { total += value; found = true; }
      }
    }
    return found ? total : null;
  }
  function normalize(report, name = 'importado') {
    if (!report || typeof report !== 'object' || !Array.isArray(report.results)) throw new Error('JSON deve conter results[]; use results-NNN.json ou summary.json.');
    const sequence = String(report.sequence || name);
    const rows = report.results.map((r, index) => {
      if (!r || typeof r !== 'object') throw new Error('Cenário inválido.');
      return { sequence, label: String(r.label || `caso-${index + 1}`), history: number(r.history), shape: String(r.shape || ''), transport: String(r.transport || ''), intervalMs: number(r.intervalMs), repeat: number(r.repeat), throughput: number(r.throughput), p50: number(r.latencyMs?.p50), p95: number(r.latencyMs?.p95), p99: number(r.latencyMs?.p99), processed: number(r.processed), errors: number(r.technicalErrors), rejected: number(r.businessRejected), lag: r.backlogAfterMeasurement?.lag == null ? null : number(Number(r.backlogAfterMeasurement.lag)), lockP95: number(r.lockWaitMs?.p95), retries: number(r.retryCount) ?? metricTotal(r.metrics, 'wager_retries_total'), conflicts: number(r.lockConflictCount) ?? metricTotal(r.metrics, 'wager_lock_conflicts_total'), errorRate: number(r.requests) && number(r.technicalErrors) !== null ? r.technicalErrors / r.requests * 100 : null, raw: r };
    });
    const limits = Array.isArray(report.populationLimits) ? report.populationLimits : [];
    return { name: sequence, status: String(report.status || 'summary'), environment: report.environment || null, rows, limits };
  }
  function filter(rows, filters) {
    return rows.filter(r => ['sequence', 'shape', 'transport', 'history'].every(k => !filters[k] || String(r[k]) === filters[k]) && (!filters.query || r.label.toLowerCase().includes(filters.query.toLowerCase())));
  }
  return { normalize, filter, number };
})();
