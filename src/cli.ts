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
  asPrediction,
} from "./core/oracle.js";
import { executePermutations } from "./core/executor.js";
import { verifyExpectation, verifyManyClaudeCliOrFallback } from "./core/expectation.js";
import { analyzeRun, cleanCleanRunScreenshots, renderFindingsMarkdown } from "./core/findings.js";
import { generatePermutationsWithStats } from "./core/permutations.js";
import { mapSurface } from "./core/surface.js";
import {
  finalizeRun,
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
  listAllBlockedPrefixes,
  listPermutationsForRun,
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
      lines.push(`                    (default because the 'claude' CLI is on PATH; uses your Claude subscription, ~5-15s per permutation)`);
    } else if (source === "anthropic-haiku") {
      lines.push(`                    (default because ANTHROPIC_API_KEY is set and 'claude' CLI is not on PATH; ~1-2s per permutation, billed per token)`);
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
}

/**
 * One end-to-end Vouch run at a single depth. Used by both `vouch run` (one
 * call, one depth) and `vouch campaign` (loops over 1..max-depth). Returns
 * the run id so callers can attribute Findings + dashboard links.
 *
 * Pipeline:
 *   1. mapSurface — discover actions on the target.
 *   2. generatePermutations — depth-N sequences with rule filtering.
 *   3. predictOne per permutation — Oracle writes expected_post_state.
 *   4. executePermutations — Playwright replays each in a fresh context.
 *   5. verifyExpectation per permutation (if verify=true) — LLM diff.
 *   6. finalizeRun — writes finished_at on the runs row.
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

  const activeBlocks = listActiveBlockedPrefixes(db, project.id);
  const blockedPrefixes = activeBlocks.map((b) => b.prefix);
  const planResult = generatePermutationsWithStats(runId, actions, {
    depth,
    maxSequences: maxSeq,
    blockedPrefixes,
  });
  const perms = planResult.permutations;
  insertPermutations(db, perms);
  process.stdout.write(
    `[depth ${depth}] generated ${perms.length} permutations (depth=${depth}, after rule filtering)` +
      (activeBlocks.length > 0
        ? ` and skipped ${planResult.blocked_skip_count} via ${activeBlocks.length} active blocked prefix${activeBlocks.length === 1 ? "" : "es"}`
        : ``) +
      `\n`,
  );

  process.stdout.write(`[depth ${depth}] running oracle (source=${oracleSource})...\n`);
  const actionsById = new Map(actions.map((a) => [a.id, a]));
  let oracleCost = 0;
  // For the claude-cli source the per-call subprocess spawn dominates the
  // wallclock (~3-5s out of ~10s per perm), so batching N perms into one
  // call gives ~Nx speedup on the oracle phase. anthropic-haiku already
  // pays only ~1s per HTTP round-trip and has no batch endpoint at this
  // size, so we keep the per-perm loop for it. heuristic is in-process
  // and instant — no point batching either.
  if (oracleSource === "claude-cli") {
    const BATCH_SIZE = 30;
    const allInputs = perms.map((perm) => ({
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
      const results = await predictManyClaudeCliOrFallback(batch);
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
        `[depth ${depth}] oracle batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allInputs.length / BATCH_SIZE)} done (${batch.length} perms in ${elapsedSec}s)\n`,
      );
    }
  } else {
    for (const perm of perms) {
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
  process.stdout.write(`[depth ${depth}] oracle done (cost ~$${oracleCost.toFixed(4)})\n`);

  process.stdout.write(`[depth ${depth}] executing permutations...\n`);
  const screenshotsDir = input.screenshots ? resolve(process.cwd(), "runs", runId, "screenshots") : null;
  const execs = await executePermutations(perms, actionsById, {
    targetUrl,
    screenshotsDir,
  });
  for (const e of execs) upsertExecution(db, e);
  const counts = execs.reduce<Record<string, number>>((acc, e) => {
    acc[e.verdict] = (acc[e.verdict] ?? 0) + 1;
    return acc;
  }, {});
  process.stdout.write(`[depth ${depth}] executor verdicts=${JSON.stringify(counts)}\n`);

  if (verify) {
    process.stdout.write(`[depth ${depth}] verifying expectations (source=${verifySource})...\n`);
    let verifyCost = 0;
    // Build the verify inputs once so the batched + per-perm paths share the
    // same construction. Skip executions whose perm has no prediction (the
    // oracle phase may have failed for that perm); without a prediction the
    // verifier has nothing to compare against.
    type VerifyJob = {
      input: import("./core/expectation.js").VerifyInputs;
      execution: typeof execs[number];
    };
    const jobs: VerifyJob[] = [];
    for (const e of execs) {
      const prediction = getPrediction(db, e.permutation_id);
      if (!prediction) continue;
      jobs.push({
        input: {
          permutationId: e.permutation_id,
          expectedPostState: prediction.expected_post_state,
          observedPostState: e.observed_post_state,
          projectName: project.name,
          targetUrl,
        },
        execution: e,
      });
    }
    if (verifySource === "claude-cli" && jobs.length > 1) {
      // Same batch sizing as the oracle (30). Same rationale: spec-text is
      // constant across perms in a batch and dominates input size; output
      // is shorter than the oracle (a verdict + 1 sentence vs a paragraph),
      // so 30 fits comfortably in the model's output budget.
      const BATCH_SIZE = 30;
      for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
        const batchJobs = jobs.slice(i, i + BATCH_SIZE);
        const batchStart = Date.now();
        const verdicts = await verifyManyClaudeCliOrFallback(batchJobs.map((j) => j.input));
        const elapsedSec = Math.round((Date.now() - batchStart) / 1000);
        for (let j = 0; j < verdicts.length; j++) {
          const v = verdicts[j]!;
          verifyCost += v.cost_usd;
          upsertExpectationVerdict(db, v);
        }
        process.stdout.write(
          `[depth ${depth}] verify batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(jobs.length / BATCH_SIZE)} done (${batchJobs.length} perms in ${elapsedSec}s)\n`,
        );
      }
    } else {
      for (const job of jobs) {
        const v = await verifyExpectation(job.input, verifySource);
        verifyCost += v.cost_usd;
        upsertExpectationVerdict(db, v);
      }
    }
    process.stdout.write(`[depth ${depth}] verify done (cost ~$${verifyCost.toFixed(4)})\n`);
  }
  finalizeRun(db, runId, nowIso());

  // Screenshot cleanup: delete dirs for permutations that produced zero
  // blocking findings. Keeps disk usage bounded; preserves evidence for the
  // ones that matter.
  if (input.screenshots) {
    const deleted = cleanCleanRunScreenshots(db, runId);
    process.stdout.write(`[depth ${depth}] screenshots: kept evidence on findings, deleted ${deleted} clean perm dirs\n`);
  }
  return runId;
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
