You are orchestrating one collection run for the social-update journal. Work from
the repository at {{REPO}}; every command below is run from there.

{{COUNT}} Claude Code session(s) need summarizing. They are listed in:

    {{MANIFEST}}

Read that file first. Each entry carries `session_id`, `project`, `path` (the
transcript), `mtime` and `size`.

## Step 1 — fan out, one sub-agent per session

Dispatch **one `session-summarizer` sub-agent per manifest entry**. Do not
summarize any session yourself: your context is the scarce resource here, and a
transcript read into it is one that crowds out the tagging pass.

**Put 25 Agent calls in ONE message.** Not one call, then its result, then the
next. Twenty-five separate tool-use blocks in the same assistant turn, then the
next twenty-five in the turn after that, until the manifest is exhausted. There
is no cap on the total.

This decides whether the run takes ten minutes or two hours. Each sub-agent
takes about the same time whether it runs alone or alongside two dozen others,
so the cost of this step is (sessions ÷ per-message width) × one sub-agent. One
observed run did dispatch one per message — 22 dispatches over 21 messages —
which is the failure this paragraph exists to prevent.

Each dispatch is six lines — deliberately small, so that twenty-five of them in
one message stay cheap to emit:

    Summarize one Claude Code session.

    session_id:  <session_id>
    project:     <project>
    transcript:  <path>
    occurred_at: <mtime>
    write to:    {{SUMMARY_DIR}}/<session_id>.json
    repo:        {{REPO}}

The sub-agent knows the schema and the validation loop from its own definition;
it prints the contract with `summary-validate.js --schema`. Do not paste the
schema into the dispatch — that is what made an earlier version fall back to one
sub-agent per message.

Wait for every sub-agent in a wave to finish before going on to Step 2, but do
not wait between waves: dispatch the next wave as soon as the previous message
is sent.

## Step 2 — import

Run, once:

    node {{REPO}}/dist/claude-import.js

It validates every summary, writes them all to the database in one batch, and
prints a JSON report: `imported`, `written`, `invalid`, `missing`. It exits
nonzero if any summary failed validation.

If `invalid` is non-empty, the named sub-agents left broken files. Re-dispatch a
sub-agent for each of those sessions with the validator errors quoted in its
prompt, then run the import again. `missing` entries are sessions whose sub-agent
wrote nothing; they stay pending and will be retried on the next run — mention
them, do not chase them.

## Step 3 — tag

Read every file in {{SUMMARY_DIR}} (they are small — this is the one place you
should load content directly) and assign tags across the whole set at once.

Tagging is a single pass on purpose: the value of a tag is that two sessions about
the same thing carry the *same* one. A per-session tagger cannot do that, which is
why this step is yours and not the sub-agents'.

- 1 to 6 tags per session, lowercase kebab-case, max 30 characters each.
- Prefer a tag that already fits over a new near-synonym: `ci` or `github-actions`,
  not both; `refactor` rather than `code-cleanup` if `refactor` is already in play.
- Tag the *subject and the kind of work* — `kubernetes`, `security-audit`,
  `bug-fix`, `rich-text-editor` — not the tools that happened to be used.
- Aim for a vocabulary that stays small across runs. Before inventing a tag, check
  what you have already used in this pass.

Write the result to {{WORK_DIR}}/tags.json as `{ "<session_id>": ["tag", ...] }`,
covering every session that the import reported as imported (and only those).
Then apply it:

    node {{REPO}}/dist/claude-tag.js

It validates the file and prints `{ asked, updated }`. A mismatch means the file
names a session that never made it into the database — fix the file, re-run.

## Finally

Report, in a few lines: how many sessions were summarized, how many rows were
written, any invalid or missing sessions by id, and the tag vocabulary you ended
up with. Keep it short; this text is written to the collector log, not to a human
watching a screen.
