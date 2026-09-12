// Runs the candidate models over the fixed sample and records what happened.
//
// Every engine under consideration (llama.cpp's llama-server, Ollama, vLLM,
// FreeToken) speaks OpenAI /v1/chat/completions, so the harness targets that and
// nothing else. Swapping engines is a base-URL change, which is the property that
// lets this benchmark be re-run later against a different backend without edits.
//
//   node bench/run.mjs --model qwen3:8b --base http://127.0.0.1:11434/v1 --n 12
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

const MODEL = arg("model");
const BASE = arg("base", "http://127.0.0.1:8080/v1");
const N = Number(arg("n", 12));
const MAX_ATTEMPTS = Number(arg("attempts", 3));
const TAG = arg("tag", MODEL?.replace(/[^\w.-]/g, "_"));
const TEMP = Number(arg("temp", 0.2));

if (!MODEL) {
  console.error("usage: node bench/run.mjs --model <name> [--base URL] [--n 12] [--attempts 3]");
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
      max_tokens: 1200,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    ms: Date.now() - t0,
    usage: body.usage ?? {},
  };
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

const sample = pickSample(N);
fs.mkdirSync(RESULTS, { recursive: true });
console.log(`${MODEL} @ ${BASE} — ${sample.length} sessions, max ${MAX_ATTEMPTS} attempts each\n`);

const rows = [];
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

const valid = rows.filter((r) => r.valid);
const firstPass = rows.filter((r) => r.attempts[0]?.mode === "ok");
const summary = {
  model: MODEL, base: BASE, temp: TEMP, n: rows.length, ran_at: new Date().toISOString(),
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
