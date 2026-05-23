// Tests for the empty-baseline permutation option in the planner.
//
// The empty-baseline perm is what lets the Sketchy Checker analyze the
// LANDING page itself (post-navigation, pre-click). Without it, every
// permutation has at least one click and the landing page is never the
// post-state of anything Vouch examines. That's how Carvana shipped
// eleven landing-page visible defects past a "passing" Vouch run.

import { describe, it, expect } from "vitest";

import { generatePermutationsWithStats } from "./permutations.js";
import { type Action } from "./types.js";

function makeAction(id: string): Action {
  return {
    id,
    kind: "click",
    selector: `[data-testid="${id}"]`,
    description: `synthetic action ${id}`,
    type_value: null,
    rules: [],
    meta: {},
  };
}

const ACTIONS = [makeAction("a"), makeAction("b"), makeAction("c")];

describe("generatePermutationsWithStats: includeEmptyBaseline", () => {
  it("default (option absent): emits only depth-N sequences, no zero-action perm", () => {
    const result = generatePermutationsWithStats("run_x", ACTIONS, { depth: 1 });
    expect(result.permutations).toHaveLength(3);
    for (const p of result.permutations) {
      expect(p.action_ids.length).toBe(1);
    }
  });

  it("includeEmptyBaseline=true: emits the empty perm at index 0", () => {
    const result = generatePermutationsWithStats("run_x", ACTIONS, {
      depth: 1,
      includeEmptyBaseline: true,
    });
    expect(result.permutations[0]!.action_ids).toEqual([]);
    expect(result.permutations[0]!.index).toBe(0);
    expect(result.permutations[0]!.id).toBe("run_x__perm_baseline");
  });

  it("indices increment correctly: baseline at 0, depth-N perms at 1..n", () => {
    const result = generatePermutationsWithStats("run_x", ACTIONS, {
      depth: 1,
      includeEmptyBaseline: true,
    });
    const indices = result.permutations.map((p) => p.index);
    expect(indices[0]).toBe(0);
    // Every subsequent perm should have a strictly increasing index.
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    }
  });

  it("baseline is NOT subject to the blocked-prefix filter", () => {
    // If you block every starting prefix, the regular plan goes to zero —
    // but the baseline should still survive because an empty sequence
    // cannot share a prefix with any non-empty blocked prefix.
    const result = generatePermutationsWithStats("run_x", ACTIONS, {
      depth: 1,
      includeEmptyBaseline: true,
      blockedPrefixes: [["a"], ["b"], ["c"]],
    });
    // Every depth-1 perm starts with one of a/b/c, all of which are
    // blocked, so the regular emission count is 0. The baseline should
    // still be there.
    expect(result.permutations).toHaveLength(1);
    expect(result.permutations[0]!.action_ids).toEqual([]);
    expect(result.blocked_skip_count).toBe(3);
  });

  it("works at higher depths too — baseline is depth-independent", () => {
    const result = generatePermutationsWithStats("run_x", ACTIONS, {
      depth: 2,
      includeEmptyBaseline: true,
    });
    expect(result.permutations[0]!.action_ids).toEqual([]);
    expect(result.permutations.slice(1).every((p) => p.action_ids.length === 2)).toBe(true);
  });
});
