"use strict";
// Phase timing for the co-op runtime.
//
// Why: "the server is slow" is not actionable. Every phase now reports how long
// it really took, so the next optimisation targets a measured phase instead of a
// guess. Off by default (`EVEJS_COOP_PERF_METRICS=1` turns it on); the ring
// buffer is bounded so instrumentation can never become the leak.
const WINDOW = Number(process.env.EVEJS_COOP_PERF_WINDOW || 200);

function createMetrics({ window = WINDOW, now = () => Date.now() } = {}) {
  const series = new Map();
  function bucket(name) {
    let b = series.get(name);
    if (!b) {
      b = { name, samples: [], count: 0, totalMs: 0, maxMs: 0, lastAt: 0 };
      series.set(name, b);
    }
    return b;
  }
  function observe(name, ms) {
    const value = Number(ms);
    if (!(value >= 0)) return;
    const b = bucket(String(name));
    b.count += 1;
    b.totalMs += value;
    if (value > b.maxMs) b.maxMs = value;
    b.samples.push(value);
    if (b.samples.length > window) b.samples.shift();
    b.lastAt = now();
  }
  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx];
  }
  function snapshot() {
    const out = [];
    for (const b of series.values()) {
      const sorted = [...b.samples].sort((x, y) => x - y);
      out.push({
        phase: b.name,
        count: b.count,
        samples: sorted.length,
        avgMs: Number((b.totalMs / Math.max(1, b.count)).toFixed(2)),
        p50Ms: Number(percentile(sorted, 50).toFixed(2)),
        p95Ms: Number(percentile(sorted, 95).toFixed(2)),
        maxMs: Number(b.maxMs.toFixed(2)),
        lastAt: b.lastAt,
      });
    }
    return out.sort((x, y) => y.avgMs - x.avgMs);
  }
  function top(n = 8) {
    return snapshot().slice(0, n);
  }
  function reset() {
    series.clear();
  }
  return Object.freeze({ observe, snapshot, top, reset });
}

let singleton = null;
function enabled(env = process.env) {
  return env.EVEJS_COOP_PERF_METRICS === "1";
}
function metrics() {
  if (!singleton) singleton = createMetrics();
  return singleton;
}

// Times one synchronous call. A thrown error is re-thrown unchanged: this must
// never alter control flow.
function timePhase(name, run) {
  if (!enabled()) return run();
  const started = process.hrtime.bigint();
  try {
    return run();
  } finally {
    metrics().observe(name, Number(process.hrtime.bigint() - started) / 1e6);
  }
}

module.exports = { createMetrics, metrics, enabled, timePhase };
