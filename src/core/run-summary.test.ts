// Tier-bucket + run-summary tests.
//
// Two layers:
//   1) tierFor(execution, expectation) — pure function, exhaustively cover
//      every branch of the bucketing logic. This is the contract the
//      dashboard's project tile renders against, and the contract that must
//      stay aligned with src/dashboard/ui/app.js primaryVerdict(). When a
//      branch is added here, mirror it there.
//   2) summarizeRun(db, runId) — DB-backed roll-up. One end-to-end test that
//      seeds an in-memory SQLite with permutations spanning every tier, then
//      asserts the counts and percentages.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  insertActions,
  insertPermutations,
  insertProject,
  insertRun,
  openDB,
  upsertExecution,
  upsertExpectationVerdict,
  type DBHandle,
} from "./db.js";
import { type Execution } from "./types.js";
import { type ExpectationVerdict } from "./expectation.js";
import { tierFor, summarizeRun } from "./run-summary.js";

function execStub(
  overrides: Partial<Execution> & { permutation_id: string },
): Execution {
  return {
    permutation_id: overrides.permutation_id,
    verdict: overrides.verdict ?? "pass",
    step_log: overrides.step_log ?? [],
    anomalies: overrides.anomalies ?? [],
    observed_post_state: overrides.observed_post_state ?? "url=https://x | title=t | text=\"ok\"",
    started_at: overrides.started_at ?? "2026-05-24T00:00:00Z",
    finished_at: overrides.finished_at ?? "2026-05-24T00:00:01Z",
    error_class: overrides.error_class ?? null,
    final_state_screenshot_path: overrides.final_state_screenshot_path ?? null,
  };
}

function verdictStub(
  overrides: Partial<ExpectationVerdict> & { permutation_id: string },
): ExpectationVerdict {
  return {
    permutation_id: overrides.permutation_id,
    match: overrides.match ?? true,
    reasoning: overrides.reasoning ?? "matches",
    source: overrides.source ?? "anthropic-haiku",
    cost_usd: overrides.cost_usd ?? 0,
    generated_at: overrides.generated_at ?? "2026-05-24T00:00:02Z",
  };
}

describe("tierFor — pure bucket logic", () => {
  it("buckets no-execution as not_executed", () => {
    expect(tierFor(null, null)).toBe("not_executed");
    expect(tierFor(null, verdictStub({ permutation_id: "p" }))).toBe("not_executed");
  });

  it("buckets any non-pass Playwright verdict as issues", () => {
    for (const v of ["fail", "timeout", "infrastructure_error", "missing_input"] as const) {
      expect(tierFor(execStub({ permutation_id: "p", verdict: v }), null)).toBe("issues");
    }
  });

  it("buckets pass + no expectation as with_concerns (NOT VERIFIED)", () => {
    expect(tierFor(execStub({ permutation_id: "p" }), null)).toBe("with_concerns");
  });

  it("buckets pass + match + no anomalies as verified (green)", () => {
    expect(
      tierFor(
        execStub({ permutation_id: "p" }),
        verdictStub({ permutation_id: "p", match: true }),
      ),
    ).toBe("verified");
  });

  it("buckets pass + match + anomalies as with_concerns (VERIFIED WITH CONCERNS)", () => {
    expect(
      tierFor(
        execStub({
          permutation_id: "p",
          anomalies: [{ kind: "console_error", message: "x", url: null, status: null, at: "2026-05-24T00:00:01Z" }],
        }),
        verdictStub({ permutation_id: "p", match: true }),
      ),
    ).toBe("with_concerns");
  });

  it("buckets pass + mismatch + heuristic verifier as with_concerns (FLAGGED rules)", () => {
    expect(
      tierFor(
        execStub({ permutation_id: "p" }),
        verdictStub({ permutation_id: "p", match: false, source: "heuristic" }),
      ),
    ).toBe("with_concerns");
  });

  it("buckets pass + mismatch + LLM verifier + 'Likely spec brittleness' as with_concerns", () => {
    expect(
      tierFor(
        execStub({ permutation_id: "p" }),
        verdictStub({
          permutation_id: "p",
          match: false,
          source: "anthropic-haiku",
          reasoning: "Likely spec brittleness — the count is data-driven.",
        }),
      ),
    ).toBe("with_concerns");
  });

  it("buckets pass + mismatch + LLM verifier + other reasoning as issues (BUG CANDIDATE)", () => {
    expect(
      tierFor(
        execStub({ permutation_id: "p" }),
        verdictStub({
          permutation_id: "p",
          match: false,
          source: "anthropic-haiku",
          reasoning: "Observed showed an empty state where the prediction said a dashboard.",
        }),
      ),
    ).toBe("issues");
  });
});

describe("summarizeRun — DB roll-up", () => {
  let tmpDir: string;
  let db: DBHandle;
  const runId = "run_summary";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vouch-runsummary-"));
    mkdirSync(tmpDir, { recursive: true });
    db = openDB(join(tmpDir, "test.db"));
    insertProject(db, {
      id: "proj",
      name: "proj",
      description: null,
      spec_text: "spec",
      created_at: "2026-05-24T00:00:00Z",
    });
    insertRun(db, {
      id: runId,
      project_id: "proj",
      target_url: "https://example.com",
      spec_text: "spec",
      spec_sha256: "deadbeef",
      strategy: "exhaustive",
      depth: 1,
      started_at: "2026-05-24T00:00:00Z",
      finished_at: null,
      prediction_source: "anthropic-haiku",
    });
    insertActions(db, runId, [
      { id: "a", kind: "click", selector: "[data-testid=a]", description: "a", type_value: null, rules: [], meta: {} },
    ]);
  });

  afterEach(() => {
    db.raw.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zeros across all tiers when the run has no permutations", () => {
    const out = summarizeRun(db, runId);
    expect(out.permutations).toBe(0);
    expect(out.counts).toEqual({ verified: 0, with_concerns: 0, issues: 0, not_executed: 0 });
    expect(out.percentages).toEqual({ verified: 0, with_concerns: 0, issues: 0, not_executed: 0 });
  });

  it("rolls 10 permutations spanning every tier into the right counts + percentages", () => {
    // 10 perms, deliberately chosen ratios:
    //   4 verified            → 40%
    //   3 with_concerns       → 30%   (1 mismatch-heuristic, 1 anomalies-on-match, 1 not-verified)
    //   2 issues              → 20%   (1 crashed, 1 LLM bug candidate)
    //   1 not_executed        → 10%
    const perms = Array.from({ length: 10 }, (_, i) => ({
      id: `${runId}__perm_${String(i).padStart(5, "0")}`,
      run_id: runId,
      action_ids: ["a"],
      index: i,
    }));
    insertPermutations(db, perms);

    // Helper bound to this test's `perms` so the body stays focused on
    // tier coverage instead of repeating non-null assertions. `perms` was
    // just constructed two lines above; the `!` is safe and the alternative
    // (a switch on `i`) is noisier than the intent it expresses.
    const idAt = (i: number): string => perms[i]!.id;

    // 0..3 verified
    for (let i = 0; i < 4; i++) {
      upsertExecution(db, execStub({ permutation_id: idAt(i) }));
      upsertExpectationVerdict(db, verdictStub({ permutation_id: idAt(i), match: true }));
    }
    // 4 with_concerns — mismatch under heuristic
    upsertExecution(db, execStub({ permutation_id: idAt(4) }));
    upsertExpectationVerdict(db, verdictStub({ permutation_id: idAt(4), match: false, source: "heuristic" }));
    // 5 with_concerns — match but anomalies
    upsertExecution(db, execStub({
      permutation_id: idAt(5),
      anomalies: [{ kind: "http_5xx", message: "500", url: "https://x/api", status: 500, at: "2026-05-24T00:00:01Z" }],
    }));
    upsertExpectationVerdict(db, verdictStub({ permutation_id: idAt(5), match: true }));
    // 6 with_concerns — pass but no verdict (NOT VERIFIED)
    upsertExecution(db, execStub({ permutation_id: idAt(6) }));
    // 7 issues — Playwright crashed
    upsertExecution(db, execStub({ permutation_id: idAt(7), verdict: "fail" }));
    // 8 issues — LLM bug candidate
    upsertExecution(db, execStub({ permutation_id: idAt(8) }));
    upsertExpectationVerdict(db, verdictStub({
      permutation_id: idAt(8),
      match: false,
      source: "anthropic-haiku",
      reasoning: "The page showed an error toast where the prediction said success.",
    }));
    // 9 not_executed — no execution row at all (perm exists in DB but executor hasn't reached it)

    const out = summarizeRun(db, runId);
    expect(out.permutations).toBe(10);
    expect(out.counts).toEqual({ verified: 4, with_concerns: 3, issues: 2, not_executed: 1 });
    expect(out.percentages).toEqual({ verified: 40, with_concerns: 30, issues: 20, not_executed: 10 });
  });
});
