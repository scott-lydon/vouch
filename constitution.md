# Vouch — Constitution

The rules. Stack, style, and non-negotiables. Everything in `spec.md`, `plan.md`, and `tasks.md` is built on top of this; if they ever disagree with this file, this file wins. Update this file when a rule has to change, never silently work around it.

> **Amendment 2026-05-22 — Swift orchestrator replaced with TypeScript end-to-end.**
> The original constitution pinned Swift for the CLI / orchestrator / iOS / image executor and TypeScript only for the web + Android subprocess helpers. We swapped that for **TypeScript everywhere** (Node 20+, Playwright, better-sqlite3, Express, Anthropic SDK, Zod). Rationale: a single language eliminates the cross-language NDJSON subprocess boundary that the original design carried only because XCUITest required Swift; Playwright now handles web mapping + execution directly in TS with no IPC overhead; iOS and Android executors (when they land) will go through Playwright + Appium drivers from the same Node process. The decisions table in `plan.md` should be re-derived from this amendment when next edited. Code matches this amendment as of commit landing 2026-05-22.

## What Vouch is, in one paragraph

Vouch is an agentic Model-Based Testing (MBT) pipeline. A developer hands off a built artifact (a URL, an iOS `.app`, an Android `.apk`, or a screenshot) plus the SUT's spec, Vouch deterministically enumerates the interactable surface, learns the Finite State Machine (FSM) over actions purely from observation, asks a cheap LLM to translate the spec into a post-condition predicate per action, runs all permutations against fresh SUT instances in a background worker, and reports verdicts. A side-channel watches the FSM for previously promoted rules that start breaking and classifies each clash as a regression or an intentional spec-driven evolution. Classical MBT requires humans to write both the FSM and the oracles. Vouch infers both; the developer never authors a transition rule.

## Tech stack constraints (non-negotiable)

| Concern | Choice | Why locked in |
| --- | --- | --- |
| Orchestrator language | Swift 5.10+ | User-preferred language; XCUITest needs Swift anyway; `swift-argument-parser` is idiomatic for the CLI. |
| CLI framework | `swift-argument-parser` | Stdlib for Apple Swift CLIs. |
| Web executor | Playwright (TypeScript, Node 20+) | DOM + ARIA accessibility tree are the cleanest deterministic surface available; Playwright is the industry default. |
| iOS executor | XCUITest (Swift) | Native accessibility hierarchy; lives in the same Xcode project as the orchestrator package. |
| Android executor | Appium 2 + UIAutomator2 driver (Node client) | Same Node helper process as Playwright; one runtime, two drivers. |
| Image executor | Pure Swift, calls Anthropic vision API directly | Fallback only when no introspection is available. |
| Async worker | Long-lived Swift process, SQLite-backed job table | Local-only target; no Redis dependency at this scale. |
| Persistence | SQLite (`vouch.db`) for runs/verdicts + on-disk dir tree (`./runs/<run-id>/`) for screenshots, DOM snapshots, network traces | Auditable, greppable, no service to run. |
| Oracle inference model | `claude-haiku-4-5-20251001` first; cache hits skip the call. Sonnet escalation is backlog, not v1. | User-chosen cost posture. |
| Cache key | `sha256(action_signature ‖ pre_state_hash ‖ spec_version)` | Stable across runs; predicate is deterministic per `(action, state)`. |
| Subprocess protocol | NDJSON over stdin/stdout, one message per line, schema-versioned | Composable, Unix-philosophy boundary; trivial to log and replay. |
| Rule scoring | Time-weighted score: `Σ(1 ÷ (1 + age_days_i))` over confirmations divided by the same over all observations | Recent evidence dominates stale evidence. Beta-with-decay shape. |
| Rule promotion thresholds (defaults) | ≥10 confirmations, <2 denials, ≥3 distinct runs, ≥2 calendar days | Independence is enforced by the multi-run, multi-day requirement; a single noisy run cannot promote a fluke. |
| Rule source | Exactly one: the Rule Inducer. The developer never authors rules. | One source of truth for "where did this rule come from." |
| Arbiter audit trail | One row per call in `arbiter_decisions`, kept forever, includes prompt sha + raw response + cost | Cheap to keep, indispensable when classifying a rule retirement after the fact. |

## Style rules

- Swift code follows the **Google Swift Style Guide** verbatim (https://google.github.io/swift/). Indent 2 spaces, line limit 100, types `PascalCase`, members `camelCase`, file names match the primary type.
- TypeScript code (Playwright + Appium client) follows the **Google TypeScript Style Guide** equivalent: 2-space indent, single quotes, semicolons, ESLint `eslint-config-google` + `@typescript-eslint/recommended-type-checked`.
- Cupid principles (https://cupid.dev) apply to every module: **Composable** (each module plays well via the NDJSON protocol), **Unix** (one thing well), **Predictable** (same inputs → same outputs; FSM-guarded so order matters and is recorded), **Idiomatic** (uses each language's native testing/CLI idioms), **Domain-based** (names match the MBT vocabulary: `Surface`, `Sequence`, `Oracle`, `Verdict`, `Trace`).
- User coding-rules gists apply where the language permits: https://gist.github.com/scott-lydon/b1498f865af1e5e28a9d15aec3eb93ed and https://gist.github.com/scott-lydon/3517b7b9f1829845faed826a63bfee76.
- **Type augmentation over service classes.** A function that operates on a `Surface` lives as an `extension Surface { ... }`, not as a method on a `SurfaceService`. A function that operates on an `Int` lives as `extension Int { ... }`. This rule is non-negotiable for Swift code.
- **Protocol-oriented over OOP** wherever Swift permits. Executors expose a `protocol PlatformExecutor` boundary; concrete executors conform. No abstract base classes.
- **No dashes in generated prose** (per user preference). Em-dashes and en-dashes are banned in user-facing text the agent emits; ASCII hyphens in identifiers and CLI flags are fine.

## Non-negotiables

- **No stub data in aggregated fields.** Verdict counts, coverage percentages, and run summaries report the real measurement or nothing. Zero is allowed only when zero is what was measured. A `null` or "n/a" is allowed when the metric is genuinely missing. A placeholder like `0.001` is never allowed. (See `~/Documents/Claude/Projects/BUG_PREVENTION.md`.)
- **No demo URLs or live credentials in social posts.** When Vouch ships, the deployed-app URL stays in the submission form, not on LinkedIn.
- **Comprehensive errors at every failure boundary.** Every `throw`, every Node `reject`, every TypeScript `throw new Error` carries enough context to diagnose without re-running the failure: which permutation, which step index, which subprocess, which action signature, which expected predicate, which observed state hash. Generic messages ("something went wrong") are a bug, not an acceptable fallback.
- **Catch only at boundaries that can recover.** Inside a module, exceptions propagate. The outermost CLI entry point catches and renders. No catch-log-continue inside executors or the verdict engine.
- **Never expose subprocess `stderr` content directly to the user-facing CLI output.** Log it to the run dir; the CLI gets a generic message plus a path to the log file. This is for the same reason OpenEMR's `CLAUDE.md` says it: error messages can carry internal details.
- **Every code change passes the QA gate.** The `qa-adversary` sub-agent runs in a fresh context against the diff before any slice is reported as shipped (see project-root `CLAUDE.md` rule). The QA gate is mandatory, not optional, on assignment repos.
- **Dual-push on every commit.** `git push origin <branch>` must fan out to GitHub and to GitLab via the two-push-URL trick. Verify with `git ls-remote origin main` vs `git ls-remote gitlab main` returning the same SHA.
- **The developer never authors transition rules.** The Rule Inducer is the sole source of rules. The developer interacts with the rule set only through inspection (`vouch rules ls`, `vouch rules show <rule_id>`) and selective overrides (`vouch rules retire <rule_id>`, `vouch rules arbitrate <rule_id> --as <verdict>`). No `vouch.rules.yaml` file exists; if a future contributor proposes one, the change must be rejected at review. The whole point of the project is to discover the FSM rather than declare it.
- **No silent rule changes, ever.** Every promotion, demotion, retirement, and arbitration writes a row to `rule_history` or `arbiter_decisions`. A grep through SQLite must always be able to answer "why is this rule in its current status." If the audit row is missing, the change did not happen.
- **The predicate DSL is closed; the rule shape vocabulary is closed.** Both are evaluated by Vouch code, not by `eval` or by string interpolation into shell. The LLM can only emit values that conform to a JSON Schema; nonconforming responses are rejected at parse time, not at runtime. This is the security boundary between LLM output and execution.

## Quality gates

| Gate | Tool | Floor |
| --- | --- | --- |
| Swift static checks | `swiftlint` with rules pinned in `.swiftlint.yml` | Zero warnings on changed files |
| Swift tests | `swift test` | Every public type has at least one test exercising its happy path AND at least one for a deliberately bad input |
| TypeScript static checks | `tsc --noEmit` + `eslint --max-warnings 0` | Zero warnings |
| TypeScript tests | `vitest` | Same as Swift |
| Protocol compatibility | `tests/protocol/` JSON-schema validation against a frozen set of fixtures | Every executor's NDJSON output validates against the current schema version |
| QA gate | `qa-adversary` via `claude-code-bridge` | Blocking findings must be resolved or surfaced in the commit description before merge |

## Things Vouch never does

- **Never catches and silently swallows a subprocess crash.** Crash = verdict `infrastructure_error` for that permutation, with the subprocess stdout/stderr captured.
- **Never mocks the SUT in integration tests.** The Playwright executor talks to a real headless browser. The XCUITest executor talks to a real simulator. The verdict engine compares real traces.
- **Never hand-writes the FSM for a SUT.** The FSM is discovered by the Rule Inducer from observation. Hand-writing the FSM is what we are explicitly replacing.
- **Never accepts a developer-authored rule file.** If a contributor proposes a `vouch.rules.yaml` or any other rule-authoring path, the proposal is rejected. The Rule Inducer is the sole writer; the Sequence Enumerator is the sole reader.
- **Never auto-promotes a rule from a single run.** Promotion requires three distinct runs across two calendar days. A single noisy run will produce repeated confirmations of the same fluke; the multi-run, multi-day requirement breaks that.
- **Never retires a rule without an audit row.** Every status transition writes to `rule_history`. Every arbiter call writes to `arbiter_decisions`. A rule's current status is recoverable as a function of its history; the current status is a cache of the history, not the source of truth.
- **Never embeds the original LLM response message into a wrapped exception's message** (user-facing). The original error is reachable via the chain; the wrapper says what we were trying to do.
- **Never invents action data.** If a form needs an email and the spec doesn't say what email, the action is skipped with a `missing_input` verdict, not run with `test@test.com`.

## Bug-prevention checklist (project-local manifestations)

Citing back to the global `~/Documents/Claude/Projects/BUG_PREVENTION.md`. Every new feature is reviewed against this list before merge.

1. **Subprocess hang.** Every executor subprocess has a per-step timeout (default 30 s, override per action). Timeout = verdict `timeout`, not a hung worker.
2. **Action signature drift.** The Sequence Enumerator and the Oracle cache both key on the action signature. Changing the signature format invalidates the cache; bump `protocol_version` in the same commit.
3. **Spec drift.** The Oracle cache also keys on `spec_version` (a sha256 of the spec file). Editing the spec invalidates relevant cache entries automatically.
4. **Flaky verdict.** A verdict that flips between runs without code change is a defect in either the oracle predicate or the executor's state-hash function. Re-run is not a fix; investigate the source.
5. **Cross-platform action name collision.** Action names are namespaced (`web:click`, `ios:tap`, `android:tap`, `image:point`). Never compare action names across platforms by raw string.
6. **JSON over stdout pollution.** Executors NEVER log to stdout; logs go to stderr. The orchestrator parses stdout strictly. One stray `console.log` corrupts the trace stream; CI enforces it via grep on the executor build outputs.
7. **Inducer race on the delta queue.** Multiple workers writing deltas to SQLite at once is the primary concurrency hazard. The queue table has a single-writer-per-run constraint; the inducer is a single-threaded reader. Stress test asserts no dropped deltas under 8 concurrent workers.
8. **Time-weighting clock skew.** The scoring formula uses `age_days = (now - observed_at) ÷ 86400`. If the system clock jumps (laptop sleep, NTP correction), historical observations can suddenly all look "in the future." The scorer clamps `age_days` to `[0, +∞)` and logs a warning if any observation has a negative age.
9. **Arbiter prompt size.** Spec diffs over a configured byte limit get truncated to the touched section's contents only, with a marker. An over-long prompt costs more and degrades classification accuracy. Test: a 10 MB spec edit still produces a prompt under the limit.
10. **Promoted rule shadowed by surface change.** If the SUT redesigns and an action signature changes (selector renamed), every promoted rule keyed on the old signature is orphaned, not denied. Detect orphans (a `proposed_rules` row whose `action_signature` no longer appears in any recent run) and mark them `orphaned`, never silently re-deny.

## Rubric anchor map

When a Gauntlet rubric pillar lands on this project, here is where the evidence lives:

| Pillar | Where to point | What it demonstrates |
| --- | --- | --- |
| Architecture | `plan.md` decisions table + `website/index.html` topology | Six-component MBT pipeline with explicit Unix-philosophy boundaries plus the learning loop (inducer → enumerator) and the side-channel (arbiter), both auditable in SQLite |
| Scalability | `plan.md` "trade-offs" section + `tasks.md` parallelization slice | Per-permutation worker isolation; SQLite is the bottleneck and the migration path is documented; the inducer is single-threaded by design to avoid contention with workers |
| Security | this file's "Things Vouch never does" + the closed predicate DSL + the single-source rule writer | Subprocesses never escape their sandbox dir; spec files are read-only to executors; LLM output can never become executable code; the Rule Inducer is the only path by which a rule enters the system |
| Testing | `tasks.md` "self-host" slice (Vouch tests Vouch) + the QA gate + the arbiter's regression-vs-evolution classifier | The project's own QA pipeline runs on every PR; dogfooding; the system distinguishes intentional behavior change from breakage |

References:

- Google Swift Style Guide: https://google.github.io/swift/
- Cupid principles: https://cupid.dev
- User coding rules: https://gist.github.com/scott-lydon/b1498f865af1e5e28a9d15aec3eb93ed and https://gist.github.com/scott-lydon/3517b7b9f1829845faed826a63bfee76
- Global bug-prevention: `~/Documents/Claude/Projects/BUG_PREVENTION.md`
- Gauntlet QA gate doc: `~/Documents/Claude/Projects/Gauntlet/qa-pipeline.html`
- Sub-agent definition: `~/.claude/agents/qa-adversary.md`
