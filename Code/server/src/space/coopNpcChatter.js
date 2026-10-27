"use strict";
// Optional local chatter for NPCs that already exist as physical ships in the
// scene. It never invents a ship, a kill, cargo or ISK: it only gives a voice
// to a native entity that is already present, with a per-pilot cooldown and a
// hard per-system cap so Local never turns into spam.
const LINES = {
  miner: [
    "[%s] Пояс спокійний, тримаю курс на руду.",
    "[%s] Видобуток іде за планом, без ускладнень.",
  ],
  hauler: [
    "[%s] Завантажився, курс на станцію.",
    "[%s] Тримаю конвой, розвантаження за графіком.",
  ],
  pirate: [
    "[%s] Бачу рух у секторі. Тримайтесь осторонь гейта.",
    "[%s] Не встрявайте, це не ваша здобич.",
  ],
  patrol: [
    "[%s] Патруль у системі, обстановка спокійна.",
    "[%s] Перевіряю гейт, далі за маршрутом.",
  ],
  trader: [
    "[%s] Беру партію на станції, ціни рухаються.",
    "[%s] Курс на станцію, вантаж за графіком.",
  ],
};
const ROLES = new Set(Object.keys(LINES));

function createChatter({ send, clock = () => Date.now(), cooldownMs = 120000, maxPerMinute = 4, observe = null } = {}) {
  if (typeof send !== "function" || typeof clock !== "function") {
    throw Error("invalid npc chatter options");
  }
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1000 || !Number.isSafeInteger(maxPerMinute) || maxPerMinute < 1) {
    throw Error("invalid npc chatter limits");
  }
  const perPilot = new Map();
  const perSystem = new Map();

  function speak({ systemID, residents = [], scene = null, sessions = [] } = {}) {
    const now = clock();
    const sys = Number(systemID);
    if (!Number.isSafeInteger(sys) || sys <= 0) return { sent: 0, status: "INVALID_SYSTEM" };
    const ready = new Set(sessions
      .filter(session => session && session._space && Number(session._space.systemID) === sys &&
        session._space.initialStateSent === true && session.socket?.destroyed !== true)
      .map(session => Number(session.characterID))
      .filter(id => Number.isSafeInteger(id) && id > 0));
    if (!ready.size) return { sent: 0, status: "NO_LOCAL_AUDIENCE" };

    const window = perSystem.get(sys) || { startedAt: now, count: 0 };
    if (now - window.startedAt >= 60000) { window.startedAt = now; window.count = 0; }
    if (window.count >= maxPerMinute) return { sent: 0, status: "RATE_LIMITED" };

    const candidate = residents.find(resident => {
      const pilotID = String(resident?.pilotID || "");
      const role = String(resident?.role || "");
      if (!pilotID || !ROLES.has(role)) return false;
      const entityID = Number(resident?.entityID);
      if (!Number.isSafeInteger(entityID) || entityID <= 0) return false;
      if (scene?.getEntityByID?.(entityID)?.kind !== "ship") return false;
      const last = perPilot.get(pilotID);
      return last === undefined || now - last >= cooldownMs;
    });
    if (!candidate) return { sent: 0, status: "NO_ELIGIBLE_NPC" };

    const texts = LINES[candidate.role];
    const name = String(candidate.name || candidate.pilotID);
    const text = texts[Math.floor(now / cooldownMs) % texts.length].replace("%s", name);
    let sent = 0;
    for (const session of sessions) {
      if (!ready.has(Number(session.characterID))) continue;
      try { send(session, text); sent++; } catch (error) { console.warn("[CoopNpcChatter]", error.message); }
    }
    if (!sent) return { sent: 0, status: "DELIVERY_FAILED" };
    perPilot.set(String(candidate.pilotID), now);
    window.count++;
    perSystem.set(sys, window);
    if (typeof observe === "function") {
      try { observe({ systemID: sys, pilotID: candidate.pilotID, role: candidate.role, entityID: Number(candidate.entityID), sent }); }
      catch (error) { console.warn("[CoopNpcChatter]", error.message); }
    }
    return { sent, status: "SPOKEN", pilotID: candidate.pilotID, role: candidate.role };
  }

  return { speak };
}

module.exports = { createChatter, LINES, ROLES };
