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
