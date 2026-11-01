'use strict';
const { createJournal } = require("./coopEconomyJournal");

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function isPositiveSafeInteger(value) {
    return typeof value === 'number'
        && Number.isInteger(value)
        && value > 0
        && value <= MAX_SAFE_INTEGER;
}

function isNonEmptyId(value) {
    return typeof value === 'string' && value.length > 0;
}

function byContractID(a, b) {
    if (a.contractID < b.contractID) return -1;
    if (a.contractID > b.contractID) return 1;
    return 0;
}

function createBoard(options) {
    // a published contract must survive a restart, or its funding is orphaned
  const contracts = createJournal(options && options.journal);

    function publish(input) {
        const { contractID, typeID, stationID, quantity, unitPriceCents, expiryTick, status } = input || {};

        if (status !== 'FUNDED') {
            return { ok: false, code: 'NOT_FUNDED' };
        }

        if (!isNonEmptyId(contractID)
            || !isNonEmptyId(typeID)
            || !isNonEmptyId(stationID)
            || !isPositiveSafeInteger(quantity)
            || !isPositiveSafeInteger(unitPriceCents)
            || !isPositiveSafeInteger(expiryTick)) {
            return { ok: false, code: 'INVALID_CONTRACT' };
        }

        contracts.set(contractID, {
            contractID,
            typeID,
            stationID,
            quantity,
            unitPriceCents,
            expiryTick,
            status: 'FUNDED',
            leaseID: null,
        });

        return { ok: true, code: 'PUBLISHED' };
    }

    function list(input) {
        const tick = (input && typeof input.tick === 'number') ? input.tick : 0;
        const result = [];

        for (const contract of contracts.values()) {
            if (contract.status !== 'FUNDED') {
                continue;
            }
            if (tick > contract.expiryTick) {
                continue;
            }
            result.push({
                contractID: contract.contractID,
                typeID: contract.typeID,
                stationID: contract.stationID,
                quantity: contract.quantity,
                unitPriceCents: contract.unitPriceCents,
                expiryTick: contract.expiryTick,
            });
        }

        result.sort(byContractID);

        return result;
    }

    function accept(input) {
        const { contractID, playerID, channelID, requestID, tick } = input || {};

        if (channelID !== 'agentMissionRuntime' && channelID !== 'jobBoard') {
            return { ok: false, code: 'UNSUPPORTED_CHANNEL' };
        }

        const contract = contracts.get(contractID);

        if (!contract || tick > contract.expiryTick) {
            return { ok: false, code: 'UNKNOWN_CONTRACT' };
        }

        if (contract.leaseID) {
            return { ok: true, code: 'ALREADY_ACCEPTED', leaseID: contract.leaseID };
        }

        contract.status = 'ACCEPTED';
        contract.leaseID = 'lease:' + contractID + ':' + playerID;

        return {
            ok: true,
            code: 'ACCEPTED',
            leaseID: contract.leaseID,
            channelID,
            requestID,
        };
    }

    return {
        publish,
        list,
        accept,
    };
}

const BOARD_CODE = {
    NOT_FUNDED: 'NOT_FUNDED',
    INVALID_CONTRACT: 'INVALID_CONTRACT',
    PUBLISHED: 'PUBLISHED',
    UNSUPPORTED_CHANNEL: 'UNSUPPORTED_CHANNEL',
    UNKNOWN_CONTRACT: 'UNKNOWN_CONTRACT',
    ALREADY_ACCEPTED: 'ALREADY_ACCEPTED',
    ACCEPTED: 'ACCEPTED',
};

module.exports = { createBoard, BOARD_CODE };
