'use strict';
const { createJournal } = require("./coopEconomyJournal");

/**
 * createQuarantine() returns an object that tracks quarantined operations.
 * State is held in a private Map(operationID -> { resourceKeys, reason, resolved }).
 * A quarantine never deletes state and never unblocks itself.
 */
function createQuarantine(options) {
  const durable = options && options.journal;
  const namespaced = (prefix) => {
    if (!durable) return undefined;
    return {
      get: (k) => durable.get(prefix + k),
      set: (k, v) => durable.set(prefix + k, v),
      has: (k) => (typeof durable.has === "function" ? durable.has(prefix + k) : durable.get(prefix + k) !== undefined),
      delete: (k) => (typeof durable.delete === "function" ? durable.delete(prefix + k) : undefined),
      entries: () => (typeof durable.entries === "function"
        ? [...durable.entries()].filter((e) => String(e[0]).startsWith(prefix))
            .map((e) => [String(e[0]).slice(prefix.length), e[1]])
        : []),
    };
  };
    const entries = createJournal(namespaced("entry:"));

    function validateResourceKeys(resourceKeys) {
        return Array.isArray(resourceKeys) &&
            resourceKeys.every(function (k) {
                return typeof k === 'string' && k.length > 0;
            });
    }

    function isNonEmptyString(value) {
        return typeof value === 'string' && value.length > 0;
    }

    function quarantine(input) {
        const operationID = input && input.operationID;
        const resourceKeys = input && input.resourceKeys;

        if (!isNonEmptyString(operationID)) {
            return { ok: false, code: "INVALID_OPERATION" };
        }
        if (!validateResourceKeys(resourceKeys)) {
            return { ok: false, code: "INVALID_OPERATION" };
        }

        const replaced = entries.has(operationID);
        entries.set(operationID, {
            resourceKeys: resourceKeys.slice(),
            reason: input && input.reason,
            resolved: false
        });

        return { ok: true, code: "QUARANTINED", replaced: replaced };
    }

    function isBlocked(resourceKey) {
        if (!isNonEmptyString(resourceKey)) {
            return false;
        }
        for (const entry of entries.values()) {
            if (entry.resolved) {
                continue;
            }
            for (const key of entry.resourceKeys) {
                if (key === resourceKey) {
                    return true;
                }
            }
        }
        return false;
    }

    function blockingKeys() {
        const keys = new Set();
        for (const entry of entries.values()) {
            if (entry.resolved) {
                continue;
            }
            for (const key of entry.resourceKeys) {
                keys.add(key);
            }
        }
        return Array.from(keys).sort();
    }

    function resolve(operationID, evidence) {
        if (!isNonEmptyString(evidence)) {
            return { ok: false, code: "EVIDENCE_REQUIRED" };
        }
        const entry = entries.get(operationID);
        if (!entry) {
            return { ok: false, code: "EVIDENCE_REQUIRED" };
        }
        entry.resolved = true;
        return { ok: true, code: "RESOLVED" };
    }

    function open() {
        const ids = [];
        for (const [operationID, entry] of entries) {
            if (!entry.resolved) {
                ids.push(operationID);
            }
        }
        return ids.sort();
    }

    function resolved() {
        const ids = [];
        for (const [operationID, entry] of entries) {
            if (entry.resolved) {
                ids.push(operationID);
            }
        }
        return ids.sort();
    }

    return {
        quarantine: quarantine,
        isBlocked: isBlocked,
        blockingKeys: blockingKeys,
        resolve: resolve,
        open: open,
        resolved: resolved
    };
}

module.exports = { createQuarantine };
