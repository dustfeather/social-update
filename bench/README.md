# Local model benchmark

Validates the local model that replaces the `claude -p` summarizer fan-out, by
running it over a fixed sample of real session transcripts and scoring the output
against the same validator the importer uses.

## What it runs against

The llama.cpp **router** served by the `ollama-k3s` repo on `127.0.0.1:1921`. The
router holds no model itself: it spawns a child `llama-server` per model and, with
`LC_ROUTER_MAX=1`, can keep exactly one resident. Two models are served, both the
same weights at different quantizations:

| model | quant | note |
|---|---|---|
| `qwen3.6-35b-a3b`    | UD-Q4_K_M, 20.6 GiB | default here — smaller and faster |
| `qwen3.6-35b-a3b-q8` | Q8_0, 34.4 GiB      | swaps on a 54.9 GiB box; slower |

Override with `--base` / `--model`, or `LLM_BASE_URL` / `LLM_MODEL`.

## Results, 2026-09-13

`qwen3.6-35b-a3b`, 12 sessions stratified by transcript size, thinking off:

    valid@1          100%   (12/12 on the first attempt, zero retries)
    mean attempts    1.00
    mean s/session   62.6   (23.9s smallest → 133.9s largest)
    150 sessions     ~156 min

The self-correction loop never had to fire. Summaries name real files and root
causes, lead with what changed, and pick sensible outcomes.

## Two traps this harness exists to avoid

**The model thinks before it answers.** `llama-server` puts that in
`reasoning_content`, not `content`. A tight `max_tokens` therefore returns
`content: ""` with `finish_reason: "length"` — an empty string, never an error —
which reaches a naive classifier as "the model could not produce JSON" and sends you
hunting for a better model instead of a bigger budget. Thinking is off by default
here, and that exact case is detected and named. `--think` turns it back on and
raises the cap to 4096.

**Loading is asynchronous.** `POST /models/load` returns `{"success":true}` in 0.0s
with the VRAM untouched; the run polls `GET /models` until `status.value` is
`loaded`. Issued moments after an unload it can also return a transient 400 while
the previous child tears down, so that is retried rather than fatal.

## Model lifecycle, and who owns it

A run loads the model, uses it, and unloads it when done — the child holds ~7.9 GiB
of VRAM, which is the whole card.

**Unloading is conditional on having loaded it.** A model already resident when the
run starts belongs to whoever loaded it, and is left exactly as found; evicting it
would kill a model another process is part-way through using. Against an endpoint
with no router management API (a plain `llama-server`, or Ollama) there is no
lifecycle to drive and the run proceeds without one.

`--keep-loaded` skips the unload while iterating, since a reload costs ~25s cold.

## Running it

> `npm run build` first — `excerpt.mjs` and `prompt.mjs` re-export from `dist/`.

```sh
systemctl is-active llama-router     # the router must be up
npm run build                        # the runner scores against dist/summary.js
node bench/run.mjs                   # defaults: qwen3.6-35b-a3b, 12 sessions
node bench/run.mjs --n 3 --keep-loaded
```

Results land in `bench/results/<tag>.json` (gitignored), one file per model.

## Why it is shaped this way

- **The sample is fixed and stratified by size**, not random. A comparison is only
  meaningful if every candidate reads identical bytes, and size is what varies the
  task — a 6-turn session and a 620-turn one are different problems.
- **Excerpting is deterministic JS**, and it outlived the benchmark: the collector
  now uses exactly the same function, so `excerpt.mjs` is a re-export of
  `dist/excerpt.js` rather than a second copy.
- **The prompt and the validator are the production ones** (`dist/summarize.js`,
  `dist/summary.js`), re-exported rather than duplicated. A benchmark scoring its
  own copy of the rules measures the copy — and one whose prompt has drifted from
  production stops predicting anything about production, which is its only job.
- **It checks meaning, not shape** — that the session id was copied rather than
  invented, that the title has no trailing period, that highlights number one to
  five. Constrained decoding can produce a well-formed object full of wrong values,
  so a benchmark that only asked "did it parse" would rank models on the one thing a
  grammar already fixes.
- **How a model fails is recorded**, not just that it did. A fenced-but-correct
  object and an inability to hold a six-field contract want different remedies.

## Files

| File | Purpose |
|---|---|
| `excerpt.mjs` | re-export of `dist/excerpt.js` — transcript → bounded deterministic excerpt, and the session's real `cwd` |
| `sample.mjs`  | the fixed, size-stratified session sample |
| `prompt.mjs`  | re-export of the production prompt (`dist/summarize.js`) and validator (`dist/summary.js`) |
| `run.mjs`     | model lifecycle, the self-correction loop, timing, failure classification |
