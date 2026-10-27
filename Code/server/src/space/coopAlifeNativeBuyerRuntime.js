"use strict";
// COOP-049: one opt-in BUY_SUPPLIES ACT within existing 30-second A-Life
// snapshot. No extra timer, virtual inventory, account bootstrap or session.
const {dispatchAlifeNativeBuyer}=require("./coopAlifeNativeBuyerDispatch"+(typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
const pos=x=>Number.isSafeInteger(x)&&x>0;
function createRuntimeAlifeBuyer({file,deps=null,createBinding=null,
 createAdminControl=null,env=process.env,clock=()=>Date.now()}={}){
 if(typeof file!=="string"||!file.startsWith("/")&&
    !/^[A-Za-z]:[\\/]/.test(file)||typeof clock!=="function")
  throw Error("ALIFE_NATIVE_BUYER_RUNTIME_CONFIG_INVALID");
 let current=null,recent=null,instance=null,busy=false;
 let nativeBinding=null,adminControl=null;
 const loadDeps=()=>deps||{
  sceneForSystem:id=>require("./runtime").ensureScene(id,{refreshStargates:false}),
  npcStore:require("./npc/nativeNpcStore"),
  controllers:require("./npc/npcRegistry"),
  worldData:require("./worldData"),
  gameStore:require("../gameStore"),
  itemStore:require("../services/inventory/itemStore"),
  marketClient:require("../services/market/marketDaemonClient").marketDaemonClient
 };
 function actor(entityID){
  // Operator recovery runs between A-Life ticks. Re-check EVERY native
  // ship/controller/station against a bounded recent A-Life witness; never
  // accept an arbitrarily old snapshot or player-supplied actor identity.
  const ctx=current||(recent&&clock()>=recent.at&&
   clock()-recent.at<=30000?recent:null);
  if(!ctx||!pos(entityID)||!Number.isSafeInteger(ctx.snapshot?.observedAt)||
     clock()<ctx.snapshot.observedAt||
     clock()-ctx.snapshot.observedAt>30000)return null;
  const links=Object.values(ctx.registry?.snapshot()?.links||{}).filter(l=>
   Number(l?.entityID)===entityID&&
   /^coop-pilot-[0-9]{3,}$/.test(String(l.pilotID||"")));
  if(links.length!==1)return null;
  const link=links[0],p=ctx.snapshot.pilots.find(x=>x.entityID===entityID);
  if(!p||p.pilotID!==link.pilotID||p.role!=="trader"||
     p.nativeVerified!==true||!pos(p.ownerID)||!pos(p.stationID)||
     p.atStation!==true||p.playerControlled!==false||p.inWarp!==false||
     p.underAttack!==false||p.activeNativeOrder!==false||
     p.economy?.ownerID!==p.ownerID||
     p.economy?.stationID!==p.stationID||
     p.economy?.systemID!==p.systemID||
     p.economy?.authoritativeNative!==true)return null;
  const deps=loadDeps(),systemID=Number(link.systemID);
  if(systemID!==p.systemID||systemID!==ctx.snapshot.systemID)return null;
  const native=deps.npcStore.getNativeEntity(entityID),
   scene=deps.sceneForSystem(systemID),
   ship=scene?.getEntityByID?.(entityID),
   controller=deps.controllers.getControllerByEntityID(entityID),
   station=deps.worldData.getStationByID(p.stationID);
  if(native?.entityID!==entityID||native?.systemID!==systemID||
     native?.ownerID!==p.ownerID||
     ship?.kind!=="ship"||ship.nativeNpc!==true||
     Number(ship.itemID)!==entityID||ship.session?.characterID||
     controller?.entityID!==entityID||controller?.systemID!==systemID||
     station?.stationID!==p.stationID||station?.solarSystemID!==systemID)return null;
  const physical=scene.staticEntities?.find(x=>x?.kind==="station"&&
   Number(x.itemID)===p.stationID);
  if(!physical||![physical.position,ship.position].every(v=>v&&
     ["x","y","z"].every(k=>Number.isFinite(v[k]))))return null;
  const distance=Math.hypot(
   physical.position.x-ship.position.x,physical.position.y-ship.position.y,
   physical.position.z-ship.position.z);
  if(distance>10000+Math.max(0,Number(ship.radius)||0)+
    Math.max(0,Number(physical.radius)||0))return null;
  const occupied=[...(scene.sessions?.values?.()||[])].some(s=>
   Number(s?._space?.shipID)===entityID);
  const inWarp=Boolean(ship.pendingWarp||ship.warpState||
   String(ship.mode||"").toUpperCase().includes("WARP"));
  const underAttack=Number(controller.currentTargetID)>0||
   controller.manualOrder?.type==="attack";
  const activeNativeOrder=Boolean(controller.manualOrder&&
   controller.manualOrder.type!=="idle");
  return {nativeVerified:!occupied&&!inWarp&&!underAttack&&!activeNativeOrder,
   isNpc:true,role:"trader",
   entityID,pilotID:p.pilotID,corporationID:p.ownerID,
   stationID:p.stationID,systemID,playerControlled:occupied,
   underAttack,inWarp,activeNativeOrder};
 }
 function needs(ownerID,stationID,typeID){
  const ctx=current;if(!ctx)return null;
  const rows=ctx.snapshot.pilots.filter(p=>p.ownerID===ownerID&&
   p.stationID===stationID&&p.economy?.authoritativeNative===true);
  if(!rows.length)return null;
  const observed=rows[0].economy;
  if(observed.ownerID!==ownerID||observed.stationID!==stationID||
     observed.systemID!==ctx.snapshot.systemID||
     !Array.isArray(observed.materialNeeds)||rows.some(p=>
       p.economy?.ownerID!==ownerID||
       p.economy?.observedAt!==observed.observedAt||
       JSON.stringify(p.economy.materialNeeds)!==
         JSON.stringify(observed.materialNeeds)))return null;
  const found=observed.materialNeeds.filter(m=>m.typeID===typeID);
  if(found.length!==1)return null;
  return {...found[0],ownerID,stationID,authoritativeNative:true,
   observedAt:observed.observedAt};
 }
 const cap=(name,defaultVal,maximum)=>{
  const n=Number(env[name]??defaultVal);
  return Number.isSafeInteger(n)&&n>=0&&n<=maximum?n:defaultVal;
 };
 function ensureBinding(){
  if(instance)return instance;
  const d=loadDeps();
  const factory=createBinding||require("./coopNpcBuyerNativeBindings")
   .createNativeNpcBuyerBindings;
  // This is a separate loopback-only operator capability, never a player
  // chat command or public game protocol. All gates are OFF by default.
  if(env.EVEJS_COOP_NPC_BUY_ADMIN_LOCAL==="1"){
   const factory=createAdminControl||require("./coopNpcBuyerAdminControl"+
     (typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"))
     .createLocalNpcBuyerRecoveryControl;
   const port=Number(env.EVEJS_COOP_NPC_BUY_ADMIN_PORT||17171);
   adminControl=factory({getBinding:()=>nativeBinding,
    secretFile:env.EVEJS_COOP_NPC_BUY_ADMIN_SECRET_FILE,
    auditLogFile:env.EVEJS_COOP_NPC_BUY_ADMIN_AUDIT_FILE,
    port,env,clock});
  }
  const binding=factory({file,clock,env,
   gameStore:d.gameStore,itemStore:d.itemStore,marketClient:d.marketClient,
   getStation:id=>d.worldData.getStationByID(id),
   resolveActor:id=>actor(id),readNeeds:(owner,station,type)=>needs(owner,station,type),
   authorizeRecoveryOperator:adminControl?
    adminControl.authorizeRecoveryOperator:null});
  nativeBinding=binding;
  if(binding?.mode!=="ALIFE_NATIVE_RUST_GAMESTORE_BUYER"||
     typeof binding.tick!=="function")
   throw Error("ALIFE_NATIVE_BUYER_BINDING_NOT_NATIVE");
  if(adminControl){
   // Listener failures do not make the admin endpoint available by accident.
   // The trusted authenticator has no grants without a successfully signed
   // HTTP request, so any recovery attempt remains denied.
   void Promise.resolve().then(()=>adminControl.start()).catch(error=>
    console.warn("[CoopNpcBuyerAdmin] local operator endpoint unavailable:",error.message));
  }
  instance=Object.freeze({mode:binding.mode,tick:binding.tick,
   maxUnitPriceCents:cap("EVEJS_COOP_ALIFE_BUY_MAX_PRICE_CENTS",10000,100000000),
   maxSpendCents:cap("EVEJS_COOP_ALIFE_BUY_MAX_SPEND_CENTS",100000,100000000),
   minReserveCents:cap("EVEJS_COOP_ALIFE_BUY_RESERVE_CENTS",10000,100000000)});
  return instance;
 }
 async function tick({snapshot,decision,registry,world}={}){
  if(env.EVEJS_COOP_ALIFE_NATIVE_BUYER!=="1")
   return {status:"DISABLED",purchases:[]};
  if(busy)return {status:"BLOCKED",reason:"ALIFE_NATIVE_BUYER_TICK_BUSY",purchases:[]};
  if(!registry?.snapshot||!world?.snapshot||!snapshot||!decision)
   return {status:"BLOCKED",reason:"ALIFE_NATIVE_BUYER_NO_WORLD",purchases:[]};
  busy=true;current={snapshot,registry,world};
  recent={snapshot,registry,world,at:clock()};
  try{
   // Initialize the operator-only endpoint even when no new order is placed.
   // A PREPARED journal must be auditable after a crash.
   if(env.EVEJS_COOP_NPC_BUY_ADMIN_LOCAL==="1")ensureBinding();
   return await dispatchAlifeNativeBuyer({snapshot,decision,now:clock(),env,
    resolveBuyer:()=>ensureBinding()});
  }
  finally{current=null;busy=false}
 }
 return Object.freeze({tick,mode:"ONE_ALIFE_TICK_NATIVE_CORP_BUYER",
  supportsLiveRuntime:false});
}
module.exports={createRuntimeAlifeBuyer};
