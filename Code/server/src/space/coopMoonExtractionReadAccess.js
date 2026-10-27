"use strict";
// Read-only corporate moon-extraction ACL. Session identity and structure
// ownership are native. This module NEVER changes general structure ACLs.
const pos = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
function authenticatedCorp(session) {
  if (!session || typeof session !== "object" || session.socket?.destroyed === true ||
      !pos(session.characterID ?? session.charid ?? session.charID)) return null;
  const values = [session.corporationID, session.corpid, session.corpID]
    .filter(value => value !== undefined && value !== null && value !== 0 && value !== "0")
    .map(pos);
  if (!values.length || values.some(value => !value) || new Set(values).size !== 1)
    return null;
  return values[0];
}
function reject(throwUserError) {
  if (typeof throwUserError === "function") throwUserError("StructureDefenseDenied");
  throw Error("MOON_EXTRACTION_READ_DENIED");
}
function assertCorpRead(session, corporationID, throwUserError) {
  const requester = authenticatedCorp(session);
  if (!requester || !pos(corporationID) || requester !== pos(corporationID))
    return reject(throwUserError);
  return true;
}
function assertStructureRead(session, structureID, structureState, throwUserError) {
  const requester = authenticatedCorp(session), id = pos(structureID);
  if (!requester || !id || !structureState ||
      typeof structureState.getStructureByID !== "function")
    return reject(throwUserError);
  let structure = null;
  try { structure = structureState.getStructureByID(id, {refresh:false}); }
  catch (_) { return reject(throwUserError); }
  if (!structure || pos(structure.structureID) !== id) return reject(throwUserError);
  // Conflicting owner aliases are corruption, NOT a way to pick one of them.
  const owners = [structure.ownerCorpID, structure.ownerID]
    .filter(value => value !== undefined && value !== null && value !== 0 && value !== "0")
    .map(pos);
  if (!owners.length || owners.some(value => !value) ||
      new Set(owners).size !== 1 || requester !== owners[0]) return reject(throwUserError);
  return true;
}
function assertMoonProfileBound(structureID, profile, structure, throwUserError) {
  const id=pos(structureID);
  const owners = [structure?.ownerCorpID, structure?.ownerID]
    .filter(value => value !== undefined && value !== null && value !== 0 && value !== "0")
    .map(pos);
  const owner = owners.length > 0 && owners.every(value => value === owners[0])
    ? owners[0] : null;
  const moonID=pos(profile?.moonID), profileOwner=pos(profile?.ownerID),
    systemID=pos(structure?.solarSystemID), profileSystem=pos(profile?.solarSystemID);
  if (!id || pos(profile?.structureID) !== id || pos(structure?.structureID) !== id || !owner || !moonID ||
      profileOwner !== owner || !systemID || profileSystem !== systemID ||
      (pos(structure?.moonID) && pos(structure.moonID) !== moonID))
    return reject(throwUserError);
  return true;
}
module.exports = {authenticatedCorp, assertCorpRead, assertStructureRead, assertMoonProfileBound};
