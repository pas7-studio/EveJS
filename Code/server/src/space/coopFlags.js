"use strict";
// One reader for co-op feature flags.
//
// Why: 244 distinct EVEJS_COOP_* keys were read from 149 modules, each with its
// own inline `process.env.X === "1"`, so nobody could answer "which gates are
// actually on in the running world?" without grepping the whole tree. The
// capacitor incident and the durable-cargo confusion both cost time for exactly
// that reason.
//
// Rules:
//  - default is always OFF and the ONLY enabling value is the string "1".
//    "true", "yes" or "on" must never enable a native mutation path just
//    because someone exported it by intuition;
//  - values are read at call time, never cached at load: tests and the
//    operator set flags after the module graph is built;
//  - this module never invents a default that changes gameplay, and it never
//    reads a flag that the caller did not name.
const on=(name)=>process.env[String(name)]==="1";
const off=(name)=>!on(name);
function number(name,fallback){
 const raw=process.env[String(name)];
 if(raw===undefined||raw==="")return fallback;
 const parsed=Number(raw);
 return Number.isFinite(parsed)&&parsed>0?parsed:fallback;
}
function snapshot(names){
 const out={};
 for(const name of names||[])out[name]=on(name);
 return out;
}
module.exports={on,off,number,snapshot};
