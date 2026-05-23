#!/usr/bin/env node
// Vouch CLI. Single entry point. Each subcommand is one logical step in the
// pipeline so you can rerun any of them in isolation if a later step fails.
//
//   vouch doctor                       — sanity-check the environment
//   vouch init <project-name>          — register a project + capture spec
//   vouch map --project P --target URL — run Surface Mapper, persist a Run row
//   vouch plan --run <id> --depth N    — generate permutations
//   vouch oracle --run <id>            — populate predictions (Haiku or heuristic)
//   vouch run-execute --run <id>       — actually replay each permutation
//   vouch run --project P --target URL — convenience: map + plan + oracle + execute
//   vouch serve [--port 7321]          — start the dashboard
//
// The `run` umbrella is the happy path; the individual commands exist so you
// can re-do a single step without redoing the others (useful when iterating
// on the spec — re-running the oracle is cheap, re-running the executor isn't).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";

import { Command } from "commander";

import {
  detectOracleSource,
  predictOne,
  predictManyClaudeCliOrFallback,
  predictManyAnthropicOrFallback,
  asPrediction,
} from "./core/oracle.js";
import { executePermutations } from "./core/executor.js";
import {
  verifyExpectation,
  verifyManyClaudeCliOrFallback,
  verifyManyAnthropicOrFallback,
} from "./core/expectation.js";
import { analyzeRun, cleanCleanRunScreenshots, renderFindingsMarkdown } from "./core/findings.js";
import { generatePermutationsWithStats } from "./core/permutations.js";
import { sequenceKey } from "./core/sequences.js";
import { mapSurface } from "./core/surface.js";
import {
  finalizeRun,
  getExecution,
  getExpectationVerdict,
  getPrediction,
  getProject,
  getProjectByName,
  getRun,
  insertActions,
  insertBlockedPrefix,
  insertPermutations,
  insertProject,
  insertRun,
  listActionsForRun,
  listActiveBlockedPrefixes,
  listActiveBlockedPrefixesAtDepth,
  listAllBlockedPrefixes,
  listPermutationsForRun,
  listRunsForProject,
  openDB,
  unblockAllPrefixes,
  unblockPrefixById,
  upsertExecution,
  upsertExpectationVerdict,
  upsertPrediction,
} from "./core/db.js";
import { startServer } from "./dashboard/server.js";
import { type PredictionSource } from "./core/types.js";

const DB_PATH = process.env.VOUCH_DB_PATH ?? resolve(process.cwd(), "vouch.db");

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parse a positive-integer env var. Returns undefined if absent or unparseable
 * (so the caller falls back to the executor's compiled defaults). We refuse
 * to silently treat a typo'd env var as zero, which would disable the cap
 * entirely and re-introduce the indefinite-hang bug the cap exists to prevent.
 */
function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(
      `[vouch] env ${name}='${raw}' is not a positive integer (ms); ignoring and using the compiled default.\n`,
    );
    return undefined;
  }
  return n;
}
function shortId(prefix: string): string {
  const t = new Date().toISOString().replace(/[:.]/g, "-");
  const r = createHash("sha256").update(`${t}-${Math.random()}`).digest("hex").slice(0, 6);
  return `${prefix}_${t.replace(/[TZ]/g, "_").replace(/-/g, "")}${r}`;
}

const program = new Command();
program.name("vouch").description("Agentic Model-Based Testing").version("0.1.0");

// ----- doctor -----
program
  .command("doctor")
  .description("Check environment: Node version, Playwright install, Anthropic key, DB writeable.")
  .action(async () => {
    const lines: string[] = [];
    const source = detectOracleSource();
    lines.push(`node:               ${process.version}`);
    lines.push(`db path:            ${DB_PATH}`);
    lines.push(`oracle source:      ${source}`);
    if (process.env.VOUCH_ORACLE) {
      lines.push(`                    (forced by VOUCH_ORACLE=${process.env.VOUCH_ORACLE})`);
    } else if (source === "claude-cli") {
      lines.push(`                    (default because the 'claude' CLI is on PATH and ANTHROPIC_API_KEY is not set; uses your Claude subscription, ~5-15s per permutation)`);
    } else if (source === "anthropic-haiku") {
      lines.push(`                    (default because ANTHROPIC_API_KEY is set; ~1-2s per permutation, billed per token, with prompt caching active so re-runs in the same 5-min window are ~90% cheaper)`);
    } else {
      lines.push(`                    (no LLM source available; install 'claude' CLI for free predictions via subscription, or set ANTHROPIC_API_KEY for API)`);
    }
    lines.push(`anthropic key:      ${process.env.ANTHROPIC_API_KEY ? "set" : "not set"}`);
    try {
      const db = openDB(DB_PATH);
      db.raw.close();
      lines.push(`db open + write:    OK`);
    } catch (err) {
      lines.push(`db open + write:    FAIL — ${(err as Error).message}`);
    }
    try {
      // Defensive: do not actually launch a browser; just confirm the module loads.
      await import("playwright");
      lines.push(`playwright module:  loaded (run 'npm run playwright:install' to download Chromium if needed)`);
    } catch (err) {
      lines.push(`playwright module:  FAIL — ${(err as Error).message}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  });

// ----- init -----
program
  .command("init <name>")
  .description("Register a project. Reads spec from --spec-file or stdin.")
  .option("--spec-file <path>", "Path to spec text (defaults to ./spec.md if present)")
  .option("--description <text>", "Optional one-line description")
  .action(async (name: string, opts: { specFile?: string; description?: string }) => {
    const db = openDB(DB_PATH);
    if (getProjectByName(db, name)) {
      throw new Error(
        `Project '${name}' already exists. Use a different name or delete the existing project row first.`,
      );
    }
    let specPath = opts.specFile ?? resolve(process.cwd(), "spec.md");
    let specText: string;
    if (existsSync(specPath)) {
      specText = readFileSync(specPath, "utf8");
    } else {
      throw new Error(
        `Spec file not found at '${specPath}'. ` +
          `Provide --spec-file <path> with a markdown file describing what the system under test is supposed to do. ` +
          `The Oracle uses this spec to predict expected behavior for each permutation.`,
      );
    }
    const project = {
      id: shortId("proj"),
      name,
      description: opts.description ?? null,
      spec_text: specText,
      created_at: nowIso(),
    };
    insertProject(db, project);
    process.stdout.write(`registered project id=${project.id} name=${project.name}\n`);
  });

interface RunOneDepthInputs {
  db: ReturnType<typeof openDB>;
  project: NonNullable<ReturnType<typeof getProjectByName>>;
  targetUrl: string;
  depth: number;
  maxSeq: number;
  oracleSource: PredictionSource;
  verify: boolean;
  verifySource: PredictionSource;
  /** Capture per-step PNG screenshots; cleaned up on clean permutations. */
  screenshots: boolean;
  /**
   * When true, look up the active blocked sequences at THIS depth for the
   * project (sequences that previously crashed or mismatched and got
   * recorded). Re-execute them BEFORE running the rest of the depth's plan.
   * If they all now pass, auto-unblock them and continue with the rest. If
   * any still fail, write the report and stop (do not run the remainder).
   *
   * Why: today, after a finding at depth N, the prefix is recorded and the
   * next campaign rerun's planner FILTERS that sequence out of the plan. The
   * user has to call `vouch unblock` manually to even retest the fix. With
   * this flag on, the retest happens automatically on every campaign rerun
   * of the same depth, and the rest of the depth is gated on those fixes
   * landing. Saves both LLM cost (skip the rest until the broken set goes
   * green) and operator overhead (no manual unblock step).
   *
   * Off for `vouch run` (single-shot, explicit user intent preserved) and
   * `vouch resume` (re-execute the same run's existing perm rows; no
   * re-planning happens there). On for `vouch campaign`.
   */
  retestPreviouslyBroken: boolean;
}

/**
 * One end-to-end Vouch run at a single depth. Used by both `vouch run` (one
 * call, one depth) and `vouch campaign` (loops over 1..max-depth). Returns
 * the run id so callers can attribute Findings + dashboard links.
 *
 * Pipeline:
 *   1. mapSurface — discover actions on the target.
 *   2. generatePermutations — depth-N sequences with rule filtering.
 *   3. If `retestPreviouslyBroken`: split perms into two phases —
 *      previously-broken-at-this-depth sequences first, the rest gated on
 *      those going green. Auto-unblock the priority set if it now passes.
 *      Otherwise: run all perms in one phase (current behavior).
 *   4. Per phase: predictOne (Oracle) → executePermutations (Playwright in a
 *      fresh context per perm) → verifyExpectation (LLM diff, if enabled).
 *   5. finalizeRun — writes finished_at on the runs row. Called exactly
 *      once, even when the priority phase short-circuits the remainder.
 */
async function runOneDepth(input: RunOneDepthInputs): Promise<string> {
  const { db, project, targetUrl, depth, maxSeq, oracleSource, verify, verifySource } = input;
  const runId = shortId("run");
  const startedAt = nowIso();
  const specSha = createHash("sha256").update(project.spec_text).digest("hex").slice(0, 16);

  insertRun(db, {
    id: runId,
    project_id: project.id,
    target_url: targetUrl,
    spec_text: project.spec_text,
    spec_sha256: specSha,
    strategy: "exhaustive",
    depth,
    started_at: startedAt,
    finished_at: null,
    prediction_source: oracleSource,
  });

  process.stdout.write(`[depth ${depth}] mapping ${targetUrl}...\n`);
  const actions = await mapSurface(targetUrl);
  insertActions(db, runId, actions);
  process.stdout.write(`[depth ${depth}] discovered ${actions.length} actions\n`);

  // ---- Retest plan ----
  // Active blocked prefixes for this project. When retestPreviouslyBroken is
  // on, we split them: the ones at THIS depth's length become the "retest
  // set" (we want the planner to re-emit them, then we execute them first).
  // The rest stay as the deeper-depth filter (e.g., a length-2 block still
  // filters length-3 perms — we are not retesting fragments here).
  const activeBlocks = listActiveBlockedPrefixes(db, project.id);
  const retestBlocks: typeof activeBlocks = input.retestPreviouslyBroken
    ? activeBlocks.filter((b) => b.prefix.length === depth)
    : [];
  const retestSequenceKeys = new Set(retestBlocks.map((b) => sequenceKey(b.prefix)));
  const filterBlocks = activeBlocks.filter((b) => !retestSequenceKeys.has(sequenceKey(b.prefix)));

  const planResult = generatePermutationsWithStats(runId, actions, {
    depth,
    maxSequences: maxSeq,
    blockedPrefixes: filterBlocks.map((b) => b.prefix),
  });
  const perms = planResult.permutations;
  insertPermutations(db, perms);
  process.stdout.write(
    `[depth ${depth}] generated ${perms.length} permutations (depth=${depth}, after rule filtering)` +
      (filterBlocks.length > 0
        ? ` and skipped ${planResult.blocked_skip_count} via ${filterBlocks.length} active blocked prefix${filterBlocks.length === 1 ? "" : "es"}`
        : ``) +
      (retestBlocks.length > 0
        ? ` (re-included ${retestBlocks.length} previously-broken sequence${retestBlocks.length === 1 ? "" : "s"} for retest)`
        : ``) +
      `\n`,
  );

  // Partition perms into "priority" (matches one of the retest sequences) and
  // "rest". Match is on action_ids equality, not perm_id, because perm_ids
  // change on every run.
  const priorityPerms = perms.filter((p) => retestSequenceKeys.has(sequenceKey(p.action_ids)));
  const restPerms = perms.filter((p) => !retestSequenceKeys.has(sequenceKey(p.action_ids)));

  const actionsById = new Map(actions.map((a) => [a.id, a]));

  // ---- Phase 1: retest the previously-broken sequences (if any). ----
  if (priorityPerms.length > 0) {
    process.stdout.write(
      `[depth ${depth}] retest phase: re-executing ${priorityPerms.length} previously-broken sequence${priorityPerms.length === 1 ? "" : "s"} before the rest of the depth.\n`,
    );
    await runMissingPhases({
      db,
      project,
      actions,
      actionsById,
      perms: priorityPerms,
      targetUrl,
      depth,
      runId,
      oracleSource,
      verify,
      verifySource,
      screenshots: input.screenshots,
      logPrefix: `[depth ${depth} retest]`,
    });

    const priorityIds = new Set(priorityPerms.map((p) => p.id));
    const priorityClean = analyzeRunForPerms(db, runId, priorityIds);
    if (priorityClean.blocking_count > 0) {
      // The fix didn't fully land. Don't burn the rest of the depth's budget;
      // surface the still-broken set and stop. The campaign loop's prompt
      // ("press Enter to re-run") brings the user back here after another
      // fix attempt.
      process.stdout.write(
        `[depth ${depth}] retest phase: ${priorityClean.blocking_count} of ${priorityPerms.length} previously-broken sequence${priorityPerms.length === 1 ? " is" : "s are"} still failing. Skipping the remaining ${restPerms.length} perm${restPerms.length === 1 ? "" : "s"} at this depth until those clear.\n`,
      );
      finalizeRun(db, runId, nowIso());
      maybeCleanupScreenshots(input.screenshots, db, runId, `[depth ${depth} retest]`);
      return runId;
    }

    // Priority set is clean. Auto-unblock the prefixes so deeper depths can
    // also re-test the now-fixed start sequences in the next campaign
    // iteration. Log each one so the operator can audit.
    for (const block of retestBlocks) {
      const ok = unblockPrefixById(db, block.id);
      if (ok) {
        process.stdout.write(
          `[depth ${depth}] retest phase: auto-unblocked #${block.id} (prefix=${JSON.stringify(block.prefix)}) because it now passes.\n`,
        );
      }
    }
    process.stdout.write(
      `[depth ${depth}] retest phase clean. Running the remaining ${restPerms.length} perm${restPerms.length === 1 ? "" : "s"}.\n`,
    );
  }

  // ---- Phase 2: the rest of the depth (or the only phase, on first run). ----
  if (restPerms.length > 0) {
    await runMissingPhases({
      db,
      project,
      actions,
      actionsById,
      perms: restPerms,
      targetUrl,
      depth,
      runId,
      oracleSource,
      verify,
      verifySource,
      screenshots: input.screenshots,
      logPrefix: `[depth ${depth}]`,
    });
  }

  finalizeRun(db, runId, nowIso());
  maybeCleanupScreenshots(input.screenshots, db, runId, `[depth ${depth}]`);
  return runId;
}


/**
 * Filtered version of analyzeRun: returns the blocking and warning counts
 * restricted to the supplied permutation ids. Used by the retest phase to
 * decide "is the priority subset clean?" without conflating it with not-yet-
 * executed remainder perms.
 */
function analyzeRunForPerms(
  db: ReturnType<typeof openDB>,
  runId: string,
  permIds: Set<string>,
): { blocking_count: number; warning_count: number } {
  const full = analyzeRun(db, runId);
  let blocking = 0;
  let warning = 0;
  for (const f of full.findings) {
    if (!permIds.has(f.permutation_id)) continue;
    if (f.severity === "blocking") blocking++;
    else if (f.severity === "warning") warning++;
  }
  return { blocking_count: blocking, warning_count: warning };
}

/**
 * Encapsulates the existing "delete screenshot dirs for clean perms" cleanup
 * so we can call it from BOTH the early-return short-circuit path (retest
 * phase still broken) and the normal-completion path, without duplicating
 * the conditional.
 */
function maybeCleanupScreenshots(
  enabled: boolean,
  db: ReturnType<typeof openDB>,
  runId: string,
  logPrefix: string,
): void {
  if (!enabled) return;
  const deleted = cleanCleanRunScreenshots(db, runId);
  process.stdout.write(`${logPrefix} screenshots: kept evidence on findings, deleted ${deleted} clean perm dirs\n`);
}

// ============================================================================
// Shared phase runner — used by `vouch run`, `vouch campaign`, and `vouch resume`.
// Each phase only runs on permutations that don't already have a corresponding
// row in the DB. This makes the entire pipeline idempotent and resumable:
//   - First execution writes everything.
//   - Re-execution on the same run is a no-op (all phases skip).
//   - Re-execution after a partial run completes only the missing work.
// ============================================================================

interface RunMissingPhasesInputs {
  db: ReturnType<typeof openDB>;
  project: NonNullable<ReturnType<typeof getProjectByName>>;
  actions: Awaited<ReturnType<typeof listActionsForRun>>;
  actionsById: Map<string, NonNullable<ReturnType<typeof listActionsForRun>>[number]>;
  perms: Awaited<ReturnType<typeof listPermutationsForRun>>;
  targetUrl: string;
  depth: number;
  runId: string;
  oracleSource: PredictionSource;
  verify: boolean;
  verifySource: PredictionSource;
  screenshots: boolean;
  logPrefix: string;
}

async function runMissingPhases(input: RunMissingPhasesInputs): Promise<void> {
  const {
    db,
    project,
    actions,
    actionsById,
    perms,
    targetUrl,
    depth,
    runId,
    oracleSource,
    verify,
    verifySource,
    logPrefix,
  } = input;
  void actions; // currently unused here; kept on the interface for future phase additions

  // ---- Oracle phase: skip perms that already have a prediction. ----
  const oraclePending = perms.filter((p) => !getPrediction(db, p.id));
  if (oraclePending.length === 0) {
    process.stdout.write(`${logPrefix} oracle: 0 missing predictions, skipping (all ${perms.length} already on disk).\n`);
  } else {
    process.stdout.write(
      `${logPrefix} running oracle (source=${oracleSource}) on ${oraclePending.length} of ${perms.length} perms` +
        (oraclePending.length < perms.length ? ` (${perms.length - oraclePending.length} already have predictions)` : "") +
        "\n",
    );
    let oracleCost = 0;
    // Both batched paths share the same shape (build inputs, slice into
    // batches, call the batched function, persist results). They only differ
    // in the call target and the human-readable "batch via..." label, so we
    // choose the function pointer once and run a single loop.
    type BatchedPredictFn = typeof predictManyClaudeCliOrFallback;
    let batchedPredict: BatchedPredictFn | null = null;
    let batchedLabel = "";
    if (oracleSource === "claude-cli") {
      batchedPredict = predictManyClaudeCliOrFallback;
      batchedLabel = "claude-cli";
    } else if (oracleSource === "anthropic-haiku") {
      // Batched + spec-prompt-cached. After the first batch in this run, the
      // spec block hits the 90%-discounted cache-read rate for the next
      // ~5 minutes.
      batchedPredict = predictManyAnthropicOrFallback;
      batchedLabel = "anthropic-haiku (cached)";
    }
    if (batchedPredict !== null) {
      const BATCH_SIZE = 30;
      const allInputs = oraclePending.map((perm) => ({
        permutation: perm,
        actionsById,
        specText: project.spec_text,
        projectName: project.name,
        projectDescription: project.description,
        targetUrl,
      }));
      for (let i = 0; i < allInputs.length; i += BATCH_SIZE) {
        const batch = allInputs.slice(i, i + BATCH_SIZE);
        const batchStart = Date.now();
        const results = await batchedPredict(batch);
        const elapsedSec = Math.round((Date.now() - batchStart) / 1000);
        for (let j = 0; j < results.length; j++) {
          const res = results[j]!;
          const perm = batch[j]!.permutation;
          oracleCost += res.cost_usd;
          const existing = getPrediction(db, perm.id);
          upsertPrediction(
            db,
            asPrediction(perm.id, res, {
              text: existing?.user_note_text ?? null,
              editedAt: existing?.user_note_edited_at ?? null,
            }),
          );
        }
        process.stdout.write(
          `${logPrefix} oracle batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allInputs.length / BATCH_SIZE)} via ${batchedLabel} done (${batch.length} perms in ${elapsedSec}s)\n`,
        );
      }
    } else {
      for (const perm of oraclePending) {
        const res = await predictOne(
          {
            permutation: perm,
            actionsById,
            specText: project.spec_text,
            projectName: project.name,
            projectDescription: project.description,
            targetUrl,
          },
          oracleSource,
        );
        oracleCost += res.cost_usd;
        const existing = getPrediction(db, perm.id);
        upsertPrediction(
          db,
          asPrediction(perm.id, res, {
            text: existing?.user_note_text ?? null,
            editedAt: existing?.user_note_edited_at ?? null,
          }),
        );
      }
    }
    process.stdout.write(`${logPrefix} oracle done (cost ~$${oracleCost.toFixed(4)})\n`);
  }

  // ---- Executor phase: skip perms that already have an execution row. ----
  const executorPending = perms.filter((p) => !getExecution(db, p.id));
  if (executorPending.length === 0) {
    process.stdout.write(`${logPrefix} executor: 0 missing executions, skipping.\n`);
  } else {
    process.stdout.write(
      `${logPrefix} executing ${executorPending.length} of ${perms.length} permutations` +
        (executorPending.length < perms.length ? ` (${perms.length - executorPending.length} already executed)` : "") +
        "\n",
    );
    const screenshotsDir = input.screenshots ? resolve(process.cwd(), "runs", runId, "screenshots") : null;
    // Honor the env vars the executor's timeout error messages advertise.
    // The executor advertises VOUCH_PERM_TIMEOUT_MS and VOUCH_LAUNCH_TIMEOUT_MS
    // in its error hints; not reading them here would render the hints dead
    // references (qa-adversary Finding 1, 2026-05-22).
    const envPermTimeout = parsePositiveIntEnv("VOUCH_PERM_TIMEOUT_MS");
    const envLaunchTimeout = parsePositiveIntEnv("VOUCH_LAUNCH_TIMEOUT_MS");
    const execs = await executePermutations(executorPending, actionsById, {
      targetUrl,
      screenshotsDir,
      ...(envPermTimeout !== undefined ? { permTimeoutMs: envPermTimeout } : {}),
      ...(envLaunchTimeout !== undefined ? { launchTimeoutMs: envLaunchTimeout } : {}),
    });
    for (const e of execs) upsertExecution(db, e);
    const counts = execs.reduce<Record<string, number>>((acc, e) => {
      acc[e.verdict] = (acc[e.verdict] ?? 0) + 1;
      return acc;
    }, {});
    process.stdout.write(`${logPrefix} executor verdicts=${JSON.stringify(counts)}\n`);
  }

  if (verify) {
    process.stdout.write(`${logPrefix} verifying expectations (source=${verifySource})...\n`);
    let verifyCost = 0;
    // Build verify jobs only for perms that have BOTH a prediction AND an
    // execution but DON'T yet have a verdict. This is the only correct
    // intersection: without a prediction there's nothing to verify against;
    // without an execution there's nothing observed to compare; and if a
    // verdict already exists, the perm is fully done.
    type VerifyJob = {
      input: import("./core/expectation.js").VerifyInputs;
    };
    const jobs: VerifyJob[] = [];
    for (const perm of perms) {
      if (getExpectationVerdict(db, perm.id)) continue;
      const prediction = getPrediction(db, perm.id);
      if (!prediction) continue;
      const execution = getExecution(db, perm.id);
      if (!execution) continue;
      jobs.push({
        input: {
          permutationId: perm.id,
          expectedPostState: prediction.expected_post_state,
          observedPostState: execution.observed_post_state,
          projectName: project.name,
          targetUrl,
        },
      });
    }
    // Pick a batched verifier when the source supports one and we have
    // enough cases for batching to pay back its overhead (single-case
    // batches just call the per-perm path under the hood).
    type BatchedVerifyFn = typeof verifyManyClaudeCliOrFallback;
    let batchedVerify: BatchedVerifyFn | null = null;
    let batchedVerifyLabel = "";
    if (verifySource === "claude-cli" && jobs.length > 1) {
      batchedVerify = verifyManyClaudeCliOrFallback;
      batchedVerifyLabel = "claude-cli";
    } else if (verifySource === "anthropic-haiku" && jobs.length > 1) {
      // Batched + rubric-prompt-cached. Less savings than the oracle's
      // spec-block cache (the rubric is smaller and sometimes below
      // Anthropic's min-cacheable threshold) but batching alone still
      // amortizes the per-call HTTP and auth overhead.
      batchedVerify = verifyManyAnthropicOrFallback;
      batchedVerifyLabel = "anthropic-haiku (cached)";
    }
    if (jobs.length === 0) {
      process.stdout.write(`${logPrefix} verify: 0 missing verdicts, skipping.\n`);
    } else if (batchedVerify !== null) {
      // Same batch sizing as the oracle (30). Output is shorter than the
      // oracle (a verdict + 1 sentence vs a paragraph), so 30 fits
      // comfortably in the model's output budget.
      const BATCH_SIZE = 30;
      for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
        const batchJobs = jobs.slice(i, i + BATCH_SIZE);
        const batchStart = Date.now();
        const verdicts = await batchedVerify(batchJobs.map((j) => j.input));
        const elapsedSec = Math.round((Date.now() - batchStart) / 1000);
        for (let j = 0; j < verdicts.length; j++) {
          const v = verdicts[j]!;
          verifyCost += v.cost_usd;
          upsertExpectationVerdict(db, v);
        }
        process.stdout.write(
          `${logPrefix} verify batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(jobs.length / BATCH_SIZE)} via ${batchedVerifyLabel} done (${batchJobs.length} perms in ${elapsedSec}s)\n`,
        );
      }
    } else {
      for (const job of jobs) {
        const v = await verifyExpectation(job.input, verifySource);
        verifyCost += v.cost_usd;
        upsertExpectationVerdict(db, v);
      }
    }
    process.stdout.write(`${logPrefix} verify done (cost ~$${verifyCost.toFixed(4)})\n`);
  }

  // finalizeRun + screenshot cleanup intentionally live in the orchestrator
  // (`runOneDepth`) and in `vouch resume`. runOneDepth can invoke this helper
  // TWICE in one run (retest phase, then remainder), so finalizing here would
  // mark the run finished after only the first phase and break the
  // partial-completion accounting in `vouch campaign`. `input.screenshots` is
  // still used above to decide screenshot capture per perm.
}

// ----- run (umbrella) -----
program
  .command("run")
  .description("Full pipeline: map + plan + oracle + execute. Writes one Run row.")
  .requiredOption("--project <name>", "Project name (use `vouch init` first)")
  .requiredOption("--target <url>", "URL of the system under test")
  .option("--depth <n>", "Permutation depth", "2")
  .option("--max-sequences <n>", "Hard cap on generated permutations", "2000")
  .option(
    "--oracle <source>",
    "Prediction source: anthropic-haiku (default if ANTHROPIC_API_KEY set), claude-cli (use local Claude subscription, slower), or heuristic (deterministic fallback)",
  )
  .option("--verify", "Also run the expectation-diff pass (LLM compares observed vs expected)")
  .option("--no-screenshots", "Skip per-step PNG capture. Default: on; clean perms get their dir deleted after analysis.")
  .action(
    async (opts: {
      project: string;
      target: string;
      depth: string;
      maxSequences: string;
      oracle?: string;
      verify?: boolean;
      screenshots: boolean;
    }) => {
      const db = openDB(DB_PATH);
      const project = getProjectByName(db, opts.project);
      if (!project) {
        throw new Error(
          `Project '${opts.project}' not found. Run 'vouch init ${opts.project} --spec-file ./spec.md' first.`,
        );
      }
      const depth = parseInt(opts.depth, 10);
      const maxSeq = parseInt(opts.maxSequences, 10);
      if (!Number.isFinite(depth) || depth < 1) {
        throw new Error(`--depth must be a positive integer, got ${opts.depth}`);
      }
      const validSources = ["anthropic-haiku", "claude-cli", "heuristic"] as const;
      type V = (typeof validSources)[number];
      let source: V;
      if (opts.oracle) {
        if (!validSources.includes(opts.oracle as V)) {
          throw new Error(`--oracle '${opts.oracle}' invalid. Valid: ${validSources.join(", ")}`);
        }
        source = opts.oracle as V;
      } else {
        source = detectOracleSource();
      }

      const runId = await runOneDepth({
        db,
        project,
        targetUrl: opts.target,
        depth,
        maxSeq,
        oracleSource: source,
        verify: !!opts.verify,
        verifySource: source,
        screenshots: opts.screenshots !== false,
        // `vouch run` is single-shot and explicit. If the user typed
        // `vouch run --depth N` with stale blocked prefixes in the DB, we
        // preserve the existing semantics: skip the blocked sequences and
        // run only the remainder. `vouch campaign` is the place that wants
        // the retest dance.
        retestPreviouslyBroken: false,
      });
      process.stdout.write(
        `[vouch/run ${runId}] view at:  vouch serve  → http://localhost:7321/#/run/${runId}\n`,
      );
    },
  );

// ----- campaign (progressive depth orchestration) -----
program
  .command("campaign")
  .description(
    "Runs depths 1..max-depth, pausing between depths so you can review Findings + fix bugs. " +
      "Each depth runs map + plan + oracle + execute + verify-expectations. If Findings exist, " +
      "saves a Claude-pasteable report and pauses (unless --no-pause).",
  )
  .requiredOption("--project <name>", "Project name (use `vouch init` first)")
  .requiredOption("--target <url>", "URL of the system under test")
  .option("--max-depth <n>", "Stop after this depth", "5")
  .option("--max-sequences <n>", "Hard cap on generated permutations per depth", "2000")
  .option(
    "--oracle <source>",
    "Prediction source: anthropic-haiku, claude-cli, or heuristic. Default: auto-detect.",
  )
  .option(
    "--verify-source <source>",
    "Expectation-verifier source (defaults to --oracle if not set)",
  )
  .option("--no-pause", "Run all depths back-to-back without prompting for input.")
  .option("--no-verify", "Skip the expectation-diff pass (saves LLM calls but no bug detection).")
  .option("--no-screenshots", "Skip per-step PNG capture.")
  .action(
    async (opts: {
      project: string;
      target: string;
      maxDepth: string;
      maxSequences: string;
      oracle?: string;
      verifySource?: string;
      pause: boolean;
      verify: boolean;
      screenshots: boolean;
    }) => {
      const maxDepth = parseInt(opts.maxDepth, 10);
      if (!Number.isFinite(maxDepth) || maxDepth < 1 || maxDepth > 8) {
        throw new Error(`--max-depth must be in [1, 8], got '${opts.maxDepth}'`);
      }
      const maxSeq = parseInt(opts.maxSequences, 10);
      const db = openDB(DB_PATH);
      const project = getProjectByName(db, opts.project);
      if (!project) {
        throw new Error(
          `Project '${opts.project}' not found. Run 'vouch init ${opts.project} --spec-file ./spec.md' first.`,
        );
      }
      const validSources = ["anthropic-haiku", "claude-cli", "heuristic"] as const;
      type V = (typeof validSources)[number];
      const oracleSource: V = (opts.oracle as V) || detectOracleSource();
      if (!validSources.includes(oracleSource)) {
        throw new Error(`--oracle '${opts.oracle}' invalid. Valid: ${validSources.join(", ")}`);
      }
      const verifySource: V = (opts.verifySource as V) || oracleSource;
      if (!validSources.includes(verifySource)) {
        throw new Error(`--verify-source '${opts.verifySource}' invalid.`);
      }

      const reportDir = resolve(process.cwd(), "runs");
      mkdirSync(reportDir, { recursive: true });

      const rl = opts.pause ? createInterface({ input, output }) : null;

      process.stdout.write(
        `=== Vouch campaign starting ===\n` +
          `  project       ${project.name}\n` +
          `  target        ${opts.target}\n` +
          `  max-depth     ${maxDepth}\n` +
          `  oracle        ${oracleSource}\n` +
          `  verify        ${opts.verify ? `${verifySource}` : "disabled"}\n` +
          `  pause         ${opts.pause}\n\n`,
      );

      // Detect unfinished runs for this project and surface them. Don't
      // auto-resume — the operator should decide explicitly, because resume
      // and fresh-start aren't always interchangeable (a fresh start may be
      // what's needed if the SUT changed since the hung run started).
      const allRunsForProject = listRunsForProject(db, project.id);
      const unfinished = allRunsForProject.filter((r) => !r.finished_at);
      if (unfinished.length > 0) {
        process.stdout.write(
          `! Notice: ${unfinished.length} unfinished run${unfinished.length === 1 ? "" : "s"} for project '${project.name}':\n`,
        );
        for (const r of unfinished.slice(0, 5)) {
          let havePred = 0,
            haveExec = 0,
            haveVerdict = 0;
          const partPerms = listPermutationsForRun(db, r.id);
          for (const p of partPerms) {
            if (getPrediction(db, p.id)) havePred++;
            if (getExecution(db, p.id)) haveExec++;
            if (getExpectationVerdict(db, p.id)) haveVerdict++;
          }
          process.stdout.write(
            `  - ${r.id}  depth=${r.depth}  perms=${partPerms.length}  predictions=${havePred}  executions=${haveExec}  verdicts=${haveVerdict}\n`,
          );
        }
        process.stdout.write(
          `\n  To resume one instead of starting fresh:  vouch resume --run <id>\n` +
            `  Continuing with a fresh campaign in 3s. Press Ctrl-C to stop.\n\n`,
        );
        await new Promise((r) => setTimeout(r, 3_000));
      }

      try {
        for (let depth = 1; depth <= maxDepth; depth++) {
          let advance = false;
          while (!advance) {
            const runId = await runOneDepth({
              db,
              project,
              targetUrl: opts.target,
              depth,
              maxSeq,
              oracleSource,
              verify: opts.verify,
              verifySource,
              screenshots: opts.screenshots !== false,
              // Broken-first scheduling: on every iteration of the campaign
              // loop, re-execute the sequences that previously crashed or
              // mismatched at THIS depth, BEFORE running the remainder.
              // Gates the remainder on those going green, auto-unblocks them
              // when they do.
              retestPreviouslyBroken: true,
            });

            const report = analyzeRun(db, runId);

            // Record blocking finding prefixes as blocked. Trust model:
            //   playwright_failure (crash) — ALWAYS blocks. A crash from a
            //   fresh-state prefix is a deterministic bug; extending it can't
            //   help and only burns LLM + Playwright budget.
            //   expectation_mismatch — blocks ONLY when the verifier source
            //   is trustworthy (claude-cli or anthropic-haiku). The heuristic
            //   source over-flags by design (token overlap, no semantics), so
            //   trusting its mismatches blocks the entire campaign after
            //   depth 1. Operators who explicitly opt in with
            //   --block-on-heuristic-mismatch override this.
            let newBlocks = 0;
            for (const f of report.findings) {
              if (f.severity !== "blocking") continue;
              if (f.category === "playwright_failure") {
                // Always trustworthy.
              } else if (f.category === "expectation_mismatch") {
                if (verifySource === "heuristic") continue;
              } else {
                continue;
              }
              const actionIds = f.action_sequence.map((a) => a.id);
              if (actionIds.length === 0) continue;
              const existed = listActiveBlockedPrefixes(db, project.id).some(
                (b) => JSON.stringify(b.prefix) === JSON.stringify(actionIds),
              );
              insertBlockedPrefix(db, {
                projectId: project.id,
                prefix: actionIds,
                reason: f.category,
                runId,
                permutationId: f.permutation_id,
              });
              if (!existed) newBlocks++;
            }

            const md = renderFindingsMarkdown(report);
            const reportPath = resolve(reportDir, `${runId}.findings.md`);
            writeFileSync(reportPath, md, "utf8");
            process.stdout.write(`\n--- Depth ${depth} done ---\n`);
            process.stdout.write(
              `  permutations: ${report.permutation_count}\n` +
                `  blocking:     ${report.blocking_count}\n` +
                `  warnings:     ${report.warning_count}\n` +
                `  new blocks:   ${newBlocks} (skipped at deeper depths until 'vouch unblock')\n` +
                `  report:       ${reportPath}\n` +
                `  dashboard:    http://localhost:7321/#/run/${runId}\n`,
            );
            if (report.blocking_count === 0) {
              process.stdout.write(`  clean. advancing to depth ${depth + 1}.\n\n`);
              advance = true;
              break;
            }
            // Findings exist. Show the report path; let the user decide.
            process.stdout.write(
              `\nFound ${report.blocking_count} blocking finding${report.blocking_count === 1 ? "" : "s"}. ` +
                `Paste the report into your Cowork chat and ask Claude to fix.\n` +
                `  cat ${reportPath} | pbcopy   # macOS: copy to clipboard\n\n`,
            );
            if (!rl) {
              process.stdout.write(
                `--no-pause: advancing despite findings. (Use 'vouch campaign' without --no-pause to retry the same depth after a fix.)\n\n`,
              );
              advance = true;
              break;
            }
            const ans = (
              await rl.question(
                `[depth ${depth}] press Enter to RE-RUN this depth (after Claude fixes), 'next' to advance anyway, 'q' to quit: `,
              )
            )
              .trim()
              .toLowerCase();
            if (ans === "q" || ans === "quit") {
              process.stdout.write(`campaign stopped at depth ${depth}.\n`);
              return;
            }
            if (ans === "next" || ans === "n") {
              advance = true;
              break;
            }
            // Anything else (or empty) -> re-run this depth.
            process.stdout.write(`\n[depth ${depth}] re-running...\n`);
          }
        }
        process.stdout.write(`\n=== Campaign complete through depth ${maxDepth} ===\n`);
      } finally {
        rl?.close();
      }
    },
  );

// ----- resume (pick up an unfinished run from where it died) -----
program
  .command("resume")
  .description(
    "Resume an unfinished run. Loads existing actions + permutations from the DB, " +
      "then runs only the phases that don't have results yet (oracle / executor / verifier). " +
      "Safe to invoke repeatedly; each phase no-ops when there's nothing left to do.",
  )
  .requiredOption("--run <id>", "Run id to resume (see `vouch serve` or inspect runs/ folder)")
  .option(
    "--oracle <source>",
    "Override the run's stored oracle source. Default: keep the source the run was started with.",
  )
  .option(
    "--verify-source <source>",
    "Verifier source for the diff pass. Default: same as the oracle source.",
  )
  .option("--no-verify", "Skip the expectation-diff pass.")
  .option("--no-screenshots", "Skip per-step PNG capture (already-captured screenshots are unaffected).")
  .action(
    async (opts: {
      run: string;
      oracle?: string;
      verifySource?: string;
      verify: boolean;
      screenshots: boolean;
    }) => {
      const db = openDB(DB_PATH);
      const run = getRun(db, opts.run);
      if (!run) {
        throw new Error(`Run '${opts.run}' not found in vouch.db. List runs with \`vouch serve\` and visit the dashboard.`);
      }
      if (run.finished_at) {
        throw new Error(
          `Run '${opts.run}' is already finalized (finished_at=${run.finished_at}). ` +
            `Resume is for runs that died mid-pipeline (finished_at IS NULL). ` +
            `To rerun this project from scratch, use \`vouch run\` or \`vouch campaign\`.`,
        );
      }
      const project = getProject(db, run.project_id);
      if (!project) {
        throw new Error(`Run '${opts.run}' references project '${run.project_id}' which no longer exists.`);
      }
      const actions = listActionsForRun(db, run.id);
      if (actions.length === 0) {
        throw new Error(
          `Run '${opts.run}' has zero actions — it died before the surface mapper completed. ` +
            `Nothing to resume. Start a fresh run instead: vouch run --project ${project.name} --target ${run.target_url} --depth ${run.depth}.`,
        );
      }
      const perms = listPermutationsForRun(db, run.id);
      if (perms.length === 0) {
        throw new Error(
          `Run '${opts.run}' has zero permutations — it died before the planner completed. ` +
            `Nothing to resume. Start a fresh run instead: vouch run --project ${project.name} --target ${run.target_url} --depth ${run.depth}.`,
        );
      }
      const validSources = ["anthropic-haiku", "claude-cli", "heuristic"] as const;
      type V = (typeof validSources)[number];
      const oracleSource: V = (opts.oracle as V) || (run.prediction_source as V);
      if (!validSources.includes(oracleSource)) {
        throw new Error(`Invalid oracle source '${oracleSource}'. Valid: ${validSources.join(", ")}`);
      }
      const verifySource: V = (opts.verifySource as V) || oracleSource;
      if (!validSources.includes(verifySource)) {
        throw new Error(`Invalid verify source '${verifySource}'. Valid: ${validSources.join(", ")}`);
      }

      // Report what's already done so the operator sees the resume is taking
      // advantage of the partial state, not silently restarting.
      let havePred = 0,
        haveExec = 0,
        haveVerdict = 0;
      for (const p of perms) {
        if (getPrediction(db, p.id)) havePred++;
        if (getExecution(db, p.id)) haveExec++;
        if (getExpectationVerdict(db, p.id)) haveVerdict++;
      }
      process.stdout.write(
        `=== Resuming run ${run.id} ===\n` +
          `  project        ${project.name}\n` +
          `  target         ${run.target_url}\n` +
          `  depth          ${run.depth}\n` +
          `  oracle         ${oracleSource}\n` +
          `  verify         ${opts.verify ? verifySource : "disabled"}\n\n` +
          `  Already on disk for this run:\n` +
          `    actions       ${actions.length}\n` +
          `    permutations  ${perms.length}\n` +
          `    predictions   ${havePred} / ${perms.length}\n` +
          `    executions    ${haveExec} / ${perms.length}\n` +
          `    verdicts      ${haveVerdict} / ${perms.length}\n\n`,
      );

      const actionsById = new Map(actions.map((a) => [a.id, a]));
      await runMissingPhases({
        db,
        project,
        actions,
        actionsById,
        perms,
        targetUrl: run.target_url,
        depth: run.depth,
        runId: run.id,
        oracleSource,
        verify: opts.verify !== false,
        verifySource,
        screenshots: opts.screenshots !== false,
        logPrefix: `[resume ${run.id.split("_").pop()}]`,
      });
      // runMissingPhases used to finalize + cleanup itself; that responsibility
      // moved to the orchestrator when broken-first scheduling landed (so
      // runOneDepth can call runMissingPhases twice without finalizing twice).
      // Resume now owns these two calls explicitly.
      finalizeRun(db, run.id, nowIso());
      maybeCleanupScreenshots(opts.screenshots !== false, db, run.id, `[resume ${run.id.split("_").pop()}]`);
      process.stdout.write(`\n=== Resume complete ===\n  view at: http://localhost:7321/#/run/${run.id}\n`);
    },
  );

// ----- blocks (list active blocked prefixes for a project) -----
program
  .command("blocks")
  .description("List active blocked prefixes for a project. These are sequences that produced findings and are skipped at deeper depths until unblocked.")
  .requiredOption("--project <name>", "Project name")
  .option("--all", "Include already-unblocked entries (history)")
  .action(async (opts: { project: string; all?: boolean }) => {
    const db = openDB(DB_PATH);
    const project = getProjectByName(db, opts.project);
    if (!project) throw new Error(`Project '${opts.project}' not found.`);
    const rows = opts.all ? listAllBlockedPrefixes(db, project.id) : listActiveBlockedPrefixes(db, project.id);
    if (rows.length === 0) {
      process.stdout.write(`(no ${opts.all ? "" : "active "}blocked prefixes for ${project.name})\n`);
      return;
    }
    for (const b of rows) {
      const status = b.unblocked_at ? `[unblocked ${b.unblocked_at}]` : `[active]`;
      const short = b.blocked_by_permutation_id?.split("__").pop() ?? "?";
      process.stdout.write(
        `  ${status.padEnd(35)} #${b.id}  ${b.reason.padEnd(22)}  ${short}  prefix=${JSON.stringify(b.prefix)}\n`,
      );
    }
  });

// ----- unblock (clear blocked prefixes once fixes land) -----
program
  .command("unblock")
  .description("Mark blocked prefix(es) as unblocked. Use after fixing the SUT bug they discovered.")
  .requiredOption("--project <name>", "Project name")
  .option("--id <n>", "Unblock a specific block id (see 'vouch blocks')")
  .option("--all", "Unblock ALL active prefixes for the project")
  .action(async (opts: { project: string; id?: string; all?: boolean }) => {
    if (!opts.id && !opts.all) {
      throw new Error(`unblock: pass --id <n> for a specific block, or --all to clear them all.`);
    }
    const db = openDB(DB_PATH);
    const project = getProjectByName(db, opts.project);
    if (!project) throw new Error(`Project '${opts.project}' not found.`);
    if (opts.id) {
      const ok = unblockPrefixById(db, parseInt(opts.id, 10));
      process.stdout.write(ok ? `unblocked #${opts.id}\n` : `#${opts.id} was not active (already unblocked or unknown).\n`);
      return;
    }
    const n = unblockAllPrefixes(db, project.id);
    process.stdout.write(`unblocked ${n} prefix${n === 1 ? "" : "es"} for ${project.name}\n`);
  });

// ----- serve -----
program
  .command("serve")
  .description("Start the dashboard server.")
  .option("--port <n>", "Port to bind", "7321")
  .action(async (opts: { port: string }) => {
    const port = parseInt(opts.port, 10);
    await startServer(DB_PATH, port);
  });

// ----- map (advanced; for re-doing one step) -----
program
  .command("map")
  .description("Run the Surface Mapper standalone and print the action list as JSON.")
  .requiredOption("--target <url>", "URL of the system under test")
  .action(async (opts: { target: string }) => {
    const actions = await mapSurface(opts.target);
    process.stdout.write(JSON.stringify(actions, null, 2) + "\n");
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`vouch: ${err.message}\n`);
  process.exit(1);
});
