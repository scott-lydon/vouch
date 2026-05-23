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

import { dirname, resolve } from "node:path";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, "ui");

export async function startServer(dbPath: string, port: number): Promise<void> {
  const db = openDB(dbPath);
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(UI_DIR));

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
    res.json({ project, runs });
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
      return {
        permutation: p,
        prediction,
        execution,
        expectation,
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
            type_value: sensitive ? "[redacted: catalog-sourced sensitive value]" : a.type_value,
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
