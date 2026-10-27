"use strict";
// LW-04B: bridge original A-Life native evidence -> the EXISTING industry
// director. No scheduler, fake game session, wallet, BPO, inventory or market.
//
// The currently shipped native manufacturing bindings explicitly declare
// supportsLiveRuntime:false. Production MUST block until verified live
// GameStore/ItemStore/Rust transaction bindings are supplied and reviewed.
const SAFE_STAGES=new Set(["MANUFACTURE","COMPLETE_JOB","LIST_OUTPUT"]);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const stamp=n=>Number.isSafeInteger(n)&&n>=0;
const validPilot=x=>/^coop-pilot-[0-9]{3,}$/.test(String(x||""));
function createRuntimeAlifeManufacturing({
 env=process.env,clock=()=>Date.now(),resolveDirector=null,
 getNativeEntity,getController,sceneForSystem,getStation,onResult=()=>{},
 maxIntents=4,maxAgeMs=30000
}={}){
 if(typeof clock!=="function"||typeof onResult!=="function"||
    [getNativeEntity,getController,sceneForSystem,getStation].some(x=>typeof x!=="function")||
    !Number.isSafeInteger(maxIntents)||maxIntents<1||maxIntents>12||
    !Number.isSafeInteger(maxAgeMs)||maxAgeMs<1000||maxAgeMs>30000)
  throw Error("ALIFE_MANUFACTURING_RUNTIME_NATIVE_DEPENDENCIES_REQUIRED");
 let active=false,context=null,dispatch=null,last=null;
 const enabled=()=>env.EVEJS_COOP_ALIFE==="1"&&
  env.EVEJS_COOP_ALIFE_ECONOMY==="1"&&
  env.EVEJS_COOP_ALIFE_ECONOMY_AUTHORITY==="1"&&
  env.EVEJS_COOP_ALIFE_ECONOMY_ACT==="1"&&
  env.EVEJS_COOP_NATIVE_NPC_ECONOMY==="1"&&
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
 const blocked=reason=>({status:"BLOCKED",reason,nativeMutation:false});
 // Never trust the original sensor alone across await boundaries. Re-read
 // physical hull, controller, station, native NPC ownership AND position.
 function actor(entityID){
  const ctx=context,now=clock();
  if(!ctx||!positive(entityID)||!stamp(now)||
     now<ctx.snapshot.observedAt||now-ctx.snapshot.observedAt>maxAgeMs)return null;
  const {snapshot,registry}=ctx;
  const links=Object.values(registry.snapshot()?.links||{}).filter(x=>
   Number(x?.entityID)===entityID&&validPilot(x.pilotID));
  if(links.length!==1)return null;
  const link=links[0],matches=snapshot.pilots.filter(p=>
   p.entityID===entityID&&p.pilotID===link.pilotID);
  if(matches.length!==1)return null;
  const p=matches[0],systemID=snapshot.systemID;
  if(!positive(p.ownerID)||!positive(p.stationID)||
     p.systemID!==systemID||Number(link.systemID)!==systemID||
     p.nativeVerified!==true||p.role!=="trader"||p.atStation!==true||
     p.playerControlled!==false||p.inWarp!==false||
     p.underAttack!==false||p.activeNativeOrder!==false||
     p.economy?.authoritativeNative!==true||
     p.economy?.ownerID!==p.ownerID||
     p.economy?.stationID!==p.stationID||
     p.economy?.systemID!==systemID)return null;
  const scene=sceneForSystem(systemID);
  // A missing live scene MUST NOT materialize a new actor to pass the audit.
  if(!scene||Number(scene.systemID)!==systemID)return null;
  const native=getNativeEntity(entityID),ship=scene.getEntityByID?.(entityID),
   control=getController(entityID),station=getStation(p.stationID);
  if(Number(native?.entityID)!==entityID||
     Number(native?.systemID)!==systemID||
     Number(native?.ownerID)!==p.ownerID||
     ship?.nativeNpc!==true||ship.kind!=="ship"||
     Number(ship.itemID)!==entityID||ship.session?.characterID||
     Number(control?.entityID)!==entityID||
     Number(control?.systemID)!==systemID||
     Number(station?.stationID)!==p.stationID||
     Number(station?.solarSystemID)!==systemID)return null;
  const physical=(scene.staticEntities||[]).filter(x=>
   x?.kind==="station"&&Number(x.itemID)===p.stationID);
  if(physical.length!==1)return null;
  const vectors=[physical[0]?.position,ship.position];
  if(!vectors.every(v=>v&&["x","y","z"].every(k=>Number.isFinite(v[k]))))return null;
  const distance=Math.hypot(...["x","y","z"].map(k=>vectors[0][k]-vectors[1][k]));
  if(distance>10000+Math.max(0,Number(ship.radius)||0)+
     Math.max(0,Number(physical[0].radius)||0))return null;
  const occupied=[...(scene.sessions?.values?.()||[])].some(s=>
   Number(s?._space?.shipID)===entityID);
  const inWarp=Boolean(ship.pendingWarp||ship.warpState||
   String(ship.mode||"").toUpperCase().includes("WARP"));
  const underAttack=Number(control.currentTargetID)>0||
   control.manualOrder?.type==="attack";
  const activeNativeOrder=Boolean(control.manualOrder&&
   control.manualOrder.type!=="idle");
  return {entityID,pilotID:p.pilotID,systemID,stationID:p.stationID,
   ownerID:p.ownerID,nativeVerified:!occupied&&!inWarp&&!underAttack&&!activeNativeOrder,
   isNpc:true,role:"trader",playerControlled:occupied,
   underAttack,inWarp,activeNativeOrder};
 }
 function products(ownerID,stationID,systemID){
  const snap=context?.snapshot;
  if(!snap||snap.systemID!==systemID)return [];
  const rows=snap.pilots.filter(p=>p.ownerID===ownerID&&p.stationID===stationID&&
   p.role==="trader"&&p.economy?.authoritativeNative===true);
  if(!rows.length)return [];
  // Product list is a native GameStore/SDE/Rust read-side witness, never the
  // strategic virtual economy or a client-provided manufacturing allowlist.
  const e=rows[0].economy;
  if(e.ownerID!==ownerID||e.stationID!==stationID||e.systemID!==systemID||
     !positive(e.productTypeID)||!Array.isArray(e.products)||
     e.products.length<1||e.products.length>8||
     rows.some(p=>JSON.stringify(p.economy)!==JSON.stringify(e)))return [];
  const types=e.products.map(p=>p.typeID);
  if(types.some(x=>!positive(x))||new Set(types).size!==types.length||
     !types.includes(e.productTypeID))return [];
  return types.sort((a,b)=>a-b);
 }
 function resolveNativeDirector(ownerID,stationID){
  if(typeof resolveDirector!=="function")return null;
  const d=resolveDirector(ownerID,stationID);
  // Live source ACT can only accept a director with a pre-attached
  // original receipt audit. No live resolver is supplied by production yet.
  return Promise.resolve(d).then(x=>x?.supportsLiveRuntime===true&&
   x?.mode==="NATIVE_AUTHORITIES_ONLY"&&typeof x.tick==="function"&&
   typeof x.auditBeforeTick==="function"?x:null);
 }
 function admitted(snapshot,decision,registry){
  if(snapshot?.authoritativeNative!==true||
     decision?.status!=="OBSERVED"||decision.systemID!==snapshot.systemID||
     decision.observedAt!==snapshot.observedAt||
     !Array.isArray(snapshot.pilots)||!Array.isArray(decision.intents)||
     !positive(snapshot.systemID)||!stamp(snapshot.observedAt)||
     snapshot.pilots.length>256||decision.intents.length>32||
     !registry||typeof registry.snapshot!=="function")
   return blocked("ALIFE_MANUFACTURING_SOURCE_UNVERIFIED");
  const now=clock();
  if(!stamp(now)||now<snapshot.observedAt||now-snapshot.observedAt>maxAgeMs)
   return blocked("ALIFE_MANUFACTURING_SOURCE_STALE");
  return null;
 }
 async function tick({snapshot,decision,registry}={}){
  if(!enabled())return {status:"DISABLED",nativeMutation:false};
  if(env.EVEJS_COOP_NATIVE_NPC_ECONOMY_SCHEDULER==="1"||
     env.EVEJS_COOP_NATIVE_NPC_MARKET==="1")
   return blocked("PARALLEL_NATIVE_ECONOMY_WRITER_ENABLED");
  if(active)return blocked("ALIFE_MANUFACTURING_TICK_BUSY");
  const deny=admitted(snapshot,decision,registry);
  if(deny)return deny;
  // The manual/offline director currently shipped in EveJS does NOT provide
  // live-safe bindings. Nothing is dispatched even with env flags set.
  if(typeof resolveDirector!=="function")
   return blocked("LIVE_NATIVE_MANUFACTURING_BINDINGS_NOT_AVAILABLE");
  active=true;context={snapshot,registry};
  const selected=[],seen=new Set();
  try{
   if(!dispatch){
    const {createAlifeNativeAct}=require("./coopAlifeNativeEconomyAct"+
     (typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
    dispatch=createAlifeNativeAct({env,resolveActor:id=>actor(id),
     resolveProductTypes:products,resolveDirector:resolveNativeDirector}).dispatch;
   }
   for(const intent of decision.intents){
    if(!SAFE_STAGES.has(intent?.stage))continue;
    const matching=snapshot.pilots.filter(p=>p.entityID===intent.entityID&&
     p.pilotID===intent.pilotID&&p.stationID===intent.stationID&&
     p.systemID===intent.systemID&&p.role==="trader");
    if(matching.length!==1||intent.provenance!=="NATIVE_READ_ONLY"||
       intent.nativeMutation!==false||
       intent.intentID!==snapshot.systemID+":"+snapshot.observedAt+":"+
        intent.entityID+":"+intent.stage)continue;
    const pilot=matching[0],key=pilot.ownerID+":"+intent.stationID;
    if(seen.has(key))continue;
    seen.add(key);
    selected.push(intent);
    if(selected.length>=maxIntents)break;
   }
   if(!selected.length)return {status:"NO_NATIVE_MANUFACTURING_INTENTS",
    count:0,nativeMutation:false};
   const results=[];
   for(const intent of selected){
    const response=await dispatch(intent);
    results.push({intentID:intent.intentID,stage:intent.stage,status:response.status,
     reason:response.reason||null,directorStatus:response.directorStatus||null,
     operationID:response.operationID||null,
     nativeMutation:response.nativeMutation===true,
     proof:response.proof||null});
   }
   last={status:"ADMISSION_EVALUATED",
    count:results.length,results};
   try{onResult(last)}catch(_ignored){}
   return last;
  }finally{context=null;active=false}
 }
 return Object.freeze({tick,snapshot:()=>({
  status:active?"BUSY":"READY",last:last?JSON.parse(JSON.stringify(last)):null
 }),mode:"NATIVE_EVIDENCE_MANUFACTURING_ADMISSION",
  supportsNativeMutation:typeof resolveDirector==="function"});
}
module.exports={createRuntimeAlifeManufacturing};
