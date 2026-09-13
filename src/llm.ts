import { config } from "dotenv";

config({ quiet: true });

// Client for the local llama.cpp stack served by the ollama-k3s repo.
//
// Two surfaces, deliberately kept apart:
//   - `/v1/chat/completions`, the OpenAI-compatible inference API. Every engine
//     that could ever back this (llama-server, Ollama, vLLM) speaks it, so
//     swapping engines is a base-URL change rather than an edit here.
//   - `/models`, `/models/load`, `/models/unload` — the ROUTER's model lifecycle,
//     which lives at the router root, NOT under /v1. That prefix is the
//     OpenAI-compatible surface and model management is not part of it.
//
// The router serves no model itself: it spawns a child llama-server on demand and,
// configured with LC_ROUTER_MAX=1, holds exactly one. Driving the lifecycle
// explicitly is what keeps the ~7.9 GiB of VRAM the child holds from lingering
// after a nightly collection finishes.

export const LLM_BASE = process.env.LLM_BASE_URL ?? "http://127.0.0.1:1921/v1";
export const LLM_MODEL = process.env.LLM_MODEL ?? "qwen3.6-35b-a3b";

const ROUTER = LLM_BASE.replace(/\/v1\/?$/, "");
const TEMP = Number(process.env.LLM_TEMP ?? 0.2);
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 1200);
// The served model can reason before it answers, and llama-server puts that in
// `reasoning_content` rather than `content`. Filling a fixed six-field schema does
// not need it, and on a 150-session backlog a thought per session is the dominant
// cost of the run — so it is off unless something asks for it.
const THINK = process.env.LLM_THINK === "1";
// A slow request must not hold the collector's slot until the next timer fires.
// This only works because the request is STREAMED — see the note on chat().
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_S ?? 300) * 1000;
const LOAD_TIMEOUT_MS = Number(process.env.LLM_LOAD_TIMEOUT_S ?? 300) * 1000;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatReply {
  text: string;
  ms: number;
  promptTokens: number;
  outputTokens: number;
}

interface StreamResult {
  text: string;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Collect an SSE completion into the same shape the non-streamed reply had.
 *
 * Every callers wants the finished text, so this hides the streaming again —
 * the streaming is there for cancellation, not for progressive output.
 */
async function readStream(res: Response): Promise<StreamResult> {
  if (!res.body) throw new Error("streamed response had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let finishReason: string | null = null;
  let usage: StreamResult["usage"] = {};

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; a frame can arrive split across
    // reads, so only whole ones are consumed and the remainder stays buffered.
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // a frame that is not JSON is not ours to interpret
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) text += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        // The usage frame arrives last and carries no choices.
        if (chunk.usage) usage = chunk.usage;
      }
    }
  }
  return { text, finishReason, usage };
}

/** `maxTokens` overrides the default completion budget for one call. The tagging
 *  pass needs a different one than a summary — a short array per session across a
 *  whole chunk — and sizing both from one env var means raising it for the pass
 *  also pays for a reasoning block on every session of the loop. */
export async function chat(
  messages: ChatMessage[],
  opts: { maxTokens?: number } = {}
): Promise<ChatReply> {
  const maxTokens = opts.maxTokens ?? MAX_TOKENS;
  const t0 = Date.now();
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local" },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      temperature: TEMP,
      max_tokens: maxTokens,
      // STREAMED, and not for the UI — nothing here renders a token as it lands.
      // It is what makes the timeout above mean anything. AbortSignal closes the
      // socket; it does not cancel work on the server. On a NON-streamed request
      // llama-server does not touch the socket until the whole completion is
      // ready, so it never learns the caller left and keeps decoding to the token
      // budget for nobody — minutes of GPU, and the next request now shares the
      // card with a ghost. With retries on top, one slow chunk leaves three of
      // them, and a pass degrades chunk over chunk until everything times out.
      // Streaming writes every token, so the first write after the abort fails and
      // the slot is released.
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: THINK },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);

  const { text, finishReason, usage } = await readStream(res);
  const body = { usage };
  const choice = { finish_reason: finishReason };

  // A thinking model that spends its whole completion budget on the thought returns
  // content="" with finish_reason="length" — an empty string, never an error.
  // Unnamed, that reaches the caller as "the model emitted no JSON" and reads as a
  // model too weak to hold the contract, which sends you looking for a better model
  // instead of a bigger budget.
  if (!text.trim() && choice.finish_reason === "length") {
    throw new Error(
      `empty content with finish_reason=length — the reasoning block consumed all ` +
      `${maxTokens} completion tokens (${body.usage?.completion_tokens ?? "?"} used). ` +
      `Raise LLM_MAX_TOKENS, or unset LLM_THINK.`
    );
  }

  return {
    text,
    ms: Date.now() - t0,
    promptTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
}

async function routerPost(endpoint: string): Promise<Response> {
  return fetch(`${ROUTER}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: LLM_MODEL }),
  });
}

// `{ managed: false }` means this endpoint has no router management API at all —
// a plain llama-server, or Ollama. That is not a failure: there is simply no model
// lifecycle to drive, and the run should proceed against whatever is already there.
async function modelStatus(): Promise<{ managed: boolean; status?: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${ROUTER}/models`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return { managed: false };
  }
  if (!res.ok) return { managed: false };
  const body = (await res.json()) as any;
  const entry = body.data?.find((m: any) => m.id === LLM_MODEL || m.aliases?.includes(LLM_MODEL));
  if (!entry) return { managed: true, status: null };
  return { managed: true, status: entry.status?.value ?? null };
}

/**
 * Make the model resident, and report whether THIS process is what made it so —
 * which is exactly the condition for unloading it afterwards.
 *
 * A model that was already loaded belongs to whoever loaded it. Unloading that on
 * the way out would evict a model another process is mid-way through using, to
 * reclaim VRAM nobody asked us for. Checking status first is also what makes this
 * idempotent: POST /models/load against a resident model is a 400, not a no-op.
 */
/**
 * Wait until the model is actually SERVING, not merely reported loaded.
 *
 * `status: "loaded"` is the router's view of its child. The child binds its port
 * and finishes bringing a multi-GB model up some seconds later, so the first real
 * request of a run can die `TypeError: fetch failed` (ECONNREFUSED) while every
 * later one succeeds. The transport retry around chat() is 3s + 6s, nowhere near
 * long enough for that, and the chunk it was carrying is lost. One cheap
 * one-token request, retried, closes the window.
 */
async function waitServing(): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  let last = "no attempt completed";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${LLM_BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer local" },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [{ role: "user", content: "ok" }],
          max_tokens: 1,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      await res.text(); // drain, so the connection is not left half-read
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String(e).slice(0, 120);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `model ${LLM_MODEL} reports loaded but is not serving after ${LOAD_TIMEOUT_MS / 1000}s (${last})`
  );
}

export async function loadModel(): Promise<boolean> {
  const { managed, status } = await modelStatus();
  if (!managed) return false; // nothing to drive; inference will still work
  if (status === null) {
    throw new Error(`the router serves no model named "${LLM_MODEL}" — check GET ${ROUTER}/models`);
  }
  if (status === "loaded") {
    // Loaded by someone else, or still coming up from an earlier load — either
    // way this run must not send real work before the child answers.
    await waitServing();
    return false;
  }

  // A load issued moments after an unload can be refused with a 400 while the
  // previous child is still tearing down. It is transient, so re-read the status
  // and retry briefly rather than failing a long run on a race with our own cleanup.
  let res = await routerPost("/models/load");
  for (let i = 0; i < 10 && res.status === 400; i++) {
    const { status: st } = await modelStatus();
    if (st === "loaded") return false; // something else won the race; not ours to unload
    await new Promise((r) => setTimeout(r, 2000));
    res = await routerPost("/models/load");
  }
  if (!res.ok) throw new Error(`/models/load → ${res.status} ${(await res.text()).slice(0, 200)}`);

  // The load is asynchronous: a 200 means accepted, not resident — measured as
  // `{"success":true}` in 0.0s with VRAM still untouched. Poll until the router
  // says loaded, so the cold load is not charged to the first session.
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { status: st } = await modelStatus();
    if (st === "loaded") {
      await waitServing();
      return true;
    }
    if (st === "failed" || st === "error") {
      throw new Error(`model ${LLM_MODEL} failed to load (status ${st})`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`model ${LLM_MODEL} did not reach "loaded" within ${LOAD_TIMEOUT_MS / 1000}s`);
}

/** Release the model. Caller passes what loadModel() returned: only a model this
 *  process loaded is ours to evict. */
export async function unloadModel(loadedByUs: boolean): Promise<void> {
  if (!loadedByUs) return;
  try {
    const res = await routerPost("/models/unload");
    if (!res.ok) console.error(`[llm] unload returned ${res.status}`);
  } catch (e) {
    console.error(`[llm] unload failed: ${e instanceof Error ? e.message : e}`);
  }
}
