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
  "k3s-cluster": "Projects/Cluster infra in git.md",
  // area fallbacks (no dedicated project note) — keep the repo connected to the
  // Projects graph via its area MOC until a real note exists.
  "social-update": "Projects/Software Engineering/Software Engineering.md",
  "tradingview-mcp": "Projects/Trading/Trading.md",
  "vaultwarden": "Projects/Homelab/Homelab.md",
  "apps-page": "Projects/Software Business/Software Business.md",
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
const vaultDocIds = new Set(vaultDocs.map((n) => n.id));

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
function nameCommunities(outDir) {
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
      labels[c] = grp.length > 1 ? `Vault Projects / docs (+${grp.length - 1})` : "Vault Projects / docs";
      continue;
    }
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

function exportHtml(workDir) {
  // `graphify export html` reads <cwd>/graphify-out/graph.json + .graphify_labels.json
  execSync(`"${GRAPHIFY}" export html`, { cwd: workDir, stdio: "ignore" });
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

// ---------- 1. per-repo bridged graphs (primary view) ----------
if (!NO_HTML && !NO_REPOS) {
  let built = 0;
  for (const m of matches) {
    if (!m.note || !m.anchor) continue;
    const vnode = vaultByFile[m.note];
    if (!vnode) continue;
    const repoNodes = byRepo[m.repo];
    const repoIds = new Set(repoNodes.map((n) => n.id));
    // just this repo's Project note + its ancestry chain (no sibling projects),
    // in one fresh community -> renders as a small "Vault Projects / docs" group.
    const chain = ancestry(m.note).map((p) => vaultByFile[p]).filter(Boolean);
    const repoComms = repoNodes.map((n) => n.community).filter((c) => typeof c === "number");
    const docComm = (repoComms.length ? Math.max(...repoComms) : 0) + 1;
    const docNodes = chain.map((n) => ({ ...n, repo: "vault-docs", _origin: "vault", community: docComm }));
    const repoLinks = links.filter((e) => repoIds.has(e.source) && repoIds.has(e.target));
    // chain edges project -> area -> MOC so the path up the tree renders
    const chainLinks = [];
    for (let i = 0; i < chain.length - 1; i++)
      chainLinks.push({ relation: "in_parent", confidence: "BRIDGE", weight: 1, confidence_score: 1,
        source: chain[i].id, target: chain[i + 1].id });
    const bridge = {
      relation: "documented_in", confidence: "BRIDGE", weight: 2, confidence_score: 1,
      source: m.anchor.id, target: (chain[0] || vnode).id,
    };
    const combined = {
      directed: !!g.directed, multigraph: false, graph: {},
      nodes: [...repoNodes, ...docNodes], links: [...repoLinks, ...chainLinks, bridge],
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

// ---------- 2. merged bridged graph.json -> graph.html ----------
if (!NO_HTML) {
  // every node EXCEPT the vault .obsidian noise, plus the repo->note bridge edges
  const keptNodes = nodes.filter((n) => n.repo !== VAULT_TAG || isVaultDoc(n));
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptLinks = links.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
  const bridged = { ...g, nodes: [...keptNodes], links: [...keptLinks] };
  let added = 0;
  for (const m of matches) {
    if (!m.note) continue;
    const vnode = vaultByFile[m.note];
    if (!vnode || !m.anchor) continue;
    bridged.links.push({
      relation: "implements", confidence: "BRIDGE", weight: 2, confidence_score: 1,
      source: vnode.id,        // Project note (vault)
      target: m.anchor.id,     // repo anchor
    });
    added++;
  }
  fs.mkdirSync(BRIDGED_OUT, { recursive: true });
  fs.writeFileSync(path.join(BRIDGED_OUT, "graph.json"), JSON.stringify(bridged));
  console.log(`\nbridged graph.json: ${added} bridge edges, ${keptNodes.length} nodes (.obsidian dropped)`);
  try {
    // re-cluster (no LLM), then name communities ourselves, then render.
    execSync(`"${GRAPHIFY}" cluster-only "${BRIDGED_DIR}" --no-label --no-viz`, { stdio: "ignore" });
    nameCommunities(BRIDGED_OUT);
    exportHtml(BRIDGED_DIR);
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
