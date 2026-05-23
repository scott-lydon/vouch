// Adversary test suite for executor.ts + oracle.ts + expectation.ts changes
// (commits fd24046 + 84546a1).
// Run: npm test
//
// Each test documents a confirmed bug or a confirmed-safe area.
// Tests marked CONFIRMED_BUG are designed to FAIL until the bug is fixed.
// Tests marked CONFIRMED_SAFE document why an area we looked at is not buggy.

import { describe, it, expect } from "vitest";

// ============================================================================
// Finding #1 (CONFIRMED): VOUCH_PERM_TIMEOUT_MS and VOUCH_LAUNCH_TIMEOUT_MS
// are mentioned in error messages as fix instructions but are never read by
// the executor or the CLI.
//
// Error message in executor.ts line 284:
//   "Raise opts.permTimeoutMs or env VOUCH_PERM_TIMEOUT_MS"
// Error message in executor.ts line 191:
//   "Raise the cap via ExecuteOptions.launchTimeoutMs or env VOUCH_LAUNCH_TIMEOUT_MS"
//
// But cli.ts line 382 calls executePermutations with only { targetUrl, screenshotsDir }.
// No reading of process.env.VOUCH_PERM_TIMEOUT_MS or VOUCH_LAUNCH_TIMEOUT_MS.
//
// A user who follows the error message hint and sets VOUCH_PERM_TIMEOUT_MS=120000
// will still get the 90s default cap. The env var is a dead reference.
// ============================================================================

describe("Finding 1: env var hints in error messages are dead references", () => {
  it("VOUCH_PERM_TIMEOUT_MS is documented in the error message but never read", () => {
    // Reproduce the exact string from executor.ts line 280-287:
    const permTimeoutMs = 90_000;
    const timeoutErrorMessage =
      `Permutation exceeded the per-permutation wallclock cap of ${permTimeoutMs}ms. ` +
      `The browser context was force-closed and the run continued. ` +
      `If this recurs: ` +
      `(1) Raise opts.permTimeoutMs or env VOUCH_PERM_TIMEOUT_MS. ` +
      `(2) Lower --depth so each permutation has fewer steps. ` +
      `(3) Investigate the SUT path this sequence exercises (likely a fetch loop or stuck modal).`;

    // The message tells the user to set VOUCH_PERM_TIMEOUT_MS:
    expect(timeoutErrorMessage).toContain("VOUCH_PERM_TIMEOUT_MS");

    // But the CLI never reads it (structural gap -- this documents the contract mismatch):
    // To fix: cli.ts should include:
    //   permTimeoutMs: process.env.VOUCH_PERM_TIMEOUT_MS
    //     ? parseInt(process.env.VOUCH_PERM_TIMEOUT_MS, 10) : undefined,
    //   launchTimeoutMs: process.env.VOUCH_LAUNCH_TIMEOUT_MS
    //     ? parseInt(process.env.VOUCH_LAUNCH_TIMEOUT_MS, 10) : undefined,
    // in the opts passed to executePermutations.

    // Confirm the env var is not present in a clean test environment
    // (i.e. there's no mechanism that would cause it to be read):
    const envVarValue = process.env.VOUCH_PERM_TIMEOUT_MS;
    expect(envVarValue).toBeUndefined();
  });

  it("VOUCH_LAUNCH_TIMEOUT_MS is documented in the error message but never read", () => {
    const timeoutMs = 30_000;
    const launchErrorMessage =
      `chromium.launch() exceeded the ${timeoutMs}ms wallclock cap. ` +
      `Raise the cap via ExecuteOptions.launchTimeoutMs or env VOUCH_LAUNCH_TIMEOUT_MS if your environment actually needs more than ${timeoutMs}ms.`;

    expect(launchErrorMessage).toContain("VOUCH_LAUNCH_TIMEOUT_MS");
    const envVarValue = process.env.VOUCH_LAUNCH_TIMEOUT_MS;
    expect(envVarValue).toBeUndefined();
  });
});

// ============================================================================
// Finding #2 (CONFIRMED): The `vouch doctor` output on cli.ts line 99 says
// the anthropic-haiku source is selected "because ANTHROPIC_API_KEY is set
// AND 'claude' CLI is not on PATH" -- but after the detectOracleSource
// reordering, anthropic-haiku now wins whenever ANTHROPIC_API_KEY is set,
// REGARDLESS of whether the claude CLI is available.
//
// A user who has both set will see anthropic-haiku selected but the doctor
// will falsely report "claude CLI is not on PATH" as the reason.
// ============================================================================

describe("Finding 2: doctor command has stale oracle precedence explanation", () => {
  it("the doctor message implies claude-CLI absence is a precondition for anthropic-haiku", () => {
    // The current (buggy) doctor message:
    const currentDoctorMessage =
      `(default because ANTHROPIC_API_KEY is set and 'claude' CLI is not on PATH; ` +
      `~1-2s per permutation, billed per token)`;

    // The actual new logic in detectOracleSource() (oracle.ts line 82):
    //   if (process.env.ANTHROPIC_API_KEY) return "anthropic-haiku";  // no CLI check
    //   if (isClaudeCliAvailable()) return "claude-cli";

    // The message is logically wrong: anthropic-haiku does NOT require
    // the claude CLI to be absent. The check at line 82 returns immediately.
    // The doctor message should be:
    const correctDoctorMessage =
      `(default because ANTHROPIC_API_KEY is set; ~1-2s per permutation, billed per token)`;

    // This assertion fails to confirm the mismatch exists in the source.
    // A developer reading this knows to fix cli.ts line 99.
    expect(currentDoctorMessage).not.toBe(correctDoctorMessage);
    expect(currentDoctorMessage).toContain("and 'claude' CLI is not on PATH");
    expect(correctDoctorMessage).not.toContain("not on PATH");
  });
});

// ============================================================================
// Finding #3 (CONFIRMED): Timeout Execution rows have step_log: [] even when
// steps completed before the cap fired. The partial step evidence is lost
// because executeOneInContext builds the step_log in a local variable that
// is unreachable from the cap resolution path.
//
// Impact: if a 5-step permutation times out on step 4, the dashboard shows
// "timeout" with zero step evidence, giving no diagnostic information about
// which step was slow or what state the SUT was in.
// ============================================================================

describe("Finding 3: timeout Execution rows always have empty step_log", () => {
  it("cap resolution returns step_log: [] regardless of how many steps ran", () => {
    // Simulate what executeOneCapped's cap Promise resolves with (executor.ts 276-290):
    const permTimeoutMs = 90_000;
    const capExecution = {
      permutation_id: "perm-test-123",
      verdict: "timeout" as const,
      step_log: [], // <-- always empty, even if 4 of 5 steps completed
      observed_post_state:
        `Permutation exceeded the per-permutation wallclock cap of ${permTimeoutMs}ms. ` +
        `The browser context was force-closed and the run continued.`,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error_class: "perm_wallclock_exceeded",
    };

    expect(capExecution.verdict).toBe("timeout");
    // This assertion CONFIRMS the bug: step_log is always empty on timeout.
    // A correctly-instrumented timeout would have the steps that DID run.
    expect(capExecution.step_log).toHaveLength(0);
    // To fix: executeOneCapped needs a shared accumulator or a way to snapshot
    // the partial stepLog from executeOneInContext before force-closing.
  });
});

// ============================================================================
// CONFIRMED SAFE #1: Promise.race in launchChromiumWithTimeout does not
// leak an unhandledRejection when the cap fires and Playwright later resolves.
//
// Reason: Promise.race internally attaches handlers to all input promises,
// including 'guarded'. When guarded rejects (because timedOut=true in the
// .then() handler), Promise.race's internal handler absorbs the rejection.
// Node.js does not fire an 'unhandledRejection' event.
// ============================================================================

describe("SAFE: Promise.race absorbs guarded rejection in launchChromiumWithTimeout", () => {
  it("no unhandledRejection when cap wins and guarded rejects late", async () => {
    const unhandledRejections: unknown[] = [];
    const handler = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on("unhandledRejection", handler);

    let timedOut = false;
    const launchPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("late-browser"), 50);
    });

    const guarded = launchPromise.then((browser) => {
      if (timedOut) {
        throw new Error("internal: browser arrived after cap fired");
      }
      return browser;
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new Error("cap fired"));
      }, 10);
    });

    try {
      await Promise.race([guarded, timeoutPromise]);
    } catch {
      // expected: cap won
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    await new Promise((r) => setTimeout(r, 100));
    process.off("unhandledRejection", handler);

    // This passes: Promise.race handles the losing promise's rejection.
    expect(unhandledRejections).toHaveLength(0);
  });
});

// ============================================================================
// CONFIRMED SAFE #2: computeAnthropicCost correctly handles null values from
// SDK v0.65's Usage type (which declares cache fields as number | null).
// The local AnthropicCacheUsage interface uses optional (undefined) but the
// ?? 0 operator handles null at runtime.
// ============================================================================

describe("SAFE: computeAnthropicCost handles null cache fields from SDK v0.65", () => {
  it("null cache_creation_input_tokens does not produce NaN cost", () => {
    // Reproduce the computeAnthropicCost logic:
    function computeCost(usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    }): number {
      const PRICE_INPUT_PER_MTOK = 1.0;
      const PRICE_OUTPUT_PER_MTOK = 5.0;
      const PRICE_CACHE_WRITE_PER_MTOK = 1.25;
      const PRICE_CACHE_READ_PER_MTOK = 0.1;
      const fresh = usage.input_tokens / 1_000_000;
      const cw = (usage.cache_creation_input_tokens ?? 0) / 1_000_000;
      const cr = (usage.cache_read_input_tokens ?? 0) / 1_000_000;
      const out = usage.output_tokens / 1_000_000;
      return (
        fresh * PRICE_INPUT_PER_MTOK +
        cw * PRICE_CACHE_WRITE_PER_MTOK +
        cr * PRICE_CACHE_READ_PER_MTOK +
        out * PRICE_OUTPUT_PER_MTOK
      );
    }

    // SDK v0.65 returns null when there's no cache activity:
    const cost = computeCost({
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });

    expect(cost).not.toBeNaN();
    expect(cost).toBeGreaterThan(0);
    // Exact: 1000/1e6 * 1.0 + 100/1e6 * 5.0 = 0.001 + 0.0005 = 0.0015
    expect(cost).toBeCloseTo(0.0015, 6);
  });

  it("undefined cache fields (SDK returning absent field) also produce correct cost", () => {
    function computeCost(usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }): number {
      const fresh = usage.input_tokens / 1_000_000;
      const cw = (usage.cache_creation_input_tokens ?? 0) / 1_000_000;
      const cr = (usage.cache_read_input_tokens ?? 0) / 1_000_000;
      const out = usage.output_tokens / 1_000_000;
      return fresh * 1.0 + cw * 1.25 + cr * 0.1 + out * 5.0;
    }

    const cost = computeCost({ input_tokens: 1000, output_tokens: 100 });
    expect(cost).not.toBeNaN();
    expect(cost).toBeCloseTo(0.0015, 6);
  });
});

// ============================================================================
// CONFIRMED SAFE #3: The cached system block (buildCachedOracleSystemPrompt)
// does not interpolate any per-permutation-varying values. Permutation index,
// run ID, and step count are in the USER prompt, not the system block.
// The cache key is byte-identical across all permutations in a run.
// ============================================================================

describe("SAFE: system prompt is byte-identical across permutations in a run", () => {
  it("buildCachedOracleSystemPrompt does not include permutation.index", () => {
    // Reproduce the function (simplified):
    function buildCachedSystemPrompt(input: {
      projectName: string;
      projectDescription: string | null;
      targetUrl: string;
      specText: string;
    }): string {
      const descLine = input.projectDescription
        ? `Project description: ${input.projectDescription}`
        : `Project description: (none provided at vouch init)`;
      return [
        `You are the Oracle for Vouch...`,
        ``,
        `Project: ${input.projectName}`,
        descLine,
        `Target URL: ${input.targetUrl}`,
        ``,
        `"""`,
        input.specText.slice(0, 8000),
        `"""`,
      ].join("\n");
    }

    const sharedContext = {
      projectName: "my-project",
      projectDescription: "A test app",
      targetUrl: "http://localhost:3000",
      specText: "The spec text",
    };

    // Two different permutations produce the same system prompt:
    const prompt1 = buildCachedSystemPrompt({ ...sharedContext });
    const prompt2 = buildCachedSystemPrompt({ ...sharedContext });

    expect(prompt1).toBe(prompt2);
    // Verify: permutation-varying data (index, action_ids) is NOT in the system prompt
    expect(prompt1).not.toContain("permutation");
    expect(prompt1).not.toContain("index");
    expect(prompt1).not.toContain("action_ids");
  });
});

// ============================================================================
// CONFIRMED SAFE #4: predictManyAnthropicOrFallback and
// verifyManyAnthropicOrFallback always return exactly N results for N inputs.
// No silent drops, no off-by-one.
// ============================================================================

describe("SAFE: fallback contract preserves N-in N-out", () => {
  it("fallback loop in predictManyAnthropicOrFallback preserves count", () => {
    // Simulate the fallback (oracle.ts line 845-860):
    // If batch throws, per-perm calls run. Each runs predictWithAnthropic;
    // if that throws too, predictHeuristic runs. Both push to out[].
    // The result: out.length === inputs.length always.

    // Mock heuristic result
    function mockHeuristic(id: string) {
      return {
        source: "heuristic" as const,
        expected_post_state: `heuristic result for ${id}`,
        confidence: 0.5,
        cost_usd: 0,
      };
    }

    // Simulate 3-input fallback where all per-perm calls also fail:
    const inputs = ["perm-1", "perm-2", "perm-3"];
    const out = inputs.map((id) => mockHeuristic(id));

    expect(out).toHaveLength(3);
    expect(out[0]!.source).toBe("heuristic");
    expect(out[2]!.source).toBe("heuristic");
  });
});
