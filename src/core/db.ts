// SQLite persistence. Tables match `types.ts` shapes; JSON-encoded columns
// are explicitly parsed via zod on read so a corrupted row surfaces with a
// useful error instead of a silent undefined.
//
// Schema is idempotent — running `applyMigrations` against an existing DB is
// a no-op. There are no destructive migrations yet; future schema changes
// will be additive (ALTER TABLE … ADD COLUMN) so historical runs stay
// readable.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  type Action,
  ActionSchema,
  type Execution,
  ExecutionSchema,
  type Permutation,
  PermutationSchema,
  type Prediction,
  PredictionSchema,
  type Project,
  ProjectSchema,
  type Run,
  RunSchema,
} from "./types.js";

export interface DBHandle {
  raw: Database.Database;
}

/**
 * Open or create the database at the given path. Parent directories are
 * created if missing so `init` from a fresh checkout works without a manual
 * `mkdir -p`.
 */
export function openDB(path: string): DBHandle {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  applyMigrations(raw);
  return { raw };
}

function applyMigrations(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      spec_text   TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      target_url        TEXT NOT NULL,
      spec_text         TEXT NOT NULL,
      spec_sha256       TEXT NOT NULL,
      strategy          TEXT NOT NULL,
      depth             INTEGER NOT NULL,
      started_at        TEXT NOT NULL,
      finished_at       TEXT,
      prediction_source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS actions (
      id           TEXT NOT NULL,
      run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL,
      selector     TEXT,
      description  TEXT NOT NULL,
      type_value   TEXT,
      rules_json   TEXT NOT NULL DEFAULT '[]',
      meta_json    TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (run_id, id)
    );

    CREATE TABLE IF NOT EXISTS permutations (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      action_ids  TEXT NOT NULL,
      idx         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_perms_run ON permutations(run_id, idx);

    CREATE TABLE IF NOT EXISTS predictions (
      permutation_id        TEXT PRIMARY KEY REFERENCES permutations(id) ON DELETE CASCADE,
      source                TEXT NOT NULL,
      expected_post_state   TEXT NOT NULL,
      confidence            REAL NOT NULL,
      cost_usd              REAL NOT NULL DEFAULT 0,
      generated_at          TEXT NOT NULL,
      user_note_text        TEXT,
      user_note_edited_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS executions (
      permutation_id      TEXT PRIMARY KEY REFERENCES permutations(id) ON DELETE CASCADE,
      verdict             TEXT NOT NULL,
      step_log_json       TEXT NOT NULL,
      observed_post_state TEXT NOT NULL,
      started_at          TEXT NOT NULL,
      finished_at         TEXT NOT NULL,
      error_class         TEXT
    );

    -- Expectation verdicts. One row per permutation that has been verified.
    -- Populated by the verify-expectations pass (off by default; opt in with
    -- --verify on \`vouch run\` or always-on inside \`vouch campaign\`).
    CREATE TABLE IF NOT EXISTS expectation_verdicts (
      permutation_id  TEXT PRIMARY KEY REFERENCES permutations(id) ON DELETE CASCADE,
      match           INTEGER NOT NULL,  -- 1 = match, 0 = mismatch
      reasoning       TEXT NOT NULL,
      source          TEXT NOT NULL,
      cost_usd        REAL NOT NULL DEFAULT 0,
      generated_at    TEXT NOT NULL
    );
  `);
}

// ============================================================================
// Projects
// ============================================================================

export function insertProject(db: DBHandle, p: Project): void {
  db.raw
    .prepare(
      `INSERT INTO projects (id, name, description, spec_text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(p.id, p.name, p.description, p.spec_text, p.created_at);
}

export function getProject(db: DBHandle, id: string): Project | null {
  const row = db.raw.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? ProjectSchema.parse(row) : null;
}

export function getProjectByName(db: DBHandle, name: string): Project | null {
  const row = db.raw.prepare(`SELECT * FROM projects WHERE name = ?`).get(name) as
    | Record<string, unknown>
    | undefined;
  return row ? ProjectSchema.parse(row) : null;
}

export function listProjects(db: DBHandle): Project[] {
  const rows = db.raw.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ProjectSchema.parse(r));
}

// ============================================================================
// Runs
// ============================================================================

export function insertRun(db: DBHandle, r: Run): void {
  db.raw
    .prepare(
      `INSERT INTO runs (id, project_id, target_url, spec_text, spec_sha256, strategy, depth, started_at, finished_at, prediction_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id,
      r.project_id,
      r.target_url,
      r.spec_text,
      r.spec_sha256,
      r.strategy,
      r.depth,
      r.started_at,
      r.finished_at,
      r.prediction_source,
    );
}

export function finalizeRun(db: DBHandle, id: string, finishedAt: string): void {
  db.raw.prepare(`UPDATE runs SET finished_at = ? WHERE id = ?`).run(finishedAt, id);
}

export function getRun(db: DBHandle, id: string): Run | null {
  const row = db.raw.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? RunSchema.parse(row) : null;
}

export function listRunsForProject(db: DBHandle, projectId: string): Run[] {
  const rows = db.raw
    .prepare(`SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC`)
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((r) => RunSchema.parse(r));
}

// ============================================================================
// Actions
// ============================================================================

export function insertActions(db: DBHandle, runId: string, actions: Action[]): void {
  const stmt = db.raw.prepare(
    `INSERT INTO actions (id, run_id, kind, selector, description, type_value, rules_json, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.raw.transaction((rows: Action[]) => {
    for (const a of rows) {
      stmt.run(
        a.id,
        runId,
        a.kind,
        a.selector,
        a.description,
        a.type_value,
        JSON.stringify(a.rules),
        JSON.stringify(a.meta),
      );
    }
  });
  tx(actions);
}

export function listActionsForRun(db: DBHandle, runId: string): Action[] {
  const rows = db.raw.prepare(`SELECT * FROM actions WHERE run_id = ?`).all(runId) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) =>
    ActionSchema.parse({
      ...r,
      rules: JSON.parse(String(r.rules_json ?? "[]")),
      meta: JSON.parse(String(r.meta_json ?? "{}")),
    }),
  );
}

// ============================================================================
// Permutations
// ============================================================================

export function insertPermutations(db: DBHandle, perms: Permutation[]): void {
  const stmt = db.raw.prepare(
    `INSERT INTO permutations (id, run_id, action_ids, idx) VALUES (?, ?, ?, ?)`,
  );
  const tx = db.raw.transaction((rows: Permutation[]) => {
    for (const p of rows) {
      stmt.run(p.id, p.run_id, JSON.stringify(p.action_ids), p.index);
    }
  });
  tx(perms);
}

export function listPermutationsForRun(db: DBHandle, runId: string): Permutation[] {
  const rows = db.raw
    .prepare(`SELECT * FROM permutations WHERE run_id = ? ORDER BY idx ASC`)
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((r) =>
    PermutationSchema.parse({
      id: r.id,
      run_id: r.run_id,
      action_ids: JSON.parse(String(r.action_ids ?? "[]")),
      index: r.idx,
    }),
  );
}

// ============================================================================
// Predictions
// ============================================================================

export function upsertPrediction(db: DBHandle, p: Prediction): void {
  db.raw
    .prepare(
      `INSERT INTO predictions (permutation_id, source, expected_post_state, confidence, cost_usd, generated_at, user_note_text, user_note_edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(permutation_id) DO UPDATE SET
         source              = excluded.source,
         expected_post_state = excluded.expected_post_state,
         confidence          = excluded.confidence,
         cost_usd            = excluded.cost_usd,
         generated_at        = excluded.generated_at`,
    )
    .run(
      p.permutation_id,
      p.source,
      p.expected_post_state,
      p.confidence,
      p.cost_usd,
      p.generated_at,
      p.user_note_text,
      p.user_note_edited_at,
    );
}

export function getPrediction(db: DBHandle, permutationId: string): Prediction | null {
  const row = db.raw
    .prepare(`SELECT * FROM predictions WHERE permutation_id = ?`)
    .get(permutationId) as Record<string, unknown> | undefined;
  return row ? PredictionSchema.parse(row) : null;
}

/**
 * Persist a user-edited note. Idempotent: same text + same row is a no-op.
 * `edited_at` is always rewritten so the dashboard can show "edited X minutes
 * ago" without ambiguity.
 */
export function updatePredictionNote(
  db: DBHandle,
  permutationId: string,
  noteText: string,
  editedAt: string,
): void {
  const result = db.raw
    .prepare(
      `UPDATE predictions
         SET user_note_text = ?, user_note_edited_at = ?
         WHERE permutation_id = ?`,
    )
    .run(noteText, editedAt, permutationId);
  if (result.changes === 0) {
    throw new Error(
      `updatePredictionNote: no prediction row for permutation_id='${permutationId}'. ` +
        `Predictions are created by the oracle pass; if you see this error, the run completed surface mapping ` +
        `and permutation generation but the oracle pass did not run or failed for this permutation. ` +
        `Re-run with 'vouch run --resume <run_id>' once that's implemented, or inspect 'predictions' table directly.`,
    );
  }
}

// ============================================================================
// Executions
// ============================================================================

export function upsertExecution(db: DBHandle, e: Execution): void {
  db.raw
    .prepare(
      `INSERT INTO executions (permutation_id, verdict, step_log_json, observed_post_state, started_at, finished_at, error_class)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(permutation_id) DO UPDATE SET
         verdict             = excluded.verdict,
         step_log_json       = excluded.step_log_json,
         observed_post_state = excluded.observed_post_state,
         started_at          = excluded.started_at,
         finished_at         = excluded.finished_at,
         error_class         = excluded.error_class`,
    )
    .run(
      e.permutation_id,
      e.verdict,
      JSON.stringify(e.step_log),
      e.observed_post_state,
      e.started_at,
      e.finished_at,
      e.error_class,
    );
}

// ============================================================================
// Expectation Verdicts
// ============================================================================

import { type ExpectationVerdict } from "./expectation.js";

export function upsertExpectationVerdict(db: DBHandle, v: ExpectationVerdict): void {
  db.raw
    .prepare(
      `INSERT INTO expectation_verdicts (permutation_id, match, reasoning, source, cost_usd, generated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(permutation_id) DO UPDATE SET
         match        = excluded.match,
         reasoning    = excluded.reasoning,
         source       = excluded.source,
         cost_usd     = excluded.cost_usd,
         generated_at = excluded.generated_at`,
    )
    .run(v.permutation_id, v.match ? 1 : 0, v.reasoning, v.source, v.cost_usd, v.generated_at);
}

export function getExpectationVerdict(db: DBHandle, permutationId: string): ExpectationVerdict | null {
  const row = db.raw
    .prepare(`SELECT * FROM expectation_verdicts WHERE permutation_id = ?`)
    .get(permutationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    permutation_id: String(row.permutation_id),
    match: Number(row.match) === 1,
    reasoning: String(row.reasoning),
    source: String(row.source) as ExpectationVerdict["source"],
    cost_usd: Number(row.cost_usd),
    generated_at: String(row.generated_at),
  };
}

export function listExpectationVerdictsForRun(
  db: DBHandle,
  runId: string,
): ExpectationVerdict[] {
  const rows = db.raw
    .prepare(
      `SELECT ev.* FROM expectation_verdicts ev
       INNER JOIN permutations p ON p.id = ev.permutation_id
       WHERE p.run_id = ?`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    permutation_id: String(row.permutation_id),
    match: Number(row.match) === 1,
    reasoning: String(row.reasoning),
    source: String(row.source) as ExpectationVerdict["source"],
    cost_usd: Number(row.cost_usd),
    generated_at: String(row.generated_at),
  }));
}

export function getExecution(db: DBHandle, permutationId: string): Execution | null {
  const row = db.raw
    .prepare(`SELECT * FROM executions WHERE permutation_id = ?`)
    .get(permutationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return ExecutionSchema.parse({
    ...row,
    step_log: JSON.parse(String(row.step_log_json ?? "[]")),
  });
}
