'use strict';

Object.defineProperty(exports, "__esModule", { value: true });
exports.FEASIBILITY = void 0;
exports.assessFeasibility = assessFeasibility;

exports.FEASIBILITY = { FEASIBLE: "FEASIBLE", INFEASIBLE: "INFEASIBLE" };

function assessFeasibility({ blueprint, materials, jobSlots, facility } = {}) {
    const reasons = new Set();

    // BPO_MISSING: no blueprint or no blueprint.typeID
    if (!blueprint || !blueprint.typeID) {
        reasons.add("BPO_MISSING");
    }

    // FACILITY_UNAVAILABLE: facility missing or facility.available !== true
    if (!facility || facility.available !== true) {
        reasons.add("FACILITY_UNAVAILABLE");
    }

    // NO_JOB_SLOTS: jobSlots is not a positive integer
    if (!Number.isInteger(jobSlots) || jobSlots <= 0) {
        reasons.add("NO_JOB_SLOTS");
    }

    // INSUFFICIENT_MATERIALS: any required material is missing or the available quantity is lower
    if (blueprint && blueprint.materials) {
        for (const typeID of Object.keys(blueprint.materials)) {
            const required = blueprint.materials[typeID];
            const available = materials && materials[typeID];
            if (available === undefined || available === null || available < required) {
                reasons.add("INSUFFICIENT_MATERIALS");
                break;
            }
        }
    }

    const sorted = Array.from(reasons).sort();
    const feasible = sorted.length === 0;

    return {
        feasible,
        status: feasible ? exports.FEASIBILITY.FEASIBLE : exports.FEASIBILITY.INFEASIBLE,
        reasons: sorted,
    };
}

module.exports = exports;
