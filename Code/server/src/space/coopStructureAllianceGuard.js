// Co-op alliance authority guard — one reusable binder per native file.
//
// Stock EveJS lets any authenticated session mutate an alliance. Our co-op rule
// is that the caller must be an authoritative native member/executor/director;
// that decision logic lives in coopStructureAllianceAuthority.js and stays there.
// This module only adapts a call site to it: the native service injects its
// authority, its local readers and its own native error once, then calls
// enforce(action, session, args) wherever the mutation happens.
//
// Gated by EVEJS_COOP_STRUCTURE_ALLIANCE_GUARD, default OFF. With the flag off
// enforce() is a no-op, so retail behaviour is unchanged.
//
// It has no require() of its own on purpose: the same bytes are unit tested from
// integration/ (archived copy) and shipped in server/src/space (deployed copy),
// and both trees resolve relative paths differently.

function create({ admit, readers, deny } = {}) {
  if (typeof admit !== "function") throw new Error("coop alliance guard needs an admit() function");
  if (typeof readers !== "function") throw new Error("coop alliance guard needs a readers() function");
  if (typeof deny !== "function") throw new Error("coop alliance guard needs a deny() function");
  return {
    enforce(action, session, args) {
      if (process.env.EVEJS_COOP_STRUCTURE_ALLIANCE_GUARD !== "1") return undefined;
      const verdict = admit({ action, session, args, ...readers() });
      if (verdict && verdict.ok) return undefined;
      return deny(verdict || { ok: false, reason: "NO_VERDICT" });
    },
  };
}

module.exports = { create };
