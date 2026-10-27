"use strict";
// Opt-in authorization fence for the native FitFitting RPC. Does NOT move,
// create, duplicate or grant items. The caller supplies native authoritative
// access decisions; unknown origin or ambiguous custody fails closed.
const id=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
function authorizeFitSource({characterID,ship,descriptor,sourceLocationID,
 sourceLocationVerified,sourceAccessVerified,shipAccessVerified}={}){
 const deny=reason=>({allowed:false,reason});
 if(!id(characterID)||!id(ship?.itemID)||!id(sourceLocationID))
  return deny("FITTING_INVALID_ACTOR_OR_LOCATION");
 if(Number(ship?.categoryID)!==6||Number(ship?.ownerID)!==characterID||
    shipAccessVerified!==true)
  return deny("FITTING_SHIP_NOT_OWNED");
 if(descriptor?.sourceKind!=="inventory"||!descriptor.item)
  return deny("FITTING_SOURCE_UNVERIFIED");
 const item=descriptor.item;
 if(!id(item.itemID)||!id(item.typeID)||!id(item.locationID)||
    !id(item.ownerID)||Number(item.ownerID)!==characterID)
  return deny("FITTING_ITEM_NOT_OWNED");
 if(sourceLocationVerified!==true||sourceAccessVerified!==true)
  return deny("FITTING_SOURCE_ACCESS_DENIED");
 if(Number(item.singleton)!==1&&(!id(item.stacksize)||item.stacksize<1))
  return deny("FITTING_ITEM_QUANTITY_INVALID");
 return {allowed:true,reason:"OWNED_NATIVE_SOURCE_VERIFIED"};
}
module.exports={authorizeFitSource};
