// Findings analyzer.
//
// Walks one Vouch run's permutations + predictions + executions + expectation
// verdicts and categorizes anything that looks like a real bug into a Finding
// row. The findings.md report is the bridge between Vouch and the human (or
// the human's Claude session): paste the report into Cowork and ask Claude
// to fix the SUT.
//
// Categories:
//   - playwright_failure  — verdict != pass (the executor crashed mid-sequence)
//   - expectation_mismatch — verify pass + observed disagrees with expected
//   - missing_verdict     — verify never ran (informational, not blocking)

import { rmSync } from "node:fs";
import { dirname } from "node:path";

import {
  getExecution,
  getExpectationVerdict,
  getPrediction,
  getProject,
  getRun,
  getSketchyVerdict,
  listActionsForRun,
  listPermutationsForRun,
  type DBHandle,
} from "./db.js";
import { type Action, type Execution, type Permutation, type Prediction } from "./types.js";
import { type ExpectationVerdict } from "./expectation.js";
import { type SketchyVerdict } from "./sketchy.js";

export interface Finding {
  permutation_id: string;
  /** Display id (the suffix after `__` in the globally-unique permutation_id). */
  short_id: string;
  category:
    | "playwright_failure"
    | "expectation_mismatch"
    | "missing_verdict"
    | "visual_sketchy";
  severity: "blocking" | "warning" | "info";
  summary: string;
  action_sequence: Array<{ id: string; kind: string; description: string; type_value: string | null }>;
  expected_post_state: string;
  observed_post_state: string;
  diagnostic: string;
}

export interface FindingsReport {
  run_id: string;
  project_name: string;
  target_url: string;
  depth: number;
  permutation_count: number;
  blocking_count: number;
  warning_count: number;
  findings: Finding[];
}

export function analyzeRun(db: DBHandle, runId: string): FindingsReport {
  const run = getRun(db, runId);
  if (!run) throw new Error(`analyzeRun: run '${runId}' not found in vouch.db`);
  const project = getProject(db, run.project_id);
  if (!project) throw new Error(`analyzeRun: project '${run.project_id}' not found in vouch.db`);

  const actions = listActionsForRun(db, runId);
  const actionsById = new Map(actions.map((a) => [a.id, a]));
  const perms = listPermutationsForRun(db, runId);

  const findings: Finding[] = [];
  for (const perm of perms) {
    const prediction = getPrediction(db, perm.id);
    const execution = getExecution(db, perm.id);
    const verdict = getExpectationVerdict(db, perm.id);
    const sketchy = getSketchyVerdict(db, perm.id);
    const fs = findingsForPermutation(perm, actionsById, prediction, execution, verdict, sketchy);
    findings.push(...fs);
  }

  return {
    run_id: runId,
    project_name: project.name,
    target_url: run.target_url,
    depth: run.depth,
    permutation_count: perms.length,
    blocking_count: findings.filter((f) => f.severity === "blocking").length,
    warning_count: findings.filter((f) => f.severity === "warning").length,
    findings,
  };
}

function findingsForPermutation(
  perm: Permutation,
  actionsById: Map<string, Action>,
  prediction: Prediction | null,
  execution: Execution | null,
  verdict: ExpectationVerdict | null,
  sketchy: SketchyVerdict | null,
): Finding[] {
  const sequence = perm.action_ids.map((id) => {
    const a = actionsById.get(id);
    return a
      ? { id: a.id, kind: a.kind, description: a.description, type_value: a.type_value }
      : { id, kind: "unknown", description: `(unknown action ${id})`, type_value: null };
  });
  const short = shortIdOf(perm.id);
  const out: Finding[] = [];

  // 1. Playwright failure
  if (execution && execution.verdict !== "pass") {
    out.push({
      permutation_id: perm.id,
      short_id: short,
      category: "playwright_failure",
      severity: "blocking",
      summary: `Playwright verdict '${execution.verdict}' on ${short}. ${execution.error_class ?? "unknown error class"}.`,
      action_sequence: sequence,
      expected_post_state: prediction?.expected_post_state ?? "(no prediction)",
      observed_post_state: execution.observed_post_state,
      diagnostic: failureDiagnostic(execution),
    });
    return out; // No point also checking expectation when Playwright crashed.
  }

  // 2. Expectation mismatch — severity depends on the verifier's trust level.
  //    heuristic source = "warning" (over-flags by design; rendered but does
  //      not block downstream effects like screenshot retention or prefix
  //      blocking).
  //    claude-cli / anthropic-haiku = "blocking" (the verifier reasons
  //      semantically; a mismatch is a real candidate SUT bug).
  if (execution && verdict && verdict.match === false) {
    const sev: Finding["severity"] = verdict.source === "heuristic" ? "warning" : "blocking";
    out.push({
      permutation_id: perm.id,
      short_id: short,
      category: "expectation_mismatch",
      severity: sev,
      summary: `Expectation mismatch on ${short}: ${verdict.reasoning.slice(0, 140)}`,
      action_sequence: sequence,
      expected_post_state: prediction?.expected_post_state ?? "(no prediction)",
      observed_post_state: execution.observed_post_state,
      diagnostic:
        `Source: ${verdict.source}${verdict.source === "heuristic" ? " (over-flags by design; install Claude CLI or set ANTHROPIC_API_KEY for semantic verification)" : ""}.\n` +
        `Reasoning: ${verdict.reasoning}\n\n` +
        `If the prediction is wrong, edit the operator note on the permutation card and rerun verify. ` +
        `If the SUT is wrong, fix it in the codebase and rerun the same depth to confirm.`,
    });
    return out;
  }

  // 3. Missing verdict (informational; not a bug, but useful to surface)
  if (execution && !verdict) {
    out.push({
      permutation_id: perm.id,
      short_id: short,
      category: "missing_verdict",
      severity: "info",
      summary: `${short} executed but has no expectation verdict (verify-expectations did not run).`,
      action_sequence: sequence,
      expected_post_state: prediction?.expected_post_state ?? "(no prediction)",
      observed_post_state: execution.observed_post_state,
      diagnostic: "Run 'vouch campaign' or pass --verify to run-expectations to populate verdicts.",
    });
  }

  // 4. Missing animation during async wait. Surfaced under the same
  //    visual_sketchy category as the vision-model findings so the
  //    dashboard's brown badge represents one consistent "UX is broken
  //    here" concept across both kinds of evidence. ADDITIVE to the
  //    categories above (a Playwright-pass click that triggered a hung-
  //    feeling wait is still a UX bug). The anomalies live on the
  //    Execution row, so we read them from there. We emit ONE finding per
  //    perm even if multiple clicks each triggered a missing_animation —
  //    the dashboard rolls the messages into one card.
  if (execution) {
    const animMisses = execution.anomalies.filter((a) => a.kind === "missing_animation");
    if (animMisses.length > 0) {
      const head = animMisses[0]!.message.split(". ")[0]!;
      out.push({
        permutation_id: perm.id,
        short_id: short,
        category: "visual_sketchy",
        severity: "warning",
        summary: `Missing-animation: ${head.slice(0, 160)}`,
        action_sequence: sequence,
        expected_post_state: prediction?.expected_post_state ?? "(no prediction)",
        observed_post_state: execution.observed_post_state,
        diagnostic:
          `Source: executor animation-presence watcher.\n` +
          `Occurrences (${animMisses.length}):\n` +
          animMisses.map((a, i) => `${i + 1}. ${a.message}`).join("\n") +
          `\n\nFix one of:\n` +
          `  (a) Add an animated loading indicator (CSS animation, transition, [role=progressbar], or [aria-busy=true]).\n` +
          `  (b) Make the async work faster than the flag threshold (default 500ms).\n` +
          `  (c) If the wait is intentionally silent and the SUT design demands it, document the choice in spec.md so the sketchy phase treats this as expected.`,
      });
    }
  }

  // 5. Visual sketchy. ADDITIVE to the categories above — a perm can be
  //    Playwright-pass + expectation-match + visually-sketchy (the click
  //    worked but the resulting page has a low-contrast hero, a stuck
  //    spinner, or leftover engineering jargon). Severity is "warning" by
  //    default: the vision model's "this looks broken" judgment is
  //    informed but not as load-bearing as a Playwright crash, and we want
  //    visual findings to surface in the dashboard without auto-blocking
  //    the entire campaign at this depth. The campaign loop in cli.ts
  //    deliberately does NOT promote warnings to blocked_prefixes for the
  //    same reason.
  if (sketchy && sketchy.verdict === "sketchy" && sketchy.issues.length > 0) {
    const headline = sketchy.issues.slice(0, 2).join("; ");
    out.push({
      permutation_id: perm.id,
      short_id: short,
      category: "visual_sketchy",
      severity: "warning",
      summary: `Visual issues on ${short}: ${headline.slice(0, 160)}`,
      action_sequence: sequence,
      expected_post_state: prediction?.expected_post_state ?? "(no prediction)",
      observed_post_state: execution?.observed_post_state ?? "(no execution)",
      diagnostic:
        `Source: ${sketchy.source} ($${sketchy.cost_usd.toFixed(4)}).\n` +
        `Issues (${sketchy.issues.length}):\n` +
        sketchy.issues.map((s, i) => `${i + 1}. ${s}`).join("\n") +
        `\n\nThese are visual / UX issues observed in the post-action screenshot. ` +
        `If a flagged issue is intentional, add a note in spec.md so future sketchy passes treat it as expected.`,
    });
  }
  return out;
}

function failureDiagnostic(execution: Execution): string {
  const failed = execution.step_log.find((s) => !s.ok);
  if (!failed) return "Verdict was non-pass but no step in the log was marked failed. Inspect step_log_json directly.";
  return (
    `Failed step: action_id=${failed.action_id} kind=${failed.kind}.\n` +
    `Error message: ${failed.error_message ?? "(none)"}\n` +
    `Time window: ${failed.started_at} → ${failed.finished_at}`
  );
}

function shortIdOf(permutationId: string): string {
  return permutationId.includes("__") ? (permutationId.split("__").pop() ?? permutationId) : permutationId;
}

// ============================================================================
// Markdown report — paste-into-Claude format
// ============================================================================

export function renderFindingsMarkdown(report: FindingsReport): string {
  const lines: string[] = [];
  lines.push(`# Vouch findings — ${report.project_name} (run ${report.run_id})`);
  lines.push("");
  lines.push(
    `**Target:** ${report.target_url}  ` +
      `**Depth:** ${report.depth}  ` +
      `**Permutations:** ${report.permutation_count}  ` +
      `**Blocking:** ${report.blocking_count}  ` +
      `**Warnings:** ${report.warning_count}`,
  );
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("No findings. This depth is clean. Safe to advance.");
    return lines.join("\n");
  }

  // Group by category, blocking first.
  const groups: Record<Finding["category"], Finding[]> = {
    playwright_failure: [],
    expectation_mismatch: [],
    visual_sketchy: [],
    missing_verdict: [],
  };
  for (const f of report.findings) groups[f.category].push(f);

  for (const cat of [
    "playwright_failure",
    "expectation_mismatch",
    "visual_sketchy",
    "missing_verdict",
  ] as const) {
    if (groups[cat].length === 0) continue;
    lines.push(`## ${categoryHeading(cat)} (${groups[cat].length})`);
    lines.push("");
    for (const f of groups[cat]) {
      lines.push(`### ${f.short_id} — ${f.severity}`);
      lines.push("");
      lines.push(`**Summary:** ${f.summary}`);
      lines.push("");
      lines.push(`**Action sequence:**`);
      lines.push("");
      for (let i = 0; i < f.action_sequence.length; i++) {
        const a = f.action_sequence[i]!;
        const val = a.type_value !== null ? ` (types: "${a.type_value}")` : "";
        lines.push(`${i + 1}. \`${a.kind}\` — ${a.description}${val}`);
      }
      lines.push("");
      lines.push(`**Expected (Oracle):**`);
      lines.push("");
      lines.push("> " + f.expected_post_state.split("\n").join("\n> "));
      lines.push("");
      lines.push(`**Observed (Executor):**`);
      lines.push("");
      lines.push("> " + f.observed_post_state.split("\n").join("\n> "));
      lines.push("");
      lines.push(`**Diagnostic:**`);
      lines.push("");
      lines.push("```");
      lines.push(f.diagnostic);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("## Suggested next step");
  lines.push("");
  lines.push(
    `Paste this report into your Cowork chat and ask: ` +
      `"Please fix the bugs Vouch found above in ${report.project_name}, then I'll re-run depth ${report.depth} to verify."`,
  );
  lines.push("");
  lines.push(
    `When the fixes land, re-run \`vouch campaign\` with the same arguments. ` +
      `It re-executes the same depth (preserving operator notes via prediction upserts) until findings are clean, then advances.`,
  );

  return lines.join("\n");
}

function categoryHeading(c: Finding["category"]): string {
  switch (c) {
    case "playwright_failure":
      return "Playwright failures (BLOCKING)";
    case "expectation_mismatch":
      return "Expectation mismatches (BLOCKING — these are candidate SUT bugs)";
    case "visual_sketchy":
      return "Visual / UX issues (warning — vision-model judgment on screenshots)";
    case "missing_verdict":
      return "Permutations with no expectation verdict (informational)";
  }
}

// ============================================================================
// Screenshot cleanup. Permutations that produced ZERO blocking findings get
// their screenshot directory deleted to keep disk usage bounded. Findings
// permutations keep their evidence forever (until the run is deleted).
// ============================================================================

export function cleanCleanRunScreenshots(db: DBHandle, runId: string): number {
  const report = analyzeRun(db, runId);
  // Build a set of permutation ids that have at least one blocking finding.
  const flagged = new Set<string>();
  for (const f of report.findings) {
    if (f.severity === "blocking") flagged.add(f.permutation_id);
  }
  const perms = listPermutationsForRun(db, runId);
  let deletedCount = 0;
  for (const p of perms) {
    if (flagged.has(p.id)) continue;
    // Locate this permutation's screenshot dir via the execution's step_log.
    const exec = getExecution(db, p.id);
    if (!exec) continue;
    for (const step of exec.step_log) {
      if (!step.screenshot_path) continue;
      try {
        const dir = dirname(step.screenshot_path);
        rmSync(dir, { recursive: true, force: true });
        deletedCount++;
        break; // One dir per permutation; rm covers all steps.
      } catch {
        // Best-effort cleanup. Don't fail the run on disk errors.
      }
    }
  }
  return deletedCount;
}
