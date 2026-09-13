// Runs the candidate models over the fixed sample and records what happened.
//
// Every engine under consideration (llama.cpp's llama-server, Ollama, vLLM,
// FreeToken) speaks OpenAI /v1/chat/completions, so the harness targets that and
// nothing else. Swapping engines is a base-URL change, which is the property that
// lets this benchmark be re-run later against a different backend without edits.
//
//   node bench/run.mjs                                  # default model, 12 sessions
//   node bench/run.mjs --model qwen3.6-35b-a3b-q8 --think
//
// Results land in bench/results/<tag>.json — one file per model, so a run can be
// interrupted and resumed a model at a time.

import fs from "fs";
import path from "path";
import { pickSample } from "./sample.mjs";
import { excerpt } from "./excerpt.mjs";
import { SYSTEM, userMessage, correctionMessage, validateSummary } from "./prompt.mjs";

const RESULTS = path.join(import.meta.dirname, "results");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};

const MODEL = arg("model", process.env.LLM_MODEL ?? "qwen3.6-35b-a3b");
const BASE = arg("base", process.env.LLM_BASE_URL ?? "http://127.0.0.1:1921/v1");
const N = Number(arg("n", 12));
const MAX_ATTEMPTS = Number(arg("attempts", 3));
const TAG = arg("tag", MODEL?.replace(/[^\w.-]/g, "_"));
const TEMP = Number(arg("temp", 0.2));
// The served model reasons before it answers, and llama-server puts that in
// `reasoning_content`, not `content`. Filling a fixed six-field schema does not
// need it, and 150 sessions each paying for a thought is the dominant cost of a
// run — so it is off unless --think is passed.
const THINK = process.argv.includes("--think");
// The run unloads when it finishes. Pass --keep-loaded to leave the model resident,
// which is what you want while iterating: a reload is 25s of every cycle.
const KEEP_LOADED = process.argv.includes("--keep-loaded");
const MAX_TOKENS = Number(arg("max-tokens", THINK ? 4096 : 1200));

if (!MODEL) {
  console.error("usage: node bench/run.mjs [--model NAME] [--base URL] [--n 12] [--attempts 3] [--think] [--keep-loaded]");
  process.exit(2);
}

async function chat(messages) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: TEMP,
      max_tokens: MAX_TOKENS,
      stream: false,
      chat_template_kwargs: { enable_thinking: THINK },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const choice = body.choices?.[0] ?? {};
  const text = choice.message?.content ?? "";

  // A thinking model that spends its whole completion budget on the thought
  // returns content="" with finish_reason="length" — an empty string, never an
  // error. Unnamed, that reaches the classifier below as "no-json" and reads as a
  // model too weak to emit an object, which is the wrong conclusion and sends you
  // looking for a better model instead of a bigger budget.
  if (!text.trim() && choice.finish_reason === "length") {
    throw new Error(
      `empty content with finish_reason=length — the reasoning block consumed all ` +
      `${MAX_TOKENS} completion tokens (${body.usage?.completion_tokens ?? "?"} used). ` +
      `Raise --max-tokens, or drop --think.`
    );
  }
  return { text, ms: Date.now() - t0, usage: body.usage ?? {} };
}

// Classifying HOW a model fails is the useful part. "invalid" lumps together a
// model that wrapped good JSON in a fence — trivially fixable with a stricter
// prompt or a grammar — and one that cannot hold a six-field contract at all.
function classify(raw, parsed, errs) {
  if (/^\s*```/.test(raw)) return "fence";
  if (parsed === undefined) return /\{/.test(raw) ? "prose-around-json" : "no-json";
  if (!errs.length) return "ok";
  if (errs.some((e) => e.includes("must not end with a period"))) return "schema:title-period";
  if (errs.some((e) => e.includes('"session_id" must be'))) return "schema:invented-id";
  if (errs.some((e) => e.includes('"highlights"'))) return "schema:highlights";
  if (errs.some((e) => e.includes('"outcome"'))) return "schema:outcome";
  return "schema:other";
}

// Models emit a fence often enough that scoring it as a hard failure would hide the
// more interesting differences. It is recorded as a failure mode AND recovered from,
// so the quality of the summary underneath still gets judged.
function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return undefined; }
}

async function runOne(session) {
  const { text: transcript } = excerpt(session.path);
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userMessage({ ...session, occurred_at: session.mtime, transcript }) },
  ];

  const attempts = [];
  let totalMs = 0, promptTok = 0, outTok = 0;

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    let reply;
    try {
      reply = await chat(messages);
    } catch (e) {
      attempts.push({ attempt: i, mode: "http-error", error: String(e).slice(0, 300) });
      return { session_id: session.session_id, valid: false, attempts, totalMs, promptTok, outTok };
    }
    totalMs += reply.ms;
    promptTok += reply.usage.prompt_tokens ?? 0;
    outTok += reply.usage.completion_tokens ?? 0;

    const parsed = extractJson(reply.text);
    const errs = parsed === undefined
      ? ["output is not a JSON object"]
      : validateSummary(parsed, { session_id: session.session_id });
    const mode = classify(reply.text, parsed, errs);
    attempts.push({ attempt: i, mode, ms: reply.ms, errors: errs.slice(0, 6), raw: reply.text.slice(0, 4000) });

    if (parsed !== undefined && !errs.length) {
      return {
        session_id: session.session_id, project: session.project,
        valid: true, attemptsUsed: i, attempts, summary: parsed,
        totalMs, promptTok, outTok,
      };
    }
    messages.push({ role: "assistant", content: reply.text });
    messages.push({ role: "user", content: correctionMessage(errs) });
  }
  return {
    session_id: session.session_id, project: session.project,
    valid: false, attemptsUsed: MAX_ATTEMPTS, attempts, totalMs, promptTok, outTok,
  };
}

// --- model lifecycle -------------------------------------------------------
//
// The router serves no model of its own: it spawns a child llama-server on demand
// and, with LC_ROUTER_MAX=1, can hold exactly one. Loading and unloading around the
// run is explicit rather than incidental so the ~7.9 GiB of VRAM the child holds is
// released the moment the work is done, instead of lingering until something else
// needs the GPU and finds it occupied.
//
// These endpoints live at the router ROOT, not under /v1 — that prefix is the
// OpenAI-compatible surface, and model management is not part of it.
const ROUTER = BASE.replace(/\/v1\/?$/, "");
let loadedByUs = false;

async function routerPost(path) {
  const res = await fetch(`${ROUTER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL }),
  });
  return res;
}

// `{ managed: false }` means this endpoint has no router management API at all —
// a plain llama-server, or Ollama. That is not a failure: there is simply no model
// lifecycle to drive, and the run should proceed.
async function modelStatus() {
  let res;
  try {
    res = await fetch(`${ROUTER}/models`);
  } catch {
    return { managed: false };
  }
  if (!res.ok) return { managed: false };
  const body = await res.json();
  const entry = body.data?.find((m) => m.id === MODEL || m.aliases?.includes(MODEL));
  if (!entry) return { managed: true, status: null };
  return { managed: true, status: entry.status?.value ?? null };
}

/**
 * Returns true only if THIS run loaded the model — which is exactly the condition
 * for unloading it afterwards.
 *
 * A model that was already resident belongs to whoever loaded it. Unloading that on
 * our way out would evict a model another process is mid-way through using, to save
 * VRAM nobody asked us to reclaim. Checking status first is also what makes loading
 * idempotent: POST /models/load on a resident model is a 400, not a no-op.
 */
async function loadModel() {
  const { managed, status } = await modelStatus();
  if (!managed) {
    console.log("no router management API here — skipping explicit load/unload");
    return false;
  }
  if (status === null) {
    throw new Error(`the router serves no model named "${MODEL}" — check GET ${ROUTER}/models`);
  }
  if (status === "loaded") {
    process.stdout.write("(already resident, left as found) ");
    return false;
  }

  // A load issued moments after an unload can be refused with a 400 while the
  // previous child is still tearing down — observed immediately after a completed
  // run. It is transient, so re-read the status and retry briefly rather than
  // failing a three-hour job on a race with our own cleanup.
  let res = await routerPost("/models/load");
  for (let i = 0; i < 10 && res.status === 400; i++) {
    const { status: st } = await modelStatus();
    if (st === "loaded") return false; // somebody else won the race; not ours
    await new Promise((r) => setTimeout(r, 2000));
    res = await routerPost("/models/load");
  }
  if (!res.ok) throw new Error(`/models/load → ${res.status} ${(await res.text()).slice(0, 200)}`);

  // The load is asynchronous: 200 means accepted, not resident — measured as
  // `{"success":true}` in 0.0s with VRAM still untouched. Poll until the router
  // says loaded, so the cold load is not charged to session 1.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const { status: st } = await modelStatus();
    if (st === "loaded") return true;
    if (st === "failed" || st === "error") throw new Error(`model ${MODEL} failed to load (status ${st})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`model ${MODEL} did not reach "loaded" within 300s`);
}

async function unloadModel() {
  if (!loadedByUs) return;
  loadedByUs = false;
  if (KEEP_LOADED) {
    console.log(`leaving ${MODEL} resident (--keep-loaded)`);
    return;
  }
  try {
    const res = await routerPost("/models/unload");
    console.log(res.ok ? `unloaded ${MODEL}` : `unload returned ${res.status}`);
  } catch (e) {
    console.error(`unload failed: ${e}`);
  }
}

// Ctrl-C during a three-hour run would otherwise leave the child resident.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log(`\n${sig} — unloading before exit`);
    await unloadModel();
    process.exit(130);
  });
}

const sample = pickSample(N);
fs.mkdirSync(RESULTS, { recursive: true });
console.log(`${MODEL} @ ${BASE} — ${sample.length} sessions, max ${MAX_ATTEMPTS} attempts each, thinking ${THINK ? "on" : "off"}\n`);

// Load the model up front rather than letting session 1 trigger it. A cold load is
// 25.4s for the 20.6 GiB Q4_K_M; charged to the first session it distorts that row
// and then scales into the "150 sessions would take" estimate at the end.
process.stdout.write(`loading ${MODEL} ... `);
const loadStart = Date.now();
loadedByUs = await loadModel();
console.log(`${((Date.now() - loadStart) / 1000).toFixed(1)}s\n`);

const rows = [];
try {
  for (const [i, s] of sample.entries()) {
    process.stdout.write(`[${String(i + 1).padStart(2)}/${sample.length}] ${s.session_id.slice(0, 8)} `);
    const r = await runOne(s);
    rows.push(r);
    const first = r.attempts[0]?.mode ?? "?";
    console.log(
      `${r.valid ? "OK " : "FAIL"} attempts=${r.attemptsUsed ?? "-"} ` +
      `${(r.totalMs / 1000).toFixed(1)}s first=${first}`
    );
  }
} finally {
  // Whatever happened — finished, threw, or a session wedged — a model this run
  // loaded holds ~7.9 GiB of VRAM until it is told otherwise, and nothing else on
  // this box can use the GPU meanwhile. One we found already resident is left
  // alone; it is not ours to evict.
  await unloadModel();
}

const valid = rows.filter((r) => r.valid);
const firstPass = rows.filter((r) => r.attempts[0]?.mode === "ok");
const summary = {
  model: MODEL, base: BASE, temp: TEMP, think: THINK, max_tokens: MAX_TOKENS,
  n: rows.length, ran_at: new Date().toISOString(),
  valid_at_1: firstPass.length / rows.length,
  valid_at_n: valid.length / rows.length,
  mean_attempts: valid.length ? valid.reduce((a, r) => a + r.attemptsUsed, 0) / valid.length : null,
  mean_s_per_session: rows.reduce((a, r) => a + r.totalMs, 0) / rows.length / 1000,
  total_s: rows.reduce((a, r) => a + r.totalMs, 0) / 1000,
  out_tok_per_s: rows.reduce((a, r) => a + r.outTok, 0) / (rows.reduce((a, r) => a + r.totalMs, 0) / 1000),
  first_attempt_modes: rows.reduce((acc, r) => {
    const m = r.attempts[0]?.mode ?? "?";
    acc[m] = (acc[m] ?? 0) + 1;
    return acc;
  }, {}),
  rows,
};
fs.writeFileSync(path.join(RESULTS, `${TAG}.json`), JSON.stringify(summary, null, 2));

console.log(`\n  valid@1            ${(summary.valid_at_1 * 100).toFixed(0)}%`);
console.log(`  valid@${MAX_ATTEMPTS}            ${(summary.valid_at_n * 100).toFixed(0)}%`);
console.log(`  mean attempts      ${summary.mean_attempts?.toFixed(2) ?? "n/a"}`);
console.log(`  mean s/session     ${summary.mean_s_per_session.toFixed(1)}`);
console.log(`  output tok/s       ${summary.out_tok_per_s.toFixed(1)}`);
console.log(`  first-attempt      ${JSON.stringify(summary.first_attempt_modes)}`);
console.log(`  -> bench/results/${TAG}.json`);
console.log(`\n  150 sessions would take ~${((summary.mean_s_per_session * 150) / 60).toFixed(0)} min`);
