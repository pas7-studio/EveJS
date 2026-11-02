'use strict';

const fs = require('fs');
const path = require('path');

const UNSAFE_FLAG_PARSING = 'UNSAFE_FLAG_PARSING';
const FLAG_NOT_FOUND = 'FLAG_NOT_FOUND';

const FLAG_RE = /EVEJS_[A-Z0-9_]+/g;

function collectFlags(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  let m;
  while ((m = FLAG_RE.exec(text)) !== null) {
    seen.add(m[0]);
  }
  return Array.from(seen).sort();
}

function classifyFlagUsage(text, flag) {
  const result = { flag, mode: FLAG_NOT_FOUND, sample: '' };
  if (typeof text !== 'string') return result;
  const idx = text.indexOf(flag);
  if (idx === -1) return result;
  const start = idx + flag.length;
  const sample = text.slice(start, start + 80);
  result.sample = sample;
  if (/!==?\s*['"]?1/.test(sample)) {
    result.mode = 'STRICT_ONE_NEGATED';
  } else if (/===?\s*['"]?1/.test(sample)) {
    result.mode = 'STRICT_ONE';
  } else if (/===?\s*['"]?true/.test(sample)) {
    result.mode = 'STRICT_TRUE';
  } else {
    result.mode = 'OTHER';
  }
  return result;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
}

function auditFlags({ srcRoot }) {
  if (!isDirectory(srcRoot)) {
    throw new TypeError('srcRoot must be a directory');
  }

  const files = [];
  walk(srcRoot, files);

  const flagData = new Map();
  for (const file of files) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    const content = fs.readFileSync(file, 'utf8');
    for (const flag of collectFlags(content)) {
      const mode = classifyFlagUsage(content, flag).mode;
      if (!flagData.has(flag)) {
        flagData.set(flag, { files: new Set(), modes: new Set() });
      }
      const d = flagData.get(flag);
      d.files.add(rel);
      d.modes.add(mode);
    }
  }

  const flags = [];
  for (const [flag, d] of flagData) {
    const modes = Array.from(d.modes).sort();
    const parsedStrictly = modes.every(
      (m) => m === 'STRICT_ONE' || m === 'STRICT_ONE_NEGATED' || m === 'STRICT_TRUE'
    );
    const unsafe = modes.some((m) => m === 'OTHER');
    flags.push({
      flag,
      files: Array.from(d.files).sort(),
      modes,
      parsedStrictly,
      unsafe,
    });
  }
  flags.sort((a, b) => (a.flag < b.flag ? -1 : a.flag > b.flag ? 1 : 0));

  const unsafeFlags = flags.filter((f) => f.unsafe);
  const totals = {
    flags: flags.length,
    unsafe: unsafeFlags.length,
  };
  const blocking = unsafeFlags.map((f) => f.flag).sort();

  return { flags, totals, blocking };
}

module.exports = {
  collectFlags,
  classifyFlagUsage,
  auditFlags,
  UNSAFE_FLAG_PARSING,
  FLAG_NOT_FOUND,
};
