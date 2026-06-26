#!/usr/bin/env node
// graphify-bridge — join the federated graph's disconnected repo islands to the
// Obsidian vault's Projects/* notes, and render named, navigable graphs.
//
// graphify federation is a UNION, not a join: ~/.graphify/global-graph.json holds
// every repo + the vault in one file but with ZERO cross-tag edges, so each repo
// floats apart from the Project note that tracks it. This script adds the missing
// bridge edges (repo-anchor -> Projects/<area>/<name>.md) and emits three views:
//
//   1. per-repo graph.html — for EACH repo, that repo's own graph joined to the
//      vault Projects MOC (the .md docs only), with a bridge edge to its Project
//      note. This is the primary view. Output:
//      ~/.graphify/repo-bridged/<repo>/graphify-out/graph.html
//   2. merged graph.html — every repo + the vault docs in one bridged graph, via
//      `graphify cluster-only`. Output: ~/.graphify/bridged/graphify-out/graph.html
//   3. .canvas — native Obsidian Canvas: each Project a file-card pointing at the
//      REAL vault note, each repo a card linking to its per-repo graph.html.
//      Output: <vault>/_graphify/repos-to-projects.canvas
//
// Three things this does beyond a raw `cluster-only`:
//   - DROPS the vault's .obsidian/* plugin nodes (609 of 648) — keeps only the
//     .md docs (Projects MOC, Resources, Home, CLAUDE) that actually track repos.
//   - NAMES communities from node content (nameCommunities) so graph.html never
//     shows "Community N". graphify reassigns community integers on every rebuild
//     and `cluster-only --no-label` writes placeholders, so naming runs AFTER it.
//   - bundles the vault docs into one "Vault Projects / docs" group per per-repo
//     graph for a legible connection.
//
//   node scripts/graphify-bridge.mjs              # build all three views
//   node scripts/graphify-bridge.mjs --no-html    # canvas only (skip graph render)
//   node scripts/graphify-bridge.mjs --no-repos   # merged + canvas, skip per-repo
//   node scripts/graphify-bridge.mjs --dry        # print the match table, write nothing
//
// The .canvas lands in the vault's throwaway _graphify/ folder (regenerated; keep
// it git-ignored) — graphify's own graph artifacts stay out of the vault (§8).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const HOME = os.homedir();
const GLOBAL = path.join(HOME, ".graphify", "global-graph.json");
const BRIDGED_DIR = path.join(HOME, ".graphify", "bridged");
const BRIDGED_OUT = path.join(BRIDGED_DIR, "graphify-out");
const REPO_BRIDGED = path.join(HOME, ".graphify", "repo-bridged");
const CANVAS_SUBDIR = "_graphify";
const CANVAS_NAME = "repos-to-projects.canvas";
// graphify resolves under a minimal PATH too (pipx) so timer/systemd runs work.
const GRAPHIFY = fs.existsSync(path.join(HOME, ".local/bin/graphify"))
  ? path.join(HOME, ".local/bin/graphify") : "graphify";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const NO_HTML = args.has("--no-html");
const NO_REPOS = args.has("--no-repos");

// repo tag -> vault Project note (vault-relative path). Exact name matches resolve
// automatically below; this table holds the fuzzy ones + area-note fallbacks for
// repos with no dedicated Project note yet.
const OVERRIDES = {
  "k3s-cluster": "Projects/Cluster infra in git.md", // no dedicated <repo>.md note
  // browser-extensions: four separate repos, one shared vault counterpart note
  "series-auto-skip": "Projects/Software Engineering/Browser Extensions.md",
  "uninsta": "Projects/Software Engineering/Browser Extensions.md",
  "undiscord": "Projects/Software Engineering/Browser Extensions.md",
  "filelist-ext": "Projects/Software Engineering/Browser Extensions.md",
  "TE": "Projects/Software Business/No7 Portal Migration.md",
  // (apps-page, vaultwarden, tradingview-mcp, social-update now have dedicated
  //  Projects/**/<repo>.md notes, so they auto-match by name — no override needed.)
};

const vaultPath = execSync(`realpath "${HOME}/obsidian.md"`).toString().trim();

const g = JSON.parse(fs.readFileSync(GLOBAL, "utf8"));
const nodes = g.nodes;
const links = g.links;

// The vault federates under a tag = its dir basename ("Obsidian Vault"), which can
// drift on rename and once duplicated a stale "vault" tag. Detect it by content —
// the tag that owns the Projects MOC note — so we never hardcode the tag name.
const VAULT_TAG = (() => {
  const moc = nodes.find((n) => (n.source_file || "") === "Projects/Projects.md");
  return moc ? moc.repo : "vault";
})();

// degree map -> repo anchor = highest-degree node in that repo's island
const deg = {};
for (const e of links) { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1; }

const byRepo = {};
for (const n of nodes) (byRepo[n.repo] = byRepo[n.repo] || []).push(n);

// vault DOC nodes only — the .md MOC. The .obsidian/* plugin config (609 of 648)
// is noise and is dropped from every view.
const isVaultDoc = (n) => n.repo === VAULT_TAG && !(n.source_file || "").startsWith(".obsidian/");
const vaultDocs = nodes.filter(isVaultDoc);
// graphify emits many nodes per note (the file at L1, then one per heading). Map
// each note to its FILE node (lowest source_location), not the last heading.
const lineNo = (n) => parseInt(String(n.source_location || "L999999").replace(/\D/g, ""), 10) || 999999;
const vaultByFile = {};
for (const n of vaultDocs) {
  if (!n.source_file) continue;
  const ex = vaultByFile[n.source_file];
  if (!ex || lineNo(n) < lineNo(ex)) vaultByFile[n.source_file] = n;
}

// Noise denylist: manifest/config/lockfile/CI/test files that graphify explodes into
// one node per key/dep/step — high count, ~zero architectural signal. Dropped from every
// bridged view (same spirit as the .obsidian/* drop). NOTE: content YAML is intentionally
// KEPT — the homelab repos (k3s-cluster, nextcloud, ...) ARE their k8s/docker manifests.
const NOISE = [
  /\.json$/,                                    // package/tsconfig/*.schema/manifest/data — key-explosion
  /(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /(^|\/)\.github\/(?!workflows\/)/,             // .github noise (templates, dependabot) — but KEEP
                                                 // workflows/: they tie repos to k3s (runs-on: arc-*, kubectl)
  /(^|\/)\.[^/]*rc(\.[^/]*)?$/,                  // .eslintrc/.prettierrc/.babelrc/.npmrc/.nvmrc...
  /(^|\/)(eslint|prettier|jest|vitest|babel|postcss|tailwind|vite|rollup|webpack|tsup|next)\.config\.[cm]?[jt]s$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,               // js/ts unit tests
  /(^|\/)(__tests__|__mocks__)\//,
  /(^|\/)test_[^/]*\.py$|_test\.py$/,           // python tests
];
const isNoise = (n) => { const f = n.source_file || ""; return f !== "" && NOISE.some((re) => re.test(f)); };

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// build name->projectNote index from the actual vault Project notes
let projNotes = [];
try {
  projNotes = execSync(`cd "${vaultPath}" && find Projects -type f -name '*.md'`)
    .toString().trim().split("\n").filter(Boolean);
} catch { /* vault unreachable */ }
const projByName = {};
for (const p of projNotes) projByName[norm(path.basename(p, ".md"))] = p;

const repos = Object.keys(byRepo).filter((r) => r !== VAULT_TAG).sort();

const matches = [];
for (const repo of repos) {
  let note = OVERRIDES[repo] || projByName[norm(repo)] || null;
  const how = OVERRIDES[repo] ? "override" : (note ? "auto" : "unmatched");
  const anchor = byRepo[repo].slice().sort((a, b) => (deg[b.id] || 0) - (deg[a.id] || 0))[0];
  matches.push({ repo, note, how, anchor });
}

console.log("repo -> Project note:");
for (const m of matches) {
  const tag = m.how === "override" ? "[override]" : m.how === "auto" ? "[auto]    " : "[NONE]    ";
  console.log(`  ${tag} ${m.repo.padEnd(26)} -> ${m.note || "(no note)"}`);
}

if (DRY) { console.log("\n--dry: nothing written."); process.exit(0); }

// ---------- community naming (so graph.html never shows "Community N") ----------
// Content-based: each community is named after its highest-degree node + dominant
// repo tag. The vault-docs bundle gets a fixed legible name. Deterministic, no LLM.
// Writes <outDir>/.graphify_labels.json, which `graphify export html` reads.
function nameCommunities(outDir, { byRepo = false } = {}) {
  const gp = path.join(outDir, "graph.json");
  const gg = JSON.parse(fs.readFileSync(gp, "utf8"));
  const ek = gg.links ? "links" : "edges";
  const ns = gg.nodes, es = gg[ek] || [];
  const d = {};
  for (const e of es) { d[e.source] = (d[e.source] || 0) + 1; d[e.target] = (d[e.target] || 0) + 1; }
  const comm = {};
  for (const n of ns) { if (n.community == null) continue; (comm[n.community] = comm[n.community] || []).push(n); }
  const clean = (s) => { s = (s || "").trim().replace(/\s+/g, " "); return s.length > 46 ? s.slice(0, 45) + "…" : s; };
  const labels = {};
  for (const c of Object.keys(comm)) {
    const grp = comm[c];
    const repoCount = {};
    for (const n of grp) if (n.repo) repoCount[n.repo] = (repoCount[n.repo] || 0) + 1;
    const ranked = Object.entries(repoCount).sort((a, b) => b[1] - a[1]);
    if (ranked.length && ranked[0][0] === "vault-docs") {
      labels[c] = grp.length > 1 ? `Obsidian Vault (+${grp.length - 1})` : "Obsidian Vault";
      continue;
    }
    // colour-by-repo merged view: one community per repo, labelled with the repo
    if (byRepo) { labels[c] = ranked.length ? ranked[0][0] : `community ${c}`; continue; }
    const hub = grp.slice().sort((a, b) =>
      ((d[b.id] || 0) - (d[a.id] || 0)) || (a.id < b.id ? 1 : -1))[0];
    let tag = "";
    if (ranked.length === 1) tag = ` [${ranked[0][0]}]`;
    else if (ranked.length > 1) tag = ` (mixed: ${ranked.slice(0, 2).map((e) => e[0]).join("/")})`;
    const suffix = grp.length > 1 ? ` +${grp.length - 1}` : "";
    labels[c] = `${clean(hub.label || String(hub.id))}${suffix}${tag}`;
  }
  fs.writeFileSync(path.join(outDir, ".graphify_labels.json"), JSON.stringify(labels));
  return Object.keys(labels).length;
}

const VIZ_NODE_LIMIT = process.env.GRAPHIFY_VIZ_NODE_LIMIT || "200000";
function exportHtml(workDir) {
  // `graphify export html` reads <cwd>/graphify-out/graph.json + .graphify_labels.json.
  // Above its node-limit (CLI default 5000, env GRAPHIFY_VIZ_NODE_LIMIT ignored on this
  // path) it collapses the graph to a one-node-per-community meta-graph. The merged
  // vault+repos graph blows past 5000, so pass --node-limit to keep the FULL node set in
  // graph.html (we want the big graph; viz perf is the browser's problem).
  execSync(`"${GRAPHIFY}" export html --node-limit ${VIZ_NODE_LIMIT}`, { cwd: workDir, stdio: "ignore" });
  pinLayoutSeed(path.join(workDir, "graphify-out", "graph.html"));
}

// vis-network seeds initial node positions with Math.random() each load, so the
// layout's rotation/placement differs every time the same graph is opened.
// Pin a fixed randomSeed (+ skip the nondeterministic improvedLayout pre-pass) so
// the force-directed layout converges the same way on every rebuild. Still draggable,
// not frozen. Done here (not in the graphify package) so it survives `graphify` upgrades.
function pinLayoutSeed(htmlPath) {
  if (!fs.existsSync(htmlPath)) return;
  let s = fs.readFileSync(htmlPath, "utf8");
  if (s.includes("randomSeed")) return; // already pinned (e.g. patched graphify build)
  const anchor = "new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, {";
  if (!s.includes(anchor)) { console.log(`pinLayoutSeed: anchor not found in ${htmlPath}`); return; }
  s = s.replace(anchor, `${anchor}\n  layout: { randomSeed: 42, improvedLayout: false },`);
  fs.writeFileSync(htmlPath, s);
}

// graphify colours by COMMUNITY_COLORS[cid % 10] — only 10 colours, so the merged
// graph's 14 repo-communities collide (cid 10..13 reuse 0..3). Repaint the exported
// HTML with a curated, max-distinct qualitative palette (spans the wheel; bright so
// it pops on the near-black #0f0f1a background). Consumed in order by assignRepoColors
// to seed new repos' persistent colours; once spent, repos get a spaced semi-random
// hue. Vault MOC/areas = fixed grey.
const REPO_PALETTE = [
  "#e6194B", "#f58231", "#ffe119", "#bfef45", "#3cb44b", "#42d4f4", "#4363d8",
  "#911eb4", "#f032e6", "#fabed4", "#469990", "#9A6324", "#aaffc3", "#dcbeff",
  "#ff8c00", "#00fa9a", "#1e90ff", "#ff1493",
];
const VAULT_GREY = "#9aa0a6";

// Persistent per-repo colour. The colour is minted ONCE per repo and stored, so it
// survives graph regen; a freshly-added repo gets a brand-new colour the first time
// it appears, and every existing repo keeps the colour it already had (no index-shift
// reshuffle when the repo set changes). Lives outside the repo + vault so it persists.
const REPO_COLORS_FILE = path.join(HOME, ".graphify", "repo-colors.json");
const NEW_HUE_MIN_SEP = 28; // min hue° gap a random colour tries to keep from existing ones

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; return h < 0 ? h + 360 : h;
}
// Semi-random bright colour (pops on the near-black bg), spaced from colours already
// in use; falls back to the best-separated candidate when the wheel is crowded.
function randomBrightHex(usedHexes) {
  const usedHues = usedHexes.map(hexToHue);
  let best = 0, bestSep = -1;
  for (let t = 0; t < 48; t++) {
    const h = Math.floor(Math.random() * 360);
    const sep = usedHues.length
      ? Math.min(...usedHues.map((u) => { const x = Math.abs(h - u) % 360; return Math.min(x, 360 - x); }))
      : 360;
    if (sep >= NEW_HUE_MIN_SEP) return hslToHex(h, 72, 58);
    if (sep > bestSep) { bestSep = sep; best = h; }
  }
  return hslToHex(best, 72, 58);
}
// Map every repo to a persistent colour, minting one for any repo not seen before.
// New repos first consume the curated max-distinct palette (so the graph keeps its
// hand-picked look); once those 18 are spent, new repos get a spaced semi-random hue.
function assignRepoColors(repos) {
  let store = {};
  try { store = JSON.parse(fs.readFileSync(REPO_COLORS_FILE, "utf8")); } catch { /* first run */ }
  let changed = false;
  for (const r of repos) {
    if (store[r]) continue;
    const used = new Set(Object.values(store).map((c) => c.toLowerCase()));
    const fromPalette = REPO_PALETTE.find((c) => !used.has(c.toLowerCase()));
    store[r] = fromPalette || randomBrightHex(Object.values(store));
    changed = true;
    console.log(`repo-colour: assigned ${store[r]} to new repo ${r}`);
  }
  if (changed) fs.writeFileSync(REPO_COLORS_FILE, JSON.stringify(store, null, 2) + "\n");
  return store;
}

// Replace a `const NAME = [ ... ];` JSON array literal in the HTML via bracket match.
function spliceJsonArray(s, marker, mutate) {
  const at = s.indexOf(marker);
  if (at < 0) return s;
  const start = s.indexOf("[", at);
  let i = start, depth = 0, inStr = false, q = "", esc = false;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === q) inStr = false; }
    else if (ch === '"' || ch === "'") { inStr = true; q = ch; }
    else if (ch === "[") depth++;
    else if (ch === "]") { if (--depth === 0) { i++; break; } }
  }
  let arr;
  try { arr = JSON.parse(s.slice(start, i)); } catch (e) { console.log(`repalette: parse failed for ${marker} (${e.message})`); return s; }
  mutate(arr);
  return s.slice(0, start) + JSON.stringify(arr) + s.slice(i);
}
function repaletteByRepo(htmlPath, colorMap) {
  const colorOf = (name) => colorMap[name] || VAULT_GREY;
  let s = fs.readFileSync(htmlPath, "utf8");
  s = spliceJsonArray(s, "const RAW_NODES = ", (arr) => {
    for (const n of arr) { const c = colorOf(n.community_name);
      n.color = { background: c, border: c, highlight: { background: "#ffffff", border: c } }; }
  });
  s = spliceJsonArray(s, "const LEGEND = ", (arr) => { for (const e of arr) e.color = colorOf(e.label); });
  fs.writeFileSync(htmlPath, s);
}

// A repo attaches ONLY to its own Project note + the ancestry up to the MOC
// (project -> area MOC -> Projects MOC), derived by PATH so no sibling projects
// leak in. e.g. Projects/Software Business/Flotila.md ->
//   [Flotila.md, Software Business/Software Business.md, Projects/Projects.md]
function ancestry(noteRel) {
  const out = [noteRel];
  const parts = noteRel.split("/");
  if (parts.length === 3 && parts[0] === "Projects") {       // Projects/<Area>/<Name>.md
    const area = `Projects/${parts[1]}/${parts[1]}.md`;
    if (area !== noteRel) out.push(area);
  }
  const MOC = "Projects/Projects.md";
  if (noteRel !== MOC) out.push(MOC);
  return out;
}

// Build a repo's bridged node/link set: repo nodes + master hub (one spoke per
// community) + the repo's Project-note ancestry chain + the master->note bridge.
// Shared by the per-repo view AND the merged union, so both carry the same shape.
function buildRepoCombined(m) {
  const vnode = vaultByFile[m.note];
  if (!vnode) return null;
  const repoNodes = byRepo[m.repo].filter((n) => !isNoise(n)); // drop config/manifest/test noise
  const repoIds = new Set(repoNodes.map((n) => n.id));
  const repoLinks = links.filter((e) => repoIds.has(e.source) && repoIds.has(e.target));

  // master = synthetic hub; every community hangs off it via its highest-degree node
  const rdeg = {};
  for (const e of repoLinks) { rdeg[e.source] = (rdeg[e.source] || 0) + 1; rdeg[e.target] = (rdeg[e.target] || 0) + 1; }
  const commHub = {};
  for (const n of repoNodes) {
    const c = n.community;
    if (c == null) continue;
    if (!commHub[c] || (rdeg[n.id] || 0) > (rdeg[commHub[c].id] || 0)) commHub[c] = n;
  }
  const repoComms = repoNodes.map((n) => n.community).filter((c) => typeof c === "number");
  const docComm = (repoComms.length ? Math.max(...repoComms) : 0) + 1;
  const masterComm = docComm + 1;
  const masterId = `${m.repo}::__repo__`;
  const masterNode = {
    id: masterId, label: m.repo, repo: m.repo, file_type: "repo",
    _origin: "master", community: masterComm, source_file: null, source_location: null,
  };
  const masterLinks = Object.values(commHub).map((h) => ({
    relation: "module", confidence: "BRIDGE", weight: 1.5, confidence_score: 1,
    source: masterId, target: h.id,
  }));

  // this repo's Project note + ancestry chain (project -> area -> MOC), no siblings
  const chain = ancestry(m.note).map((p) => vaultByFile[p]).filter(Boolean);
  const docNodes = chain.map((n) => ({ ...n, repo: "vault-docs", _origin: "vault", community: docComm }));
  const chainLinks = [];
  for (let i = 0; i < chain.length - 1; i++)
    chainLinks.push({ relation: "in_parent", confidence: "BRIDGE", weight: 1, confidence_score: 1,
      source: chain[i].id, target: chain[i + 1].id });
  const bridge = {
    relation: "documented_in", confidence: "BRIDGE", weight: 2, confidence_score: 1,
    source: masterId, target: (chain[0] || vnode).id,
  };
  return {
    nodes: [...repoNodes, masterNode, ...docNodes],
    links: [...repoLinks, ...masterLinks, ...chainLinks, bridge],
  };
}

// Parse the vault's [[wikilink]] web straight from the .md files. graphify's own
// extraction only emits a fraction of them as `references` edges (62 of ~343), so we
// build the real note->note link graph ourselves: complete, deterministic, no LLM.
// Returns edges between vault FILE nodes (resolved via vaultByFile); media embeds and
// links to non-existent notes resolve to nothing and are skipped.
function vaultWikilinkEdges() {
  let files = [];
  try {
    files = execSync(`cd "${vaultPath}" && find . -name '*.md' -not -path './.obsidian/*' -not -path './.trash/*'`)
      .toString().trim().split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
  } catch { return []; }
  // resolvers: Obsidian links by note basename (case-insensitive) or by relative path
  const byBase = {}, byPath = {};
  for (const f of Object.keys(vaultByFile)) {
    byPath[f.toLowerCase()] = f;
    byPath[f.toLowerCase().replace(/\.md$/, "")] = f;
    const b = path.basename(f, ".md").toLowerCase();
    if (!(b in byBase)) byBase[b] = f; // first wins; basename collisions are rare here
  }
  const resolve = (target) => {
    const t = target.split("|")[0].split("#")[0].trim(); // strip alias + heading/block ref
    if (!t) return null;
    const tl = t.toLowerCase();
    if (t.includes("/")) return byPath[tl] || byPath[tl + ".md"] || null;
    return byBase[tl] || byPath[tl] || byPath[tl + ".md"] || null;
  };
  const edges = [];
  const re = /!?\[\[([^\]]+)\]\]/g;
  for (const f of files) {
    const src = vaultByFile[f];
    if (!src) continue; // note produced no graphify node
    let body = "";
    try { body = fs.readFileSync(path.join(vaultPath, f), "utf8"); } catch { continue; }
    let mm;
    while ((mm = re.exec(body))) {
      const tf = resolve(mm[1]);
      if (!tf || tf === f) continue; // unresolved (media / missing note) or self-link
      const dst = vaultByFile[tf];
      if (!dst) continue;
      edges.push({ source: src.id, target: dst.id, relation: "wikilink",
        confidence: "BRIDGE", weight: 1, confidence_score: 1 });
    }
  }
  return edges;
}

// ---------- 1. per-repo bridged graphs (primary view) ----------
if (!NO_HTML && !NO_REPOS) {
  let built = 0;
  for (const m of matches) {
    if (!m.note || !m.anchor) continue;
    const vnode = vaultByFile[m.note];
    if (!vnode) continue;
    const c = buildRepoCombined(m);
    if (!c) continue;
    const combined = {
      directed: !!g.directed, multigraph: false, graph: {}, nodes: c.nodes, links: c.links,
    };
    const outDir = path.join(REPO_BRIDGED, m.repo, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify(combined));
    nameCommunities(outDir);
    try { exportHtml(path.join(REPO_BRIDGED, m.repo)); built++; }
    catch (e) { console.log(`WARN: export failed for ${m.repo} (${e.message})`); }
  }
  console.log(`\nper-repo bridged graphs: ${built} -> ${REPO_BRIDGED}/<repo>/graphify-out/graph.html`);
}

// ---------- 2. merged bridged graph.html (union of the per-repo graphs) ----------
if (!NO_HTML) {
  // Union the same per-repo builds so every repo carries its master + module spokes,
  // and dedup the shared vault Project notes/areas/MOC by id so all repos hang off
  // ONE Projects tree. No cluster-only — that re-segmented the union and erased the
  // master structure. Per-repo community ints collide, so remap each repo's to a
  // unique global range; all vault-doc nodes share one community/colour.
  // Colour by repo: one community per repo (so all of a repo's nodes share a
  // colour), vault docs share one. The Project tree dedups by id across repos.
  const seen = new Map();           // node id -> kept node
  const linkSeen = new Set();
  const mergedNodes = [], mergedLinks = [];
  const SHARED_DOC_COMM = 0;        // shared area/MOC vault nodes -> one (grey) community
  const repoComm = {};              // repo tag -> colour community id
  let commBase = 1;
  const noteRepo = {};              // a repo's Project-note id -> that repo (share its colour)
  for (const m of matches) {
    if (!m.note || !m.anchor) continue;
    if (!(m.repo in repoComm)) repoComm[m.repo] = commBase++;
    const vn = vaultByFile[m.note];
    if (vn) noteRepo[vn.id] = m.repo;
  }
  for (const m of matches) {
    if (!m.note || !m.anchor) continue;
    const c = buildRepoCombined(m);
    if (!c) continue;
    for (const n of c.nodes) {
      if (seen.has(n.id)) continue; // vault MOC/area shared across repos -> keep once
      let comm;
      if (n.repo === "vault-docs")  // a repo's own Project note joins its repo's colour;
        comm = (n.id in noteRepo) ? repoComm[noteRepo[n.id]] : SHARED_DOC_COMM; // areas/MOC stay grey
      else { const r = n.repo || n.id.split("::")[0]; if (!(r in repoComm)) repoComm[r] = commBase++; comm = repoComm[r]; }
      const nn = { ...n, community: comm };
      seen.set(n.id, nn);
      mergedNodes.push(nn);
    }
    for (const e of c.links) {
      const k = `${e.source} ${e.target} ${e.relation}`;
      if (linkSeen.has(k)) continue;
      linkSeen.add(k);
      mergedLinks.push(e);
    }
  }
  // Fold in the FULL vault: every note as a node (file-level, not headings) plus its
  // real [[wikilink]] web. Notes already pulled in as a repo's bridge target keep their
  // repo colour; the rest share the grey "Vault Projects / docs" community.
  for (const f of Object.keys(vaultByFile)) {
    const vn = vaultByFile[f];
    if (seen.has(vn.id) || isNoise(vn)) continue; // already added, or config/data noise
    const comm = (vn.id in noteRepo) ? repoComm[noteRepo[vn.id]] : SHARED_DOC_COMM;
    const nn = { ...vn, repo: "vault-docs", community: comm };
    seen.set(vn.id, nn);
    mergedNodes.push(nn);
  }
  for (const e of vaultWikilinkEdges()) {
    if (!seen.has(e.source) || !seen.has(e.target)) continue; // endpoint outside the graph
    const k = `${e.source} ${e.target} ${e.relation}`;
    if (linkSeen.has(k)) continue;
    linkSeen.add(k);
    mergedLinks.push(e);
  }
  // Vault hub: a note with no wikilink in/out and not in any repo's Project ancestry
  // ends up with zero edges and floats off alone. Add ONE synthetic "Obsidian Vault"
  // root, give every such orphan a spoke to it, and tie the root into the Projects MOC
  // (already wired to the repo masters) so the whole vault — orphans included — hangs
  // off the main graph instead of scattering.
  {
    const deg = {};
    for (const e of mergedLinks) { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1; }
    const VAULT_ROOT_ID = "vault::__root__";
    const orphanLinks = [];
    for (const n of mergedNodes) {
      if (n.repo !== "vault-docs" || n.id === VAULT_ROOT_ID) continue;
      if ((deg[n.id] || 0) > 0) continue; // already connected via wikilink/ancestry/bridge
      orphanLinks.push({ source: VAULT_ROOT_ID, target: n.id, relation: "vault-root",
        confidence: "BRIDGE", weight: 1, confidence_score: 1 });
    }
    if (orphanLinks.length) {
      const vaultRoot = { id: VAULT_ROOT_ID, label: "Obsidian Vault", repo: "vault-docs",
        file_type: "vault-root", _origin: "vault-root", community: SHARED_DOC_COMM,
        source_file: null, source_location: null };
      seen.set(VAULT_ROOT_ID, vaultRoot);
      mergedNodes.push(vaultRoot);
      const moc = vaultByFile["Projects/Projects.md"]; // anchor the hub into the connected graph
      if (moc && seen.has(moc.id)) mergedLinks.push({ source: VAULT_ROOT_ID, target: moc.id,
        relation: "vault-root", confidence: "BRIDGE", weight: 1, confidence_score: 1 });
      for (const e of orphanLinks) mergedLinks.push(e);
      console.log(`vault hub: linked ${orphanLinks.length} orphaned vault notes to "Obsidian Vault" root`);
    }
  }
  const bridged = { directed: !!g.directed, multigraph: false, graph: {}, nodes: mergedNodes, links: mergedLinks };
  fs.mkdirSync(BRIDGED_OUT, { recursive: true });
  fs.writeFileSync(path.join(BRIDGED_OUT, "graph.json"), JSON.stringify(bridged));
  console.log(`\nmerged graph.json: ${mergedNodes.length} nodes, ${mergedLinks.length} edges (union of per-repo + full vault wikilink web; coloured by repo)`);
  try {
    nameCommunities(BRIDGED_OUT, { byRepo: true });
    exportHtml(BRIDGED_DIR);
    // persistent per-repo colour (minted once, stored, new repo -> new colour)
    const sortedRepos = [...new Set(matches.filter((m) => m.note && m.anchor).map((m) => m.repo))].sort();
    const colorMap = assignRepoColors(sortedRepos);
    repaletteByRepo(path.join(BRIDGED_OUT, "graph.html"), colorMap);
    console.log(`merged graph.html: ${path.join(BRIDGED_OUT, "graph.html")}`);
  } catch (e) {
    console.log(`WARN: merged render failed (${e.message}); graph.json is written.`);
  }
}

// ---------- 3. Obsidian Canvas ----------
const canvasNodes = [];
const canvasEdges = [];
const COL_REPO = 0, COL_PROJ = 520, W = 320, H = 90, GAP = 130;
matches.forEach((m, i) => {
  const y = i * GAP;
  const repoId = `repo-${m.repo}`;
  // link the card at the per-repo BRIDGED graph (the connected view)
  const htmlPath = path.join(REPO_BRIDGED, m.repo, "graphify-out", "graph.html");
  canvasNodes.push({
    id: repoId, type: "text", x: COL_REPO, y, width: W, height: H,
    color: "4",
    text: `**${m.repo}**\n\`${htmlPath}\``,
  });
  if (m.note) {
    const projId = `proj-${i}`;
    canvasNodes.push({ id: projId, type: "file", file: m.note, x: COL_PROJ, y, width: W, height: H });
    canvasEdges.push({
      id: `e-${i}`, fromNode: repoId, fromSide: "right",
      toNode: projId, toSide: "left",
      label: m.how === "override" ? "tracks*" : "tracks",
    });
  }
});

const canvas = { nodes: canvasNodes, edges: canvasEdges };
const canvasDir = path.join(vaultPath, CANVAS_SUBDIR);
fs.mkdirSync(canvasDir, { recursive: true });
const canvasFile = path.join(canvasDir, CANVAS_NAME);
fs.writeFileSync(canvasFile, JSON.stringify(canvas, null, 2));
console.log(`\ncanvas: ${canvasFile}`);
console.log(`open in Obsidian: ${CANVAS_SUBDIR}/${CANVAS_NAME}  (mark ${CANVAS_SUBDIR}/ git-ignored)`);
