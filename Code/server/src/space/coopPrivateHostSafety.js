'use strict';
// Chat 41: read-only validation of the *effective* Docker Compose configuration,
// pinned EveJS auth/advertisement config and a loopback-only private SSH path.
const net = require('node:net');
const EXPECTED = Object.freeze({
  server: Object.freeze({'443':26003,'5222':5222,'26000':26000,'26001':26001,'26002':26002}),
  market: Object.freeze({'40110':40110}),
});
const PRIVATE_CIDRS = Object.freeze([[10,0,0,0,8],[172,16,0,0,12],[192,168,0,0,16],[100,64,0,0,10]]);
function ipv4ToBigInt(text) {
  if (net.isIP(text)!==4) return null;
  const pieces=text.split('.').map(Number);
  return pieces.reduce((value,octet)=>(value<<8n)|BigInt(octet),0n);
}
function privatePeer(address) {
  const peer=ipv4ToBigInt(address);
  if(peer===null) return false;
  return PRIVATE_CIDRS.some(([a,b,c,d,bits])=>{
    const ip=BigInt(a)*16777216n+BigInt(b)*65536n+BigInt(c)*256n+BigInt(d);
    const mask=((1n<<BigInt(bits))-1n)<<BigInt(32-bits);
    return (peer&mask)===(ip&mask);
  });
}
function stripJsonComments(text) {
  if(typeof text!=='string') throw Error('CONFIG_TEXT_REQUIRED');
  let out='',quoted=false,escaped=false,line=false,block=false;
  for(let i=0;i<text.length;i++){
    const c=text[i],n=text[i+1];
    if(line){if(c==='\n'||c==='\r'){line=false;out+=c;}continue;}
    if(block){if(c==='*'&&n==='/'){block=false;i++;}else if(c==='\n'||c==='\r')out+=c;continue;}
    if(quoted){out+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;out+=c;continue;}
    if(c==='/'&&n==='/'){line=true;i++;continue;}
    if(c==='/'&&n==='*'){block=true;i++;continue;}
    out+=c;
  }
  if(quoted||block)throw Error('UNTERMINATED_JSON_CONFIG');
  return out;
}
function parseNativeConfig(text){return JSON.parse(stripJsonComments(text));}
function environmentOf(service){
  const env=service?.environment||{};
  if(Array.isArray(env))return Object.fromEntries(env.filter(x=>typeof x==='string'&&x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
  return typeof env==='object'?env:{};
}
function isLoopback(host){return host==='127.0.0.1'||host==='::1';}
function isLoopbackName(host){return isLoopback(host)||host==='localhost';}
function urlIsLoopback(url,expectedPort){
  if(typeof url!=='string'||!url.trim())return false;
  try{const value=new URL(url);return value.protocol==='http:'&&isLoopbackName(value.hostname)&&Number(value.port)===expectedPort&&!value.username&&!value.password&&!value.hash;}
  catch{return false;}
}
function validateCompose(compose){
  const errors=[],warnings=[],services=compose?.services;
  if(!services||typeof services!=='object'||Array.isArray(services))return {errors:['COMPOSE_SERVICES_MISSING'],warnings};
  for(const name of ['init','market','server'])if(!services[name])errors.push('COMPOSE_SERVICE_MISSING_'+name);
  const byPort=new Set();
  for(const [name,service] of Object.entries(services)){
    if(service?.network_mode==='host'||service?.privileged===true||service?.pid==='host')errors.push('DANGEROUS_CONTAINER_ISOLATION_'+name);
    if(!Array.isArray(service?.ports))continue;
    for(const port of service.ports){
      if(!port||typeof port!=='object'){errors.push('UNNORMALIZED_COMPOSE_PORT_'+name);continue;}
      const host=String(port.host_ip||''),published=String(port.published??''),target=Number(port.target);
      if(!isLoopback(host))errors.push('NON_LOOPBACK_PUBLICATION_'+name+'_'+published);
      if(!/^\d{1,5}$/.test(published)||Number(published)<1||Number(published)>65535||
          !Number.isSafeInteger(target)||target<1||target>65535)errors.push('INVALID_COMPOSE_PORT_'+name);
      if((port.protocol||'tcp')!=='tcp')errors.push('NON_TCP_PUBLICATION_'+name+'_'+published);
      if(!Object.hasOwn(EXPECTED[name]||{},published)||EXPECTED[name][published]!==target)
        errors.push('UNEXPECTED_COMPOSE_PORT_'+name+'_'+published);
      const key=host+'/'+published;
      if(byPort.has(key))errors.push('DUPLICATE_COMPOSE_PUBLISHED_PORT_'+published);
      byPort.add(key);
    }
  }
  for(const [name,ports] of Object.entries(EXPECTED))for(const published of Object.keys(ports)){
    const matches=(services[name]?.ports||[]).filter(p=>String(p?.published)===published&&Number(p?.target)===ports[published]&&isLoopback(String(p.host_ip)));
    if(matches.length!==1)errors.push('REQUIRED_LOOPBACK_PORT_MISSING_'+name+'_'+published);
  }
  const mounts=Array.isArray(services.server?.volumes)?services.server.volumes:[];
  const data=mounts.filter(v=>v&&v.type==='volume'&&v.target==='/var/lib/evejs'&&typeof v.source==='string'&&v.source.length>0);
  if(data.length!==1)errors.push('GAMESTORE_NAMED_VOLUME_REQUIRED');
  if(data.length===1){
    const source=data[0].source;
    for(const name of ['market','init']){
      const found=(services[name]?.volumes||[]).some(v=>v?.type==='volume'&&v.target==='/var/lib/evejs'&&v.source===source);
      if(!found)errors.push('GAMESTORE_VOLUME_MISMATCH_'+name);
    }
  }
  if(!mounts.some(v=>v?.type==='volume'&&v.target==='/app/server/src/_secondary/image/generated'))
    warnings.push('GENERATED_CHARACTER_PORTRAITS_NOT_NAMED_VOLUME');
  for(const [name,service] of Object.entries(services)){
    if((service?.volumes||[]).some(v=>String(v?.source||'').includes('docker.sock')))
      errors.push('DOCKER_SOCKET_MOUNT_'+name);
  }
  const env=environmentOf(services.server);
  for(const [key,expected] of Object.entries({EVEJS_GAME_SERVER_HOST:'127.0.0.1',EVEJS_XMPP_CONNECT_HOST:'localhost'})){
    if(env[key]!==expected)errors.push('NON_LOOPBACK_ADVERTISEMENT_'+key);
  }
  for(const [key,port] of Object.entries({EVEJS_IMAGE_SERVER_URL:26001,EVEJS_MICROSERVICES_PUBLIC_BASE_URL:26002,EVEJS_MICROSERVICES_REDIRECT_URL:26002}))
    if(!urlIsLoopback(env[key],port))errors.push('NON_LOOPBACK_ADVERTISEMENT_'+key);
  if(env.EVEJS_MARKET_DAEMON_HOST!=='market'||String(env.EVEJS_MARKET_DAEMON_PORT)!=='40111')
    warnings.push('MARKET_INTERNAL_ENDPOINT_DRIFT');
  for(const [key,value] of Object.entries(env)){
    if(/^EVEJS_DEV_(SKIP_PASSWORD_VALIDATION|AUTO_CREATE_ACCOUNTS)$/.test(key)&&['true','1','yes','on'].includes(String(value).trim().toLowerCase()))
      errors.push('UNSAFE_AUTH_ENV_'+key);
  }
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)],gameVolume:data[0]?.source||null,
    hostPublishedPorts:Object.values(EXPECTED).reduce((acc,v)=>acc+Object.keys(v).length,0)};
}
function validateNativeConfig(config){
  const errors=[],warnings=[];
  if(!config||typeof config!=='object'||Array.isArray(config))return {errors:['NATIVE_AUTH_CONFIG_MISSING'],warnings};
  for(const key of ['devSkipPasswordValidation','devAutoCreateAccounts','devBypassAssetSafetyWrapAccess','upwellGmBypassRestrictions']){
    if(config[key]!==false)errors.push('UNSAFE_NATIVE_CONFIG_'+key);
  }
  if(config.devHandshakeSeedSkillExtractorAccessToken===true)warnings.push('DEV_HANDSHAKE_SKILL_EXTRACTOR_TOKEN_ENABLED');
  return {errors,warnings};
}
function validateTunnel({hostVpnIPv4,sshPort=22,hostKeyChecking='yes',batchMode='yes',gatewayPorts='no',
  forwardings=[],remoteName='',sshUser=''}={}){
  const errors=[];
  if(!privatePeer(hostVpnIPv4))errors.push('SSH_PEER_NOT_PRIVATE_OR_VPN');
  if(!Number.isInteger(sshPort)||sshPort<1||sshPort>65535)errors.push('INVALID_SSH_PORT');
  if(hostKeyChecking!=='yes'||batchMode!=='yes'||gatewayPorts!=='no')errors.push('INSECURE_SSH_OPTIONS');
  if(!/^[A-Za-z0-9._-]{1,64}$/.test(sshUser))errors.push('INVALID_SSH_USER');
  if(remoteName&&!isLoopbackName(remoteName))errors.push('REMOTE_FORWARD_TARGET_NOT_LOOPBACK');
  const allowed=[443,5222,26000,26001,26002].sort((a,b)=>a-b);
  const real=forwardings.map(x=>Number(x?.localPort)).sort((a,b)=>a-b);
  if(real.length!==allowed.length||!allowed.every((x,i)=>x===real[i]))errors.push('SSH_FORWARD_PORT_SET_MISMATCH');
  if(forwardings.some(x=>!isLoopback(x?.localHost)||!isLoopback(x?.remoteHost)||Number(x?.localPort)!==Number(x?.remotePort)))
    errors.push('SSH_FORWARD_NOT_LOOPBACK_SYMMETRIC');
  return {errors:[...new Set(errors)],warnings:[]};
}
function assess({compose,nativeConfig,tunnel}={}){
  const c=validateCompose(compose),a=validateNativeConfig(nativeConfig),t=tunnel?validateTunnel(tunnel):{errors:[],warnings:[]};
  return {ok:c.errors.length+a.errors.length+t.errors.length===0,
    errors:[...c.errors,...a.errors,...t.errors],warnings:[...c.warnings,...a.warnings,...t.warnings],
    inspected:{effectiveCompose:true,nativeConfig:true,tunnel:Boolean(tunnel)},gameVolume:c.gameVolume||null};
}
module.exports={EXPECTED,privatePeer,parseNativeConfig,validateCompose,validateNativeConfig,validateTunnel,assess};
