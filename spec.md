# Vouch — Spec

What we are building and why. User stories with explicit acceptance criteria, out-of-scope list, rubric-pillar mapping, and the demo path. The constitution constrains how this is built; this file says what.

## Problem statement

A solo developer (or a small team) finishes a slice of a product and wants to know, before they ship, whether every sensible interaction sequence still works. Hand-writing a regression suite at the granularity Vouch operates is uneconomical; eyeballing it is unreliable; existing model-based testing tools require both the model and the oracles to be authored by hand. The result is that combinatorial regressions are found by users, not by tests. Vouch closes that loop: the developer hands off a built artifact and a spec, and a background worker drives every action sequence under the declared rules, comparing observed behavior to oracles that were inferred from the spec by a cheap LLM.

Success looks like: the developer pushes a build, walks away, comes back to a verdict report that names the exact permutation that broke, the action it broke on, and the discrepancy between the spec-derived expectation and the observed state. They never had to write the test for that permutation.

## Personas

- **Indie developer** — single-author projects (Swift iOS apps, small web tools). Wants async background runs while they keep coding. The dominant Vouch persona.
- **Small-team QA lead** — three to five developers, no dedicated QA hire. Uses Vouch as the post-merge regression sweep.
- **Spec author** — the same developer wearing a different hat. Edits `spec.md` (the SUT spec, not this one), watches the oracle cache invalidate and the failing permutations re-run.

## Core user stories with acceptance criteria

Acceptance is Given / When / Then so the QA gate's adversary agent can replay each story as an integration test.

### US-01 — Web app handoff produces a complete surface map

> As an indie developer, I want to hand off a URL to a running web app so that Vouch maps every interactable element without me having to enumerate them.

**Given** a local URL serving a single-page application with at least ten interactable nodes spread across two routes,
**When** I run `vouch map --target https://localhost:3000 --output ./surface.json`,
**Then** the resulting `surface.json` lists every interactable node by stable selector (test-id preferred, then ARIA role + accessible name, then CSS path as fallback) AND records each node's enabled/disabled state at observation time AND validates against `schemas/surface.schema.json` AND the run completes in under fifteen seconds for a surface of ten to one hundred nodes on a recent MacBook.

### US-02 — iOS .app handoff produces the same surface map

> As an iOS developer, I want to hand off a `.app` bundle so that Vouch maps every accessibility-exposed element with no DOM equivalent.

**Given** a `.app` bundle built for the iOS Simulator, with each interactable element carrying an `accessibilityIdentifier`,
**When** I run `vouch map --target ./MyApp.app --platform ios --output ./surface.json`,
**Then** Vouch boots a simulator (or attaches to a running one), launches the app, walks the accessibility hierarchy, and emits the same `surface.json` schema as US-01 AND the simulator is left running so subsequent action runs reuse it.

### US-03 — Permutations are enumerated under FSM constraints

> As a developer, I want a deterministic enumeration strategy so that two runs of the same surface and the same current rule set produce the same permutation list.

**Given** a `surface.json` and the current rule set (the set of promoted rules in `vouch.db`, which may be empty on day one and grows as the Rule Inducer learns),
**When** I run `vouch plan --depth 3 --strategy pairwise --output ./plan.json`,
**Then** the plan lists every action sequence of length at most three that satisfies the current rule set AND the order is deterministic (stable sort by action-signature hash) AND re-running with the same inputs produces an identical file (byte-for-byte) AND a `--seed` flag makes random sampling strategies (e.g. `--strategy sample --count 500`) reproducible. On a freshly initialized project with zero promoted rules, the enumerator emits every sequence the surface allows — exhaustive freedom is the bootstrap state, and the Rule Inducer narrows it over subsequent runs.

### US-04 — Spec drives oracle inference under a budget

> As a developer, I want each permutation's expected outcome inferred from my spec by a cheap LLM so that I do not have to write oracles by hand.

**Given** a `spec.md` describing the SUT's behavior in natural language,
**When** Vouch needs an oracle for action `web:click@#submit` at pre-state `form_valid`,
**Then** it computes `cache_key = sha256(action_signature ‖ pre_state_hash ‖ spec_version)` AND, on cache miss, calls Haiku once with the spec excerpt + action + pre-state, AND parses the response into a `PostConditionPredicate` (a small DSL described in `plan.md`) AND writes the predicate to the cache, AND a cache hit on the second run takes under fifty milliseconds (zero LLM cost).

### US-05 — Background worker runs permutations asynchronously

> As a developer, I want Vouch to keep running while I keep coding so that QA is not a context switch.

**Given** a planned run of one hundred permutations,
**When** I run `vouch run --plan ./plan.json --workers 4 &`,
**Then** the CLI returns immediately with a `run_id`, the worker process runs in the background, each permutation is executed against a fresh SUT instance (new browser context, new simulator boot, new app launch) AND verdicts stream to `./runs/<run_id>/verdicts.ndjson` as they complete AND `vouch status <run_id>` reports progress without blocking.

### US-06 — Verdict report names the failing permutation precisely

> As a developer, I want a failure to point me at exactly the action that broke so that I do not have to bisect.

**Given** a completed run with at least one failure,
**When** I run `vouch report <run_id>`,
**Then** each failure entry includes: the full action sequence, the index of the failing step, the action signature, the predicate that was violated, the observed state hash, a screenshot path, a DOM/accessibility snapshot path, and the network/console log path for that step.

### US-07 — Image-only handoff falls back to vision

> As a developer with a system I cannot introspect deterministically (e.g., a Flutter app, a Unity build), I want to hand off screenshots so that Vouch can still attempt coverage.

**Given** a directory of screenshots representing distinct application states,
**When** I run `vouch map --target ./screens/ --platform image --output ./surface.json`,
**Then** Vouch calls a vision LLM to enumerate interactable regions per screen, emits a `surface.json` annotated `confidence: low` AND surfaces a clear warning that image-mode coverage is best-effort.

### US-08 — Self-host: Vouch tests Vouch

> As the Vouch developer, I want Vouch to run its own CLI through its web executor so that the project dogfoods itself.

**Given** a local dev mode that serves Vouch's CLI surface via a thin HTTP shim,
**When** I run `vouch run --plan tests/self-host/plan.json` against `http://localhost:7777`,
**Then** every Vouch CLI command appears as a node in the surface, every documented flag combination appears as an action, AND the verdict report covers the CLI's documented behavior.

### US-09 — Spec edits invalidate the right cache entries automatically

> As a developer iterating on my SUT's spec, I want Vouch to re-infer only the oracles that the edit touched so that an unrelated paragraph rewrite does not nuke the whole cache.

**Given** a `spec.md` edited in one section (one heading and its body),
**When** Vouch re-runs against the same plan,
**Then** only oracles whose `spec_excerpt` overlaps the edited section are recomputed AND a `vouch cache stats` command reports cache hit ratio per run.

### US-10 — Surface delta detection on every action

> As a developer, I want Vouch to notice when an action exposes (or hides) new interactable elements so that the surface is treated as a live thing, not a one-shot snapshot.

**Given** a sequence is running and the executor has just performed step `n`,
**When** the post-step accessibility/DOM snapshot differs from the pre-step snapshot in its set of interactable node identifiers,
**Then** the executor emits a `SurfaceDelta` record naming exactly which node identifiers appeared and which disappeared AND that record is persisted under `runs/<run_id>/<sequence_id>/deltas.ndjson` AND every step's pre-state and post-state surface hashes are recorded in `vouch.db` so a later cross-run query can compare them. The detection runs on every step of every permutation regardless of whether the step's predicate passed.

### US-11 — Candidate rule proposal with scored confirmations and denials

> As a developer, I want Vouch to discover rules from what it observes so that the FSM gets denser without me writing anything.

**Given** two distinct runs have observed the same surface delta following the same action signature at compatible pre-states,
**When** the Rule Inducer scans the `SurfaceDelta` history,
**Then** it creates (or updates) a candidate rule row in `vouch.db` carrying:
- a stable `rule_id` derived from the action signature and the consequent shape,
- a `rule_shape` (one of: `exposes`, `hides`, `requires-prior`, `requires-state`, `forbids-followed-by`),
- per-observation arrays of confirmations and denials, EACH entry timestamped to ISO-8601 UTC and carrying the `run_id` + step index that produced it,
- a time-weighted `confirmation_score` recomputed on every observation, favoring recent evidence over old.

A `vouch rules ls --status candidate` command lists every candidate rule with its score, observation count, first-seen and last-seen timestamps. Every rule in `vouch.db` is system-discovered; there is no other source.

### US-12 — Rules promote and retire under threshold rules, never silently

> As a developer, I want Vouch's promoted rules to be inspectable and overrideable so that I can always see exactly which behaviors the system has learned to trust.

**Given** a candidate rule with at least ten confirmations and fewer than two denials, observed across at least three distinct runs spanning at least two distinct calendar days,
**When** the Rule Inducer evaluates promotion at the end of a run,
**Then** the rule's status flips from `candidate` to `promoted` AND `promoted_at` is set AND the next call to the Sequence Enumerator includes the promoted rule in its constraint set AND `vouch rules ls --status promoted` lists it AND a developer can override with `vouch rules retire <rule_id>` (which sets status to `retired_by_human` and prevents re-promotion).

Symmetrically, a previously promoted rule that accumulates three consecutive denials OR whose time-weighted score falls below 0.7 fires the Clash Arbiter (US-13). Promotion, demotion, and retirement always log to a structured audit trail in `vouch.db` `rule_history` so a developer can replay how any given rule reached its current status.

### US-13 — Clash arbitration distinguishes regression from intentional evolution

> As a developer, when a previously trustworthy rule starts breaking, I want Vouch to tell me whether my code regressed or whether my spec just changed.

**Given** a promoted rule has fired the demotion trigger (three consecutive denials, or score below 0.7),
**When** the Clash Arbiter runs,
**Then** it loads the `spec.md` content at the rule's `promoted_at` timestamp (from git history, falling back to the SQLite snapshot taken at promotion time), diffs it against the current `spec.md`, AND:

- If no relevant spec section changed, the verdict is `regression` AND a high-severity finding is filed in the run report naming the broken rule, the offending action sequence, the original confirming runs, and the most recent denying runs.
- If a relevant spec section changed, the Arbiter calls Haiku once with the broken rule, the spec diff narrowed to the touched headings, and the recent denying observations. The model returns one of three labels:
  - `evolution_intentional` (spec change plausibly explains the new behavior): the rule retires with `retired_by_spec_change` AND the spec excerpt that explains it is recorded.
  - `evolution_possibly_intentional` (model is uncertain): the rule is marked `pending_human_review` and surfaced in the run report.
  - `regression_despite_spec_change` (spec changed but does not justify the observed deviation): the rule stays promoted and a high-severity finding is filed, with the spec diff attached as "exonerating evidence rejected."

The Arbiter's verdict, the prompt it used, and the model's raw response are all persisted to `vouch.db` `arbiter_decisions` for audit. A developer can override any Arbiter call with `vouch rules arbitrate <rule_id> --as <verdict>`.

## Out of scope (deliberate, with one-line reasons)

| Out of scope | Why |
| --- | --- |
| Hosted multi-tenant dashboard | Local-only target this iteration; user explicitly chose local CLI + background worker. |
| Cross-browser matrix (Firefox, Safari) | Playwright supports it; not the v1 demo. Add when there is a real bug attributable to engine differences. |
| Auto-fix of failing permutations | Vouch reports, the developer fixes. Auto-fix is a different product. |
| Visual diffing | Screenshot-by-screenshot diff is a different paradigm; Vouch compares state predicates, not pixels. |
| Pricing / billing / accounts | No multi-user concept exists. |
| Replacing unit tests | Vouch operates at the surface; unit tests still cover internal logic. |
| Sonnet escalation v1 | Backlog item; Haiku-with-cache is the cost posture. |
| Vision-LLM as the primary introspection mode | Fallback only. Determinism is a constitution-level rule. |
| Developer-authored transition rules | The whole point is that the developer never writes rules. The system discovers everything by observation. If a developer thinks they have a rule the system has missed, the right move is to wait a few runs (or run a high-coverage exhaustive pass once) so the inducer can observe it. |
| Cross-project rule transfer | Rules are scoped per repo (one `vouch.db` per project). A promoted rule in app A is invisible to app B even if surface signatures collide. Revisit once the dataset is large enough that hashing collisions matter. |

## Rubric-pillar mapping

| Rubric pillar | User stories that satisfy it | Where the evidence lives |
| --- | --- | --- |
| Architecture | US-01, US-02, US-07 (polyglot executors behind one CLI), US-03 (FSM-guarded enumeration with the rule set discovered, not declared), US-10 to US-13 (delta detection + rule induction loop + arbiter side-channel) | `plan.md` decisions table + `website/index.html` topology |
| Scalability | US-05 (background worker), US-09 (incremental cache invalidation), US-10 (delta detection is O(1) per step, not per surface) | `plan.md` "trade-offs" + `tasks.md` parallelization slice |
| Security | constitution "Things Vouch never does" + US-07's read-only screenshot handoff + US-12's "never silently" promotion rule | `constitution.md` non-negotiables section |
| Testing | US-06 (precise verdicts), US-08 (self-host), US-13 (regression-vs-evolution classifier as a testing-quality multiplier) | `tasks.md` self-host slice + the QA gate output on every PR |

## Demo script (sixty-second happy path)

1. Hand-off line: `vouch map --target https://demo.local:3000 --output surface.json && head -20 surface.json` — show the surface enumerated as JSON, point at one ARIA-derived selector.
2. `vouch plan --depth 3 --strategy pairwise --output plan.json && jq '.sequences | length' plan.json` — show that the plan emerges from the surface and whatever rules the system has learned so far. On a fresh project this is the full combinatorial space; the rule set is empty on day one.
3. `vouch run --plan plan.json --workers 4 &` — get a `run_id` back instantly. The shell prompt returns.
4. While the run is going: `vouch status <run_id>` — show progress, including count of new candidate rules being observed.
5. After completion: `vouch report <run_id>` — show the verdict tree, drill into one failure, show the named action, the violated predicate, the screenshot. Show the inducer-changes section: three new candidate rules this run, one promoted.
6. `vouch rules ls --status promoted` — drill into the promoted rule's history: ten confirmations across four runs, last one ten minutes ago. Every rule shown is system-discovered; no developer wrote any of them.
7. Edit the SUT spec, re-run, show the cache stats: most oracles cached, only the touched section re-inferred.
8. Run a deliberately regressed build and re-run: the Clash Arbiter classifies it `regression` (no spec change), the previously promoted rule stays promoted, the verdict report names the broken action and links the arbiter audit row.

Total: under ninety seconds of spoken demo over a pre-recorded build.

## Cross-references

- Decisions and trade-offs: `plan.md`
- Slice sequencing for the agent: `tasks.md`
- Stack and style rules: `constitution.md`
- Rubric anchor evidence: `constitution.md` rubric anchor map
