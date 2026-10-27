"use strict";
// Prioritize encounter-capable native ships under small per-system caps.
// Stock EveJS miner/hauler fleet hulls are reused separately.
const ranks=Object.freeze({pirate:0,patrol:1,trader:2,miner:3,hauler:4});
function orderForMaterialization(pilots){
 return [...(Array.isArray(pilots)?pilots:[])].sort((a,b)=>
  (ranks[a?.role]??5)-(ranks[b?.role]??5)||
  String(a?.id||"").localeCompare(String(b?.id||"")));
}
module.exports={orderForMaterialization};
