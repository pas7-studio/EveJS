"use strict";
// Apply a bounded time-only adjustment to native EveJS manufacturing jobs.
// Blueprint materials, skill requirements, taxes, job payment and item
// delivery remain wholly authoritative in native industryRuntimeState.
function adjust(seconds,activityID,manufacturingID,raw=process.env.EVEJS_COOP_MANUFACTURING_TIME_MULTIPLIER){
 const base=Number(seconds),activity=Number(activityID),manufacturing=Number(manufacturingID);
 if(!Number.isFinite(base)||base<0||!Number.isSafeInteger(activity)||
  !Number.isSafeInteger(manufacturing)||activity!==manufacturing)return seconds;
 if(raw==null||raw==="")return base;
 const factor=Number(raw);
 // Config mistakes should not silently create free instant ship production.
 if(!Number.isFinite(factor)||factor<0.2||factor>1)
  throw Error("INVALID_COOP_MANUFACTURING_TIME_MULTIPLIER");
 return base*factor;
}
module.exports={adjust};
