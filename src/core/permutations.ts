// Permutation generator.
//
// Given a set of actions and a depth N, emits every length-N sequence of
// action ids, with two filters applied:
//
//   1. Rule filter: an action with a `requires_prior_action` rule is only
//      valid at index i in the sequence if a matching prior action exists at
//      some index j < i. For `same_selector: true`, the prior action must
//      reference the same selector.
//
//   2. Cap: if the unfiltered count exceeds `maxSequences` (default 2000),
//      we throw a clear error rather than silently truncating. The user can
//      raise the cap with `--max-sequences` or lower depth.
//
// Ordering is deterministic (lexicographic by action_id) so re-runs produce
// byte-identical plan.json output.

import { type Action, type Permutation } from "./types.js";

export interface PlanOptions {
  depth: number;
  /** Hard cap on emitted sequences. Default 2000. Throws past the cap. */
  maxSequences?: number;
  /**
   * Sequences whose action_ids start with any of these prefixes are skipped.
   * Each prefix is an ordered list of action_ids. Empty array means no
   * filtering (the default). Used by the campaign loop: after a permutation
   * fails at depth N, its action_ids become a blocked prefix that filters
   * depth N+1.
   */
  blockedPrefixes?: string[][];
  /**
   * When true, ALSO emit the zero-action permutation (`action_ids: []`) at
   * index 0, in addition to the regular depth-N sequences. The zero-action
   * permutation captures the landing-page state with no interaction —
   * lets the Sketchy Checker analyze the LANDING page (low-contrast hero
   * copy, broken images, leftover engineering jargon, etc.) which would
   * otherwise never be screenshotted (every other permutation starts with
   * at least one click, so the post-state is post-click).
   *
   * Default false because `vouch run --depth 2` shouldn't pay for an extra
   * Playwright open it didn't ask for. The campaign command sets it true.
   */
  includeEmptyBaseline?: boolean;
}

export interface PlanResult {
  permutations: Permutation[];
  /** Number of sequences that would have been emitted but were skipped due to a blocked prefix. */
  blocked_skip_count: number;
}

const DEFAULT_MAX = 2000;

export function generatePermutations(runId: string, actions: Action[], opts: PlanOptions): Permutation[] {
  return generatePermutationsWithStats(runId, actions, opts).permutations;
}

export function generatePermutationsWithStats(
  runId: string,
  actions: Action[],
  opts: PlanOptions,
): PlanResult {
  if (actions.length === 0) {
    throw new Error(
      `generatePermutations: zero actions discovered for run '${runId}'. ` +
        `Re-run 'vouch map' against a URL with at least one interactable element, or check that the target page actually loaded ` +
        `(the Surface Mapper skips elements with display:none, visibility:hidden, opacity:0, or zero bounding-box size).`,
    );
  }
  if (opts.depth < 1) {
    throw new Error(`generatePermutations: depth must be >= 1, got ${opts.depth}`);
  }
  const maxSeq = opts.maxSequences ?? DEFAULT_MAX;

  // Deterministic ordering for reproducibility.
  const sorted = [...actions].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(sorted.map((a) => [a.id, a]));

  // Quick upper-bound check before we expand. Exhaustive count is n^depth.
  const upperBound = Math.pow(sorted.length, opts.depth);
  if (upperBound > maxSeq * 10) {
    // Even with filtering, this would blow up. Refuse early with a clear hint.
    throw new Error(
      `generatePermutations: exhaustive count for ${sorted.length} actions at depth ${opts.depth} is ` +
        `${upperBound.toLocaleString()}, far above the cap of ${maxSeq}. ` +
        `Lower depth (try --depth ${Math.max(1, opts.depth - 1)}) or raise the cap with --max-sequences. ` +
        `Pairwise / sample strategies will land in a later slice; depth-2 exhaustive is the v1 target.`,
    );
  }

  const blockedPrefixes = opts.blockedPrefixes ?? [];
  const out: Permutation[] = [];
  const sequence: string[] = [];
  let blockedSkipCount = 0;

  // Empty-baseline permutation. Emitted at index 0 when requested, so the
  // dashboard and the sketchy phase see the landing-page screenshot before
  // any of the depth-N sequences. We do NOT apply the blocked-prefix filter
  // to it: an empty sequence cannot share a prefix with any non-empty
  // blocked prefix, and the baseline is exactly what we want even when
  // every action sequence is blocked.
  if (opts.includeEmptyBaseline === true) {
    out.push({
      id: `${runId}__perm_baseline`,
      run_id: runId,
      action_ids: [],
      index: 0,
    });
  }

  /**
   * Returns true if `sequence` (the full sequence at terminal depth) starts
   * with any blocked prefix. Prefix-length must be <= sequence.length AND
   * every element must match.
   */
  const startsWithBlocked = (seq: readonly string[]): boolean => {
    for (const prefix of blockedPrefixes) {
      if (prefix.length === 0) continue;
      if (prefix.length > seq.length) continue;
      let ok = true;
      for (let i = 0; i < prefix.length; i++) {
        if (seq[i] !== prefix[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };

  function recurse(): void {
    if (sequence.length === opts.depth) {
      // Apply the blocked-prefix filter at terminal depth. Counted, not silent.
      if (startsWithBlocked(sequence)) {
        blockedSkipCount++;
        return;
      }
      if (out.length >= maxSeq) {
        throw new Error(
          `generatePermutations: emitted ${out.length} sequences, which exceeds the cap of ${maxSeq}. ` +
            `This run filtered down from ${upperBound.toLocaleString()} unfiltered candidates. ` +
            `Raise --max-sequences or lower --depth.`,
        );
      }
      const idx = out.length;
      // Permutation ids are globally unique: the SQLite primary key is
      // permutations.id, so two runs that both have `perm_00000` would
      // collide. Prefix with runId. The dashboard still renders the short
      // suffix (everything after the last `__`) so the UI stays readable.
      const id = `${runId}__perm_${idx.toString().padStart(5, "0")}`;
      out.push({ id, run_id: runId, action_ids: [...sequence], index: idx });
      return;
    }
    for (const candidate of sorted) {
      if (!isValidAt(candidate, sequence, byId)) continue;
      sequence.push(candidate.id);
      recurse();
      sequence.pop();
    }
  }

  recurse();
  return { permutations: out, blocked_skip_count: blockedSkipCount };
}

/**
 * Checks whether `candidate` can appear at the next position in `sequence`,
 * given the actions already in the sequence. Returns false if a
 * `requires_prior_action` rule isn't satisfied.
 */
export function isValidAt(
  candidate: Action,
  sequence: string[],
  byId: Map<string, Action>,
): boolean {
  for (const rule of candidate.rules) {
    if (rule.kind !== "requires_prior_action") continue;
    let satisfied = false;
    for (const priorId of sequence) {
      const prior = byId.get(priorId);
      if (!prior) continue;
      if (prior.kind !== rule.prior_kind) continue;
      if (rule.same_selector && prior.selector !== candidate.selector) continue;
      satisfied = true;
      break;
    }
    if (!satisfied) return false;
  }
  return true;
}
