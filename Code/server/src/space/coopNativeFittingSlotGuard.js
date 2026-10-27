"use strict";
// Correct native EveJS slot-count validation without adding a fitting store.
// The installer is owned by Chat 01. This pure module is invoked only by an
// explicitly enabled, default-OFF one-call hook inside liveFittingState.js.
const FAMILY_FLAGS=Object.freeze({
 low:[11,12,13,14,15,16,17,18],
 med:[19,20,21,22,23,24,25,26],
 high:[27,28,29,30,31,32,33,34],
 rig:[92,93,94,95,96,97,98,99],
 subsystem:[125,126,127,128,129,130,131,132],
 service:[164,165,166,167,168,169,170,171]
});
const integer=v=>typeof v==="number"&&Number.isSafeInteger(v);
function getSlotFlagsForFamily({family,shipTypeID,baseFlags,slotCounts}={}){
 const expected=FAMILY_FLAGS[family];
 // Never manufacture flags from untrusted or incomplete Dogma metadata.
 if(!expected||!Array.isArray(baseFlags)||
  baseFlags.length!==expected.length||
  baseFlags.some((v,i)=>v!==expected[i]))return [];
 // Native callers also ask for a generic flag family with no hull. Preserve
 // that capability; the stricter limit applies only to a specific ship.
 if(shipTypeID===null||shipTypeID===undefined)return [...expected];
 if(!integer(shipTypeID)||shipTypeID<=0||!slotCounts||
  typeof slotCounts!=="object")return [];
 const limit=slotCounts[family];
 if(!integer(limit)||limit<0||limit>expected.length)return [];
 return expected.slice(0,limit);
}
module.exports={getSlotFlagsForFamily};
