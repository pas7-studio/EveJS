"use strict";
// CH38: strictly native NPE identity/state; never grant starter rewards here.
// In EveJS, selected character IDs are server session data, not arbitrary RPC arguments.
const pos = x => Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0;
function getRecord(id, explicit) {
  if (typeof explicit === 'function') return explicit(id);
  return require('../services/character/characterState').getCharacterRecord(id);
}
function resolveCharacterID(args, session, options = {}) {
  const charID = pos(session && session.characterID);
  const aliasID = pos(session && session.charid);
  const claimed = Array.isArray(args) && args.length ? pos(args[0]) : 0;
  if (!charID && !aliasID) throw Error('COOP38_SELECTED_CHARACTER_REQUIRED');
  if (charID && aliasID && charID !== aliasID) throw Error('COOP38_SESSION_CHARACTER_CONFLICT');
  const selected = charID || aliasID;
  if (claimed && claimed !== selected) throw Error('COOP38_FOREIGN_CHARACTER_DENIED');
  if (session && session.socket && session.socket.destroyed === true)
    throw Error('COOP38_DISCONNECTED_SESSION');
  const userID = pos(session && session.userid);
  if (!userID) throw Error('COOP38_ACCOUNT_REQUIRED');
  const record = getRecord(selected, options.getCharacterRecord);
  if (!record || pos(record.accountId ?? record.accountID) !== userID)
    throw Error('COOP38_ACCOUNT_CHARACTER_MISMATCH');
  return selected;
}
function currentTutorialState(args, session, options = {}) {
  const id = resolveCharacterID(args, session, options);
  const getter = options.getSnapshot || (x => require('../services/npe/tutorialRuntime').getCharacterTutorialSnapshot(x));
  const snapshot = getter(id);
  if (!snapshot || snapshot.exists !== true || !Number.isSafeInteger(snapshot.tutorialState))
    throw Error('COOP38_NATIVE_TUTORIAL_STATE_UNAVAILABLE');
  return snapshot.tutorialState;
}
function supportedEnvironment(options = {}) {
  // This does not assert that a compatible client can load Starter Space.
  const state = options.snapshot || null;
  return {nativeTutorialState: Boolean(state && state.exists),
    starterSpaceVerified: false, starterRewardsIssuedByCoop: false};
}
module.exports = {resolveCharacterID, currentTutorialState, supportedEnvironment};
