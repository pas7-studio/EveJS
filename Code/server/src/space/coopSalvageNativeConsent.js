"use strict";
// Two separate real authenticated EVE pilots must explicitly accept same
// originally verified RESCUE quote before any NPC wallet escrow debit.
const fs=require("node:fs"),path=require("node:path");
const key=x=>typeof x==="string"&&/^\d+-\d+-\d+$/.test(x);
const pos=x=>Number.isSafeInteger(x)&&x>0;
const deny=status=>({status});
const clone=x=>JSON.parse(JSON.stringify(x));
function createSalvageConsent({root,io=fs,clock=()=>Date.now(),
 readQuote,verifyPilot}={}){
 if(!path.isAbsolute(root||"")||
  [clock,readQuote,verifyPilot].some(x=>typeof x!=="function"))
  throw Error("SALVAGE_CONSENT_AUTHORITIES_REQUIRED");
 const dir=path.join(root,"salvage-acceptance");
 const file=(manifestKey,id)=>path.join(dir,manifestKey+"-"+id+".json");
 const pair=manifestKey=>path.join(dir,manifestKey+"-duo.json");
 function load(p){
  try{
   const s=io.readFileSync(p,"utf8");
   if(typeof s!=="string"||s.length>6000||!s.endsWith("\n"))
    return deny("SALVAGE_CONSENT_CORRUPT");
   return {status:"READY",value:JSON.parse(s.trim())};
  }catch(e){return deny(e?.code==="ENOENT"?"NOT_FOUND":"SALVAGE_CONSENT_READ_FAILED")}
 }
 function write(p,v){
  let fd;try{
   io.mkdirSync(dir,{recursive:true});
   const buf=Buffer.from(JSON.stringify(v)+"\n");
   fd=io.openSync(p,"wx",0o600);
   if(io.writeSync(fd,buf,0,buf.length,null)!==buf.length)
    return false;
   io.fsyncSync(fd);
  }catch{return false}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  try{fd=io.openSync(dir,"r");io.fsyncSync(fd);return true}
  catch{return false}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
 }
 function source(manifestKey,{allowStarted=false}={}){
  if(!key(manifestKey))return deny("SALVAGE_CONSENT_INVALID_MANIFEST");
  const quote=readQuote(manifestKey,{allowStarted});
  if(quote?.status!=="SALVAGE_NATIVE_OFFER_READY"||
   quote.manifestKey!==manifestKey||
   !pos(quote.corporationID)||!pos(quote.amountISK)||
   !Array.isArray(quote.characters)||quote.characters.length!==2||
   !quote.characters.every(pos)||quote.characters[0]>=quote.characters[1])
   return deny("SALVAGE_NATIVE_OFFER_NOT_VERIFIED");
  return {status:"READY",quote};
 }
 function readDuo(manifestKey){
  if(!key(manifestKey))return deny("SALVAGE_CONSENT_INVALID_MANIFEST");
  // An already signed duo receipt is mandatory to read historical terms:
  // never let a fresh acceptance bypass the actual live wreck source.
  const r=load(pair(manifestKey));if(r.status!=="READY")return r;
  const src=source(manifestKey,{allowStarted:true});
  if(src.status!=="READY")return src;
  const p=r.value,q=src.quote;
  if(p?.v!==1||p.manifestKey!==manifestKey||
   p.corporationID!==q.corporationID||p.amountISK!==q.amountISK||
   JSON.stringify(p.characters)!==JSON.stringify(q.characters)||
   !pos(p.at))
   return deny("SALVAGE_ACCEPTED_PAIR_CONFLICT");
  for(const id of q.characters){
   const a=load(file(manifestKey,id));
   if(a.status!=="READY"||a.value?.characterID!==id||
    a.value.manifestKey!==manifestKey||
    a.value.amountISK!==q.amountISK||
    a.value.corporationID!==q.corporationID)
    return deny("SALVAGE_ACCEPTED_CHARACTER_CONFLICT");
  }
  return {status:"VERIFIED_DUO_SALVAGE_ACCEPT",
   manifestKey,characters:q.characters.slice(),
   amountISK:q.amountISK,corporationID:q.corporationID};
 }
 function accept(session,manifestKey){
  if(process.env.EVEJS_COOP_SALVAGE_CONSENT!=="1")return deny("DISABLED");
  const src=source(manifestKey);
  if(src.status!=="READY")return src;
  const q=src.quote,id=session?.characterID;
  if(!pos(id)||session?.socket?.destroyed===true||
   !q.characters.includes(id))
   return deny("SALVAGE_CONSENT_UNAUTHORIZED_PLAYER");
  let authorized;
  try{authorized=verifyPilot(session,manifestKey,q)}
  catch{return deny("SALVAGE_PLAYER_NATIVE_SOURCE_UNAVAILABLE")}
  if(authorized?.status!=="SALVAGE_AUTHENTIC_PILOT"||
   authorized.characterID!==id)
   return deny("SALVAGE_PLAYER_NOT_VERIFIED");
  const existing=readDuo(manifestKey);
  if(existing.status==="VERIFIED_DUO_SALVAGE_ACCEPT")return existing;
  if(!["NOT_FOUND"].includes(existing.status))return existing;
  const at=clock();if(!pos(at))return deny("SALVAGE_INVALID_CLOCK");
  const receipt={v:1,manifestKey,characterID:id,
   corporationID:q.corporationID,amountISK:q.amountISK,at};
  const prior=load(file(manifestKey,id));
  if(prior.status==="NOT_FOUND"){
   if(!write(file(manifestKey,id),receipt))
    return deny("SALVAGE_CONSENT_FSYNC_UNCERTAIN");
  }else if(prior.status!=="READY"||
   JSON.stringify({...prior.value,at:receipt.at})!==
    JSON.stringify(receipt))
   return deny("SALVAGE_CONSENT_CHANGED");
  const both=q.characters.map(cid=>load(file(manifestKey,cid)));
  if(both.some(x=>x.status==="NOT_FOUND"))
   return {status:"SALVAGE_WAITING_FOR_OTHER_ACCEPTOR",manifestKey,
    amountISK:q.amountISK};
  if(both.some((x,i)=>x.status!=="READY"||
   x.value?.characterID!==q.characters[i]||
   x.value?.amountISK!==q.amountISK||
   x.value?.corporationID!==q.corporationID))
   return deny("SALVAGE_CONSENT_DUO_CONFLICT");
  if(!write(pair(manifestKey),{v:1,manifestKey,
   characters:q.characters.slice(),corporationID:q.corporationID,
   amountISK:q.amountISK,at}))
   return deny("SALVAGE_DUO_FSYNC_UNCERTAIN");
  return readDuo(manifestKey);
 }
 return {accept,readDuo};
}
module.exports={createSalvageConsent};
