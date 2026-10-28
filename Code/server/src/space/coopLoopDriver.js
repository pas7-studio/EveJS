/**
 * The co-op loop's own clock.
 *
 * Measured 2026-10-29: the economic phases (refinery, manufacture, distribution) ran only
 * when the mining think happened to reach one branch of stock code. It ran at 23:30:26 and
 * then not again for eight minutes while the world kept simulating and the fleet thought was
 * healthy - a journaled gate crossing sat at 6 km from its gate with nobody to advance it.
 * A phase that runs "whenever something else calls it" is not a phase.
 *
 * This driver owns the beat. It is env-gated and default OFF, so a world that does not ask
 * for it behaves exactly as before. It never invents work: it calls the same `tick` the
 * stock hook calls, with the same authorities, and only once per interval.
 *
 *   EVEJS_COOP_LOOP_DRIVER=1        enable the beat
 *   EVEJS_COOP_LOOP_INTERVAL_MS     beat interval (default 60000, floor 15000)
 */

let timer = null;
let beats = 0;
let lastBeatAt = 0;
let lastStatus = null;
let lastError = null;

function intervalMs(env) {
  const raw = Number(env.EVEJS_COOP_LOOP_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 15000 ? Math.floor(raw) : 60000;
}

function note(event, fields) {
  try {
    const observe = require("./coopRuntimeProbe").observe;
    observe(event, null, null, fields);
  } catch (_error) { /* telemetry only */ }
}

/** Run one beat. Exported so a test can drive it without a timer. */
function beat(options = {}) {
  const env = options.env || process.env;
  if (String(env.EVEJS_COOP_LOOP_DRIVER || "") !== "1") return { status: "DISABLED" };
  beats += 1;
  lastBeatAt = Date.now();
  let status = "OK";
  try {
    // The beat is a scheduler, not an authority: the phases decide what is possible.
    status = String(require("./coopLoopTick").tick({ env }).status || "OK");
    lastError = null;
  } catch (error) {
    status = "THREW";
    lastError = String((error && error.message) || error).slice(0, 120);
  }
  if (status !== lastStatus) {
    // One line per change of state, never one per beat.
    note("living-coop-loop-driver", { status, beats, error: lastError });
    lastStatus = status;
  }
  return { status, beats, error: lastError };
}

/** Start the beat once; later calls are no-ops. */
function ensure(options = {}) {
  const env = options.env || process.env;
  if (String(env.EVEJS_COOP_LOOP_DRIVER || "") !== "1") return { status: "DISABLED" };
  if (timer) return { status: "ALREADY_RUNNING", beats };
  const ms = intervalMs(env);
  timer = setInterval(() => { beat({ env }); }, ms);
  // A background phase must never hold the process open by itself.
  if (typeof timer.unref === "function") timer.unref();
  note("living-coop-loop-driver", { status: "STARTED", intervalMs: ms });
  return { status: "STARTED", intervalMs: ms };
}

function stop() {
  if (timer && typeof clearInterval === "function") clearInterval(timer);
  timer = null;
  return { status: "STOPPED", beats };
}

function status() {
  return { running: Boolean(timer), beats, lastBeatAt, lastStatus, lastError };
}

module.exports = { ensure, stop, beat, status, intervalMs };
