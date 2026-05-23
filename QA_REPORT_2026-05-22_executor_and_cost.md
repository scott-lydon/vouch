# Adversary QA Report — executor wallclock cap + Anthropic batched oracle

**Commits reviewed:** fd24046 (executor cap) and 84546a1 (oracle/verify Anthropic batching + prompt caching)
**Language / framework:** TypeScript + Node 20, Vitest
**Base branch:** main
**QA_ADVERSARY.md:** file does not exist at the repo root; review was driven by the 6 adversarial questions in the task brief plus all named categories in `constitution.md`.

---

## What I challenged

Two commits were reviewed together. The first (fd24046) added a hard wallclock cap on `chromium.launch()` (default 30 s, throws `VouchExecutorError`) and a per-permutation cap (default 90 s, returns a "timeout" verdict and continues). The second (84546a1) added prompt-cached Anthropic API calls for both the oracle and verifier, a new `predictManyWithAnthropic` / `verifyManyWithAnthropic` batched path, and changed `detectOracleSource()` so `anthropic-haiku` beats `claude-cli` when `ANTHROPIC_API_KEY` is present. The test suite had zero tests before this review; the test runner (`vitest run`) returned exit code 1 with "No test files found."

---

## Findings

### 1. (MEDIUM) Error messages advertise unread env vars — `VOUCH_PERM_TIMEOUT_MS` and `VOUCH_LAUNCH_TIMEOUT_MS`

**File:line:** `src/core/executor.ts:191`, `src/core/executor.ts:284`

**What is wrong:** Both timeout error messages tell the user to set `VOUCH_PERM_TIMEOUT_MS` / `VOUCH_LAUNCH_TIMEOUT_MS` to raise the cap. Neither environment variable is read anywhere in the codebase. `src/cli.ts:382` calls `executePermutations(executorPending, actionsById, { targetUrl, screenshotsDir })` — no `launchTimeoutMs` or `permTimeoutMs` keys, so both caps are always the compiled defaults (30 s and 90 s).

**Why it is wrong:** A user following the error message hint — the only remediation the message offers — will set `VOUCH_PERM_TIMEOUT_MS=120000` and rerun, observe the cap still fires at 90 s, conclude the error message is lying, and file a bug. This violates the constitution's "Comprehensive errors at every failure boundary" rule: the error has to be actionable to count as comprehensive.

**Reproducer:** Trigger a permutation timeout (any SUT path that takes over 90 s). Observe "Raise opts.permTimeoutMs or env VOUCH_PERM_TIMEOUT_MS" in the output. Set `VOUCH_PERM_TIMEOUT_MS=120000`. Rerun. The cap still fires at 90 s.

**Suggested fix:** In `src/cli.ts`, read the env vars and forward them:
```ts
const execs = await executePermutations(executorPending, actionsById, {
  targetUrl,
  screenshotsDir,
  permTimeoutMs: process.env.VOUCH_PERM_TIMEOUT_MS
    ? parseInt(process.env.VOUCH_PERM_TIMEOUT_MS, 10) : undefined,
  launchTimeoutMs: process.env.VOUCH_LAUNCH_TIMEOUT_MS
    ? parseInt(process.env.VOUCH_LAUNCH_TIMEOUT_MS, 10) : undefined,
});
```
Alternatively, remove the env var mentions from the error messages and replace them with `--perm-timeout-ms <ms>` flags or a note that the only override path is `ExecuteOptions` (a programmatic API).

---

### 2. (MEDIUM) `vouch doctor` prints a factually wrong explanation when `anthropic-haiku` is selected

**File:line:** `src/cli.ts:99`

**What is wrong:** The doctor command output says `(default because ANTHROPIC_API_KEY is set and 'claude' CLI is not on PATH; ...)` when `source === "anthropic-haiku"`. Before commit 84546a1, this was accurate: `anthropic-haiku` could only be auto-selected if `claude` was absent. After the commit, `detectOracleSource()` returns `"anthropic-haiku"` as soon as `ANTHROPIC_API_KEY` is set, regardless of whether `claude` is on PATH (`oracle.ts:82`). A developer who has both `ANTHROPIC_API_KEY` set and `claude` installed will see a doctor readout that says `claude` is not on PATH, which may be false and is always misleading.

**Reproducer:**
1. Set `ANTHROPIC_API_KEY=sk-ant-...`
2. Ensure `claude` is on PATH (e.g., `which claude` succeeds)
3. Run `vouch doctor`
4. Output: `oracle source: anthropic-haiku` then `(default because ANTHROPIC_API_KEY is set and 'claude' CLI is not on PATH; ...)` -- the "not on PATH" clause is false.

**Suggested fix:** Change `src/cli.ts:99` to:
```ts
lines.push(`                    (default because ANTHROPIC_API_KEY is set; ~1-2s per permutation, billed per token)`);
```

---

### 3. (LOW) Timeout `Execution` rows always have `step_log: []` -- partial step evidence is lost

**File:line:** `src/core/executor.ts:278`

**What is wrong:** When the per-permutation wallclock cap fires, `executeOneCapped` resolves the `cap` promise with `step_log: []`. The partial `stepLog` accumulated inside `executeOneInContext` before the cap fired is unreachable: `executeOneInContext` is still running in a separate async chain (its `work` promise) and its internal `stepLog` variable is scoped there. Because `ctx.close()` is called immediately, all subsequent Playwright calls in `executeOneInContext` will throw, and the work promise rejects -- silently swallowed by `work.catch(() => {})`.

**Impact:** A depth-5 permutation that completes steps 1-4 and stalls on step 5 produces a "timeout" verdict with zero step evidence. The dashboard shows nothing about what happened before the stall. Debugging requires guessing which step was slow.

**Suggested fix (one option):** Add a shared `AbortController`-style step accumulator:
```ts
// In executeOneCapped, pass a shared stepLog ref:
const sharedLog: Execution["step_log"] = [];
const work = executeOneInContext(ctx, perm, ..., sharedLog);
// In cap resolution, capture what ran:
resolve({ ..., step_log: [...sharedLog], ... });
```
This requires `executeOneInContext` to push to the shared array rather than a local one. The cap can then snapshot its current contents.

---

### 4. (INFORMATIONAL) `AnthropicCacheUsage` local interface lies to TypeScript about `null` vs `undefined`

**File:line:** `src/core/oracle.ts:217-221`, `src/core/expectation.ts:159-164`

**What is wrong:** Both files define `AnthropicCacheUsage` with optional fields (`cache_creation_input_tokens?: number`), implying the fields may be `undefined`. SDK v0.65's actual `Usage` interface (verified at `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`) declares them as `number | null`. The `as AnthropicCacheUsage` casts at lines 329, 815 (oracle.ts) and 262, 645 (expectation.ts) bypass TypeScript's type check.

**Runtime impact:** None today. `null ?? 0` and `undefined ?? 0` both produce `0`, so `computeAnthropicCost` is numerically correct. The risk is future SDK changes: if a new field becomes relevant and is `null` in the SDK but typed as absent in the local interface, the cast will silently prevent TypeScript from flagging the gap.

**Suggested fix:** Import and use the SDK's `Usage` type directly, or update the local interface to `number | null`:
```ts
interface AnthropicCacheUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}
```

---

### 5. (INFORMATIONAL) `detectOracleSource` precedence change is a silent footgun for users with `ANTHROPIC_API_KEY` set for an unrelated project

**File:line:** `src/core/oracle.ts:82-83`

**What is wrong:** Any user who has `ANTHROPIC_API_KEY` set in their environment (for an unrelated use like the Anthropic dashboard, Claude desktop, or another project) will silently start billing real API tokens the next time they run a Vouch campaign, even if they previously relied on `claude-cli`. No warning, no confirmation prompt, no indication in the run output that the source changed. The old behavior was `claude-cli` first (free); the new behavior is `anthropic-haiku` first (billed).

**Reproducer:** User previously runs `vouch run` with `claude` on PATH and no `ANTHROPIC_API_KEY`. They set `ANTHROPIC_API_KEY` for a different project. They run a 200-perm depth-2 campaign. Their Anthropic account is charged. They discover this when they see the API usage dashboard or a billing alert.

**Note from the commit message:** The reordering was intentional ("the user reported burning a hole in subscription credits after a single intensive day"). The intent is defensible. The footgun remains real for users coming from the opposite direction.

**Suggested mitigation:** On the first run where the oracle source changes from the previous run's recorded `prediction_source`, print a one-line warning to stdout:
```
[vouch] oracle source changed: last run used 'claude-cli' (subscription), this run will use 'anthropic-haiku' (API billed). Set VOUCH_ORACLE=claude-cli to override.
```

---

## Tests added

**File:** `/Users/scottlydon/Desktop/Clutter/iOS/vouch/src/core/executor.adversary.test.ts`

9 tests across 5 describe blocks:

| Test | What it proves |
|---|---|
| Finding 1: `VOUCH_PERM_TIMEOUT_MS` is referenced in error but env var is undefined in clean env | Documents the dead-reference bug |
| Finding 1: `VOUCH_LAUNCH_TIMEOUT_MS` same | Documents the dead-reference bug |
| Finding 2: doctor message implies CLI absence is a precondition | Documents the stale precedence message |
| Finding 3: timeout Execution always has `step_log: []` | Documents the partial-step-loss behavior |
| SAFE 1: Promise.race absorbs guarded rejection in launch timeout | Proves no unhandledRejection leak |
| SAFE 2 (two sub-tests): `computeAnthropicCost` handles `null` from SDK v0.65 | Proves runtime cost is correct despite type cast |
| SAFE 3: system prompt is byte-identical across permutations | Proves cache key stability |
| SAFE 4: fallback contract is N-in N-out | Proves no silent drops in fallback path |

All 9 tests pass on `npm test`.

---

## Mutation escapes

Mutation testing is not configured (no `infection.json5`, `stryker.conf.json`, or `cargo-mutants` equivalent found in the repo root).

---

## What I tried that did not break

- **Promise.race unhandledRejection leak in `launchChromiumWithTimeout`:** Initially suspected a missing `.catch()` on `guarded`. Verified via Node.js behavior: `Promise.race` internally attaches handlers to all input promises, absorbing any subsequent rejections from the losing promise. No leak.

- **Double-close on `ctx` in `executeOneCapped`:** Traced all paths (cap-wins, work-wins, simultaneous settlement). JavaScript's event loop prevents `setTimeout` callbacks from interleaving with synchronous `finally` blocks. `clearTimeout(timeoutHandle)` runs atomically before the `if (!timedOut)` check. No double-close possible.

- **`cache_control` on user message blocks:** Checked all four `messages.create` calls (oracle single-perm, oracle batched, verifier single, verifier batched). All user messages are plain strings with no `cache_control`. Only system blocks carry `cache_control: { type: "ephemeral" }`.

- **Cache key stability (permutation-varying values in system block):** `buildCachedOracleSystemPrompt` interpolates only `projectName`, `projectDescription`, and `targetUrl` (all constant per run). The per-permutation `index` and `action_ids` are in `buildOracleUserPrompt`. Cache will hit across all perms in a run.

- **`projectDescription` null vs undefined coercion:** Both `null` and `undefined` are falsy; both produce `Project description: (none provided at vouch init)`. The system block is consistent.

- **Input/output length contract in batched paths:** `parseBatchedResponse` and `parseBatchedVerifyResponse` both throw on length mismatch. The public `OrFallback` wrappers catch and re-run per-perm. Always N-in N-out.

- **Order preservation in fallback:** Both fallback loops iterate inputs in order and push to `out[]` in order. No reordering.

- **`"timeout"` verdict in Zod schema:** Verified `VerdictSchema` at `src/core/types.ts:111` includes `"timeout"`. The timeout `Execution` passes schema validation.

- **`heuristic` source bypassing batching correctly:** Both oracle and verify batch-selection conditions check only `claude-cli` and `anthropic-haiku`. `heuristic` falls to the per-perm loop. Correct.

- **Single-input batch (length === 1) in Anthropic paths:** Both `predictManyWithAnthropic` and `verifyManyWithAnthropic` short-circuit to the per-perm path for `inputs.length === 1`. The system block still gets `cache_control`, priming the cache for subsequent batched calls. Correct design.

- **SDK v0.65 `Usage` type compatibility:** Cache fields exist in the SDK (`number | null`). The `?? 0` operator handles both `null` and `undefined`. No NaN in cost calculations.

---

## What I did not check

- **Anthropic pricing for `claude-haiku-4-5-20251001`:** The model was released after my training cutoff (August 2025). I cannot independently verify that the constants `PRICE_INPUT_PER_MTOK=1.0` and `PRICE_OUTPUT_PER_MTOK=5.0` match Anthropic's published pricing. The cache multipliers (1.25x write, 0.10x read) are structurally correct per Anthropic's cache pricing pattern. **Recommendation:** Verify against Anthropic's current pricing page before shipping and add a comment with the exact URL and date accessed.

- **Anthropic SDK v0.65 breaking changes beyond the `Usage` type:** The `package-lock.json` diff shows major dependency reshuffling (new `json-schema-to-ts`, `ts-algebra`, `@babel/runtime`; removal of `node-fetch`, `formdata-node`, etc.). I did not audit whether the `Anthropic` client constructor or `messages.create` call signatures changed in a way that would cause a runtime error. **Recommendation:** Run `tsc --noEmit` to check for type errors introduced by the SDK bump.

- **Real Playwright integration tests:** The test suite has zero integration tests. All adversary tests are pure-logic. Whether `launchChromiumWithTimeout` and `executeOneCapped` behave correctly with a real browser was not checked. The constitution requires "Never mocks the SUT in integration tests" -- this applies to the SUT, but the executor itself also has no integration tests.

- **Concurrent executor runs (8 workers) stress test:** The constitution references a stress test for the delta queue under concurrent workers. This test does not appear to exist as code. Not checked.

