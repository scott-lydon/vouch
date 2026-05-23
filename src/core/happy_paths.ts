// Happy-Path Manifest from the SUT.
//
// Background. Vouch's permutation engine discovers actions by walking the
// DOM and synthesizing every depth-N sequence. That covers exploratory
// surface coverage, but it cannot know domain truth — a Carvana SUT
// knows that `WZY1433` is a valid Texas license plate, that
// `address line 2 + zip = pickup ready`, that `tap upload, then drop a
// PNG, then tap submit = success`. Random typing won't discover those
// inputs; Vouch will see the chat say "Refresh and try again" and report
// a bug that's actually a missing happy-path test.
//
// The fix: let the SUT publish a manifest of known-good action sequences
// with their expected outcomes. Vouch fetches it during the map phase
// and merges the named happy paths into the perm plan AS-IS. They run
// through the same Executor + Oracle + Verifier + Sketchy pipeline as
// every other perm.
//
// Contract (versioned so the SUT can evolve without breaking older Vouch):
//
//   GET <target_url>/.well-known/vouch-happy-paths.json
//   Content-Type: application/json
//   {
//     "version": "1",
//     "paths": [
//       {
//         "name": "valid VIN entry",
//         "description": "User enters a known-valid VIN in chat",
//         "actions": [
//           { "kind": "focus_input", "selector": "[data-testid=chat-input]" },
//           { "kind": "type", "selector": "[data-testid=chat-input]",
//             "value": "WZY1433" },
//           { "kind": "click", "selector": "[data-testid=chat-send]" }
//         ],
//         "expectedOutcome": "Chat shows the VIN lookup with vehicle details."
//       }
//     ]
//   }
//
// Failure mode: a 404 / 403 / network error / malformed body is NOT an
// error from Vouch's perspective — most SUTs won't publish a manifest.
// We log one info line and proceed. A malformed JSON parses with a clear
// error so the SUT operator can fix it.

import { z } from "zod";

import { ActionKindSchema, type Action, type Permutation } from "./types.js";

export const HappyPathActionSchema = z.object({
  kind: ActionKindSchema,
  selector: z.string().nullable().default(null),
  /** For `type` actions: the literal text to type. */
  value: z.string().optional(),
  /** Optional human-readable description shown on the dashboard. */
  description: z.string().optional(),
});
export type HappyPathAction = z.infer<typeof HappyPathActionSchema>;

export const HappyPathSchema = z.object({
  /** Short slug-able name. Used as part of the action id, so kebab-case is best. */
  name: z.string().min(1).max(80),
  /** Free-form. Shown on the dashboard. */
  description: z.string().optional(),
  /** Ordered list of actions to play. */
  actions: z.array(HappyPathActionSchema).min(1),
  /**
   * What the SUT expects to be true after the actions complete. Fed to
   * the Oracle as the prediction, bypassing the LLM call entirely for this
   * permutation. Lower cost AND domain-correct — the SUT is the
   * authoritative source here, the LLM was guessing.
   */
  expectedOutcome: z.string().min(1),
});
export type HappyPath = z.infer<typeof HappyPathSchema>;

export const HappyPathManifestSchema = z.object({
  version: z.literal("1"),
  paths: z.array(HappyPathSchema),
});
export type HappyPathManifest = z.infer<typeof HappyPathManifestSchema>;

/**
 * Default timeout for the manifest fetch. Short on purpose: if the SUT
 * doesn't publish one, we want to move on fast. Override via the optional
 * `timeoutMs` argument when the test SUT is on a slow link.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

/**
 * Fetch the happy-path manifest from the SUT, validate it, and return the
 * parsed object. Returns `null` (no error) when the SUT does not publish
 * one. Throws ONLY for a malformed-on-publish manifest (the SUT did
 * publish JSON but it doesn't match the schema), so the SUT operator
 * gets a fast feedback loop.
 *
 * The well-known URL convention is the only path queried. We do NOT
 * probe other paths to avoid noisy 404s in the SUT's request logs.
 */
export async function fetchHappyPathManifest(
  targetUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<HappyPathManifest | null> {
  const manifestUrl = buildManifestUrl(targetUrl);
  const timeout = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let resp: Response;
  try {
    resp = await fetch(manifestUrl, { signal: controller.signal });
  } catch (err) {
    // Network error, DNS, abort. Not a Vouch error; the SUT just doesn't
    // publish one or isn't reachable. Log at the call site, not here.
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);
  if (!resp.ok) {
    // 404 / 403 / 500 / etc. Manifest not published. Not a Vouch error.
    return null;
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new Error(
      `happy-paths: ${manifestUrl} returned 200 but the body is not JSON. ` +
        `Either the SUT mis-served the file, or the JSON has a syntax error. ` +
        `Inner error: ${(err as Error).message}`,
    );
  }
  const parsed = HappyPathManifestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `happy-paths: ${manifestUrl} returned 200 but the body does not match ` +
        `the v1 schema. Each entry needs name, actions[] with kind + selector, ` +
        `and expectedOutcome. ` +
        `Validation errors: ${JSON.stringify(parsed.error.flatten(), null, 2)}`,
    );
  }
  return parsed.data;
}

/**
 * Compose the well-known URL for a given target. We strip any path the
 * caller passed (e.g. https://example.com/login → https://example.com/.well-known/vouch-happy-paths.json)
 * because the well-known convention is origin-scoped. If the caller wanted
 * a per-route manifest, the SUT's response to the root manifest can list
 * those routes; we don't ad-hoc this here.
 */
export function buildManifestUrl(targetUrl: string): string {
  const u = new URL(targetUrl);
  return `${u.origin}/.well-known/vouch-happy-paths.json`;
}

/**
 * Lower a HappyPath into vouch's Action + Permutation rows for a given run.
 *
 * Returns:
 *   - `actions`: synthesized Action rows representing every action used in
 *     the path. Each gets an id like `happy_<name-slug>_<idx>_<kind>` so it
 *     does not collide with surface-mapper-discovered ids.
 *   - `permutation`: ONE Permutation row whose `action_ids` is the ordered
 *     list of those synthesized ids. Index numbering is the caller's
 *     responsibility (the planner-merge code in cli.ts knows how to keep
 *     ids unique across the regular and happy plans).
 *   - `predictionExpected`: the expectedOutcome string. The caller passes
 *     this straight to upsertPrediction so the Oracle's LLM call is
 *     skipped for this perm.
 *
 * The synthesized actions do NOT carry rules. The path is asserted to be
 * known-good by the SUT, so we trust its ordering instead of re-validating
 * with the requires_prior_action rule on type actions.
 */
export function lowerHappyPathToRows(
  path: HappyPath,
  runId: string,
  permIndex: number,
): { actions: Action[]; permutation: Permutation; predictionExpected: string } {
  const nameSlug = path.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const actions: Action[] = [];
  const actionIds: string[] = [];
  for (let i = 0; i < path.actions.length; i++) {
    const step = path.actions[i]!;
    const id = `happy__${nameSlug}__${String(i).padStart(2, "0")}__${step.kind}`;
    actions.push({
      id,
      kind: step.kind,
      selector: step.selector,
      description:
        step.description ??
        `Happy-path "${path.name}" step ${i + 1}: ${step.kind}${step.selector ? ` on ${step.selector}` : ""}`,
      type_value: step.kind === "type" ? step.value ?? "" : null,
      rules: [],
      meta: {
        source: "happy_path_manifest",
        happy_path_name: path.name,
        step_index: i,
      },
    });
    actionIds.push(id);
  }
  const permutation: Permutation = {
    id: `${runId}__happy__${nameSlug}`,
    run_id: runId,
    action_ids: actionIds,
    index: permIndex,
  };
  return {
    actions,
    permutation,
    predictionExpected: path.expectedOutcome,
  };
}
