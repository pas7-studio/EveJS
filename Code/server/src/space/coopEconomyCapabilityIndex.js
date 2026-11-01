'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CAPABILITY_FAMILIES = [
  {
    id: 'extraction',
    title: 'Extraction',
    modules: [
      'space/coopNativeMiningAtomic',
      'space/coopNativeMiningFleetDurable',
      'space/coopMiningDemandGovernor',
    ],
  },
  {
    id: 'ore_custody',
    title: 'Ore custody',
    modules: [
      'space/coopNativeHaulCargo',
      'space/coopNativeDepot',
      'space/coopNativeWarehouse',
      'space/coopNativeStationOreSettlement',
    ],
  },
  {
    id: 'refinery',
    title: 'Refinery',
    modules: [
      'space/coopNpcRefineryRuntime',
      'space/coopNpcRefineryTick',
    ],
  },
  {
    id: 'factory',
    title: 'Factory',
    modules: [
      'space/coopNpcManufacturingPlanner',
      'space/coopNpcManufacturingNative',
      'space/coopNpcIndustryNativeBindings',
    ],
  },
  {
    id: 'manual_bridge',
    title: 'Manual-to-live bridge',
    modules: [
      'space/coopNpcNativeEconomyDirector',
      'space/coopNpcIndustryOriginalStageExecutor',
      'space/coopNpcLiveFactoryReadiness',
      'space/coopAlifeNativeManufacturingRuntime',
    ],
  },
  {
    id: 'demand',
    title: 'Demand',
    modules: [
      'space/coopNpcDemandAuthority',
      'space/coopNpcInputSupply',
      'space/coopAlifeStationAuthorityRuntime',
    ],
  },
  {
    id: 'market',
    title: 'Market',
    modules: [
      'space/coopNpcBuyerCoordinator',
      'space/coopNpcCorporateSettlement',
      'space/coopNpcMarketPolicy',
      'space/coopNpcIndustryOriginalRustSell',
    ],
  },
  {
    id: 'logistics',
    title: 'Logistics',
    modules: [
      'space/coopNpcDistribution',
      'space/coopDistributionRun',
      'space/coopNpcMineralLift',
      'space/coopNpcGateCrossing',
    ],
  },
  {
    id: 'treasury',
    title: 'Corporate funds',
    modules: [
      'space/coopNpcCorpTreasury',
      'space/coopCorpWallet',
      'space/coopNpcCorporateBuyerAtomic',
    ],
  },
  {
    id: 'alife',
    title: 'A-Life',
    modules: [
      'space/coopAlifeEconomy',
      'space/coopAlifeEconomySensor',
      'space/coopAlifeNativeEconomyAct',
      'space/coopAlifeNativeBuyerDispatch',
    ],
  },
  {
    id: 'scheduling',
    title: 'Scheduling',
    modules: [
      'space/coopLoopTick',
      'space/coopLoopDriver',
      'space/coopLivingWorldPhaseCoordinator',
      'space/coopNpcEconomyScheduler',
    ],
  },
  {
    id: 'player_entry',
    title: 'Player entry',
    modules: [
      'space/coopNpcJobBoard',
      'space/coopEscortRuntime',
      'services/agent/agentMissionRuntime',
    ],
  },
  {
    id: 'audit',
    title: 'Audit',
    modules: [
      'space/coopEconomyConservationAudit',
    ],
  },
];

function buildCapabilityIndex({ srcRoot }) {
  if (typeof srcRoot !== 'string' || !fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
    throw new TypeError('srcRoot must be a directory');
  }

  const EVEJS_RE = /EVEJS_[A-Z0-9_]+/g;

  const families = CAPABILITY_FAMILIES.map((family) => {
    const modules = family.modules.map((modulePath) => {
      const full = path.join(srcRoot, modulePath + '.js');
      let bytes = 0;
      let flags = [];
      let exists = false;
      try {
        if (fs.existsSync(full)) {
          const text = fs.readFileSync(full, 'utf8');
          const found = new Set();
          for (const m of text.matchAll(EVEJS_RE)) {
            found.add(m[0]);
          }
          flags = Array.from(found).sort();
          bytes = fs.statSync(full).size;
          exists = true;
        }
      } catch {
        // ignore read errors; treat as missing
      }
      return {
        path: modulePath,
        exists,
        bytes,
        flags,
      };
    });

    const missing = modules.filter((m) => !m.exists).map((m) => m.path);

    return {
      id: family.id,
      title: family.title,
      modules,
      missing,
      status: missing.length > 0 ? 'MISSING_MODULE' : 'CODE_CONFIRMED',
      runtime: 'UNKNOWN',
    };
  });

  const totals = {
    families: families.length,
    modules: families.reduce((n, f) => n + f.modules.length, 0),
    missing: families.reduce((n, f) => n + f.missing.length, 0),
  };

  return {
    version: 1,
    families,
    totals,
  };
}

function toMarkdown(index) {
  const header = '| family | title | modules | missing | runtime |';
  const separator = '| --- | --- | --- | --- | --- |';
  const rows = index.families.map((f) => {
    const modules = f.modules.map((m) => m.path).join(', ');
    const missing = f.missing.length ? f.missing.join(', ') : '-';
    return `| ${f.id} | ${f.title} | ${modules} | ${missing} | ${f.runtime} |`;
  });

  return [header, separator, ...rows].join('\n');
}

module.exports = { CAPABILITY_FAMILIES, buildCapabilityIndex, toMarkdown };
