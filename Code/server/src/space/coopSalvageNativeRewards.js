"use strict";
// Stage J: true NPC corporation-funded RESCUE escrow, two native player credits
// only after all uniquely identified original stock is physically warehoused.
// Independent escrow namespace; never reuses the original Escort reservation.
const crypto=require("node:crypto");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const cents=x=>Number.isFinite(x)&&Math.abs(Math.round(x*100)-x*100)<0.00001&&
 Number.isSafeInteger(Math.round(x*100))?Math.round(x*100):null;
const money=n=>n/100;
const deny=status=>({status});
const SEP="\u001f",CORP_ESCROWS="coopSalvageEscrows",CORP_ACCOUNT="1000";
const marker=(key,cargoID,wreckItemID)=>
 "coop-salvage:v1:"+key+":"+cargoID+":"+wreckItemID;
const copy=x=>JSON.parse(JSON.stringify(x));
function createSalvageNativeRewards({atomic,isNpcCorporation,readWitness,
 readManifest,readAcceptedDuo,clock=()=>Date.now(),
 ratePerUnitISK=5,maxRewardISK=1000000,
 refundAfterMs=3600000}={}){
 if(typeof atomic?.transact!=="function"||
  [isNpcCorporation,readWitness,readManifest,readAcceptedDuo,clock]
  .some(x=>typeof x!=="function")||
  !pos(ratePerUnitISK)||!pos(maxRewardISK)||maxRewardISK>1000000000||
  !Number.isSafeInteger(refundAfterMs)||refundAfterMs<60000)
  throw Error("SALVAGE_NATIVE_WALLET_AUTHORITIES_REQUIRED");
 function quote(manifestKey){
  if(!/^\d+-\d+-\d+$/.test(String(manifestKey)))return deny("SALVAGE_QUOTE_INVALID_KEY");
  let witness,manifest,accept;try{
   witness=readWitness(manifestKey);manifest=readManifest(manifestKey);
   accept=readAcceptedDuo(manifestKey);
  }catch{return deny("SALVAGE_QUOTE_SOURCE_UNAVAILABLE")}
  const r=witness?.record,m=manifest?.record;
  if(witness?.status!=="READY"||r?.manifestKey!==manifestKey||
   manifest?.status!=="READY"||m?.key!==manifestKey||
   r.stationID!==m.stationID||r.corporationID!==m.corporationID||
   !isNpcCorporation(r.corporationID)||!Array.isArray(r.rows)||
   !r.rows.length||r.rows.length>1000)
   return deny("SALVAGE_QUOTE_ORIGINAL_STOCK_UNVERIFIED");
  const qty=r.rows.reduce((n,x)=>n+x.quantity,0);
  if(!Number.isSafeInteger(qty)||!pos(qty))return deny("SALVAGE_QUOTE_QUANTITY_OVERFLOW");
  const reward=Math.min(maxRewardISK,Math.floor(qty*ratePerUnitISK/2)*2);
  if(!pos(reward)||!Number.isSafeInteger(reward))return deny("SALVAGE_QUOTE_NOT_PAYABLE");
  if(accept?.status!=="VERIFIED_DUO_SALVAGE_ACCEPT"||
   accept.manifestKey!==manifestKey||
   !Array.isArray(accept.characters)||accept.characters.length!==2||
   !accept.characters.every(pos)||
   accept.characters[0]>=accept.characters[1])
   return deny("SALVAGE_EXPLICIT_DUO_ACCEPT_REQUIRED");
  return {status:"SALVAGE_NATIVE_QUOTE_READY",contractID:"salvage-"+manifestKey,
   manifestKey,stationID:r.stationID,corporationID:r.corporationID,
   wreckID:r.wreckID,characters:accept.characters.slice(),
   amountISK:reward,quantity:qty,rows:copy(r.rows)};
 }
 function ready(){
  return process.env.EVEJS_COOP_SALVAGE_REWARDS==="1"&&
   process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
   atomic.mode==="SERVER_INTERNAL_FLAGGED"&&
   atomic.isPoisoned?.()===false;
 }
 function row(tx,key){return tx.get("corporationRuntime",key)}
 function ledger(tx){const r=row(tx,CORP_ESCROWS);
  if(r===null)return {version:1,byContract:{}};
  if(r?.version!==1||!r.byContract||
   typeof r.byContract!=="object"||Array.isArray(r.byContract)||
   Object.keys(r.byContract).length>512)throw Error("SALVAGE_ESCROW_LEDGER_INVALID");
  return r;
 }
 function corp(tx,c){const key="corporations"+SEP+c.corporationID,rec=row(tx,key);
  const division=rec?.wallet?.divisions?.[CORP_ACCOUNT];
  if(!rec||!division||division.key!==1000||
   cents(division.balance)===null||
   !Array.isArray(division.journal)||!Array.isArray(division.transactions))
   throw Error("SALVAGE_CORP_WALLET_UNAVAILABLE");
  return {key,rec,division,balance:cents(division.balance)};
 }
 function chars(tx,c){return c.characters.map(id=>{
  const r=tx.get("characters",String(id));
  if(r?.characterID!==id||cents(r.balance)===null||
   !Array.isArray(r.walletJournal))
   throw Error("SALVAGE_PLAYER_WALLET_UNAVAILABLE");
  return r;
 })}
 function transactionID(c,stage,i=0){
  return Number.parseInt(crypto.createHash("sha256")
   .update(c.contractID+":"+stage+":"+i).digest("hex").slice(0,12),16);
 }
 function entry(c,stage,amountCents,balanceCents,now,ownerID2=0,i=0){
  const id=transactionID(c,stage,i);
  return {transactionID:id,referenceID:id,
   transactionDate:String(116444736000000000n+BigInt(now)*10000n),
   entryTypeID:10,ownerID1:c.corporationID,ownerID2,
   accountKey:1000,amount:money(amountCents),balance:money(balanceCents),
   currency:1,sortValue:1,
   description:"Native salvage "+stage+" "+c.contractID,
   salvageContractID:c.contractID};
 }
 function reserve(manifestKey){
  if(!ready())return deny("DISABLED");
  const c=quote(manifestKey);
  if(c.status!=="SALVAGE_NATIVE_QUOTE_READY")return c;
  try{return atomic.transact(["corporationRuntime","characters","npcWreckItems"],tx=>{
   const l=ledger(tx);
   if(l.byContract[c.contractID]){
    const saved=l.byContract[c.contractID];
    if(saved.amountISK!==c.amountISK||
     saved.corporationID!==c.corporationID||
     JSON.stringify(saved.characters)!==JSON.stringify(c.characters))
     throw Error("SALVAGE_ESCROW_IDENTITY_CONFLICT");
    return {status:saved.status==="SETTLED"?"SALVAGE_ALREADY_PAID":
     saved.status==="REFUNDED"?"SALVAGE_ALREADY_REFUNDED":"SALVAGE_ALREADY_RESERVED",
     contractID:c.contractID};
   }
   if(Object.keys(l.byContract).length>=512)
    throw Error("SALVAGE_ESCROW_CAP");
   // The quote was read before the transaction. A native NPC rival
   // may have acquired a wreck item in that interval. The original
   // wreck rows, duplicate provenance and rival receipts must be checked
   // INSIDE the same SQLite write transaction as the corporate ISK debit.
   const wrecks=tx.get("npcWreckItems","items");
   const playerMoves=tx.get("corporationRuntime","coopSalvageMoves");
   const rivals=tx.get("corporationRuntime","coopSalvageRivalMoves");
   if(!wrecks||typeof wrecks!=="object"||Array.isArray(wrecks)||
    (playerMoves&&(playerMoves.version!==1||!playerMoves.moves))||
    (rivals&&(rivals.version!==1||!rivals.moves)))
    return deny("SALVAGE_RESERVATION_NATIVE_SOURCE_UNAVAILABLE");
   const seenCargo=new Set(),seenWreck=new Set();
   for(const item of c.rows){
    if(!pos(item.cargoID)||!pos(item.wreckItemID)||
     !pos(item.typeID)||!pos(item.quantity)||
     seenCargo.has(item.cargoID)||seenWreck.has(item.wreckItemID))
     return deny("SALVAGE_RESERVATION_ORIGINAL_ROWS_CONFLICT");
    seenCargo.add(item.cargoID);seenWreck.add(item.wreckItemID);
    const live=wrecks[String(item.wreckItemID)];
    if(!live||live.wreckID!==c.wreckID||
     live.wreckItemID!==item.wreckItemID||
     live.sourceKind!=="cargo"||
     live.sourceCargoID!==item.cargoID||
     live.typeID!==item.typeID||live.quantity!==item.quantity||
     playerMoves?.moves?.[manifestKey+":"+item.cargoID]||
     rivals?.moves?.[String(item.wreckItemID)])
     return deny("SALVAGE_RESERVATION_SOURCE_ALREADY_MOVED");
   }
   chars(tx,c);
   const company=corp(tx,c),debit=cents(c.amountISK);
   if(company.balance<debit)throw Error("SALVAGE_CORP_INSUFFICIENT_FUNDS");
   const now=clock();if(!pos(now))throw Error("SALVAGE_CLOCK_INVALID");
   const remaining=company.balance-debit;
   company.division.balance=money(remaining);
   const e=entry(c,"reserve",-debit,remaining,now);
   company.division.journal=[...company.division.journal,e].slice(-100);
   company.division.transactions=[...company.division.transactions,e].slice(-2000);
   tx.put("corporationRuntime",company.key,company.rec);
   l.byContract[c.contractID]={contractID:c.contractID,
    manifestKey:c.manifestKey,stationID:c.stationID,
    corporationID:c.corporationID,amountISK:c.amountISK,
    characters:c.characters,rows:c.rows,status:"RESERVED",reservedAt:now};
   tx.put("corporationRuntime",CORP_ESCROWS,l);
   return {status:"SALVAGE_NATIVE_CORP_ESCROW_RESERVED",contractID:c.contractID,
    amountISK:c.amountISK,characters:c.characters};
  })}catch{return deny("SALVAGE_NATIVE_ESCROW_UNCERTAIN")}
 }
 function verify(manifestKey){
  if(!ready())return deny("DISABLED");
  const c=quote(manifestKey);
  if(c.status!=="SALVAGE_NATIVE_QUOTE_READY")return c;
  try{return atomic.transact(["corporationRuntime"],tx=>{
   const saved=ledger(tx).byContract[c.contractID];
   if(!saved)return deny("NOT_FOUND");
   if(saved.amountISK!==c.amountISK||
    saved.corporationID!==c.corporationID||
    JSON.stringify(saved.characters)!==JSON.stringify(c.characters))
    return deny("SALVAGE_NATIVE_ESCROW_IDENTITY_CONFLICT");
   return {status:saved.status,contractID:c.contractID,
    characters:c.characters,amountISK:c.amountISK,nativeDurable:true};
  })}catch{return deny("SALVAGE_NATIVE_ESCROW_SOURCE_UNAVAILABLE")}
 }
 function settle(manifestKey){
  if(!ready())return deny("DISABLED");
  const c=quote(manifestKey);
  if(c.status!=="SALVAGE_NATIVE_QUOTE_READY")return c;
  try{return atomic.transact(["corporationRuntime","characters","items","npcWreckItems"],tx=>{
   const l=ledger(tx),saved=l.byContract[c.contractID];
   if(!saved)return deny("SALVAGE_ESCROW_NOT_RESERVED");
   if(saved.amountISK!==c.amountISK||
    saved.corporationID!==c.corporationID||
    JSON.stringify(saved.characters)!==JSON.stringify(c.characters)||
    JSON.stringify(saved.rows)!==JSON.stringify(c.rows))
    throw Error("SALVAGE_ESCROW_IDENTITIES_CHANGED");
   if(saved.status==="SETTLED")return {status:"SALVAGE_ALREADY_PAID",contractID:c.contractID};
   if(saved.status!=="RESERVED")throw Error("SALVAGE_ESCROW_NOT_PAYABLE");
   // All original cargo must remain in the real native station and NO
   // source wreck items can still be available for another pickup.
   const all=tx.scan("items"),wrecks=tx.get("npcWreckItems","items");
   const nativeMoves=tx.get("corporationRuntime","coopSalvageMoves");
   if(nativeMoves?.version!==1||!nativeMoves.moves)
    throw Error("SALVAGE_NATIVE_MOVE_JOURNAL_MISSING");
   const used=new Set(),deliveryProof=[];
   for(const r of c.rows){
    if(wrecks?.[String(r.wreckItemID)])
     throw Error("SALVAGE_ORIGINAL_WRECK_STILL_HAS_ITEM");
    const move=nativeMoves.moves[manifestKey+":"+r.cargoID];
    if(move?.v!==1||move.state!=="DELIVERED"||
     move.manifestKey!==manifestKey||move.cargoID!==r.cargoID||
     move.wreckItemID!==r.wreckItemID||move.wreckID!==c.wreckID||
     move.corporationID!==c.corporationID||
     move.stationID!==c.stationID||move.quantity!==r.quantity||
     !pos(move.nativeItemID)||
     !c.characters.includes(move.characterID))
     throw Error("SALVAGE_NATIVE_ATOMIC_DELIVERY_RECEIPT_UNVERIFIED");
    const matches=all.filter(x=>x.value?.customInfo===
     marker(manifestKey,r.cargoID,r.wreckItemID));
    if(matches.length!==1||matches[0].value?.itemID!==move.nativeItemID||
     used.has(matches[0].key))
     throw Error("SALVAGE_NATIVE_CARGO_NOT_ALL_DELIVERED");
    used.add(matches[0].key);
    const item=matches[0].value;
    if(!pos(item.itemID)||item.typeID!==r.typeID||
     item.ownerID!==c.corporationID||item.locationID!==c.stationID||
     item.flagID!==4||item.quantity!==r.quantity||
     item.stacksize!==r.quantity||item.singleton!==0)
     throw Error("SALVAGE_NATIVE_CUSTODY_NOT_FINAL");
    if(!pos(move.shipID))throw Error("SALVAGE_NATIVE_ORIGINAL_SHIP_UNVERIFIED");
    // Seal original item custody in the SAME transaction as wallet credits:
    // later legitimate sales must not erase earned reputation/history.
    deliveryProof.push({v:1,manifestKey,
     cargoID:r.cargoID,wreckItemID:r.wreckItemID,
     nativeItemID:move.nativeItemID,typeID:r.typeID,quantity:r.quantity,
     characterID:move.characterID,shipID:move.shipID,
     stationID:c.stationID,corporationID:c.corporationID});
   }
   const people=chars(tx,c),half=cents(c.amountISK/2);
   const now=clock();if(!pos(now))throw Error("SALVAGE_CLOCK_INVALID");
   for(let i=0;i<people.length;i++){
    const p=people[i],balance=cents(p.balance)+half;
    if(!Number.isSafeInteger(balance))throw Error("SALVAGE_WALLET_OVERFLOW");
    p.balance=money(balance);p.balanceChange=c.amountISK/2;
    p.walletJournal=[entry(c,"pilot",half,balance,now,c.characters[i],i+1),
     ...p.walletJournal].slice(0,100);
    tx.put("characters",String(c.characters[i]),p);
   }
   saved.status="SETTLED";saved.settledAt=now;
   saved.credits=c.characters.map(characterID=>({
    characterID,amountISK:c.amountISK/2}));
   saved.deliveryProof=deliveryProof;
   tx.put("corporationRuntime",CORP_ESCROWS,l);
   return {status:"SALVAGE_NATIVE_DUO_PAID",contractID:c.contractID,
    amountISK:c.amountISK,credits:saved.credits,nativeDurable:true};
  })}catch{return deny("SALVAGE_SETTLEMENT_NOT_VERIFIED_OR_UNCERTAIN")}
 }
 // An unused, timed-out contract can release its OWN original escrow
 // only if EVERY original wreck item still exists and NO pickup receipt exists.
 // Active salvage in any player ship blocks auto-refund for manual repair.
 function refundUnstarted(manifestKey){
  if(!ready())return deny("DISABLED");
  const c=quote(manifestKey);
  if(c.status!=="SALVAGE_NATIVE_QUOTE_READY")return c;
  try{return atomic.transact(["corporationRuntime","npcWreckItems"],tx=>{
   const l=ledger(tx),saved=l.byContract[c.contractID];
   if(!saved)return deny("SALVAGE_ESCROW_NOT_RESERVED");
   if(saved.status==="REFUNDED")
    return {status:"SALVAGE_ALREADY_REFUNDED",contractID:c.contractID};
   if(saved.status!=="RESERVED"||saved.corporationID!==c.corporationID||
    saved.amountISK!==c.amountISK||
    JSON.stringify(saved.rows)!==JSON.stringify(c.rows))
    return deny("SALVAGE_ESCROW_NOT_REFUNDABLE");
   const now=clock();
   if(!pos(now)||now<saved.reservedAt||
    now-saved.reservedAt<refundAfterMs)
    return deny("SALVAGE_ESCROW_REFUND_NOT_DUE");
   const wrecks=tx.get("npcWreckItems","items");
   const moves=tx.get("corporationRuntime","coopSalvageMoves");
   if(!wrecks||c.rows.some(r=>{
    const w=wrecks[String(r.wreckItemID)];
    return !w||w.wreckID!==c.wreckID||
     w.sourceCargoID!==r.cargoID||w.typeID!==r.typeID||
     w.quantity!==r.quantity||
     Boolean(moves?.moves?.[manifestKey+":"+r.cargoID]);
   }))
    return deny("SALVAGE_STARTED_OR_WRECK_UNVERIFIED");
   const company=corp(tx,c),sum=cents(c.amountISK);
   const next=company.balance+sum;
   if(!Number.isSafeInteger(next))
    throw Error("SALVAGE_CORP_REFUND_BALANCE_OVERFLOW");
   company.division.balance=money(next);
   const e=entry(c,"refund",sum,next,now);
   company.division.journal=[...company.division.journal,e].slice(-100);
   company.division.transactions=[...company.division.transactions,e].slice(-2000);
   tx.put("corporationRuntime",company.key,company.rec);
   saved.status="REFUNDED";saved.refundedAt=now;
   tx.put("corporationRuntime",CORP_ESCROWS,l);
   return {status:"SALVAGE_NATIVE_CORP_ESCROW_REFUNDED",
    contractID:c.contractID,amountISK:c.amountISK,nativeDurable:true};
  })}catch{return deny("SALVAGE_NATIVE_REFUND_UNCERTAIN")}
 }
 // Read-only per-character, native terminal-verified RESCUE history.
 // There is no public caller-supplied balance, score or credit command.
 function history(characterID,limit=8){
  if(!ready())return {status:"DISABLED",history:[]};
  if(!pos(characterID)||!Number.isSafeInteger(limit)||limit<1||limit>50)
   return {status:"SALVAGE_HISTORY_INVALID_QUERY",history:[]};
  try{return atomic.transact(["corporationRuntime","items","npcWreckItems"],tx=>{
   const l=ledger(tx);
   const moves=tx.get("corporationRuntime","coopSalvageMoves");
   const all=tx.scan("items"),wrecks=tx.get("npcWreckItems","items");
   const records=[];
   for(const x of Object.values(l.byContract)){
    if(!x.characters?.includes(characterID)||
     !["SETTLED","REFUNDED"].includes(x.status))continue;
    if(!pos(x.amountISK)||!Array.isArray(x.characters)||
     x.characters.length!==2||!x.characters.every(pos)||
     x.characters[0]>=x.characters[1]||
     !Array.isArray(x.rows)||!x.rows.length||
     typeof x.manifestKey!=="string"||
     x.contractID!=="salvage-"+x.manifestKey)
     return {status:"SALVAGE_HISTORY_WALLET_CORRUPT",history:[]};
    if(x.status==="SETTLED"){
     if(!pos(x.settledAt)||!Array.isArray(x.credits)||
      x.credits.length!==2||x.credits.some((z,i)=>
       z.characterID!==x.characters[i]||
       z.amountISK!==x.amountISK/2))
      return {status:"SALVAGE_HISTORY_NATIVE_CREDITS_UNVERIFIED",history:[]};
     // Sealed proofs were written only after native custody checks inside
     // the payout transaction. They survive subsequent lawful NPC sales.
     const sealed=x.deliveryProof;
     if(sealed!==undefined&&(!Array.isArray(sealed)||
      sealed.length!==x.rows.length))
      return {status:"SALVAGE_HISTORY_DELIVERY_PROOF_INVALID",history:[]};
     const sealedItemIDs=new Set();
     for(const [i,r] of x.rows.entries()){
      if(sealed!==undefined){
       const p=sealed[i];
       if(p?.v!==1||p.manifestKey!==x.manifestKey||
        p.cargoID!==r.cargoID||p.wreckItemID!==r.wreckItemID||
        p.typeID!==r.typeID||p.quantity!==r.quantity||
        p.stationID!==x.stationID||
        p.corporationID!==x.corporationID||
        !pos(p.nativeItemID)||!pos(p.shipID)||
        !x.characters.includes(p.characterID)||
        sealedItemIDs.has(p.nativeItemID))
        return {status:"SALVAGE_HISTORY_DELIVERY_PROOF_INVALID",history:[]};
       // Cross-check the proof against the separately durable GameStore
       // movement receipt. The warehouse item itself may have been sold.
       const recorded=moves?.moves?.[x.manifestKey+":"+r.cargoID];
       if(recorded?.v!==1||recorded.state!=="DELIVERED"||
        recorded.manifestKey!==x.manifestKey||
        recorded.cargoID!==p.cargoID||
        recorded.wreckItemID!==p.wreckItemID||
        recorded.nativeItemID!==p.nativeItemID||
        recorded.quantity!==p.quantity||
        recorded.characterID!==p.characterID||
        recorded.shipID!==p.shipID||
        recorded.corporationID!==p.corporationID||
        recorded.stationID!==p.stationID)
        return {status:"SALVAGE_HISTORY_DELIVERY_RECEIPT_CONFLICT",history:[]};
       sealedItemIDs.add(p.nativeItemID);
       continue;
      }
      // Legacy settlement without a sealed proof: never backfill
      // history by inference, retain strict current-stock verification.
      const m=moves?.moves?.[x.manifestKey+":"+r.cargoID];
      if(m?.v!==1||m.state!=="DELIVERED"||
       m.cargoID!==r.cargoID||m.wreckItemID!==r.wreckItemID||
       m.corporationID!==x.corporationID||
       m.stationID!==x.stationID||m.quantity!==r.quantity||
       !x.characters.includes(m.characterID)||
       wrecks?.[String(r.wreckItemID)])
       return {status:"SALVAGE_HISTORY_NATIVE_CUSTODY_UNVERIFIED",history:[]};
      const stock=all.filter(z=>z.value?.itemID===m.nativeItemID&&
       z.value.customInfo===marker(x.manifestKey,r.cargoID,r.wreckItemID)&&
       z.value.ownerID===x.corporationID&&
       z.value.locationID===x.stationID&&
       z.value.flagID===4&&z.value.quantity===r.quantity&&
       z.value.typeID===r.typeID);
      if(stock.length!==1)
       return {status:"SALVAGE_HISTORY_STOCK_NOT_VERIFIED",history:[]};
     }
    }else if(!pos(x.refundedAt)||x.credits)
     return {status:"SALVAGE_HISTORY_REFUND_CORRUPT",history:[]};
    records.push({contractID:x.contractID,manifestKey:x.manifestKey,
     corporationID:x.corporationID,outcome:x.status,
     amountISK:x.amountISK,
     earnedISK:x.status==="SETTLED"?x.amountISK/2:0,
     reputationPoints:x.status==="SETTLED"?12:0,
     recordedAt:x.status==="SETTLED"?x.settledAt:x.refundedAt});
   }
   records.sort((a,b)=>b.recordedAt-a.recordedAt||
    a.contractID.localeCompare(b.contractID));
   return {status:"READY",history:records.slice(0,limit),
    reputation:{paidRescues:records.filter(x=>x.outcome==="SETTLED").length,
     refundedRescues:records.filter(x=>x.outcome==="REFUNDED").length,
     score:records.reduce((n,x)=>n+x.reputationPoints,0),
     earnedISK:records.reduce((n,x)=>n+x.earnedISK,0)}};
  })}catch{return {status:"SALVAGE_HISTORY_NATIVE_SOURCE_UNAVAILABLE",history:[]}}
 }
 return {quote,reserve,verify,settle,refundUnstarted,history};
}
module.exports={createSalvageNativeRewards};
