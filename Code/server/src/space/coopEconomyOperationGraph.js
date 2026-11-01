'use strict';

const GRAPH_CODE = {
  OK: 'OK',
  INVALID_OPERATION: 'INVALID_OPERATION',
  DUPLICATE_OPERATION: 'DUPLICATE_OPERATION',
  UNKNOWN_DEPENDENCY: 'UNKNOWN_DEPENDENCY',
  CYCLE: 'CYCLE',
};

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function createGraph() {
  const operations = new Map();

  function add(input) {
    const operationID = input && input.operationID;
    const resourceKeys = input && input.resourceKeys;
    const dependencies = input && input.dependencies;

    const valid =
      isNonEmptyString(operationID) &&
      Array.isArray(resourceKeys) &&
      resourceKeys.every(isNonEmptyString) &&
      Array.isArray(dependencies) &&
      dependencies.every(isNonEmptyString);

    if (!valid) {
      return { ok: false, code: GRAPH_CODE.INVALID_OPERATION };
    }

    if (operations.has(operationID)) {
      return { ok: false, code: GRAPH_CODE.DUPLICATE_OPERATION };
    }

    operations.set(operationID, {
      resourceKeys: resourceKeys.slice(),
      dependencies: dependencies.slice(),
    });

    return { ok: true, code: GRAPH_CODE.OK };
  }

  function order() {
    const ids = Array.from(operations.keys());
    const idSet = new Set(ids);

    // Detect unknown dependencies first.
    const missing = new Set();
    for (const id of ids) {
      const deps = operations.get(id).dependencies;
      for (const d of deps) {
        if (!idSet.has(d)) {
          missing.add(d);
        }
      }
    }

    if (missing.size > 0) {
      return {
        ok: false,
        code: GRAPH_CODE.UNKNOWN_DEPENDENCY,
        missing: Array.from(missing).sort(),
      };
    }

    // Build dependents map and in-degrees (edge: dependency -> dependent).
    const dependents = new Map();
    const inDegree = new Map();
    for (const id of ids) {
      dependents.set(id, []);
      inDegree.set(id, 0);
    }
    for (const id of ids) {
      const deps = operations.get(id).dependencies;
      for (const d of deps) {
        dependents.get(d).push(id);
        inDegree.set(id, inDegree.get(id) + 1);
      }
    }

    // Kahn's algorithm with alphabetical tie-breaking.
    const available = ids.filter(function (id) {
      return inDegree.get(id) === 0;
    });
    available.sort();

    const order = [];
    while (available.length > 0) {
      const id = available.shift();
      order.push(id);
      const nexts = dependents.get(id).slice().sort();
      for (const dep of nexts) {
        const newDeg = inDegree.get(dep) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) {
          const arr = available;
          let lo = 0;
          let hi = arr.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < dep) {
              lo = mid + 1;
            } else {
              hi = mid;
            }
          }
          arr.splice(lo, 0, dep);
        }
      }
    }

    if (order.length !== ids.length) {
      // Remaining nodes participate in a cycle.
      const remaining = ids.filter(function (id) {
        return inDegree.get(id) > 0;
      });

      const adj = new Map();
      for (const id of remaining) {
        adj.set(id, []);
      }
      for (const id of remaining) {
        const deps = operations.get(id).dependencies;
        for (const d of deps) {
          if (remaining.indexOf(d) !== -1) {
            adj.get(id).push(d);
          }
        }
      }

      const cycle = findCycle(remaining, adj);
      return {
        ok: false,
        code: GRAPH_CODE.CYCLE,
        cycle: cycle.sort(),
      };
    }

    return { ok: true, code: GRAPH_CODE.OK, order: order };
  }

  function findCycle(remaining, adj) {
    const visited = new Set();
    const recStack = [];
    const recSet = new Set();

    function dfs(node) {
      visited.add(node);
      recStack.push(node);
      recSet.add(node);
      for (const next of adj.get(node)) {
        if (recSet.has(next)) {
          const idx = recStack.indexOf(next);
          return recStack.slice(idx);
        }
        if (!visited.has(next)) {
          const res = dfs(next);
          if (res) {
            return res;
          }
        }
      }
      recStack.pop();
      recSet.delete(node);
      return null;
    }

    for (const id of remaining) {
      if (!visited.has(id)) {
        const res = dfs(id);
        if (res) {
          return res;
        }
      }
    }
    return remaining;
  }

  function dependentsOf(id) {
    const result = [];
    for (const opId of operations.keys()) {
      const deps = operations.get(opId).dependencies;
      if (deps.indexOf(id) !== -1) {
        result.push(opId);
      }
    }
    return result.sort();
  }

  return {
    add: add,
    order: order,
    dependentsOf: dependentsOf,
  };
}

module.exports = { createGraph: createGraph, GRAPH_CODE: GRAPH_CODE };
