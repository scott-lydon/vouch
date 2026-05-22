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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Command } from "commander";

import { detectOracleSource, predictOne, asPrediction } from "./core/oracle.js";
import { executePermutations } from "./core/executor.js";
import { generatePermutations } from "./core/permutations.js";
import { mapSurface } from "./core/surface.js";
import {
  finalizeRun,
  getPrediction,
  getProject,
  getProjectByName,
  getRun,
  insertActions,
  insertPermutations,
  insertProject,
  insertRun,
  listActionsForRun,
  listPermutationsForRun,
  openDB,
  upsertExecution,
  upsertPrediction,
} from "./core/db.js";
import { startServer } from "./dashboard/server.js";

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
  .action(async (opts: { project: string; target: string; depth: string; maxSequences: string; oracle?: string }) => {
    const db = openDB(DB_PATH);
    const project = getProjectByName(db, opts.project);
    if (!project) {
      throw new Error(
        `Project '${opts.project}' not found. Run 'vouch init ${opts.project} --spec-file ./spec.md' first.`,
      );
    }
    const depth = parseInt(opts.depth, 10);
    const maxSeq = parseInt(opts.maxSequences, 10);
    if (!Number.isFinite(depth) || depth < 1) throw new Error(`--depth must be a positive integer, got ${opts.depth}`);

    const runId = shortId("run");
    const startedAt = nowIso();
    const specSha = createHash("sha256").update(project.spec_text).digest("hex").slice(0, 16);
    const validSources = ["anthropic-haiku", "claude-cli", "heuristic"] as const;
    type ValidSource = (typeof validSources)[number];
    let source: ValidSource;
    if (opts.oracle) {
      if (!validSources.includes(opts.oracle as ValidSource)) {
        throw new Error(
          `--oracle '${opts.oracle}' is not recognized. Valid: ${validSources.join(", ")}`,
        );
      }
      source = opts.oracle as ValidSource;
    } else {
      source = detectOracleSource();
    }

    insertRun(db, {
      id: runId,
      project_id: project.id,
      target_url: opts.target,
      spec_text: project.spec_text,
      spec_sha256: specSha,
      strategy: "exhaustive",
      depth,
      started_at: startedAt,
      finished_at: null,
      prediction_source: source,
    });

    process.stdout.write(`[vouch/run ${runId}] mapping ${opts.target}…\n`);
    const actions = await mapSurface(opts.target);
    insertActions(db, runId, actions);
    process.stdout.write(`[vouch/run ${runId}] discovered ${actions.length} actions\n`);

    const perms = generatePermutations(runId, actions, { depth, maxSequences: maxSeq });
    insertPermutations(db, perms);
    process.stdout.write(`[vouch/run ${runId}] generated ${perms.length} permutations (depth=${depth})\n`);

    process.stdout.write(`[vouch/run ${runId}] running oracle (source=${source})…\n`);
    const actionsById = new Map(actions.map((a) => [a.id, a]));
    let totalCost = 0;
    for (const perm of perms) {
      const res = await predictOne({ permutation: perm, actionsById, specText: project.spec_text }, source);
      totalCost += res.cost_usd;
      const existing = getPrediction(db, perm.id);
      upsertPrediction(
        db,
        asPrediction(perm.id, res, {
          text: existing?.user_note_text ?? null,
          editedAt: existing?.user_note_edited_at ?? null,
        }),
      );
    }
    process.stdout.write(`[vouch/run ${runId}] predictions written (oracle cost ~$${totalCost.toFixed(4)})\n`);

    process.stdout.write(`[vouch/run ${runId}] executing permutations…\n`);
    const execs = await executePermutations(perms, actionsById, { targetUrl: opts.target });
    for (const e of execs) upsertExecution(db, e);
    finalizeRun(db, runId, nowIso());
    const counts = execs.reduce<Record<string, number>>((acc, e) => {
      acc[e.verdict] = (acc[e.verdict] ?? 0) + 1;
      return acc;
    }, {});
    process.stdout.write(
      `[vouch/run ${runId}] finished. verdicts=${JSON.stringify(counts)}\n` +
        `[vouch/run ${runId}] view at:  vouch serve  → http://localhost:7321/run/${runId}\n`,
    );
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
