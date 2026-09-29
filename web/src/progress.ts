// What the "Collect now" and "Generate drafts" bars show. Pure, so a test can
// drive it without a server or a DOM.
//
// Both bars are REAL progress, and each is honest about the stretches where there
// is nothing to count: the bar goes indeterminate (value null) rather than
// inventing a percentage.

import type { CollectRun } from "./api";

export interface BarView {
  /** 0..1, or null when there is no measurable fraction right now. */
  value: number | null;
  label: string;
  /** The span of the bar the work in hand will fill, [from, to] in 0..1 — drawn as
   *  a moving stripe when the step itself has nothing finer to report. */
  active?: [number, number];
}

export function fmtDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "--";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// The collector reports sessions summarized out of sessions to summarize, and its
// own ETA. Around that loop there are minutes it cannot count — discovering the
// sessions before, importing and tagging after — which read as indeterminate.
export function collectBar(run: CollectRun | null): BarView | null {
  if (!run) return null;
  if (run.status === "pending") {
    // Waiting for the poller on the WSL box, which also holds a run back while the
    // GPU is busy. Nothing has started, so there is nothing to measure.
    return { value: null, label: "Queued — waiting for the collector" };
  }
  if (run.status !== "running") return null;
  const done = run.progress_done;
  const total = run.progress_total;
  if (done == null || total == null) return { value: null, label: "Starting…" };
  if (total === 0) return { value: null, label: "Nothing new to summarize — finishing" };
  if (done >= total) return { value: 1, label: `${total}/${total} processed — importing and tagging` };
  const eta = run.progress_eta_ms != null ? ` · ~${fmtDuration(run.progress_eta_ms)} left` : "";
  return { value: done / total, label: `${done}/${total} sessions${eta}` };
}

// Generation is two model passes, reported by the server as each one starts. The
// bar fills a segment per pass; the current segment animates, because a single
// `claude -p` call has no progress of its own to report.
export type GenerateStage = "drafting" | "humanizing";
const STAGES: GenerateStage[] = ["drafting", "humanizing"];
const STAGE_LABEL: Record<GenerateStage, string> = {
  drafting: "Drafting",
  humanizing: "Humanizing",
};

export function generateBar(stage: GenerateStage | null, elapsedMs: number): BarView {
  const time = ` · ${fmtDuration(elapsedMs)}`;
  if (!stage) return { value: null, label: `Starting…${time}` };
  const i = STAGES.indexOf(stage);
  return {
    value: i / STAGES.length,
    label: `${STAGE_LABEL[stage]} (${i + 1}/${STAGES.length})${time}`,
    active: [i / STAGES.length, (i + 1) / STAGES.length],
  };
}

// NDJSON arrives in network chunks that split lines anywhere, including inside a
// multi-byte character — hence the decoder in stream mode, and a held-back tail.
export function createLineSplitter() {
  const decoder = new TextDecoder();
  let tail = "";
  const split = (text: string) => {
    const parts = (tail + text).split("\n");
    tail = parts.pop() ?? "";
    return parts.filter((l) => l.trim());
  };
  return {
    push: (chunk: Uint8Array): string[] => split(decoder.decode(chunk, { stream: true })),
    end: (): string[] => {
      const rest = (tail + decoder.decode()).trim();
      tail = "";
      return rest ? [rest] : [];
    },
  };
}
