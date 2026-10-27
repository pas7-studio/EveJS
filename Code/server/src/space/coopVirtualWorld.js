"use strict";
// Offline virtual pilots: deterministic, bounded world-state only.
// Physical ships are exclusively owned by native EveJS when a scene is observed.
const fs=require("node:fs"),path=require("node:path");
function integer(v){const x=Number(v);return Number.isSafeInteger(x)&&x>0?x:null;}
const CALLSIGNS=["Rook","Ember","Kestrel","Nyx","Solace","Vega","Drift","Mara","Orion","Talon","Iris","Harrow","Sable","Arden","Rift","Cinder"];
const SURNAMES=["Voss","Kade","Renn","Vale","Nadir","Soren","Rooke","Hale","Morrow","Quill","Tarin","Fenn","Keir","Dane","Solan","Vey"];
function pilotName(i){return CALLSIGNS[i%CALLSIGNS.length]+" "+SURNAMES[(i*5+Math.floor(i/CALLSIGNS.length)*7+3)%SURNAMES.length]+(i>=256?" "+String(i+1):"");}
function factionFor(index){return Math.floor(index/2)%2?"frontier":"independent";}
function createWorld({file,route,population=16,clock=()=>Date.now(),travelMs=120000,migrateFactions=false}){
 if(!file||!Array.isArray(route)||route.length<2||route.some(x=>!integer(x)))throw Error("valid route and file required");
 if(!Number.isInteger(population)||population<1||population>100)throw Error("population cap 1..100");
 if(!Number.isInteger(travelMs)||travelMs<10000)throw Error("travelMs must be >= 10000");
 const persist=s=>{fs.mkdirSync(path.dirname(file),{recursive:true});const t=file+".tmp-"+process.pid;fs.writeFileSync(t,JSON.stringify(s));fs.renameSync(t,file);};
 const makePilot=(i,now)=>({
   id:"coop-pilot-"+String(i+1).padStart(3,"0"),
   name:pilotName(i),
   faction:factionFor(i),
   routeIndex:i%route.length,
   systemID:route[i%route.length],
   nextMoveAt:now+travelMs*(1+(i%4)),
   journeys:0
 });
 let state;
 try{state=JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}
 if(!state){
   const now=clock();
   state={version:1,factionLayoutVersion:2,lastAdvancedAt:now,pilots:Array.from({length:population},(_,i)=>makePilot(i,now))};
   persist(state);
 }
 if(state.version!==1||!Array.isArray(state.pilots)||state.pilots.length>100)throw Error("invalid saved world");
 // The old 2-system layout accidentally assigned all NPCs in each system
 // to the same faction, making cross-faction encounters nearly impossible.
 // Preserve existing pilot identity, ship mapping, journeys and prior history.
 if(state.factionLayoutVersion!==2&&migrateFactions){
   const backup=file+".pre-faction-layout-v2.bak";
   const original=fs.readFileSync(file,"utf8");
   // Never silently overwrite an owner's previous backup.
   if(fs.existsSync(backup)){
     if(fs.readFileSync(backup,"utf8")!==original)
       throw Error("faction backup already exists with different world state");
   }else fs.writeFileSync(backup,original,{encoding:"utf8",flag:"wx"});
   for(const pilot of state.pilots){
     const match=/^coop-pilot-([0-9]{3,})$/.exec(String(pilot.id));
     const index=match?Number(match[1])-1:-1;
     if(index>=0&&Number.isSafeInteger(index)&&
        pilot.faction===(index%2?"frontier":"independent"))
       pilot.faction=factionFor(index);
   }
   state.factionLayoutVersion=2;
   state.factionLayoutMigratedAt=clock();
   persist(state);
 }
 // Increase population on upgrades without wiping established pilot history
 // or destroying already materialized native ships.
 if(state.pilots.length<population){
   const now=clock(),ids=new Set(state.pilots.map(p=>p.id));
   for(let i=0;state.pilots.length<population&&i<100;i++){
     const candidate=makePilot(i,now);
     if(!ids.has(candidate.id)){state.pilots.push(candidate);ids.add(candidate.id);}
   }
   persist(state);
 }
 function advance(physicalLocations={}){
   const now=clock();
   if(now<state.lastAdvancedAt)return {status:"CLOCK_REWIND",moves:0};
   let moves=0;
   for(const pilot of state.pilots){
     // A physically materialized native ship is authoritative. Do not
     // virtual-jump its pilot to a different system behind players' backs.
     const live=Number(physicalLocations[pilot.id]);
     if(Number.isSafeInteger(live)&&live>0){
       if(pilot.systemID!==live){pilot.systemID=live;moves++;} 
       pilot.nextMoveAt=now+travelMs;
       continue;
     }
     // Mathematical catch-up, not per-tick replay; bounded by elapsed time.
     if(now>=pilot.nextMoveAt){
       const steps=Math.floor((now-pilot.nextMoveAt)/travelMs)+1;
       pilot.routeIndex=(pilot.routeIndex+steps)%route.length;
       pilot.systemID=route[pilot.routeIndex];
       pilot.nextMoveAt+=steps*travelMs;
       pilot.journeys+=steps;
       moves+=steps;
     }
   }
   state.lastAdvancedAt=now;
   if(moves||Object.keys(physicalLocations).length)persist(state);
   return {status:"OK",moves};
 }
 function residents(systemID){return state.pilots.filter(p=>p.systemID===integer(systemID)).map(p=>({...p}));}
 return {advance,residents,snapshot:()=>structuredClone(state)};
}
module.exports={createWorld};
