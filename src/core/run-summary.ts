// Run summarizer.
//
// Walks one run's permutations + executions + expectation verdicts and bucks
// each permutation into ONE of four primary-verdict tiers. The output is the
// per-tile breakdown the dashboard's project view renders on each run card,
// so an operator can scan a list and answer "did anything break here?" without
// clicking through.
//
// The four buckets are deliberately the SAME tiers the run-detail page shows
// when expanded: a tile that reports 5/10 verified must contain exactly 5
// permutations the detail page labels VERIFIED. If you change the tier rules
// here, mirror them in src/dashboard/ui/app.js's primaryVerdict() — and vice
// versa. There is no shared module because the dashboard JS is intentionally
// build-step-free (no bundler, no TS for the browser layer), so the two
// implementations are kept in sync by convention. The test suite at
// src/core/run-summary.test.ts pins the buckets so a drift surfaces as a
// failing assertion instead of a silent UI desync.

import {
  getExecution,
  getExpectationVerdict,
  listPermutationsForRun,
  type DBHandle,
} from "./db.js";
import { type Execution } from "./types.js";
import { type ExpectationVerdict } from "./expectation.js";

/**
 * One of the four tier buckets a permutation falls into for the project-list
 * tile breakdown. The labels match the operator-facing wording on the run
 * detail page (see app.js primaryVerdict()) so the tile and the detail view
 * use the same vocabulary.
 *
 *   verified       — Playwright ran clean AND the verifier said observed
 *                    matched expected AND no browser anomalies fired.
 *                    Maps to the green VERIFIED card.
 *   with_concerns  — Walked, but is not pristine: VERIFIED WITH CONCERNS
 *                    (match + anomalies), SPEC BRITTLENESS (LLM mismatch
 *                    classified as data variation), FLAGGED (heuristic
 *                    verifier mismatch), or NOT VERIFIED (steps ran but the
 *                    verify pass did not). All yellow on the detail page.
 *   issues         — Hard failures: CRASHED (Playwright step crashed /
 *                    timed out / boot failed) and BUG CANDIDATE (LLM
 *                    verifier flagged a real semantic divergence). Red on
 *                    the detail page.
 *   not_executed   — The executor has not replayed this permutation yet.
 *                    Common during a partial run or before the executor
 *                    starts. Gray on the detail page.
 */
export type PrimaryTier = "verified" | "with_concerns" | "issues" | "not_executed";

export interface RunSummary {
  /** Total permutations for this run. Equals the sum of the four tier counts. */
  permutations: number;
  /** Tier counts. Always exactly these four keys; missing tier = 0. */
  counts: Record<PrimaryTier, number>;
  /** Percentage of total in each tier, rounded to one decimal. Zero when permutations === 0. */
  percentages: Record<PrimaryTier, number>;
}

/**
 * Bucket one permutation's evidence into a tier. Pure function, no DB access,
 * so the same rules are trivially testable. Mirrors app.js primaryVerdict()
 * — keep them aligned.
 */
export function tierFor(
  execution: Execution | null,
  expectation: ExpectationVerdict | null,
): PrimaryTier {
  // Not executed yet — operator has not run, or executor crashed before
  // recording this perm. Either way it counts as "pending work" on the tile.
  if (!execution) return "not_executed";

  // Anything that wasn't a clean step run is a hard failure. Crashed /
  // timed out / boot failed all collapse to a red bucket because the page
  // never reached a final state to verify against.
  if (execution.verdict !== "pass") return "issues";

  // Steps ran, but the verify pass never produced a verdict. Yellow because
  // we don't know if the SUT is right — surfaces in the detail view as
  // NOT VERIFIED.
  if (!expectation) return "with_concerns";

  const anomalies = Array.isArray(execution.anomalies) ? execution.anomalies : [];

  // Match path. Green only when nothing else fired underneath.
  if (expectation.match) {
    return anomalies.length === 0 ? "verified" : "with_concerns";
  }

  // Mismatch path. The verifier's source + classification decide red vs.
  // yellow.
  //   - heuristic source: yellow (over-flags by design)
  //   - LLM source, "Likely spec brittleness" classification: yellow
  //     (structural behavior matched, data variation only)
  //   - LLM source, otherwise: red (real candidate SUT bug)
  if (expectation.source === "heuristic") return "with_concerns";
  if (/^\s*Likely\s+spec\s+brittleness/i.test(expectation.reasoning)) {
    return "with_concerns";
  }
  return "issues";
}

/**
 * Read every permutation, execution, and expectation row for a run and roll
 * them up into a RunSummary. Three queries per run (perms + per-perm
 * execution lookup + per-perm expectation lookup) is fine at the cardinalities
 * Vouch deals with (low hundreds of perms per run, single-digit runs per
 * project view). When that stops being true the right fix is a single JOINed
 * query, not a cache.
 */
export function summarizeRun(db: DBHandle, runId: string): RunSummary {
  const perms = listPermutationsForRun(db, runId);
  const counts: Record<PrimaryTier, number> = {
    verified: 0,
    with_concerns: 0,
    issues: 0,
    not_executed: 0,
  };
  for (const p of perms) {
    const execution = getExecution(db, p.id);
    const expectation = getExpectationVerdict(db, p.id);
    counts[tierFor(execution, expectation)]++;
  }
  return {
    permutations: perms.length,
    counts,
    percentages: percentagesOf(perms.length, counts),
  };
}

/**
 * Compute per-tier percentages, rounded to one decimal place. Returns all
 * zeros when total === 0 so the dashboard can render a "no permutations"
 * state without a divide-by-zero.
 */
function percentagesOf(
  total: number,
  counts: Record<PrimaryTier, number>,
): Record<PrimaryTier, number> {
  if (total <= 0) {
    return { verified: 0, with_concerns: 0, issues: 0, not_executed: 0 };
  }
  return {
    verified: round1((counts.verified / total) * 100),
    with_concerns: round1((counts.with_concerns / total) * 100),
    issues: round1((counts.issues / total) * 100),
    not_executed: round1((counts.not_executed / total) * 100),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
