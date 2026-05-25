// Vouch dashboard server.
//
// Single Express process. Serves:
//   - JSON API at /api/* for the client-side renderer
//   - Static HTML/JS/CSS from ./ui at /
//
// The dashboard is intentionally read-mostly. The only write endpoint is
// POST /api/predictions/:permutationId/note, which persists the operator's
// edited "expected behavior" note. That endpoint is idempotent and never
// overwrites the model's prediction itself (those are upserted only by the
// oracle pass).

import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import {
  getExecution,
  getExpectationVerdict,
  getPrediction,
  getProject,
  getRun,
  listActionsForRun,
  listPermutationsForRun,
  listProjects,
  listRunsForProject,
  openDB,
  updatePredictionNote,
} from "../core/db.js";
import { analyzeRun, renderFindingsMarkdown } from "../core/findings.js";
import { REDACTED_TYPE_VALUE } from "../core/inputs.js";
import { summarizeRun, type RunSummary } from "../core/run-summary.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, "ui");

/**
 * Absolute root of the runs/ directory the executor writes screenshots into.
 * Resolved at server start so the static handler can scope itself to this
 * subtree only — we deliberately do NOT mount the entire runs/ root, because
 * it also holds `*.findings.md` reports and other non-image artifacts that
 * have no business being world-readable through the dashboard.
 *
 * Resolution mirrors the same `resolve(process.cwd(), "runs", runId, ...)`
 * pattern the CLI uses for `--screenshots`, so a server started from the
 * vouch project root finds the same paths the executor wrote to.
 */
const RUNS_ROOT = resolve(process.cwd(), "runs");

/**
 * Translate an executor-written absolute screenshot path into the URL the
 * dashboard's static route exposes. Returns null when the path is missing,
 * outside the runs root (defense against a stale row pointing somewhere
 * unexpected), or the file no longer exists on disk (a clean-perm prune
 * already removed it).
 *
 * Why the existsSync check: the findings cleanup pass deletes per-perm
 * screenshot dirs for clean perms, but the step_log rows in vouch.db still
 * reference the now-gone paths. Returning a non-null URL there would render
 * a broken-image icon in the dashboard; null lets the UI skip the thumbnail
 * cleanly.
 */
function screenshotUrlForAbsPath(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const resolved = resolve(absPath);
  const rel = relative(RUNS_ROOT, resolved);
  // relative() returns a path that starts with ".." or is absolute when the
  // target is outside the base. Reject both — that's the path-traversal
  // defense for the static route.
  if (rel.startsWith("..") || rel.startsWith("/")) return null;
  if (!existsSync(resolved)) return null;
  return `/runs/${rel.split("\\").join("/")}`;
}

export async function startServer(dbPath: string, port: number): Promise<void> {
  const db = openDB(dbPath);
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(UI_DIR));

  // Scoped static route for screenshots. Two layers of defense:
  //
  //   1. Extension allowlist middleware that runs BEFORE express.static so
  //      requests for non-image paths under runs/ get a hard 403. Without
  //      this a request like /runs/<id>.findings.md would slip through and
  //      expose the markdown reports to anyone with the URL.
  //   2. express.static itself rejects `..` traversal that would escape the
  //      mounted root (RUNS_ROOT), so a malformed URL cannot reach vouch.db
  //      or source files outside runs/.
  //
  // `fallthrough: false` on static() makes missing files 404 instead of
  // continuing to the SPA fallback (which would serve index.html under an
  // image content-type and quietly fail in the browser).
  app.use("/runs", (req, res, next) => {
    // decodeURIComponent is mandatory: Express leaves percent-escapes in
    // req.path, so a request for /runs/foo%2Epng (encoded `.`) would slip
    // past a naive endsWith(".png") check on the raw string and then get
    // happily served by express.static (which DOES decode). The reverse —
    // a request for /runs/leak%2Emd (encoded `.md`) — would be allowed by
    // the naive check and then served as text. Decode at the boundary so
    // the allowlist sees the SAME path express.static will resolve.
    // Malformed escapes (lone `%`, `%G0`) throw URIError; reject with 400
    // because that's the request's fault, not the server's (QA W3, 2026-05-24).
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch {
      res.status(400).type("text/plain").send("Bad request: malformed percent-escape in path.");
      return;
    }
    const lower = decodedPath.toLowerCase();
    if (
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      lower.endsWith(".png")
    ) {
      next();
      return;
    }
    res.status(403).type("text/plain").send("Forbidden: only screenshot files are served from /runs.");
  });
  app.use("/runs", express.static(RUNS_ROOT, { fallthrough: false }));

  // ---- read endpoints ----

  app.get("/api/projects", (_req, res) => {
    const projects = listProjects(db);
    res.json({ projects });
  });

  app.get("/api/projects/:projectId/runs", (req, res) => {
    const project = getProject(db, req.params.projectId);
    if (!project) {
      res.status(404).json({ error: `project '${req.params.projectId}' not found` });
      return;
    }
    const runs = listRunsForProject(db, project.id);
    // Enrich each run with the per-tier breakdown used by the project tile.
    // Three queries per run (perms + per-perm execution + per-perm
    // expectation) at low cardinalities, so we compute on every request
    // instead of caching — keeps the UI honest: the moment a row in the
    // executions or expectation_verdicts table changes, the next page load
    // reflects it.
    const enriched: Array<Record<string, unknown>> = runs.map((r) => {
      const summary: RunSummary = summarizeRun(db, r.id);
      return { ...r, summary };
    });
    res.json({ project, runs: enriched });
  });

  app.get("/api/runs/:runId", (req, res) => {
    const run = getRun(db, req.params.runId);
    if (!run) {
      res.status(404).json({ error: `run '${req.params.runId}' not found` });
      return;
    }
    const project = getProject(db, run.project_id);
    const actions = listActionsForRun(db, run.id);
    const perms = listPermutationsForRun(db, run.id);
    const enriched = perms.map((p) => {
      const prediction = getPrediction(db, p.id);
      const execution = getExecution(db, p.id);
      const expectation = getExpectationVerdict(db, p.id);
      // Pre-compute per-step screenshot URLs and the final-state URL so the
      // dashboard UI does not have to know about the runs/ filesystem
      // layout. This is the ONLY surface that translates absolute
      // executor-written paths into URLs; the UI treats the URLs as opaque
      // strings to drop into <img src>. Both lo and hi can be null
      // independently (lo when capture was off, hi only on failing steps
      // or post-loop). The init step in step_log gets the same treatment
      // and the UI renders it as the first thumbnail in the strip.
      const step_screenshots = (execution?.step_log ?? []).map((s) => ({
        action_id: s.action_id,
        lo: screenshotUrlForAbsPath(s.screenshot_path),
        hi: screenshotUrlForAbsPath(s.screenshot_path_hires),
      }));
      const final_state_screenshot = execution
        ? screenshotUrlForAbsPath(execution.final_state_screenshot_path)
        : null;
      return {
        permutation: p,
        prediction,
        execution,
        expectation,
        step_screenshots,
        final_state_screenshot,
        action_descriptions: p.action_ids.map((id) => {
          const a = actions.find((x) => x.id === id);
          if (!a) return null;
          // Carry the catalog provenance fields the UI needs to render a
          // "via catalog: <name>" chip. `sensitive` flips redaction on
          // type_value so wallet seeds / API tokens / env-sourced values
          // never reach the browser.
          const meta = a.meta as Record<string, unknown>;
          const catalogEntryName =
            typeof meta["catalog_entry_name"] === "string"
              ? (meta["catalog_entry_name"] as string)
              : undefined;
          const sensitive = meta["sensitive"] === true;
          const fixtureKind =
            typeof meta["fixture_kind"] === "string"
              ? (meta["fixture_kind"] as string)
              : undefined;
          return {
            id: a.id,
            kind: a.kind,
            description: a.description,
            selector: a.selector,
            // Use the shared constant so a rename in inputs.ts cannot silently
            // desync the dashboard's redaction string from the DB row sentinel.
            // Pre-this-commit: hardcoded literal; a rename of REDACTED_TYPE_VALUE
            // would compile and tests would pass but the dashboard would emit
            // a different string than the row contained.
            type_value: sensitive ? REDACTED_TYPE_VALUE : a.type_value,
            catalog_entry_name: catalogEntryName,
            catalog_fixture_kind: fixtureKind === "catalog" ? "catalog" : undefined,
            sensitive,
          };
        }),
      };
    });
    res.json({ run, project, actions, permutations: enriched });
  });

  app.get("/api/runs/:runId/findings", (req, res) => {
    const run = getRun(db, req.params.runId);
    if (!run) {
      res.status(404).json({ error: `run '${req.params.runId}' not found` });
      return;
    }
    const report = analyzeRun(db, run.id);
    const wantMd = String(req.query.format ?? "").toLowerCase() === "markdown";
    if (wantMd) {
      res.set("content-type", "text/markdown; charset=utf-8");
      res.send(renderFindingsMarkdown(report));
      return;
    }
    res.json(report);
  });

  // ---- write endpoint ----

  app.post("/api/predictions/:permutationId/note", (req, res) => {
    const noteText = String((req.body?.note_text ?? "")).trim();
    if (noteText.length > 4_000) {
      res.status(400).json({ error: `note_text too long (max 4000 chars, got ${noteText.length})` });
      return;
    }
    try {
      updatePredictionNote(db, req.params.permutationId, noteText, new Date().toISOString());
      const updated = getPrediction(db, req.params.permutationId);
      res.json({ ok: true, prediction: updated });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- SPA fallback: every non-API path returns index.html so the client
  // router (vanilla JS) handles routes.
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(resolve(UI_DIR, "index.html"));
  });

  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      process.stdout.write(`vouch dashboard running at http://localhost:${port}\n`);
      resolve();
    });
  });
}
