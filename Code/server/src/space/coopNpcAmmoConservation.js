"use strict";
// Source gate shared by pinned EveJS missile and turret/local-cycle reloads.
// The native reload engines already persist and consume genuine cargo stacks;
// they also offer a *virtual* ammo reserve when those stacks run out. This
// switch disables ONLY that fallback. The existing real-cargo path is kept.
// Enabled only by an explicit opt-in; all current gameplay defaults untouched.
function isStrict(entity,env=process.env){
 return env?.EVEJS_COOP_NPC_STRICT_AMMO==="1"&&
  entity?.kind==="ship"&&entity.nativeNpc===true;
}
module.exports={isStrict};
