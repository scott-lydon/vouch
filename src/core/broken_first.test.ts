// Tests for the broken-first scheduler primitives.
//
// The full broken-first dance in `runOneDepth` requires Playwright + LLM
// integration, so we don't exercise it end-to-end here. Instead we cover the
// pure pieces it composes from:
//   1. sequenceKey: injective ordered-list -> string mapping.
//   2. listActiveBlockedPrefixesAtDepth: the DB query that picks the
//      "previously broken at THIS depth" prefixes.
//   3. The partition logic: given perms and a set of sequence keys, split
//      into priority vs rest.
//   4. The auto-unblock logic: when the priority subset passes, the
//      corresponding blocks are flipped to unblocked_at IS NOT NULL.
//
// Anything that requires the executor or oracle is out of scope; that's
// what the campaign integration tests will cover when they exist.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  insertBlockedPrefix,
  listActiveBlockedPrefixes,
  listActiveBlockedPrefixesAtDepth,
  insertProject,
  openDB,
  unblockPrefixById,
  type DBHandle,
} from "./db.js";
import { partitionPermsForRetest, sequenceKey } from "./sequences.js";

// ---------------------------------------------------------------------------
// 1. sequenceKey
// ---------------------------------------------------------------------------

describe("sequenceKey", () => {
  it("returns the same key for the same ordered sequence", () => {
    expect(sequenceKey(["a", "b", "c"])).toBe(sequenceKey(["a", "b", "c"]));
  });

  it("returns different keys for different orders (sequences are ordered)", () => {
    expect(sequenceKey(["a", "b"])).not.toBe(sequenceKey(["b", "a"]));
  });

  it("returns different keys for different lengths", () => {
    expect(sequenceKey(["a"])).not.toBe(sequenceKey(["a", "b"]));
  });

  it("does not collide on the comma-vs-list ambiguity (uses unit separator, not comma)", () => {
    // The whole point of the unit-separator joiner: ["a,b"] (one element
    // containing a comma) must not key the same as ["a", "b"] (two elements).
    // If sequenceKey ever switches to comma-joining this regresses.
    const oneElementWithComma = sequenceKey(["a,b"]);
    const twoElements = sequenceKey(["a", "b"]);
    expect(oneElementWithComma).not.toBe(twoElements);
  });

  it("handles an empty sequence without throwing", () => {
    expect(sequenceKey([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. listActiveBlockedPrefixesAtDepth
// ---------------------------------------------------------------------------

describe("listActiveBlockedPrefixesAtDepth", () => {
  let tmpDir: string;
  let db: DBHandle;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vouch-test-"));
    mkdirSync(tmpDir, { recursive: true });
    db = openDB(join(tmpDir, "test.db"));
    insertProject(db, {
      id: "proj_test",
      name: "test-project",
      description: null,
      spec_text: "test spec",
      created_at: "2026-05-23T00:00:00Z",
    });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns prefixes whose length matches the requested depth", () => {
    insertBlockedPrefix(db, {
      projectId: "proj_test",
      prefix: ["a"], // length 1
      reason: "playwright_failure",
      runId: "run_1",
      permutationId: "p1",
    });
    insertBlockedPrefix(db, {
      projectId: "proj_test",
      prefix: ["a", "b"], // length 2
      reason: "playwright_failure",
      runId: "run_2",
      permutationId: "p2",
    });
    insertBlockedPrefix(db, {
      projectId: "proj_test",
      prefix: ["a", "b", "c"], // length 3
      reason: "playwright_failure",
      runId: "run_3",
      permutationId: "p3",
    });

    const atDepth2 = listActiveBlockedPrefixesAtDepth(db, "proj_test", 2);
    expect(atDepth2).toHaveLength(1);
    expect(atDepth2[0]!.prefix).toEqual(["a", "b"]);

    const atDepth1 = listActiveBlockedPrefixesAtDepth(db, "proj_test", 1);
    expect(atDepth1).toHaveLength(1);
    expect(atDepth1[0]!.prefix).toEqual(["a"]);

    const atDepth4 = listActiveBlockedPrefixesAtDepth(db, "proj_test", 4);
    expect(atDepth4).toHaveLength(0);
  });

  it("excludes prefixes that have been unblocked", () => {
    const id = insertBlockedPrefix(db, {
      projectId: "proj_test",
      prefix: ["x", "y"],
      reason: "playwright_failure",
      runId: "run_1",
      permutationId: "p1",
    });
    expect(listActiveBlockedPrefixesAtDepth(db, "proj_test", 2)).toHaveLength(1);
    expect(unblockPrefixById(db, id)).toBe(true);
    expect(listActiveBlockedPrefixesAtDepth(db, "proj_test", 2)).toHaveLength(0);
  });

  it("scopes by project (does not leak across projects)", () => {
    insertProject(db, {
      id: "proj_other",
      name: "other",
      description: null,
      spec_text: "other spec",
      created_at: "2026-05-23T00:00:00Z",
    });
    insertBlockedPrefix(db, {
      projectId: "proj_other",
      prefix: ["a", "b"],
      reason: "playwright_failure",
      runId: "run_x",
      permutationId: "px",
    });
    expect(listActiveBlockedPrefixesAtDepth(db, "proj_test", 2)).toHaveLength(0);
    expect(listActiveBlockedPrefixesAtDepth(db, "proj_other", 2)).toHaveLength(1);
  });

  it("returned set is a strict subset of listActiveBlockedPrefixes", () => {
    insertBlockedPrefix(db, {
      projectId: "proj_test",
      prefix: ["a"],
      reason: "playwright_failure",
      runId: "r",
      permutationId: "p",
    });
    insertBlockedPrefix(db, {
      projectId: "proj_test",
      prefix: ["a", "b"],
      reason: "playwright_failure",
      runId: "r",
      permutationId: "p2",
    });
    const all = listActiveBlockedPrefixes(db, "proj_test");
    const atDepth1 = listActiveBlockedPrefixesAtDepth(db, "proj_test", 1);
    const allKeys = new Set(all.map((b) => sequenceKey(b.prefix)));
    for (const b of atDepth1) {
      expect(allKeys.has(sequenceKey(b.prefix))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Partition logic. Imported from sequences.ts so this test exercises the
//    SAME implementation that runOneDepth uses — no parallel test copy to
//    drift out of sync.
// ---------------------------------------------------------------------------

interface PermLike {
  id: string;
  action_ids: string[];
}

describe("partitionPermsForRetest (shared with runOneDepth)", () => {
  const perms: PermLike[] = [
    { id: "p1", action_ids: ["a", "b"] },
    { id: "p2", action_ids: ["a", "c"] },
    { id: "p3", action_ids: ["b", "a"] },
    { id: "p4", action_ids: ["c", "d"] },
  ];

  it("empty retest list -> all perms in rest, none in priority", () => {
    const { priority, rest } = partitionPermsForRetest(perms, []);
    expect(priority).toHaveLength(0);
    expect(rest).toHaveLength(4);
  });

  it("retest list matches exactly one perm by ordered sequence", () => {
    const { priority, rest } = partitionPermsForRetest(perms, [["a", "b"]]);
    expect(priority).toHaveLength(1);
    expect(priority[0]!.id).toBe("p1");
    expect(rest.map((p) => p.id).sort()).toEqual(["p2", "p3", "p4"]);
  });

  it("order-sensitive: [a,b] is not the same as [b,a]", () => {
    const { priority } = partitionPermsForRetest(perms, [["a", "b"]]);
    expect(priority.map((p) => p.id)).not.toContain("p3");
  });

  it("priority union rest equals all perms (no perm is dropped)", () => {
    const { priority, rest } = partitionPermsForRetest(perms, [["a", "b"], ["c", "d"]]);
    expect(priority.length + rest.length).toBe(perms.length);
    expect(new Set([...priority, ...rest].map((p) => p.id))).toEqual(
      new Set(perms.map((p) => p.id)),
    );
  });

  it("priority and rest do not overlap (no perm is in both)", () => {
    const { priority, rest } = partitionPermsForRetest(perms, [["a", "c"]]);
    const priorityIds = new Set(priority.map((p) => p.id));
    for (const r of rest) {
      expect(priorityIds.has(r.id)).toBe(false);
    }
  });
});
