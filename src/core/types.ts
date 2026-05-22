// Shared type definitions for Vouch.
//
// Every cross-module value flows through one of the zod schemas below. The
// schemas are the single source of truth: TypeScript types are derived, and
// the same schemas guard SQLite reads/writes so corrupt rows surface as
// parse errors at the storage boundary instead of silent `undefined` deep
// in the executor.

import { z } from "zod";

// ============================================================================
// Action — one interactable element discovered by the Surface Mapper.
// ============================================================================

export const ActionKindSchema = z.enum([
  "click", // buttons, links, anchors
  "focus_input", // clicking into a text/email/password/textarea field (no typing yet)
  "type", // typing into a focused field; requires a prior focus_input on the same selector
  "toggle_checkbox",
  "select_option", // <select> dropdowns
  "resize_viewport", // global page-level action (no selector)
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

/**
 * A rule constrains when an action is valid inside a permutation. The
 * canonical example: a `type` action is only valid when an earlier step in
 * the sequence was a `focus_input` on the same selector. The rule below is
 * declarative; the permutation generator filters sequences that violate it.
 */
export const ActionRuleSchema = z.object({
  kind: z.literal("requires_prior_action"),
  prior_kind: ActionKindSchema,
  /** When true, the prior action must reference the same selector as this one. */
  same_selector: z.boolean().default(true),
  /** Human-readable explanation for the dashboard. */
  description: z.string(),
});
export type ActionRule = z.infer<typeof ActionRuleSchema>;

export const ActionSchema = z.object({
  /** Stable id within a (project, run) scope. Used as the unit of permutation. */
  id: z.string(),
  kind: ActionKindSchema,
  /** CSS selector (or `null` for global actions like resize_viewport). */
  selector: z.string().nullable(),
  /** Human-readable description suitable for the dashboard. */
  description: z.string(),
  /**
   * For `type` actions: the literal text Vouch will type. Generated
   * deterministically from the input's `name`/`placeholder` so re-runs
   * are reproducible.
   */
  type_value: z.string().nullable().default(null),
  rules: z.array(ActionRuleSchema).default([]),
  /** Free-form metadata for the dashboard (tag name, role, accessible name, etc.). */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type Action = z.infer<typeof ActionSchema>;

// ============================================================================
// Permutation — one ordered sequence of action ids.
// ============================================================================

export const PermutationSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  /** Ordered list of action ids. Length equals plan depth. */
  action_ids: z.array(z.string()),
  /** Index in the deterministic emission order for this run. */
  index: z.number().int().nonnegative(),
});
export type Permutation = z.infer<typeof PermutationSchema>;

// ============================================================================
// Prediction — the oracle's expected outcome for one permutation.
// ============================================================================

export const PredictionSourceSchema = z.enum(["anthropic-haiku", "claude-cli", "heuristic"]);
export type PredictionSource = z.infer<typeof PredictionSourceSchema>;

export const PredictionSchema = z.object({
  permutation_id: z.string(),
  source: PredictionSourceSchema,
  /** What the system should observe after the last action in the sequence. */
  expected_post_state: z.string(),
  /** Confidence score from the source. Heuristic source uses 0.5 by convention. */
  confidence: z.number().min(0).max(1),
  /** Tokens or compute cost (USD). 0 for heuristic. */
  cost_usd: z.number().min(0).default(0),
  /** Generated_at ISO timestamp. */
  generated_at: z.string(),
  /**
   * User-editable note. Persists across runs. Treated as authoritative once
   * set — the dashboard shows it as "operator override" alongside the
   * model's prediction.
   */
  user_note_text: z.string().nullable().default(null),
  user_note_edited_at: z.string().nullable().default(null),
});
export type Prediction = z.infer<typeof PredictionSchema>;

// ============================================================================
// Execution — the actual result of replaying one permutation.
// ============================================================================

export const VerdictSchema = z.enum([
  "pass",
  "fail",
  "infrastructure_error",
  "timeout",
  "missing_input",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ExecutionSchema = z.object({
  permutation_id: z.string(),
  verdict: VerdictSchema,
  /** Per-step traces as JSON strings; one per action in the sequence. */
  step_log: z.array(
    z.object({
      action_id: z.string(),
      kind: ActionKindSchema,
      started_at: z.string(),
      finished_at: z.string(),
      ok: z.boolean(),
      error_message: z.string().nullable().default(null),
      /**
       * Absolute path to the PNG screenshot taken AFTER this step executed.
       * Populated when the executor's screenshot mode is on (default).
       * Cleaned up (deleted from disk) for permutations that complete without
       * any blocking finding, to bound disk usage. Findings analyzer flips
       * to "preserve" for permutations with at least one blocking finding so
       * the dashboard can render the evidence.
       */
      screenshot_path: z.string().nullable().default(null),
    }),
  ),
  observed_post_state: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  /**
   * If verdict is `infrastructure_error`, the named error class so dashboard
   * can surface a fix hint instead of a stack trace.
   */
  error_class: z.string().nullable().default(null),
});
export type Execution = z.infer<typeof ExecutionSchema>;

// ============================================================================
// Run — a single end-to-end Vouch session for a project.
// ============================================================================

export const RunSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  target_url: z.string().url(),
  spec_text: z.string(),
  spec_sha256: z.string(),
  strategy: z.enum(["exhaustive", "pairwise"]),
  depth: z.number().int().positive(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  prediction_source: PredictionSourceSchema,
});
export type Run = z.infer<typeof RunSchema>;

// ============================================================================
// Project — a named scope. One row per assignment / target system.
// ============================================================================

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Free-form description shown on the dashboard project picker. */
  description: z.string().nullable().default(null),
  /**
   * Spec text the user provided at `vouch init`. Mutable; the run captures
   * its own snapshot via `spec_sha256` so historical runs stay stable.
   */
  spec_text: z.string(),
  created_at: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;
