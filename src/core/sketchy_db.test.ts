// DB roundtrip tests for sketchy_verdicts.
//
// Mirrors the pattern used by broken_first.test.ts for blocked_prefixes.
// In-memory SQLite (via better-sqlite3 + file in tmp), insert, read back,
// upsert (idempotent overwrite), schema-driven NULL safety.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  getSketchyVerdict,
  insertActions,
  insertPermutations,
  insertProject,
  insertRun,
  openDB,
  upsertSketchyVerdict,
  type DBHandle,
} from "./db.js";
import { type SketchyVerdict } from "./sketchy.js";

describe("sketchy_verdicts DB roundtrip", () => {
  let tmpDir: string;
  let db: DBHandle;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vouch-sketchy-db-"));
    mkdirSync(tmpDir, { recursive: true });
    db = openDB(join(tmpDir, "test.db"));
    // Seed the FK chain so the perm-id insert is valid.
    insertProject(db, {
      id: "proj_sketch",
      name: "sketch-test",
      description: null,
      spec_text: "spec",
      created_at: "2026-05-23T00:00:00Z",
    });
    insertRun(db, {
      id: "run_sketch",
      project_id: "proj_sketch",
      target_url: "https://example.com",
      spec_text: "spec",
      spec_sha256: "deadbeef",
      strategy: "exhaustive",
      depth: 1,
      started_at: "2026-05-23T00:00:00Z",
      finished_at: null,
      prediction_source: "anthropic-haiku",
    });
    insertActions(db, "run_sketch", [
      {
        id: "a",
        kind: "click",
        selector: "[data-testid=a]",
        description: "a",
        type_value: null,
        rules: [],
        meta: {},
      },
    ]);
    insertPermutations(db, [
      { id: "run_sketch__perm_00000", run_id: "run_sketch", action_ids: ["a"], index: 0 },
    ]);
  });

  afterEach(() => {
    db.raw.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for an unknown permutation_id", () => {
    expect(getSketchyVerdict(db, "run_sketch__perm_does_not_exist")).toBeNull();
  });

  it("roundtrips a clean verdict", () => {
    const v: SketchyVerdict = {
      permutation_id: "run_sketch__perm_00000",
      verdict: "clean",
      issues: [],
      source: "anthropic-haiku-vision",
      cost_usd: 0.0012,
      generated_at: "2026-05-23T01:00:00Z",
    };
    upsertSketchyVerdict(db, v);
    const out = getSketchyVerdict(db, v.permutation_id);
    expect(out).not.toBeNull();
    expect(out!.verdict).toBe("clean");
    expect(out!.issues).toEqual([]);
    expect(out!.cost_usd).toBeCloseTo(0.0012, 5);
  });

  it("roundtrips a sketchy verdict with multiple issues", () => {
    const v: SketchyVerdict = {
      permutation_id: "run_sketch__perm_00000",
      verdict: "sketchy",
      issues: ["hero subtitle low-contrast", "state field misaligned"],
      source: "anthropic-haiku-vision",
      cost_usd: 0.003,
      generated_at: "2026-05-23T01:00:00Z",
    };
    upsertSketchyVerdict(db, v);
    const out = getSketchyVerdict(db, v.permutation_id)!;
    expect(out.verdict).toBe("sketchy");
    expect(out.issues).toEqual([
      "hero subtitle low-contrast",
      "state field misaligned",
    ]);
  });

  it("upsert is idempotent — a second write with the same key replaces the row, not appends", () => {
    const v1: SketchyVerdict = {
      permutation_id: "run_sketch__perm_00000",
      verdict: "clean",
      issues: [],
      source: "anthropic-haiku-vision",
      cost_usd: 0.001,
      generated_at: "2026-05-23T01:00:00Z",
    };
    upsertSketchyVerdict(db, v1);
    const v2: SketchyVerdict = {
      ...v1,
      verdict: "sketchy",
      issues: ["new finding"],
      cost_usd: 0.002,
      generated_at: "2026-05-23T02:00:00Z",
    };
    upsertSketchyVerdict(db, v2);
    const out = getSketchyVerdict(db, v1.permutation_id)!;
    expect(out.verdict).toBe("sketchy");
    expect(out.issues).toEqual(["new finding"]);
    expect(out.generated_at).toBe("2026-05-23T02:00:00Z");
  });

  it("handles 'unsupported' verdict (no LLM key available) without crashing", () => {
    const v: SketchyVerdict = {
      permutation_id: "run_sketch__perm_00000",
      verdict: "unsupported",
      issues: [],
      source: "unavailable",
      cost_usd: 0,
      generated_at: "2026-05-23T01:00:00Z",
    };
    upsertSketchyVerdict(db, v);
    const out = getSketchyVerdict(db, v.permutation_id)!;
    expect(out.verdict).toBe("unsupported");
    expect(out.source).toBe("unavailable");
  });
});
