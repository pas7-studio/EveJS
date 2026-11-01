"use strict";

const fs = require("fs");
const path = require("path");

const INCOMPATIBLE_EXECUTORS = "INCOMPATIBLE_EXECUTORS";

function collectJsFiles(srcRoot) {
  const files = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") {
          walk(full);
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
        files.add(full);
      }
    }
  };
  walk(srcRoot);
  return files;
}

function extractRequireArgs(content) {
  const args = [];
  const re = /require\s*\(/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    let argStart = i;
    while (i < content.length && depth > 0) {
      const c = content[i];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      if (depth === 0) break;
      i++;
    }
    const argText = content.slice(argStart, i);
    const literals = [];
    const strRe = /['"]([^'"]*)['"]/g;
    let s;
    while ((s = strRe.exec(argText)) !== null) {
      literals.push(s[1]);
    }
    if (!literals.length) continue;
    // require(path.join(__dirname, "a", "b")) builds a local path from literals that need not start
    // with "./": joining them keeps the directory-relative meaning of the original expression.
    const fromDirname = argText.includes("__dirname");
    args.push({ value: fromDirname ? literals.join("/") : literals[0], fromDirname });
  }
  return args;
}

function resolveTarget(fileDir, relPath, files) {
  const candidates = [
    path.join(fileDir, relPath),
    path.join(fileDir, relPath) + ".js",
    path.join(fileDir, relPath, "index.js"),
  ];
  for (const c of candidates) {
    if (files.has(c)) return c;
  }
  return null;
}

function toRel(srcRoot, abs) {
  return path.relative(srcRoot, abs).split(path.sep).join("/");
}

function buildRequireGraph({ srcRoot, entryFile }) {
  if (typeof srcRoot !== "string" || typeof entryFile !== "string") {
    throw new TypeError("srcRoot and entryFile are required");
  }
  if (!fs.existsSync(entryFile)) {
    throw new TypeError("srcRoot and entryFile are required");
  }

  const files = collectJsFiles(srcRoot);
  const fileSet = new Set(files);
  const edges = {};

  for (const f of files) {
    const content = fs.readFileSync(f, "utf8");
    const fileDir = path.dirname(f);
    const rel = toRel(srcRoot, f);
    const relArgs = extractRequireArgs(content).filter(
      (a) => a.fromDirname || a.value.startsWith(".") || a.value.startsWith("/"),
    );
    const targets = [];
    for (const a of relArgs) {
      const t = resolveTarget(fileDir, a.value, fileSet);
      if (t) targets.push(toRel(srcRoot, t));
    }
    if (targets.length) {
      edges[rel] = [...new Set(targets)].sort();
    }
  }

  const reachable = new Set();
  const queue = [entryFile];
  reachable.add(toRel(srcRoot, entryFile));
  while (queue.length) {
    const cur = queue.shift();
    const rel = toRel(srcRoot, cur);
    const deps = edges[rel] || [];
    for (const d of deps) {
      if (!reachable.has(d)) {
        reachable.add(d);
        queue.push(path.join(srcRoot, d));
      }
    }
  }

  const all = [...fileSet].map((f) => toRel(srcRoot, f)).sort();
  const sortedReach = [...reachable].sort();
  const unreachable = all.filter((x) => !reachable.has(x));

  return {
    entry: entryFile,
    srcRoot: path.resolve(srcRoot),
    files: files.size,
    reachable: sortedReach,
    unreachable,
    edges,
  };
}

function unreachableModules(graph, prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return [];
  // graph.unreachable holds srcRoot-relative posix paths, while callers pass absolute directories:
  // compare both forms or every prefix silently matches nothing.
  const relatives = [];
  for (const prefix of prefixes) {
    const value = String(prefix);
    relatives.push(value.replace(/\\/g, "/"));
    if (path.isAbsolute(value) && graph && typeof graph.srcRoot === "string") {
      relatives.push(path.relative(graph.srcRoot, value).split(path.sep).join("/"));
    }
  }
  const result = new Set();
  for (const u of graph.unreachable || []) {
    if (typeof u !== "string") continue;
    for (const prefix of relatives) {
      const clean = prefix.replace(/\/$/, "");
      if (clean.length > 0 && (u === clean || u.startsWith(clean + "/"))) result.add(u);
    }
  }
  return [...result].sort();
}

function detectIncompatibleExecutors(registry) {
  // A registry filled from env or config usually carries "true"/1, not a boolean; a missing owner must
  // not collapse two executors into one, because [] is the answer that reads as "compatible".
  const ENABLED = new Set([true, "true", 1, "1"]);
  const groups = new Map();
  for (const e of registry || []) {
    if (!e || typeof e !== "object") continue;
    if (e.phase === undefined || e.phase === null) continue;
    if (!ENABLED.has(e.enabled)) continue;
    const phase = String(e.phase);
    if (!groups.has(phase)) groups.set(phase, []);
    groups.get(phase).push(
      typeof e.owner === "string" && e.owner.length > 0 ? e.owner : "<unnamed>",
    );
  }
  const out = [];
  for (const [phase, owners] of groups) {
    if (owners.length > 1) {
      out.push({ phase, owners: [...owners].sort() });
    }
  }
  out.sort((a, b) => (a.phase < b.phase ? -1 : a.phase > b.phase ? 1 : 0));
  return out;
}

module.exports = {
  buildRequireGraph,
  unreachableModules,
  detectIncompatibleExecutors,
  INCOMPATIBLE_EXECUTORS,
};
