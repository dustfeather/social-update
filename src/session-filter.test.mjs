import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { isProgrammaticSession } = await import("../dist/claude-sessions.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessfilter-"));
const write = (name, lines) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return p;
};

test("an sdk-driven session is excluded", () => {
  const f = write("sdk.jsonl", [
    { type: "user", entrypoint: "sdk-py", message: { content: "Review this change" } },
  ]);
  assert.equal(isProgrammaticSession(f), true);
});

test("an interactive cli session is kept", () => {
  const f = write("cli.jsonl", [{ type: "user", entrypoint: "cli", message: { content: "hi" } }]);
  assert.equal(isProgrammaticSession(f), false);
});

// The asymmetry that shapes this filter: a dropped real session is silent and gone,
// a kept agent session costs one summary. So anything unrecognised is kept.
test("an unknown entrypoint is kept, not guessed at", () => {
  const f = write("future.jsonl", [{ type: "user", entrypoint: "vscode-beta", message: { content: "hi" } }]);
  assert.equal(isProgrammaticSession(f), false);
});

test("a transcript with no entrypoint at all is kept", () => {
  const f = write("bare.jsonl", [{ type: "summary", leafUuid: "x" }]);
  assert.equal(isProgrammaticSession(f), false);
});

test("an unreadable path is kept rather than throwing mid-scan", () => {
  assert.equal(isProgrammaticSession(path.join(dir, "does-not-exist.jsonl")), false);
});

test("entrypoint found past the first line still counts", () => {
  const f = write("late.jsonl", [
    { type: "summary", leafUuid: "x" },
    { type: "user", entrypoint: "sdk-cli", message: { content: "config" } },
  ]);
  assert.equal(isProgrammaticSession(f), true);
});

// The claudeception Stop hook starts a headless `claude -p` per fire. Those
// transcripts are the tooling reading the session you already summarize.
test("a claudeception hook child is excluded by its opening line", () => {
  const f = write("ception.jsonl", [
    {
      type: "user",
      entrypoint: "sdk-cli",
      message: {
        content:
          "Read the file /tmp/claude-claudeception-slice-abc123.txt. It is a transcript slice",
      },
    },
  ]);
  assert.equal(isProgrammaticSession(f), true);
});

// The entrypoint denylist catches these today too, but only by accident: it is off
// under CLAUDE_INCLUDE_SDK_SESSIONS=1, and a release could relabel `claude -p`.
test("a claudeception child is excluded even with an entrypoint that would be kept", () => {
  const f = write("ception-cli.jsonl", [
    {
      type: "user",
      entrypoint: "cli",
      message: { content: "Read the file /tmp/claude-claudeception-slice-deadbeef.txt." },
    },
  ]);
  assert.equal(isProgrammaticSession(f), true);
});

// The discriminator, and the reason the marker is read off the OPENING PROMPT only:
// a session that works ON the hook quotes the child's prompt verbatim — in a tool
// result, a diff, a test fixture — and that session is real work worth journaling.
test("a session that merely works on the hook is kept, even quoting the child prompt", () => {
  const f = write("hook-edit.jsonl", [
    { type: "user", entrypoint: "cli", message: { content: "fix the claudeception stop hook" } },
    {
      type: "assistant",
      entrypoint: "cli",
      message: {
        content: [
          { type: "text", text: "Read the file /tmp/claude-claudeception-slice-abc.txt" },
        ],
      },
    },
  ]);
  assert.equal(isProgrammaticSession(f), false);
});
