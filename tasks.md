# Vouch — Tasks

Actionable slices. Each box is something the implementing agent can finish, hand to `qa-adversary`, and ship without blocking the next slice. The top section is the slice in flight; below it is the next; below that is the backlog. Check the box AND commit the check in the same commit as the code, so the diff makes the slice auditable.

When delegating to `claude-code-bridge` or the QA gate, brief the implementing agent against the union of `constitution.md`, `spec.md`, `plan.md`, and this file.

---

## Current slice — Slice 1: CLI scaffold + NDJSON protocol skeleton

> Spec stories served: foundation for US-01 through US-13. Plan components touched: §1 CLI, §2 protocol contract. Rubric: Architecture (boundary definition).

- [ ] Initialize Swift package (`swift package init --type executable --name vouch`); set platforms `[.macOS(.v13)]`; add `swift-argument-parser` as a dependency.
- [ ] Lay out source tree: `Sources/VouchCLI/`, `Sources/VouchCore/`, `Sources/VouchProtocol/`, `Tests/VouchCoreTests/`, `Tests/VouchProtocolTests/`.
- [ ] Add `.swiftlint.yml` with Google Swift Style Guide rules pinned (2-space indent, 100-col, file-header rules disabled where appropriate). Done-criterion: `swiftlint` exits 0 on an empty source set.
- [ ] Define `VouchProtocol` types as `Codable` Swift structs: `ProtocolEnvelope`, `MapRequest`, `MapResponse`, `PlanRequest`, `PlanResponse`, `RunRequest`, `RunResponse`, `Verdict`, `PostConditionPredicate`. One file per type per Google Swift style. Done-criterion: encoding then decoding an instance is the identity (round-trip test in `Tests/VouchProtocolTests`).
- [ ] Implement `vouch --version` and `vouch doctor` (`doctor` checks `ANTHROPIC_API_KEY` is set, `node` is on PATH, `xcrun simctl` is on PATH; clear named errors for each missing piece). Done-criterion: `vouch doctor` exits 0 on a fully-set-up machine and exits 1 with a named missing-piece message otherwise.
- [ ] Wire stderr structured logging (one log line = one JSON object) under a `Sources/VouchCore/Log.swift` extension on `Logger`. Done-criterion: piping stderr to `jq` parses every line.
- [ ] First commit (Conventional Commits): `feat(cli): scaffold Vouch CLI with NDJSON protocol types and doctor subcommand`. Dual-push to GitHub + GitLab (see constitution).
- [ ] **QA gate**: invoke `qa-adversary` via `claude-code-bridge` against the diff; resolve or surface any blocking findings before declaring the slice done.

---

## Next slice — Slice 2: Web Surface Mapper

> Spec story served: US-01. Plan components: §2 Surface Mapper (web). Rubric: Architecture (first deterministic introspection); demonstrates US-01's acceptance test.



- [ ] Initialize Node 20 helper at `executors/web/` with `package.json`, `tsconfig.json`, `eslint`, `vitest`. Pin Playwright to a specific minor version in `package.json`.
- [ ] Implement `executors/web/src/index.ts`: reads NDJSON `MapRequest` from stdin, drives Playwright, emits NDJSON `MapResponse`. Stable-selector preference: `data-testid` > ARIA role+name > stable CSS path.
- [ ] Add a fixture SPA at `tests/fixtures/spa/` with ten interactable nodes across two routes. Done-criterion: the executor produces a `surface.json` matching `tests/fixtures/spa/expected.surface.json` byte-for-byte.
- [ ] Implement `vouch map` subcommand in Swift that spawns the Node helper, pipes NDJSON, validates the response against `schemas/surface.schema.json`, writes the result.
- [ ] Acceptance test (replay of US-01): `swift test --filter SurfaceMapperWebTests` runs the executor against the fixture SPA, asserts ten nodes, asserts every node carries a stable selector, asserts the run completes in under fifteen seconds.
- [ ] Error surface coverage: SUT-unreachable, Playwright not installed, NDJSON parse failure on either end. Each is a clear named error with a fix hint.
- [ ] Commit: `feat(executor-web): add Playwright-based Surface Mapper for web SUTs`. Dual-push.
- [ ] **QA gate**: `qa-adversary` against the diff.

---

## Backlog (ordered)

### Slice 3 — Sequence Enumerator

> Spec story: US-03. Plan component: §3 Sequence Enumerator.

- [ ] Implement `Sources/VouchCore/Enumerator/PromotedRulesLoader.swift` — reads `proposed_rules WHERE status = 'promoted'` from `vouch.db`. On a fresh project this returns an empty set; the enumerator handles that as the bootstrap case (emit every sequence the surface allows up to `--depth`).
- [ ] Implement `Sources/VouchCore/Enumerator/Pairwise.swift` (port of PICT covering-array algorithm).
- [ ] Implement `Sources/VouchCore/Enumerator/Exhaustive.swift` with a hard cap of 100,000 sequences; emits a clear error past the cap.
- [ ] Implement `Sources/VouchCore/Enumerator/Sample.swift` with seeded RNG.
- [ ] `vouch plan` subcommand wires the three strategies. Done-criterion: same inputs produce byte-identical output AND a fresh `vouch.db` produces a plan that exercises the entire surface (verifying the empty-rule-set bootstrap).
- [ ] Replay test for US-03.
- [ ] QA gate.

### Slice 4 — Oracle Translator with cache

> Spec stories: US-04, US-09. Plan component: §4 Oracle Translator.

- [ ] Implement `Sources/VouchCore/Oracle/AnthropicClient.swift` (Haiku endpoint, retry-once on parse failure with stricter prompt).
- [ ] Implement `Sources/VouchCore/Oracle/PredicateDSL.swift` — the closed set of nine `kind`s. Reject anything else at parse time.
- [ ] Implement `Sources/VouchCore/Oracle/Cache.swift` — SQLite-backed, key `sha256(action ‖ pre_state ‖ spec_version)`.
- [ ] Implement spec-section invalidation: parse `spec.md` headings, map each oracle row to the heading it was derived under, on spec edit recompute only overlapping headings.
- [ ] Replay tests for US-04 and US-09. Done-criterion: cache hit on second run takes under 50 ms (asserted by test).
- [ ] QA gate.

### Slice 5 — Executor + Verdict Engine (web only)

> Spec stories: US-05, US-06, **US-10** (surface delta emission lives here). Plan component: §5 Executor + Verdict Engine.

- [ ] Implement `Sources/VouchCore/Worker/Pool.swift` (Swift `actor`-based pool, configurable size).
- [ ] Implement `Sources/VouchCore/Worker/WebWorker.swift` — fresh browser context per sequence, snapshots, predicate evaluation.
- [ ] Implement pre/post-step surface snapshot capture and `SurfaceDelta` emission to `runs/<run_id>/<sequence_id>/deltas.ndjson` + SQLite queue. This is US-10's acceptance hook — the inducer reads from here in Slice 6.
- [ ] Add `surface_snapshots` table to `vouch.db` (run_id, sequence_id, step_index, phase=pre|post, surface_hash, snapshot_blob). Index on `(run_id, sequence_id, step_index, phase)`.
- [ ] Implement trace artifact writes under `runs/<run_id>/<sequence_id>/`.
- [ ] Implement `vouch run` (returns `run_id` immediately, detaches background worker).
- [ ] Implement `vouch status <run_id>` showing progress + count of deltas observed.
- [ ] Replay tests for US-05, US-06, US-10 (delta emission validated by reading the NDJSON file).
- [ ] QA gate.

### Slice 6 — Rule Inducer

> Spec stories: **US-11, US-12**. Plan component: §6 Rule Inducer + Enumerator re-pass.

- [ ] Add `proposed_rules` and `rule_history` tables to `vouch.db`. Schema in plan §6.
- [ ] Implement `Sources/VouchCore/Inducer/RuleId.swift` — `sha256(action_signature ‖ rule_shape ‖ consequent_signature)`. Tests for the five `rule_shape` variants.
- [ ] Implement `Sources/VouchCore/Inducer/Scorer.swift` — time-weighted formula. Unit tests cover: a recent denial outweighing an old confirmation, the score graceful-forgetting old observations, the score never exceeding 1.0 nor falling below 0.
- [ ] Implement `Sources/VouchCore/Inducer/Inducer.swift` — drains the SQLite delta queue, updates rows, evaluates promotion/demotion at end of run. Configurable thresholds in `vouch.config.yaml` with documented defaults (10/2/3/2).
- [ ] Re-pass the Sequence Enumerator (Slice 3): on `vouch plan`, read promoted rules from `proposed_rules` and feed them as enumeration constraints. There is no other rule source.
- [ ] Implement `vouch rules ls [--status ...]` and `vouch rules show <rule_id>`.
- [ ] Implement `vouch rules retire <rule_id>` (developer override; sets status `retired_by_human` and prevents re-promotion).
- [ ] Replay tests for US-11 (candidate creation), US-12 (promotion under thresholds, demotion under denials, retire-override invariance).
- [ ] Done-criterion stress test: a run with one hundred sequences must complete induction within ten seconds of the last worker finishing.
- [ ] **QA gate** (the qa-adversary will lean on this slice hard; the learning loop is a prime spot for catch-log-continue bugs).

### Slice 7 — Clash Arbiter

> Spec story: **US-13**. Plan component: §7 Clash Arbiter.

- [ ] Add `arbiter_decisions` table to `vouch.db`. Schema in plan §7.
- [ ] Implement `Sources/VouchCore/Arbiter/SpecLoader.swift` — `git show <sha>:spec.md` first, `rule_history.spec_snapshot` fallback, loud failure when neither is available (`arbiter_unavailable` finding).
- [ ] Implement `Sources/VouchCore/Arbiter/SectionDiff.swift` — section-level diff that narrows to touched headings. Tests cover: unrelated whole-file rewrite touches every heading but only those overlapping the rule survive narrowing.
- [ ] Implement `Sources/VouchCore/Arbiter/Arbiter.swift` — fast-path classification (no spec change → immediate `regression`), slow-path Haiku call with the closed prompt template + JSON schema validation on the response.
- [ ] Implement `vouch rules arbitrate <rule_id> --as <verdict>` (developer override). Override always logs to `arbiter_decisions` with `model_id = "human"` so the audit row distinguishes machine vs. developer calls.
- [ ] Replay tests for US-13: regression-no-spec-change path (no LLM call asserted), evolution_intentional path, regression_despite_spec_change path, parse-failure-falls-back-to-pending path.
- [ ] Done-criterion: arbiter cost per call is below one cent (assert by reading the `cost_estimate_usd` column on the test run).
- [ ] **QA gate** (the regression-vs-evolution classifier is the highest-stakes LLM call in the system; this is exactly the kind of decision boundary qa-adversary should attack).

### Slice 8 — Reporter polish

> Spec story: US-06 polish + reporting on inducer and arbiter outputs. Plan component: §8 Reporter.

- [ ] Implement `vouch report <run_id>` with a verdict tree, an inducer-changes section (new candidates this run, new promotions, new demotions), and an arbiter-findings section (one entry per `arbiter_decisions` row this run).
- [ ] Implement `--format json` for piping.
- [ ] Implement `vouch cache stats`.
- [ ] Replay tests.
- [ ] QA gate.

### Slice 9 — iOS Surface Mapper + executor

> Spec story: US-02. Plan component: §2 (iOS) + §5 (iOS worker). The inducer + arbiter are platform-agnostic and require no changes.

- [ ] New Swift target `vouch-ios-executor` in the same package.
- [ ] Implement XCUITest helper to walk the accessibility hierarchy.
- [ ] Implement iOS worker with simulator pooling (one simulator serves N permutations sequentially with app reset).
- [ ] Ensure pre/post surface snapshots emit on the same NDJSON channel as the web worker so the inducer needs no platform-specific code.
- [ ] Replay test for US-02.
- [ ] QA gate.

### Slice 10 — Android Surface Mapper + executor

> Spec story: US-01 (Android variant). Plan component: §2 (Android) + §5 (Android worker).

- [ ] Node helper at `executors/android/` with Appium 2 + UIAutomator2 driver.
- [ ] Android worker; same surface-snapshot contract as iOS and web.
- [ ] Replay test against a fixture `.apk`.
- [ ] QA gate.

### Slice 11 — Image executor

> Spec story: US-07. Plan component: §2 (image).

- [ ] Swift target `vouch-image-executor`.
- [ ] Anthropic vision API integration with a fixed prompt template.
- [ ] Emit `surface.json` with `confidence: low` annotation.
- [ ] Surface a warning in the CLI when image mode is active.
- [ ] Verify the inducer treats vision-inferred regions as first-class surface nodes (no special-casing).
- [ ] Replay test for US-07.
- [ ] QA gate.

### Slice 12 — Self-host (Vouch tests Vouch)

> Spec story: US-08. Plan component: dogfooding loop.

- [ ] Thin HTTP shim around the CLI under `tools/cli-http-shim/`.
- [ ] Self-host fixture: `tests/self-host/plan.json`.
- [ ] Replay run that exercises every documented flag combination AND lets the inducer discover at least one inferred rule about the CLI surface (e.g., `vouch rules show requires-prior vouch run` — you cannot meaningfully run `vouch report` before `vouch run`). Done-criterion validates dogfooding works at the rule-induction layer, not just the verdict layer.
- [ ] QA gate.

### Slice 13 — Downstream deliverables

> Per the per-assignment automation rules in `~/Documents/Claude/Projects/Gauntlet/CLAUDE.md`.

- [ ] `docs/DEFENSE_BREAKOUT_SCRIPT.md` — substance-only, no meta about the breakout format. Spend a third of the script on the induction loop + arbiter, because that is the novel piece vs. textbook MBT.
- [ ] `website/index.html` — sticky nav, hero, topology Mermaid (six components, two feedback loops, zero edge crossings), per-component cards, decisions table, trade-offs panels, cost charts, tech-stack grid with Simple Icons logos.
- [ ] `docs/AI_INTERVIEW_PREP.md` — portal link at top, twelve-plus answers, spoken-prose style, named concrete examples per safety/testing mechanism. Pre-bake at least one named story per: the scoring algorithm, the arbiter's three labels, the "zero developer-authored rules" design choice.
- [ ] Update website + interview prep in the same commit as any architecture change going forward.

---

## Done-criteria template (copy per task)

```
> Spec story: US-NN
> Plan component: §N <name>
> Rubric line: <pillar>
> Done when:
>   - <observable acceptance, replayable by qa-adversary>
>   - <one negative test: deliberately broken input → named error>
> Files touched: <list>
> Commit: <type>(<scope>): <one-line summary>
> Dual-push verified: `git ls-remote origin main` == `git ls-remote gitlab main`
> QA gate: qa-adversary findings resolved or surfaced
```
