"use strict";
// COOP-049: reuse exactly the existing A-Life BUY_SUPPLIES intent.
// The A-Life decision is only a gate; final stock/wallet/Rust proof is
// re-read by the COOP-048 native buyer coordinator before any paid write.
const pos=n=>Number.isSafeInteger(n)&&n>0;
const count=n=>Number.isSafeInteger(n)&&n>=0;
async function dispatchAlifeNativeBuyer({snapshot,decision,resolveBuyer,
 maxPurchases=1,now=Date.now(),env=process.env}={}){
 const denied=reason=>({status:"BLOCKED",reason,purchases:[]});
 if(env.EVEJS_COOP_ALIFE!=="1"||env.EVEJS_COOP_ALIFE_ECONOMY!=="1"||
    env.EVEJS_COOP_ALIFE_ECONOMY_AUTHORITY!=="1"||
    env.EVEJS_COOP_ALIFE_ECONOMY_ACT!=="1"||
    env.EVEJS_COOP_ALIFE_NATIVE_BUYER!=="1"||
    env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1"||
    env.EVEJS_COOP_NPC_BUY_PLAYER_ASK!=="1"||
    env.EVEJS_COOP_RUST_NPC_CORP_BUY_PLAYER!=="1")
  return {status:"DISABLED",purchases:[]};
 if(typeof resolveBuyer!=="function"||!pos(maxPurchases)||maxPurchases>2||
    !count(now)||snapshot?.authoritativeNative!==true||
    decision?.status!=="OBSERVED"||!Array.isArray(decision.intents)||
    !Array.isArray(snapshot.pilots)||!Array.isArray(snapshot.stations)||
    !pos(snapshot.systemID)||snapshot.systemID!==decision.systemID||
    !count(snapshot.observedAt)||now<snapshot.observedAt||
    now-snapshot.observedAt>30000||decision.observedAt!==snapshot.observedAt)
  return denied("ALIFE_BUY_INTENT_SNAPSHOT_MISMATCH");
 const pilots=new Map(snapshot.pilots.map(x=>[x.entityID,x]));
 const stationIDs=new Set(snapshot.stations.filter(x=>x.nativeVerified===true).map(x=>x.stationID));
 const outcomes=[],owners=new Set();
 for(const intent of decision.intents){
  if(intent.stage!=="BUY_SUPPLIES")continue;
  const p=pilots.get(intent.entityID),economy=p?.economy;
  if(!p||p.pilotID!==intent.pilotID||p.role!=="trader"||
     p.nativeVerified!==true||p.playerControlled!==false||
     p.inWarp!==false||p.underAttack!==false||
     p.activeNativeOrder!==false||p.atStation!==true||
     !pos(p.ownerID)||!stationIDs.has(intent.stationID)||
     intent.stationID!==p.stationID||
     intent.systemID!==snapshot.systemID||
     intent.provenance!=="NATIVE_READ_ONLY"||intent.nativeMutation!==false||
     intent.resource!=="station:"+p.stationID+":supplies"||
     intent.intentID!==snapshot.systemID+":"+snapshot.observedAt+
       ":"+p.entityID+":BUY_SUPPLIES"||
     economy?.authoritativeNative!==true||economy.ownerID!==p.ownerID||
     economy.stationID!==p.stationID||economy.systemID!==p.systemID||
     !Array.isArray(economy.materialNeeds))
   return denied("ALIFE_BUY_INTENT_OR_OWNER_UNATTESTED");
  const materials=economy.materialNeeds;
  if(materials.length>64||materials.some(m=>!pos(m?.typeID)||
     !pos(m.required)||!count(m.available)||!pos(m.shortage)||
     m.required>50000||m.shortage!==Math.max(0,m.required-m.available)))
   return denied("ALIFE_BUY_SDE_MATERIAL_NEEDS_INVALID");
  const choice=[...materials].sort((a,b)=>b.shortage-a.shortage||
    a.typeID-b.typeID)[0];
  if(!choice)return denied("ALIFE_BUY_NO_CONCRETE_MATERIAL");
  const key=p.ownerID+":"+p.stationID;
  if(owners.has(key))continue;
  owners.add(key);
  if(outcomes.length>=maxPurchases)break;
  const buyer=await resolveBuyer(p,choice,decision);
  if(!buyer||typeof buyer.tick!=="function"||
     buyer.mode!=="ALIFE_NATIVE_RUST_GAMESTORE_BUYER")
   return denied("ALIFE_BUY_NATIVE_BUYER_UNAVAILABLE");
  const result=await buyer.tick({actorID:p.entityID,buyerCorpID:p.ownerID,
   stationID:p.stationID,typeID:choice.typeID,
   maxUnitPriceCents:buyer.maxUnitPriceCents,
   maxSpendCents:buyer.maxSpendCents,
   minReserveCents:buyer.minReserveCents});
  if(!result||typeof result.status!=="string")
   return denied("ALIFE_BUY_NATIVE_SETTLEMENT_UNVERIFIED");
  outcomes.push({pilotID:p.pilotID,ownerID:p.ownerID,stationID:p.stationID,
   typeID:choice.typeID,status:result.status,
   reason:result.reason||null,fillID:result.fillID||null,
   itemID:result.itemID||null});
 }
 return {status:"ALIFE_BUY_DISPATCHED",purchases:outcomes,
  nativeMutation:outcomes.some(x=>x.status==="NPC_PLAYER_PURCHASE_SETTLED")};
}
module.exports={dispatchAlifeNativeBuyer};
