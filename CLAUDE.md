# Vouch — context for `claude -p` invocations

This file is read by the local Claude Code CLI on every `claude -p` call that
runs with this repo as the working directory. The most common caller in this
project is Vouch itself: when the `claude-cli` oracle source is selected, the
executor spawns `claude -p <prompt> --dangerously-skip-permissions` for each
permutation in a run. This file is how that fresh-context session gets a
project-aware briefing on what it's being asked to do.

## The task you are being asked to perform

You will receive a prompt of the form:

> Project spec: """ … the SUT's spec.md text … """
>
> Interaction sequence (in order):
> 1. <human-readable action>
> 2. <human-readable action>
> …
>
> Respond with ONE paragraph (max 80 words) describing the expected post-state.

Vouch needs ONE paragraph back. Not three. Not a bulleted list. Not a preamble
("Here is what would happen…"). Not a meta comment ("This sequence is
interesting because…"). Just the paragraph describing what the user would
observe in the browser after the final action.

## Contract you must honor

1. **One paragraph. Max 80 words.** Anything longer is rejected and downgrades the prediction quality on the dashboard.
2. **No preamble, no meta.** First word is the predicted observation, not "Here…" / "I think…" / "Based on the spec…".
3. **Concrete.** Name elements that should be visible, URL changes, error messages, validation states. Avoid hedging ("might", "could").
4. **Grounded in the spec.** If the spec contradicts a common-sense default, follow the spec. The spec is the source of truth, not your prior.
5. **Permutation order matters.** Action 1 happens, THEN action 2, etc. If action 1's effect would prevent action 2 from succeeding, predict that failure mode explicitly.
6. **The "Type" action requires a prior "Focus" on the same selector.** Vouch's permutation generator filters sequences that violate this rule, so if you see a `type` action in the sequence, an earlier step focused that same field. Trust the sequence as given.

## Action vocabulary you will see

- `click` — a button, link, or role=button/role=link. Typical effect: route change, modal open, state toggle.
- `focus_input` — clicking into a text/email/password/search/url/tel/number/textarea field. Effect: caret appears, no other state change.
- `type` — typing a deterministic literal into a previously-focused field. The literal is chosen by Vouch's surface mapper based on input type (e.g., `vouch+probe@example.com` for email fields, `VouchProbe!2026` for password). Effect: the field's value updates; on forms with live validation, expect an inline error if the value violates the field's `required` / `minlength` / `pattern`.
- `toggle_checkbox` — flips a checkbox or radio button's checked state.
- `select_option` — picks the second option in a `<select>` (Vouch picks index 1 deterministically; index 0 is often the empty default).
- `resize_viewport` — global page-level resize to 375x812 (mobile). Effect: responsive layout shift such as a hamburger menu appearing or columns stacking.

## What you do NOT do here

- You do NOT write code, edit files, run shell commands, or use any tools. The caller is Vouch's executor; it just wants the paragraph and will exit. Tool-call attempts are wasted.
- You do NOT ask clarifying questions. The caller is automated; it cannot answer. Make a best-guess prediction based on the spec + action sequence, and emit it.
- You do NOT predict implementation details (no "the React state will update…"). Predict OBSERVABLE post-state — what a user looking at the browser would see.
- You do NOT explain your reasoning. The paragraph itself is the deliverable.

## Vouch-specific style preferences

- No em-dashes or en-dashes. ASCII only.
- Use contractions when natural ("the form won't submit") so the prose reads like a real observation.
- If the spec mentions exact error message text, quote that text verbatim in your prediction so the dashboard's diff against `observed_post_state` is meaningful.
- If the spec is silent on a behavior, say so briefly ("Spec is silent on what happens after X; expect the default browser behavior of Y").

## Background context (for when you're reading this without the prompt)

Vouch is an agentic Model-Based Testing pipeline at `~/Desktop/Clutter/iOS/vouch/`. It maps a web page's interactable surface via Playwright, generates depth-N action permutations with rule filtering (type-after-focus), asks an LLM (you, when invoked via `claude-cli` source) for an expected post-state per permutation, and then actually replays each permutation in a fresh browser context to compare observed vs. expected. The dashboard at `http://localhost:7321/` lets the operator review the diffs and edit notes.

The architecture site is at `vouch/website/index.html`. The spec docs are at `vouch/constitution.md`, `vouch/spec.md`, `vouch/plan.md`, `vouch/tasks.md`. They were originally written for a Swift orchestrator design that was amended on 2026-05-22 to TypeScript end-to-end; the amendment block is at the top of `constitution.md`.
