"use strict";
// FW-007C: Unix-socket-only administrative channel, no HTTP, no player RPC.
// Container filesystem ACL (0700 socket directory, 0600 credential file and
// socket) plus constant-time secret and server-minted operator identity.
const fs=require("node:fs"),path=require("node:path"),net=require("node:net"),
 crypto=require("node:crypto");
function createWarRecoverySocket({createConsole,secretFile,socketPath,
 fsApi=fs,netApi=net,env=process.env,principalID="local-war-operator"}={}){
 if(typeof createConsole!=="function"||typeof secretFile!=="string"||
  typeof socketPath!=="string"||!path.isAbsolute(secretFile)||
  !path.isAbsolute(socketPath)||typeof principalID!=="string"||
  !/^[A-Za-z0-9_.:@-]{3,100}$/.test(principalID))
  throw Error("WAR_RECOVERY_SOCKET_CONFIG_INVALID");
 const enabled=()=>env.EVEJS_COOP_WAR_RECOVERY_ADMIN==="1"&&
  env.EVEJS_COOP_WAR_RECOVERY_SOCKET==="1"&&
  env.EVEJS_COOP_FACTION_WAR_NATIVE_TRANSFER==="1";
 let server=null,connections=0;
 function credentials(){
  const stat=fsApi.lstatSync(secretFile);
  if(!stat.isFile()||stat.isSymbolicLink()||
   (stat.mode&0o077)!==0||stat.size<32||stat.size>256||
   (typeof process.getuid==="function"&&stat.uid!==process.getuid()))
   throw Error("WAR_RECOVERY_SECRET_FILE_UNSAFE");
  const v=fsApi.readFileSync(secretFile,"utf8").trim();
  if(!/^[A-Za-z0-9+/_=-]{32,200}$/.test(v))
   throw Error("WAR_RECOVERY_SECRET_FORMAT_INVALID");
  return Buffer.from(v,"utf8");
 }
 function checkToken(expected,candidate){
  if(typeof candidate!=="string"||candidate.length!==expected.length)
   return false;
  return crypto.timingSafeEqual(expected,Buffer.from(candidate,"utf8"));
 }
 function start(){
  if(!enabled())return {status:"DISABLED"};
  if(server)return {status:"ALREADY_STARTED"};
  if(process.platform==="win32")return {status:"UNSUPPORTED_WINDOWS_HOST_USE_LINUX_CONTAINER"};
  // Both parent directory ACL and credential-file ownership are checked
  // before accepting any local socket client.
  const expected=credentials(),directory=path.dirname(socketPath);
  fsApi.mkdirSync(directory,{recursive:true,mode:0o700});
  const st=fsApi.lstatSync(directory);
  if(!st.isDirectory()||st.isSymbolicLink()||
   (st.mode&0o077)!==0||
   (typeof process.getuid==="function"&&st.uid!==process.getuid()))
   throw Error("WAR_RECOVERY_SOCKET_DIRECTORY_UNSAFE");
  if(fsApi.existsSync(socketPath))
   throw Error("WAR_RECOVERY_SOCKET_EXISTS_OPERATOR_MUST_INSPECT");
  const service=createConsole({
   authorizeOperator:({operator})=>operator?.principalID===principalID
  });
  if(!service||typeof service.review!=="function"||
   typeof service.apply!=="function")
   throw Error("WAR_RECOVERY_CONSOLE_REQUIRED");
  const created=netApi.createServer(socket=>{
   connections++;
   if(connections>8){connections--;socket.destroy();return}
   socket.setTimeout(10000,()=>socket.destroy());
   let buffer="",done=false;
   socket.on("close",()=>{connections--});
   socket.on("error",()=>{});
   socket.on("data",chunk=>{
    if(done)return;
    buffer+=chunk.toString("utf8");
    if(Buffer.byteLength(buffer,"utf8")>4096){
     done=true;socket.end('{"status":"REQUEST_TOO_LARGE"}\n');return;
    }
    const idx=buffer.indexOf("\n");
    if(idx<0)return;
    done=true;
    let answer;
    try{
     const request=JSON.parse(buffer.slice(0,idx));
     if(!checkToken(expected,request?.credential)){
      answer={status:"FORBIDDEN"};
     }else if(!Number.isSafeInteger(request.entityID)||
      request.entityID<=0)answer={status:"INVALID_ENTITY"};
     else if(request.operation==="review")
      answer=service.review({entityID:request.entityID,
       operator:{principalID}});
     else if(request.operation==="apply")
      answer=service.apply({entityID:request.entityID,
       operator:{principalID},action:request.action,
       expectedWitness:request.expectedWitness,reason:request.reason});
     else answer={status:"UNKNOWN_OPERATION"};
    }catch{answer={status:"INVALID_OR_FAILED_REQUEST"}}
    socket.end(JSON.stringify(answer)+"\n");
   });
  });
  // Prevent an unhandled listen error from crashing the game server.
  created.on("error",error=>{
   console.error("[CoopWarRecoverySocket]",String(error?.code||"LISTEN_FAILED"));
  });
  server=created;
  created.listen(socketPath,()=>{
   try{fsApi.chmodSync(socketPath,0o600)}
   catch(error){created.close();console.error("[CoopWarRecoverySocket] unsafe permissions",error.message)}
  });
  return {status:"LISTENING_INITIATED",socketPath};
 }
 function close(){
  if(!server)return {status:"NOT_STARTED"};
  const current=server;server=null;
  current.close();
  // The socket inode is kept until an operator has inspected it; do not
  // unlink another process's socket blindly during shutdown.
  return {status:"CLOSING"};
 }
 return Object.freeze({start,close});
}
module.exports={createWarRecoverySocket};
