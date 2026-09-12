You are orchestrating one collection run for the social-update journal. Work from
the repository at {{REPO}}; every command below is run from there.

{{COUNT}} Claude Code session(s) need summarizing. They are listed in:

    {{MANIFEST}}

Read that file first. Each entry carries `session_id`, `project`, `path` (the
transcript), `mtime` and `size`.

## Step 1 — fan out, one sub-agent per session

Dispatch **one `session-summarizer` sub-agent per manifest entry**, and send them
**concurrently — as many Agent calls in a single message as you can**. Do not
summarize any session yourself: your context is the scarce resource here, and a
transcript read into it is one that crowds out the tagging pass.

Every session in the manifest gets a sub-agent; there is no cap on the total. If
the manifest is long, send them in waves of roughly 25 per message and start the
next wave as soon as the previous one is dispatched — the waves are a limit on
what fits in one message, not a limit on how many sessions you process.

Give each sub-agent exactly this, filled in from its manifest entry:

    Summarize one Claude Code session.

    session_id:  <session_id>
    project:     <project>
    transcript:  <path>
    occurred_at: <mtime>
    write to:    {{SUMMARY_DIR}}/<session_id>.json

    The file must contain this JSON object and nothing else:

{{SCHEMA}}

    Then validate it:
        node {{REPO}}/dist/summary-validate.js {{SUMMARY_DIR}}/<session_id>.json
    It exits nonzero and names the offending field. Fix and re-run until it prints
    OK. Do not stop while it fails.

Wait for every sub-agent to finish before going on.

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
