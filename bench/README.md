# Local model benchmark

Picks the model that will replace the `claude -p` summarizer fan-out, by running
candidates over a fixed sample of real session transcripts and scoring them against
the same validator the importer uses.

## Why it is shaped this way

- **The sample is fixed and stratified by transcript size**, not random. A model
  comparison is only meaningful if every candidate reads identical bytes, and a
  regression later is only debuggable if the input is reproducible. Size is what
  varies the task — a 14-turn session and a 636-turn one are different problems.
- **Excerpting is deterministic JS**, not a sub-agent inventing a `grep` each run.
  `excerpt.mjs` is the piece that outlives the benchmark: the production collector
  needs exactly the same function.
- **Scoring calls `dist/summary.js`**, the real validator, not a copy of its rules.
  A model that passes here passes the actual import gate.
- **It checks meaning, not just shape.** That the session id was copied rather than
  invented, that the title carries no trailing period, that highlights number one to
  five. Grammar-constrained decoding can produce a well-formed object full of wrong
  values, so a benchmark that only asked "did it parse" would rank models on the one
  thing a grammar already fixes.
- **How a model fails is recorded, not just that it did.** A fenced-but-correct
  object and an inability to hold a six-field contract are different problems, and
  only one of them is fixable with a stricter prompt.

## Running it

Needs an OpenAI-compatible endpoint. The `ollama-k3s` stack is currently torn down,
so this runs against a local Ollama:

```sh
sudo systemctl start ollama       # installed but left disabled by default
ollama pull qwen3:8b
npm run build                     # the runner scores against dist/summary.js
node bench/run.mjs --model qwen3:8b
```

Results land in `bench/results/<model>.json` (gitignored), one file per model, so a
sweep can be interrupted and resumed a model at a time.

### Set the context window first, or the numbers are meaningless

Ollama derives the context window from free VRAM when `OLLAMA_CONTEXT_LENGTH` is
unset, and on an 8 GB card that default is **4096**. Excerpts here reach ~6000
tokens. Past the window, input is dropped before the model sees it — no error, no
warning, a fluent reply about the first few thousand tokens. Every candidate then
scores alike on exactly the long sessions that would otherwise separate them.

```sh
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'CONF'
[Service]
Environment="OLLAMA_CONTEXT_LENGTH=16384"
Environment="OLLAMA_FLASH_ATTENTION=true"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
CONF
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

Flash attention and the `q8_0` KV cache roughly halve the cache a 16k window needs,
which keeps layers on the GPU. They are not separable — `q8_0` requires flash
attention. Measure tok/s after changing this, not only correctness: a window bought
by evicting layers onto the CPU costs roughly an order of magnitude in speed.

## Files

| File | Purpose |
|---|---|
| `excerpt.mjs` | transcript → bounded deterministic excerpt (also needed in production) |
| `sample.mjs`  | the fixed, size-stratified session sample |
| `prompt.mjs`  | the one prompt every model is judged on, plus the correction turn |
| `run.mjs`     | the self-correction loop, timing, and failure-mode classification |
