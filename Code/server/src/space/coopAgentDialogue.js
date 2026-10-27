"use strict";
// Server-side substitution for authored agent dialogue.
//
// Mission text from the missionAuthority static tables carries placeholders
// such as "{[character]player.name}". They are not client localization
// tokens: the client prints them literally, so a pilot reads
// "Good of you to stop by, {[character]player.name}!".
//
// This module only fills the value the server already knows. Other authored
// tokens ([location]..., [npcOrganization]...) need their own resolution and
// are deliberately left untouched.
const TOKEN = /\{\[character\]player\.name\}/g;

let pendingSession = null;

function characterName(session) {
  return String((session && (session.characterName || session.userName)) || "").trim();
}

function render(text, session) {
  if (typeof text !== "string" || text.indexOf("{[character]") === -1) {
    return text;
  }
  const name = characterName(session);
  if (!name) {
    return text;
  }
  return text.replace(TOKEN, name);
}

// Set once per DoAction request; consumed by the first tuple that needs it so
// a stale session can never leak into a later response.
function enter(session) {
  pendingSession = session || null;
}

function applyToTuple(tuple) {
  const session = pendingSession;
  pendingSession = null;
  if (!tuple || !Array.isArray(tuple.items) || tuple.items.length === 0) {
    return tuple;
  }
  tuple.items[0] = render(tuple.items[0], session);
  return tuple;
}

module.exports = { enter, applyToTuple, render };
