# Vouch — Plan

How it gets built. Topology, component responsibilities, data flow, decisions, trade-offs, slice sequencing. The polished version of the topology lives in `website/index.html`; this file is the source for it.

## High-level topology

The pipeline is six components arranged as a downward main spine with one feedback loop on the left (the Rule Inducer learns from the executor and feeds the Sequence Enumerator on the next run — this is the only source of rules in the entire system) and one side-channel on the right (the Clash Arbiter is triggered by the Rule Inducer when a promoted rule starts to deny, and writes its decision into the audit table). The persistence column on the far right is read and written by every stage that needs durable state. The developer never authors transition rules; on day one the rule set is empty and the enumerator emits every sequence the surface allows.

```
                                                ┌──────────────────────────────────────┐
                                                │  vouch CLI  (Swift, ArgumentParser)  │
                                                └──────┬────────────────────┬──────────┘
                                                       │ spawns subprocesses │ reads/writes
                                                       ▼                     ▼
                          ┌─────────────────────────────────────┐    ┌────────────────────────┐
                          │  Surface Mapper                     │    │  vouch.db (SQLite)     │
                          │  - web   : node-playwright helper   │    │  runs, verdicts,       │
                          │  - ios   : XCUITest helper (Swift)  │    │  oracle_cache,         │
                          │  - and   : node-appium helper       │    │  proposed_rules,       │
                          │  - image : Swift + vision LLM       │    │  rule_history,         │
                          └──────────────┬──────────────────────┘    │  arbiter_decisions,    │
                                         │ NDJSON: surface.json       │  surface_snapshots     │
                                         ▼                            └──────────┬─────────────┘
              promoted ┌──────────────────────────────────────┐                   │
              rules    │  Sequence Enumerator (Swift module)  │                   │
              feedback │  reads promoted rules + surface.json │                   │
              ┌────────┤  emits plan.json                     │                   │
              │        └──────────────┬───────────────────────┘                   │
              │                       │                                            │
              │                       ▼                                            │
              │        ┌──────────────────────────────────────┐                    │
              │        │  Oracle Translator (Swift)           │◀───────────────────┤ cache lookup
              │        │  Haiku call per (action, pre-state)  │                    │
              │        │  parses PostConditionPredicate DSL   │───────────────────▶│ cache write
              │        └──────────────┬───────────────────────┘                    │
              │                       │                                            │
              │                       ▼                                            │
              │        ┌──────────────────────────────────────┐                    │
              │        │  Executor + Verdict Engine (Swift)   │                    │
              │        │  - workers run permutations in       │                    │
              │        │    isolated SUT instances             │                    │
              │        │  - emits (pre, post, action, delta)  │───────────────────▶│ verdict +
              │        │    stream + verdict per step          │                    │ surface_snapshot
              │        └──────────────┬───────────────────────┘                    │ inserts
              │                       │ surface-delta stream                       │
              │                       ▼                                            │
              │        ┌──────────────────────────────────────┐                    │
              └────────┤  Rule Inducer (Swift)                │───────────────────▶│ proposed_rules
                       │  scores candidate rules, promotes /  │                    │ rule_history
                       │  retires under threshold rules        │                    │ writes
                       └──────────────┬───────────────────────┘                    │
                                      │ on promoted-rule denial                    │
                                      ▼                                            │
                       ┌──────────────────────────────────────┐                    │
                       │  Clash Arbiter (Swift + Haiku)        │                    │
                       │  loads spec.md at promoted_at,        │───────────────────▶│ arbiter_decisions
                       │  diffs vs now, classifies              │                    │ writes
                       │  regression / evolution / pending     │                    │
                       └──────────────┬───────────────────────┘                    │
                                      │                                            │
                                      ▼                                            │
                       ┌──────────────────────────────────────┐                    │
                       │  Reporter (Swift)                     │◀───────────────────┘ reads everything
                       │  vouch report / vouch rules ls /      │
                       │  vouch cache stats                    │
                       └──────────────────────────────────────┘
```

The left-side feedback loop (Rule Inducer → Sequence Enumerator) is the learning channel: each subsequent `vouch plan` invocation gets a denser FSM without anyone editing YAML. The right-side feedback loop (every stage → SQLite) is the persistence channel. The arrows are laid out so no edges cross.

## Component breakdown

### 1. CLI (Swift, `swift-argument-parser`)

The user-facing entry point. Subcommands: `map`, `plan`, `run`, `status`, `report`, `cache stats`, `cache clear`. Each subcommand is a `ParsableCommand` type in its own file under `Sources/VouchCLI/Commands/`. No business logic lives in the CLI types; they parse and dispatch.

Inputs: command-line args, environment (`VOUCH_DB_PATH`, `ANTHROPIC_API_KEY`, `VOUCH_RUNS_DIR`).
Outputs: an exit code, structured logs to stderr, NDJSON to stdout when piped (`vouch run --plan ... --json | jq ...`).
Failure modes: missing env (clear message naming the variable + a `vouch doctor` hint), unparseable args (`swift-argument-parser`'s built-in help text).

### 2. Surface Mapper (per-platform subprocess)

Each platform has its own subprocess binary. The CLI orchestrator spawns the right one based on `--platform` (or auto-detected from `--target`). Each speaks NDJSON over stdin/stdout, one request per line, one response per line.

| Platform | Process | How introspection works |
| --- | --- | --- |
| Web | `node executors/web/dist/index.js` | Playwright launches Chromium, navigates to the URL, walks the accessibility tree via `page.accessibility.snapshot()` + per-route DOM scrape, stable selectors prefer `data-testid` → ARIA role+name → CSS path |
| iOS | `vouch-ios-executor` (Swift binary, separate target) | Spawns or attaches to `xcrun simctl`, launches the app, queries `XCUIApplication().descendants(matching: .any)` and reads `identifier` / `label` / `value` / `isEnabled` |
| Android | `node executors/android/dist/index.js` | Appium 2 + UIAutomator2 driver, queries the view hierarchy via `mobile: source` |
| Image | `vouch-image-executor` (Swift binary, separate target) | Reads images, sends each frame to Anthropic vision API with a fixed prompt template, parses the response into `surface.schema.json` |

Failure modes: SUT unreachable (named in error, with `vouch doctor` hint), introspection times out (per-step 30 s default, `--timeout` flag), unparseable executor output (raw chunk attached to the error, never silently dropped).

### 3. Sequence Enumerator (Swift module, `Sources/VouchCore/Enumerator`)

Pure function: `(Surface, PromotedRules, Strategy) -> Plan`. Reads `surface.json` and the current set of promoted rules from `vouch.db` (zero rows on a fresh project is the normal bootstrap state), emits `plan.json`. Has no I/O outside reading the two inputs and writing the one output (Composable + Predictable).

Strategies in v1:
- `exhaustive` — every sequence up to `--depth`. Bounded by combinatorial blowup; capped at 100,000 sequences with a clear error if the surface × depth exceeds it.
- `pairwise` — covering array (orthogonal 2-way) using a port of Microsoft's PICT algorithm. Default.
- `sample --count N --seed S` — uniform random sample of valid sequences, seeded for reproducibility.

The rule vocabulary the enumerator filters on is exactly the five `rule_shape` values the Rule Inducer produces (`exposes`, `hides`, `requires-prior`, `requires-state`, `forbids-followed-by`); the inducer is the sole writer of rules and the enumerator is the sole consumer. Anything that looks like a "transition rule" anywhere in this codebase came from observation, not authorship. State predicates referenced by `requires-state` rules are also discovered by the inducer (when it consistently sees a cluster of post-state surface conditions correlate with an action being enabled, it proposes the cluster as a named state).

### 4. Oracle Translator (Swift module, `Sources/VouchCore/Oracle`)

For each `(action, pre_state)` in the plan, computes the cache key `sha256(action_signature ‖ pre_state_hash ‖ spec_version)` and either:
- returns the cached `PostConditionPredicate`, or
- calls Anthropic Haiku with a prompt that supplies (a) the relevant spec excerpt, (b) the action signature, (c) the pre-state description, and asks for a JSON object conforming to `predicate.schema.json`. On parse failure, retries once with a stricter prompt. On second failure, marks the predicate `unparseable` and the action gets verdict `unparseable_oracle` at run time (the developer fixes the spec, not the oracle).

`PostConditionPredicate` DSL (intentionally tiny, audit-friendly):
```json
{
  "kind": "all_of",
  "checks": [
    { "kind": "selector_exists", "selector": "#order-confirmation" },
    { "kind": "selector_text_contains", "selector": ".status", "text": "draft" },
    { "kind": "url_matches", "regex": "^/orders/[0-9]+$" }
  ]
}
```

Supported `kind` values in v1: `selector_exists`, `selector_text_contains`, `selector_text_matches`, `url_matches`, `state_transitioned_to`, `all_of`, `any_of`, `not`. Everything composable from this set; nothing executable beyond it. The DSL is the security boundary: the LLM can never emit arbitrary code.

`spec_version` is `sha256(spec.md)` (the SUT's spec, not Vouch's own). When the user edits a heading and its body, only oracles whose excerpt overlaps that section's byte range are invalidated. The mapping from `(section heading) -> (oracle cache rows)` is maintained at infer time.

### 5. Executor + Verdict Engine (Swift module + per-platform helpers)

For each sequence in the plan, the executor:
1. Spins up a fresh SUT instance (new browser context, new simulator boot, new app launch).
2. Walks the sequence step by step. Before each step, snapshots the pre-state. After each step, snapshots the post-state.
3. Evaluates the step's `PostConditionPredicate` against the post-state. Records verdict for that step.
4. If a step's verdict is `fail`, optionally continues with remaining steps (default: stop, so the report points at the first break).
5. Writes the trace to `./runs/<run_id>/<sequence_id>/`: `pre-state.json`, `post-state.json`, `screenshot.png`, `network.ndjson`, `console.ndjson`, `verdict.json`.

Verdict values: `pass`, `fail`, `timeout`, `infrastructure_error`, `unparseable_oracle`, `skipped:missing_input`. Each carries a reason string and (where applicable) a delta (expected vs observed).

Workers are managed by a simple Swift `actor`-based pool. Default `--workers 4`. Per-permutation isolation = no shared mutable state across workers.

### 6. Rule Inducer (Swift module, `Sources/VouchCore/Inducer`)

The learning loop and the only source of rules in the system. The Executor emits a `(action, pre_state_hash, post_state_hash, surface_delta)` record for every step it runs. The Rule Inducer subscribes to that stream (writes from the executor's side, reads via SQLite on the inducer's side; the executor never blocks on the inducer). It maintains the `proposed_rules` and `rule_history` tables.

For each observation, the inducer:
1. Computes a `rule_id` candidate: `sha256(action_signature ‖ rule_shape ‖ consequent_signature)`. Identical observations across runs always hash to the same `rule_id`.
2. Decides the `rule_shape`. v1 supports five:
   - `exposes` — action's `post_state` surface contains node identifiers not in `pre_state`.
   - `hides` — `pre_state` surface contains node identifiers not in `post_state`.
   - `requires-prior` — derived from cross-run analysis: action B only ever fires successfully in sequences where action A fired earlier.
   - `requires-state` — derived from cross-run analysis: action B only ever fires successfully when the FSM is in state S.
   - `forbids-followed-by` — derived from cross-run analysis: when action A precedes action B in any sequence, B's verdict is `fail` or its predicate is unevaluable.
3. Either creates a new candidate row OR appends to the existing row's `confirmations` or `denials` array. Each entry carries `{run_id, sequence_id, step_index, observed_at}` (ISO-8601 UTC).
4. Recomputes the `confirmation_score` using a time-weighted formula:

   `score = Σ(1 ÷ (1 + age_days_i)) for confirmations_i  ÷  Σ(1 ÷ (1 + age_days_j)) for all_observations_j`

   Equivalent to a Beta-distribution-with-decay; near-1.0 means many recent confirmations and few recent denials, near-0 means the opposite, the score gracefully forgets old observations so a rule that used to be true but is now wrong does not stay promoted forever.

5. Evaluates promotion at the end of every run. A candidate promotes when **all** of: confirmations ≥ 10, denials < 2, distinct runs ≥ 3, observation span ≥ 2 calendar days. These defaults live in `vouch.config.yaml` and are per-project tunable.
6. Evaluates demotion on every observation against a promoted rule. A promoted rule fires the Clash Arbiter (see §7) when **either**: three consecutive denials in chronological order OR `confirmation_score < 0.7`. The demotion check is the only synchronous, blocking work the inducer does on the executor's hot path; everything else is async.

Every row in `proposed_rules` is system-discovered. There is no other source of rules. The developer interacts with the rule set only through inspection (`vouch rules ls`, `vouch rules show <rule_id>`) and selective overrides (`vouch rules retire <rule_id>`, `vouch rules arbitrate <rule_id> --as <verdict>`); they never author.

Inputs: `surface_snapshots` table, `verdicts` table, current run's deltas.
Outputs: `proposed_rules` row inserts/updates, `rule_history` row inserts.
Failure modes: a `proposed_rules` write conflict (concurrent runs) is resolved by the SQLite-enforced unique constraint on `rule_id`; the loser retries.

### 7. Clash Arbiter (Swift module + Haiku call, `Sources/VouchCore/Arbiter`)

The regression-vs-evolution classifier. Triggered by the Rule Inducer when a promoted rule fires the demotion criteria. Runs at most once per (rule_id, demotion_trigger_run_id) tuple — repeated denials of the same rule in the same run do not re-trigger.

Algorithm:
1. Load `spec.md` (the SUT's spec) at the rule's `promoted_at` commit. Source of truth: the project's git history (the arbiter runs `git show <sha>:spec.md`). If the project is not git-versioned, the inducer takes a SHA-256 + content snapshot at promotion time and stores it in `rule_history`; the arbiter falls back to that.
2. Load the current `spec.md`.
3. Compute the section-level diff (heading + body). If no section is touched, classification is **immediate** without an LLM call: verdict is `regression`, severity `critical`, finding filed in the current run's report. Cheap path on purpose; most regressions are obvious.
4. If sections are touched, narrow the diff to the touched headings (drop unrelated edits). Build a prompt:
   - The broken rule's `action_signature`, `rule_shape`, `consequent_signature`.
   - The narrowed spec diff.
   - The three most recent denying observations, each with `(run_id, sequence_id, observed_at, observed_state_delta)`.
   - Instructions: return JSON conforming to `arbiter_verdict.schema.json` with `label ∈ {evolution_intentional, evolution_possibly_intentional, regression_despite_spec_change}` and a `reasoning` field (one paragraph, audited not consumed).
5. Call Haiku once. On parse failure retry once with a stricter prompt; on second failure default to `evolution_possibly_intentional` and flag `pending_human_review`. Never escalate to a more expensive model without explicit configuration.
6. Write the result to `arbiter_decisions` (one row per arbiter call) with: `rule_id`, `triggered_at`, `triggered_run_id`, `prompt_sha256`, `raw_response`, `label`, `reasoning`, `model_id`, `cost_estimate_usd`. Audit trail is forever; cheap to keep.
7. Apply the action implied by the label: `evolution_intentional` retires the rule (`status = retired_by_spec_change`, the spec section that explains it is recorded), `evolution_possibly_intentional` flips status to `pending_human_review`, `regression_despite_spec_change` keeps the rule promoted and files a critical-severity finding with the spec diff attached as "exonerating evidence rejected."

Inputs: `proposed_rules`, `rule_history`, `verdicts`, git history (or fallback `rule_history.spec_snapshot`), current `spec.md`.
Outputs: `arbiter_decisions` row, optional `proposed_rules.status` update, optional finding inserted into the run report.
Failure modes: missing git history AND missing fallback snapshot (rare, surfaced loudly as `arbiter_unavailable`), Haiku rate-limited (queued and retried with exponential backoff, never silently dropped).

A developer override always wins. `vouch rules arbitrate <rule_id> --as <verdict>` writes its own row to `arbiter_decisions` (with `model_id = "human"`) and supersedes the machine's classification. The override itself is auditable in the same table.

### 8. Reporter (Swift module)

`vouch report <run_id>` queries `vouch.db` and renders:
- A tree by verdict (pass / fail / timeout / etc) with counts.
- For each failure: the action sequence, the failing step index, the predicate that was violated, the expected vs observed delta, and the file paths to the artifacts.
- For each **arbiter finding**: the rule_id, the rule shape, the broken vs original behavior, the arbiter's label, the spec diff (if any), and the link to the audit row in `arbiter_decisions`.
- A `--format json` flag dumps the same data for piping.

`vouch rules ls` (also part of the Reporter surface) lists every rule with columns: `rule_id`, `rule_shape`, `status` (candidate/promoted/retired_by_human/retired_by_spec_change/pending_human_review), `confirmations`, `denials`, `score`, `first_seen`, `last_seen`. Filterable by status. `vouch rules show <rule_id>` drills into the full history including every confirmation and denial timestamp plus any arbiter decision. Every row in `proposed_rules` is system-discovered, so no provenance column is needed; the table's existence is the provenance.

## Data flow for the primary use case

1. Developer runs `vouch map --target https://localhost:3000 --output surface.json`.
2. CLI spawns the web Surface Mapper subprocess.
3. Subprocess walks Playwright accessibility tree, returns `surface.json` over NDJSON.
4. CLI validates against `surface.schema.json`, writes to disk.
5. Developer runs `vouch plan --depth 3 --strategy pairwise --output plan.json`.
6. Enumerator reads `surface.json` + the `proposed_rules` rows whose `status` is `promoted`. On a fresh project the promoted set is empty and the enumerator emits everything the surface allows; on subsequent runs the rule set is denser and the plan is correspondingly more focused. Emits `plan.json` (deterministic ordering).
7. Developer runs `vouch run --plan plan.json --workers 4 &`. CLI returns `run_id` immediately.
8. Worker pool: for each sequence, fork a worker. Worker:
   a. Asks Oracle Translator for predicates for every step (parallel cache hits, serial LLM calls with a small rate limit).
   b. Launches a fresh browser context.
   c. Executes the sequence step by step. For each step:
      - Snapshots pre-state surface (hash + full snapshot to `surface_snapshots`).
      - Performs the action.
      - Snapshots post-state surface.
      - Diffs the two surfaces, emits a `SurfaceDelta` record to the run's `deltas.ndjson` AND to a SQLite-backed queue read by the Rule Inducer.
      - Evaluates the step's predicate against observed state.
   d. Writes verdict + trace artifacts.
9. Rule Inducer drains the `SurfaceDelta` queue in parallel with the workers (separate worker thread, low priority). Updates `proposed_rules` rows; on demotion-trigger fires the Clash Arbiter inline.
10. Clash Arbiter (when triggered) loads the spec diff, classifies, writes to `arbiter_decisions`.
11. Developer can run `vouch status <run_id>` at any time to see progress, including count of new candidate rules and any arbiter decisions filed this run.
12. When the worker pool drains, `vouch report <run_id>` renders the verdict tree, the candidate-rule changes, and any arbiter findings. `vouch rules ls` shows the full rule state across all runs.

## Decisions table

This table is the source for the decision panel on `website/index.html`. Keep them in sync.

| Decision | What we chose | Alternative considered | Why |
| --- | --- | --- | --- |
| Orchestrator language | Swift | Python | User preference; XCUITest already requires Swift; one less language for the human to context-switch into. |
| Web introspection | Playwright (TypeScript subprocess) | Selenium WebDriver from Swift | Playwright's accessibility-tree API is richer and faster; Selenium-Swift bindings are sparsely maintained. |
| iOS introspection | XCUITest directly | Appium iOS driver | XCUITest is first-party, faster, and avoids the Appium server boot cost when iOS is the only platform. |
| Android introspection | Appium 2 + UIAutomator2 | Espresso from a Kotlin host | Appium aligns with the Node helper already running for web; one process to manage instead of two. |
| Subprocess protocol | NDJSON (one JSON object per line) over stdin/stdout | gRPC, MessagePack, shared SQLite | NDJSON is trivially loggable, replayable, and language-agnostic. The cost (parsing per line) is irrelevant at our volumes. |
| Async backend | Long-lived Swift process + SQLite job table | Redis + BullMQ | Local-only target. No Redis to install, no daemon to manage. |
| Persistence | SQLite + dir tree per run | Postgres | Local target. SQLite handles tens of thousands of verdicts per run without breaking a sweat. Postgres is the migration path when this becomes hosted. |
| Oracle model | `claude-haiku-4-5-20251001` | Sonnet | User-chosen cost posture. Haiku + cache + small predicate DSL keeps cost under one cent per hundred unique oracles in our tests. |
| Cache key | `sha256(action_signature ‖ pre_state_hash ‖ spec_version)` | Plain action name + URL | Catches spec-driven invalidation; insensitive to cosmetic URL changes via `state_hash`. |
| Predicate DSL | Closed set of nine `kind`s | Free-form JavaScript expression strings | Security and auditability. The LLM never emits executable code. |
| Sequence strategy default | Pairwise (covering array) | Exhaustive | Exhaustive blows up combinatorially; pairwise catches the majority of multi-step regressions for a fraction of the run cost. |
| Rule authorship | Rules are exclusively discovered by the Rule Inducer; the developer never writes any | Hybrid model where the developer declares baseline rules in YAML and the inducer adds more | Imposes zero setup burden on the developer; one source of truth for "where did this rule come from"; the inducer is already responsible for tracking provenance via `confirmations` and `denials`, so the developer's signature would be redundant. |
| Rule scoring | Time-weighted confirmation/denial score (Beta-with-decay) | Raw ratio of confirmations to denials | A rule that was true last year and started failing yesterday must demote; raw ratios let stale truths dominate. |
| Promotion thresholds | ≥10 confirmations, <2 denials, ≥3 distinct runs, ≥2 calendar days | Single confirmation count threshold | A single noisy run can produce 10 confirmations of the same fluke; the run-and-day requirements force independence. |
| Arbiter LLM model | Same Haiku, separate cache | Sonnet for arbiter, Haiku for oracle | One cost posture across the system; the arbiter's prompt is short (narrowed diff + rule) so Haiku is enough. Sonnet escalation is a single config flag away. |
| Spec snapshot at promotion | Git history first, SQLite fallback | Always-on SQLite snapshot | Git is the source of truth when present; duplicating its content wastes disk on the common path. The fallback exists so non-git projects still work. |

## Trade-offs

Each trade-off below maps to a panel on `website/index.html`.

**Local-only v1 vs. hosted from day one.** We accept that non-developer team members cannot trigger runs themselves. When it would bite: when a designer wants to QA their changes without a terminal. Trigger to revisit: when more than one non-developer asks.

**LLM-inferred oracles vs. hand-written.** We accept some oracle errors (`unparseable_oracle` verdict, occasional miscalibrated predicate). When it would bite: when the spec is ambiguous and the model invents a predicate the developer disagrees with. Mitigation: cache stats expose the LLM's effective contribution; the developer can override any predicate by hand-editing the cache row.

**SQLite vs. Postgres.** We accept that the worker count is bounded by SQLite's writer-serialization. When it would bite: above sixteen concurrent workers writing verdicts. Mitigation: the executor batches verdict writes per sequence (one transaction per sequence), so the bottleneck is sequence count not step count.

**Per-permutation fresh SUT vs. reusing.** We accept the cost of booting fresh contexts (browser ~200 ms, simulator ~5 s, app launch ~1 s). When it would bite: a hundred iOS permutations is several minutes of simulator boot. Mitigation: iOS executor pools simulators across permutations of the same plan (one simulator can serve N permutations sequentially with app reset between each).

**Pairwise default vs. exhaustive default.** We accept missing some 3-way interactions in the default mode. When it would bite: a regression that requires three specific actions in a specific order. Mitigation: `--strategy exhaustive --depth 3` is one flag away; the developer chooses when paranoia is required.

**Statistical confidence vs. promotion latency.** Higher thresholds (more confirmations, more days, more distinct runs) mean inferred rules promote slowly but stay correct. Lower thresholds mean fast learning and more flapping. We chose the high end of reasonable defaults (10 / 3 / 2). When it would bite: a developer iterating on a brand-new feature wants the inducer to recognize a pattern within a single day. Mitigation: per-project tuning in `vouch.config.yaml`; the developer can drop thresholds to 3/2/0 while bootstrapping and raise them back later.

**Auto-retire vs. always flag-for-human.** Auto-retire (under `evolution_intentional`) means the system self-heals without queue management; the cost is the occasional silently-wrong retirement. Flag-for-human (everything to a queue) is correct but creates a backlog the solo developer will never drain. We split the difference: `evolution_intentional` retires, `evolution_possibly_intentional` flags. When it would bite: the arbiter is overconfident and a rule retires that should not have. Mitigation: `vouch rules ls --status retired_by_spec_change` is greppable, and the `arbiter_decisions` audit row is the smoking gun on a misfire.

**Spec-diff arbitration vs. test-author judgement.** We accept that an LLM reading a diff will sometimes misclassify regression as evolution (false negative) or vice versa (false noise). When it would bite: the arbiter labels a real regression `evolution_intentional` because the spec edit is superficially plausible. Mitigation: every arbiter call is audited with prompt + raw response; the developer can replay the call, override with `vouch rules arbitrate <rule_id> --as regression`, and the override itself is logged. The label is a hint, not a substitute for review.

## Sequencing (informs `tasks.md`)

The slices are stacked so each one ships independently and the QA gate can replay it.

1. **Slice 1 — CLI scaffold + protocol skeleton.** `vouch --version`, `vouch doctor`, the NDJSON protocol types defined, no platform executors yet. Verifiable in isolation.
2. **Slice 2 — Web Surface Mapper.** `vouch map --target <url> --platform web` produces a valid `surface.json` for a fixture app. Unblocks every later slice.
3. **Slice 3 — Sequence Enumerator + rules DSL.** `vouch plan` deterministic; pairwise + exhaustive + sample strategies; YAML rule parser with line-number errors.
4. **Slice 4 — Oracle Translator with cache.** Haiku integration, predicate DSL, cache schema, spec-section invalidation.
5. **Slice 5 — Executor + Verdict Engine (web only).** Workers, fresh-context isolation, verdict writes, trace files. ALSO writes pre/post surface snapshots + deltas to the queue.
6. **Slice 6 — Rule Inducer.** Reads the delta queue, maintains `proposed_rules` and `rule_history`, time-weighted scoring, promotion + demotion thresholds, `vouch rules ls`. Enumerator (Slice 3) gets a re-pass to read promoted rules. This slice fundamentally requires Slice 5 to have shipped, because there is no delta stream to learn from until then.
7. **Slice 7 — Clash Arbiter.** Triggered on demotion, git-history-first spec loader, Haiku classification, `arbiter_decisions` audit, finding emission. Requires Slice 6 to have shipped (no promoted rules → no demotions → no arbiter).
8. **Slice 8 — Reporter polish.** `vouch report` (with arbiter findings + candidate-rule deltas), `vouch status`, `vouch cache stats`, `vouch rules show`.
9. **Slice 9 — iOS Surface Mapper + executor.** XCUITest helper; everything downstream of the surface already works including induction and arbitration (the inducer is platform-agnostic).
10. **Slice 10 — Android Surface Mapper + executor.** Same shape as iOS slice.
11. **Slice 11 — Image executor.** Vision-LLM fallback. Induction works on image surfaces too (the surface is just a set of node identifiers; the model treats vision-inferred regions the same as DOM nodes).
12. **Slice 12 — Self-host (Vouch tests Vouch).** A thin HTTP shim around the CLI for the web executor to point at; covers `tasks.md` US-09.
13. **Slice 13 — Architecture website + AI interview prep + defense breakout script.** Downstream deliverables once architecture is stable.

Each slice carries: a spec story it serves, the plan component(s) it touches, the rubric line it advances, and a tiny acceptance test the QA gate can replay. See `tasks.md`.
