"use strict";
// FW-057 (review): one predicate for everyone who can earn war money.
//
// The war money chain knew only NPC pilots. `coopMilitiaWarPlayer` proves a real
// player kill and names it `coop-player-<characterID>`, but every ledger behind it
// rejected that shape: `coopWarKillMerit.pilotOf`, `coopWarBounty.pilotOf`,
// `coopWarChestFunding.creditPilot` and the market earned ledger all used the NPC
// regex `/^coop-pilot-[0-9]{3,}$/`. A player could therefore be killed, kill, and
// earn merit in the war state while the payout path refused the identity it was
// handed. NPC-only features keep the strict predicate; the money chain takes both.
const NPC_PILOT = /^coop-pilot-[0-9]{3,}$/;
const PLAYER_PILOT = /^coop-player-[0-9]{3,}$/;

const isNpcPilotID = (value) => typeof value === "string" && NPC_PILOT.test(value);
const isPlayerPilotID = (value) => typeof value === "string" && PLAYER_PILOT.test(value);
const isWarPilotID = (value) => isNpcPilotID(value) || isPlayerPilotID(value);

module.exports = { isNpcPilotID, isPlayerPilotID, isWarPilotID };
