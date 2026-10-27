"use strict";
// COOP-059: host-local, explicitly enabled, authenticated operator-only
// recovery control. NEVER reachable through player RPC/slash/agent commands.
const http=require("node:http"),fs=require("node:fs"),crypto=require("node:crypto");
const {timingSafeEqual,createHmac,createHash,randomBytes,randomUUID}=crypto;
const pos=x=>Number.isSafeInteger(x)&&x>0;
function readOperatorKey(file){
 if(typeof file!=="string"||!require("node:path").isAbsolute(file))
  throw Error("NPC_ADMIN_SECRET_ABSOLUTE_PATH_REQUIRED");
 // Open with O_NOFOLLOW and validate the OPEN file descriptor; an attacker
 // must not be able to swap a safe key for a symlink between stat and read.
 const fd=fs.openSync(file,fs.constants.O_RDONLY|
   (fs.constants.O_NOFOLLOW||0));
 try{
  const st=fs.fstatSync(fd);
  if(!st.isFile()||st.size<32||st.size>4096)
   throw Error("NPC_ADMIN_SECRET_INVALID_FILE");
  if(typeof process.getuid==="function"&&
     (st.uid!==process.getuid()||(st.mode&0o077)!==0))
   throw Error("NPC_ADMIN_SECRET_PERMISSIONS");
  const key=fs.readFileSync(fd);
  if(key.length<32||key.length>4096)throw Error("NPC_ADMIN_SECRET_INVALID_LENGTH");
  return key;
 }finally{fs.closeSync(fd)}
}
function signRequest(key,{timestamp,nonce,path,body}){
 return createHmac("sha256",key).update(String(timestamp)+"\n"+nonce+"\n"+
  path+"\n"+createHash("sha256").update(body).digest("hex")).digest("hex");
}
function createLocalNpcBuyerRecoveryControl({getBinding,secretFile,
 auditLogFile,port=17171,env=process.env,clock=()=>Date.now(),
 serverFactory=http.createServer}={}){
 if(typeof getBinding!=="function"||typeof clock!=="function"||
    (!Number.isSafeInteger(port)||port<0||port>65535)||
    typeof auditLogFile!=="string"||
    !require("node:path").isAbsolute(auditLogFile))
  throw Error("NPC_ADMIN_INVALID_CONFIGURATION");
 const enabled=()=>env.EVEJS_COOP_NPC_BUY_ADMIN_LOCAL==="1"&&
  env.EVEJS_COOP_NPC_BUY_RECOVERY_OPERATOR==="1"&&
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
  env.EVEJS_COOP_NPC_BUY_PLAYER_ASK==="1";
 if(!enabled())throw Error("NPC_ADMIN_DISABLED");
 const key=readOperatorKey(secretFile);
 const nonces=new Map(),tickets=new Map(),grants=new Map();
 let server=null,closing=false,executing=false;
 const logPath=require("node:path");
 function auditLog(event){
  const st=fs.existsSync(auditLogFile)?fs.lstatSync(auditLogFile):null;
  if(st&&(!st.isFile()||st.isSymbolicLink()||
     (typeof process.getuid==="function"&&
       (st.uid!==process.getuid()||(st.mode&0o077)!==0))))
   throw Error("NPC_ADMIN_AUDIT_FILE_UNSAFE");
  if(!st)fs.mkdirSync(logPath.dirname(auditLogFile),{recursive:true});
  // Even when an operator log is created for the first time, its containing
  // directory cannot be writable by another user. Never follow log symlinks.
  const parent=fs.lstatSync(logPath.dirname(auditLogFile));
  if(!parent.isDirectory()||parent.isSymbolicLink()||
     (typeof process.getuid==="function"&&
    ((parent.mode&0o022)!==0||parent.uid!==process.getuid())))
   throw Error("NPC_ADMIN_AUDIT_DIR_UNSAFE");
  const fd=fs.openSync(auditLogFile,fs.constants.O_WRONLY|
    fs.constants.O_CREAT|fs.constants.O_APPEND|
    (fs.constants.O_NOFOLLOW||0),0o600);
  try{
   const actual=fs.fstatSync(fd);
   if(!actual.isFile()||(typeof process.getuid==="function"&&
      (actual.uid!==process.getuid()||(actual.mode&0o077)!==0)))
    throw Error("NPC_ADMIN_AUDIT_FILE_UNSAFE");
   fs.writeSync(fd,JSON.stringify({at:clock(),...event})+"\n");fs.fsyncSync(fd);
  }finally{fs.closeSync(fd)}
 }
 function safeJSON(res,status,content){
  const output=JSON.stringify(content);
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8",
   "Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
   "Content-Length":Buffer.byteLength(output)});
  res.end(output);
 }
 function prune(map,now,ttl){for(const [k,t] of map)if(now-t.at>ttl)map.delete(k)}
 function authenticated(req,path,body){
  if(!enabled())return false;
  const ts=String(req.headers["x-evejs-timestamp"]||"");
  const nonce=String(req.headers["x-evejs-nonce"]||"");
  const sig=String(req.headers["x-evejs-signature"]||"");
  const now=clock(),t=Number(ts);
  if(!/^[0-9]{13}$/.test(ts)||!Number.isSafeInteger(t)||
     Math.abs(t-now)>60000||
     !/^[A-Za-z0-9_-]{16,120}$/.test(nonce)||
     !/^[0-9a-f]{64}$/.test(sig))return false;
  prune(nonces,now,120000);
  if(nonces.has(nonce)||nonces.size>=2048)return false;
  const expected=signRequest(key,{timestamp:ts,nonce,path,body});
  if(!timingSafeEqual(Buffer.from(sig,"hex"),Buffer.from(expected,"hex")))
   return false;
  nonces.set(nonce,{at:now});
  return true;
 }
 function consumeGrant(approval){
  const grant=grants.get(approval?.approvalID);
  if(!grant)return false;
  grants.delete(approval.approvalID);
  return grant.at+120000>=clock()&&
   ["claimKey","action","reason","actorID","orderID","buyerCorpID",
    "stationID","typeID"].every(k=>grant[k]===approval[k]);
 }
 async function route(req,res){
  const ip=req.socket?.remoteAddress;
  if(ip!=="127.0.0.1"&&ip!=="::ffff:127.0.0.1")
   return safeJSON(res,403,{status:"DENIED"});
  if(req.method!=="POST"||!["/v1/recovery/audit",
      "/v1/recovery/execute"].includes(req.url)||
     !/^application\/json(?:\s*;.*)?$/i.test(String(req.headers["content-type"]||"")))
   return safeJSON(res,404,{status:"NOT_FOUND"});
  let body="";
  try{for await(const chunk of req){
   body+=chunk;
   if(Buffer.byteLength(body)>4096)
    return safeJSON(res,413,{status:"REQUEST_TOO_LARGE"});
  }}catch{return safeJSON(res,400,{status:"REQUEST_INVALID"})}
  if(!authenticated(req,req.url,body))
   return safeJSON(res,401,{status:"UNAUTHORIZED"});
  let input;
  try{input=JSON.parse(body);if(!input||Array.isArray(input)||
    typeof input!=="object")throw Error("invalid")}
  catch{return safeJSON(res,400,{status:"JSON_INVALID"})}
  const binding=getBinding();
  if(!binding||typeof binding.audit!=="function"||
    typeof binding.recoverApproved!=="function")
   return safeJSON(res,503,{status:"NATIVE_RECOVERY_UNAVAILABLE"});
  const now=clock();
  if(req.url==="/v1/recovery/audit"){
   const claimKey=input.claimKey;
   if(!/^npc-corpbuy:[0-9a-f]{32}$/.test(claimKey||"")||
      Object.keys(input).length!==1)
    return safeJSON(res,400,{status:"CLAIM_SCOPE_INVALID"});
   let report;
   try{report=await binding.audit()}
   catch{return safeJSON(res,503,{status:"AUDIT_AUTHORITY_UNAVAILABLE"})}
   const matching=report?.entries?.filter(e=>e.claimKey===claimKey)||[];
   if(matching.length!==1)return safeJSON(res,409,{status:"CLAIM_NOT_UNIQUE"});
   const entry=matching[0];
   if(report.status==="HOLD_MANUAL"||report.lockPresent||
      entry.status==="HOLD_MANUAL"||entry.status==="CONSISTENT"||
      entry.requiresOperator!==true)
    return safeJSON(res,409,{status:"HOLD_MANUAL",reason:entry.reason||entry.status});
   prune(tickets,now,120000);
   if(tickets.size>=128)return safeJSON(res,429,{status:"AUDIT_CAP"});
   const ticket=randomBytes(24).toString("hex");
   tickets.set(ticket,{at:now,claimKey,action:entry.status});
   return safeJSON(res,200,{status:"AUDITED",ticket,
    claimKey,action:entry.status,reason:entry.reason||null,
    expiresInSeconds:90});
  }
  if(executing)return safeJSON(res,409,{status:"ADMIN_RECOVERY_BUSY"});
  const {ticket,claimKey,action,reason,actorID}=input;
  if(Object.keys(input).sort().join(",")!==
       ["action","actorID","claimKey","reason","ticket"].sort().join(",")||
     typeof ticket!=="string"||!/^[0-9a-f]{48}$/.test(ticket)||
     !/^npc-corpbuy:[0-9a-f]{32}$/.test(claimKey||"")||
     typeof reason!=="string"||reason.trim().length<12||
     reason.length>500||!pos(actorID))
   return safeJSON(res,400,{status:"APPROVAL_INVALID"});
  const approved=tickets.get(ticket);tickets.delete(ticket);
  if(!approved||now-approved.at>90000||
     approved.claimKey!==claimKey||approved.action!==action)
   return safeJSON(res,409,{status:"AUDIT_TICKET_INVALID"});
  const approvalID=randomUUID().replace(/-/g,"");
  const grant={at:now,approvalID,claimKey,action,reason:reason.trim(),actorID};
  // Other trusted binding properties (buyerCorpID, stationID, etc.) come
  // from the durable journal inside recoverApproved, not from client JSON.
  // Resolve them from the coordinator's signed-internal journal read.
  const snapshot=binding.inspect();
  const matching=Object.values(snapshot?.entries||{}).filter(e=>
   e?.claimKey===claimKey&&e.phase==="PREPARED");
  if(matching.length!==1)return safeJSON(res,409,{status:"JOURNAL_NOT_UNIQUE"});
  const entry=matching[0];
  Object.assign(grant,{orderID:entry.orderID,
   buyerCorpID:entry.buyerCorpID,stationID:entry.stationID,typeID:entry.typeID});
  executing=true;
  try{
   // Write-ahead operator log: if it cannot fsync, refuse any wallet mutation.
   auditLog({stage:"APPROVED",approvalID,action,claimKey,actorID,reason:grant.reason});
   grants.set(approvalID,grant);
   let result;
   try{result=await binding.recoverApproved({actorID,approval:{
      claimKey,action,approvalID,reason:grant.reason}})}
   finally{grants.delete(approvalID)}
   try{auditLog({stage:"RESULT",approvalID,action,claimKey,
      status:result?.status||"UNKNOWN",reason:result?.reason||null})}
   catch{return safeJSON(res,503,{status:"RESULT_AUDIT_WRITE_FAILED",
       approvalID,requiresFreshAudit:true})}
   return safeJSON(res,result?.status==="NPC_BUY_OPERATOR_RECOVERED"?200:409,
    {status:result?.status||"UNKNOWN",reason:result?.reason||null,
     action,approvalID,fillID:result?.fillID||null,itemID:result?.itemID||null});
  }catch{
   return safeJSON(res,503,{status:"RECOVERY_UNCERTAIN",requiresFreshAudit:true});
  }finally{executing=false}
 }
 async function start(){
  if(server||closing)throw Error("NPC_ADMIN_ALREADY_STARTED");
  if(!enabled())throw Error("NPC_ADMIN_DISABLED");
  server=serverFactory((req,res)=>{
   Promise.resolve(route(req,res)).catch(()=>{if(!res.headersSent)
    safeJSON(res,503,{status:"RECOVERY_UNCERTAIN",requiresFreshAudit:true});
    else res.destroy()});
  });
  try{await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,"127.0.0.1",()=>{server.removeListener("error",reject);resolve()});
   })}catch(e){server=null;throw e}
  return {host:"127.0.0.1",port:server.address().port};
 }
 async function close(){
  closing=true;
  if(server){const s=server;server=null;await new Promise(resolve=>s.close(resolve))}
  nonces.clear();tickets.clear();grants.clear();
 }
 return Object.freeze({start,close,authorizeRecoveryOperator:async a=>consumeGrant(a),
  mode:"LOOPBACK_HMAC_OPERATOR_ONLY"});
}
module.exports={createLocalNpcBuyerRecoveryControl,signRequest,readOperatorKey};
