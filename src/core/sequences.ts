// Sequence utilities.
//
// A "sequence" in Vouch is an ordered list of action ids (a click-path). Two
// places need to match sequences across runs:
//
//   1. The broken-first scheduler in `runOneDepth` partitions the freshly
//      generated permutations into "previously broken at this depth" vs
//      "the rest". Match is on action_ids, not perm_id, because perm_ids
//      embed the run id and change every campaign iteration.
//
//   2. The blocked-prefix filter in `generatePermutationsWithStats` matches
//      a sequence against a list of prefixes. That code does element-by-
//      element comparison; we don't reuse this key there yet, but the same
//      semantics should apply if we ever switch to a hash-set filter.
//
// The key uses U+001F UNIT SEPARATOR as the joiner. Action ids in Vouch are
// kebab-cased alphanumeric and cannot contain it, so the join is injective:
// ["a", "b"] and ["a,b"] produce different keys.

const UNIT_SEPARATOR = "";

/**
 * Build a stable string key from an ordered sequence of action ids.
 *
 * Equal sequences produce equal keys. Different sequences (different order
 * OR different elements) produce different keys, including when one is a
 * prefix of the other (the trailing separator boundary makes ["a"] and
 * ["a", ""] distinct, though "" is not a valid action id in Vouch).
 */
export function sequenceKey(actionIds: readonly string[]): string {
  return actionIds.join(UNIT_SEPARATOR);
}

/**
 * Anything that carries an ordered action_ids list and an id. Both
 * Permutation (planner output) and BlockedPrefix-derived placeholders fit.
 * Defined as a structural type so callers don't have to import or extend a
 * concrete class.
 */
export interface HasActionIds {
  readonly id: string;
  readonly action_ids: readonly string[];
}

/**
 * Split a list of perms into "priority" (matches one of the target
 * sequences) and "rest" (everything else). Used by runOneDepth's broken-
 * first scheduler. Exported (rather than inlined) so the unit tests and
 * the production code path are the SAME implementation — keeps a parallel
 * test copy from drifting from the prod copy.
 *
 * Matching is on the ordered action_ids list, not on perm id, because perm
 * ids change every run (they include the run id).
 */
export function partitionPermsForRetest<T extends HasActionIds>(
  perms: readonly T[],
  targetSequences: readonly (readonly string[])[],
): { priority: T[]; rest: T[] } {
  const keys = new Set(targetSequences.map(sequenceKey));
  const priority: T[] = [];
  const rest: T[] = [];
  for (const p of perms) {
    if (keys.has(sequenceKey(p.action_ids))) priority.push(p);
    else rest.push(p);
  }
  return { priority, rest };
}
