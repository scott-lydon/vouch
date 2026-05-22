// Oracle. Predicts the expected post-state for one permutation given the
// project spec + the action sequence.
//
// Two sources are wired:
//
//   1. `anthropic-haiku` — calls Claude Haiku 4.5 once per permutation,
//      passes the spec + the action sequence + a request for one paragraph
//      describing what the user should observe after the last step. Used
//      when `ANTHROPIC_API_KEY` is set in the process env.
//
//   2. `heuristic` — pure-TS rule-based prediction that composes a sentence
//      from action kinds and selectors. Used when no API key is present.
//      The dashboard tags predictions with the source, so heuristic outputs
//      never masquerade as model outputs.
//
// Both sources produce a typed `Prediction` row in the same shape. Notes
// edited by the operator on the dashboard are preserved across re-runs.

import { spawn, spawnSync } from "node:child_process";

import Anthropic from "@anthropic-ai/sdk";

import {
  type Action,
  type Permutation,
  type Prediction,
  type PredictionSource,
  type Project,
} from "./types.js";

const MODEL = "claude-haiku-4-5-20251001";

export interface OracleInputs {
  permutation: Permutation;
  actionsById: Map<string, Action>;
  specText: string;
  /**
   * Briefing context the oracle needs to define expected behavior accurately.
   * Without these, the LLM has to infer what the product is, what kind of
   * user is using it, and what "success" means from the spec alone. Passing
   * the project's name + description + target URL grounds the prediction in
   * the actual product instead of treating the spec as a generic blob.
   */
  projectName: string;
  projectDescription: string | null;
  targetUrl: string;
}

export interface OracleResult {
  source: PredictionSource;
  expected_post_state: string;
  confidence: number;
  cost_usd: number;
}

/**
 * Default-source detection. Priority order (highest first):
 *
 *   1. process.env.VOUCH_ORACLE — explicit env override, validated as a known source.
 *   2. claude-cli — if the `claude` binary is on PATH. Uses the user's local
 *      Claude subscription (Max-plan token allowance) instead of API billing.
 *      Default model is Sonnet; the user's global ~/.claude/CLAUDE.md and any
 *      project CLAUDE.md auto-load. Slower than the API (~5-15s per call) but
 *      free at the margin if subscription tokens aren't being maxed out.
 *   3. anthropic-haiku — if ANTHROPIC_API_KEY is set. Cheapest API option;
 *      ~$0.02 per 51-permutation run.
 *   4. heuristic — deterministic rule-based fallback. No LLM, no spec
 *      grounding. Always available.
 *
 * The user explicitly chose claude-cli as the default when available because
 * their subscription token allowance has zero marginal cost. Override with
 * --oracle on the CLI or VOUCH_ORACLE=anthropic-haiku in the env.
 */
export function detectOracleSource(): PredictionSource {
  const fromEnv = process.env.VOUCH_ORACLE;
  if (fromEnv === "anthropic-haiku" || fromEnv === "claude-cli" || fromEnv === "heuristic") {
    return fromEnv;
  }
  if (isClaudeCliAvailable()) return "claude-cli";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic-haiku";
  return "heuristic";
}

/**
 * Is the `claude` binary on PATH? Used by detectOracleSource(). We do a
 * synchronous check at module level because the result is stable for the
 * lifetime of a Vouch process. We do NOT verify auth here — that's deferred
 * to the actual claude-cli call so a degraded run is one failed permutation,
 * not a refusal to start.
 */
function isClaudeCliAvailable(): boolean {
  // spawnSync works cleanly in both ESM and CJS; `command -v` exits 0 iff
  // the named binary is on PATH and executable.
  const probe = spawnSync("/bin/sh", ["-c", "command -v claude"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * Compute a prediction for one permutation. Falls back to the heuristic when
 * the chosen source fails — the dashboard will display the actual source so
 * the operator can spot a degraded run.
 */
export async function predictOne(
  input: OracleInputs,
  preferred: PredictionSource = detectOracleSource(),
): Promise<OracleResult> {
  if (preferred === "anthropic-haiku") {
    try {
      return await predictWithAnthropic(input);
    } catch (err) {
      process.stderr.write(
        `[vouch/oracle] Anthropic call failed for permutation '${input.permutation.id}'; ` +
          `falling back to heuristic. Underlying: ${(err as Error).message}\n`,
      );
      return predictHeuristic(input);
    }
  }
  if (preferred === "claude-cli") {
    try {
      return await predictWithClaudeCli(input);
    } catch (err) {
      process.stderr.write(
        `[vouch/oracle] claude-cli call failed for permutation '${input.permutation.id}'; ` +
          `falling back to heuristic. Underlying: ${(err as Error).message}\n`,
      );
      return predictHeuristic(input);
    }
  }
  return predictHeuristic(input);
}

/**
 * Build the oracle prompt used by both anthropic-haiku and claude-cli sources.
 * Shared so the two sources are directly comparable on the dashboard.
 *
 * Structure (in order):
 *   1. ASSIGNMENT — what role you're playing and what you're producing.
 *   2. CONTEXT SUMMARY — the project name, description, target URL. Grounds
 *      the prediction in the actual product, not a generic spec blob.
 *   3. SPEC — the source-of-truth document for what the product is supposed to do.
 *   4. SEQUENCE — the ordered list of actions Vouch will replay.
 *   5. CONTRACT — output format and rules. Repeated last so it stays in
 *      the model's working memory when it starts generating.
 */
export function buildOraclePrompt(input: OracleInputs): string {
  const sequenceText = describeSequence(input);
  const descLine = input.projectDescription
    ? `Project description: ${input.projectDescription}`
    : `Project description: (none provided at vouch init)`;
  return [
    `# Assignment`,
    ``,
    `You are the Oracle for Vouch, an agentic Model-Based Testing pipeline. Vouch maps the interactable surface of a product, generates action permutations, and then asks you (the Oracle) to predict the EXPECTED post-state for each permutation given the product's spec. Vouch then actually replays the permutation in a real browser and compares your prediction against the observed outcome.`,
    ``,
    `Your prediction IS the expected behavior. Vouch's verdict engine uses it as the source of truth for what should happen. If your prediction is vague or wrong, the verdict engine cannot tell pass from fail.`,
    ``,
    `# Context summary`,
    ``,
    `Project: ${input.projectName}`,
    descLine,
    `Target URL: ${input.targetUrl}`,
    `This permutation is index ${input.permutation.index} of the run, sequence length ${input.permutation.action_ids.length}.`,
    ``,
    `# Spec (the source of truth for what this product should do)`,
    ``,
    `"""`,
    input.specText.slice(0, 8000),
    `"""`,
    ``,
    `# Interaction sequence (in order)`,
    ``,
    sequenceText,
    ``,
    `# Contract for your response`,
    ``,
    `Respond with ONE paragraph (max 80 words) describing the EXPECTED POST-STATE after the final action above completes.`,
    ``,
    `Hard rules:`,
    `- One paragraph. No bullets. No multiple paragraphs.`,
    `- No preamble. First word is the observation, not "Here..." / "I think..." / "Based on the spec...".`,
    `- Concrete. Name elements that should be visible, URL changes, error message text (quote verbatim if the spec specifies it), validation states.`,
    `- Grounded in the spec. If the spec contradicts a common-sense default, follow the spec.`,
    `- Predict the observable state, not the implementation. A user looking at the browser. Not "React state will update".`,
    `- Order matters. Action 1 happens THEN action 2. If action 1's effect would prevent action 2, predict that failure explicitly.`,
    `- The "type" action only ever appears in a sequence after a "focus_input" on the same selector. Trust that constraint.`,
    `- If the spec is silent on a behavior, say so briefly ("Spec is silent on X; expect default browser behavior of Y") rather than inventing.`,
    ``,
    `Emit only the paragraph.`,
  ].join("\n");
}

async function predictWithAnthropic(input: OracleInputs): Promise<OracleResult> {
  const client = new Anthropic({});
  const prompt = buildOraclePrompt(input);

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });
  const text = resp.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error(`Anthropic returned an empty response (id=${resp.id}, stop_reason=${resp.stop_reason})`);
  }
  // Rough cost estimate at published Haiku 4.5 pricing ($1/M input, $5/M output).
  // Both token counts come back from the API; this is for the dashboard cost panel.
  const inTok = resp.usage.input_tokens;
  const outTok = resp.usage.output_tokens;
  const cost = (inTok / 1_000_000) * 1 + (outTok / 1_000_000) * 5;
  return {
    source: "anthropic-haiku",
    expected_post_state: text,
    confidence: 0.7,
    cost_usd: Number(cost.toFixed(6)),
  };
}

/**
 * Use the user's local `claude` CLI (the same binary the claude-code-bridge
 * spawns) to generate a prediction. This shells out to `claude -p <prompt>
 * --dangerously-skip-permissions` and consumes the user's Claude subscription
 * instead of billing the Anthropic API. Slower than direct API calls (~5-15s
 * vs ~1-2s) and the same auth-revocation fragility we documented at
 * ~/Documents/Claude/Projects/BUG_PREVENTION.md applies.
 *
 * Cost reported as 0 because the call doesn't bill the API; the user pays
 * via their subscription instead. The dashboard's cost panel will show "via
 * subscription" rather than a dollar amount when source === "claude-cli".
 */
async function predictWithClaudeCli(input: OracleInputs): Promise<OracleResult> {
  const prompt = buildOraclePrompt(input);

  const text = await new Promise<string>((resolveCli, rejectCli) => {
    const child = spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      rejectCli(
        new Error(
          `claude-cli timed out after 90s for permutation '${input.permutation.id}'. ` +
            `If your auth was recently revoked, run '~/.local/bin/claude-bridge-doctor' to verify.`,
        ),
      );
    }, 90_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (e: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      rejectCli(
        new Error(
          `claude-cli spawn failed: ${e.message}. Is the 'claude' binary on PATH? ` +
            `Install: https://docs.claude.com/en/docs/claude-code. Then 'claude auth login --claudeai'.`,
        ),
      );
    });
    child.on("close", (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectCli(
          new Error(
            `claude-cli exited with code ${code}. Often means the OAuth token is server-side revoked ` +
              `(see ~/Documents/Claude/Projects/BUG_PREVENTION.md). stderr: ${err.trim().slice(0, 400)}`,
          ),
        );
        return;
      }
      const trimmed = out.trim();
      if (!trimmed) {
        rejectCli(new Error(`claude-cli returned empty stdout (exit 0). stderr: ${err.trim().slice(0, 400)}`));
        return;
      }
      resolveCli(trimmed);
    });
  });

  return {
    source: "claude-cli",
    expected_post_state: text,
    confidence: 0.75, // Sonnet via CLI is more capable than Haiku on this task; bump from 0.7.
    cost_usd: 0, // Billed against subscription, not API. Dashboard surfaces this.
  };
}

/**
 * BATCHED claude-cli oracle. Sends N permutations in a single subprocess
 * spawn and parses N predictions back from a JSON array. Eliminates the
 * dominant per-call cost on claude-cli (~3-5s of spawn + auth + plugin init)
 * which on a 289-perm depth-2 run shrinks oracle wallclock from ~50 min to
 * ~5 min (one batch ≈ one solo call's wallclock).
 *
 * Architectural trade-off: a malformed JSON response loses the whole batch
 * versus a single perm. Mitigation:
 *   1. We ask Claude for STRICT JSON in the contract, repeated last so it
 *      stays in working memory.
 *   2. On parse failure we DO NOT silently lose the batch — we fall back
 *      to per-perm `predictWithClaudeCli` calls so the user gets the
 *      predictions, just at the slower pace. This preserves the
 *      "no catch-log-continue" rule: the caller still gets a result per
 *      input, the cost is just degraded throughput.
 *
 * Per-batch contract: caller picks the batch size. 30 is the sweet spot for
 * the Meridian-scale spec (~8k chars, shared across all perms in a batch).
 * The shared bulk plus 30 short sequences (~3k chars) still fits comfortably
 * in Claude's context, and the response (30 × ~80 words ≈ 3200 tokens) fits
 * the default output budget.
 */
export async function predictManyWithClaudeCli(
  inputs: OracleInputs[],
): Promise<OracleResult[]> {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) {
    // No batching benefit; reuse the single-perm path so a failure surfaces
    // with the original error class.
    return [await predictWithClaudeCli(inputs[0]!)];
  }

  const prompt = buildBatchedOraclePrompt(inputs);

  const text = await new Promise<string>((resolveCli, rejectCli) => {
    const child = spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let resolved = false;
    // 90s is plenty for a single perm; a 30-perm batch realistically needs
    // ~20s (model output of ~3k tokens) but we triple the budget so a slow
    // Anthropic day doesn't kill the whole batch.
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      rejectCli(
        new Error(
          `claude-cli (batch of ${inputs.length}) timed out after 270s. ` +
            `If your auth was recently revoked, run '~/.local/bin/claude-bridge-doctor' to verify.`,
        ),
      );
    }, 270_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (e: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      rejectCli(
        new Error(
          `claude-cli batch spawn failed: ${e.message}. Is 'claude' on PATH? ` +
            `'claude auth login --claudeai' if auth is the issue.`,
        ),
      );
    });
    child.on("close", (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectCli(
          new Error(
            `claude-cli batch exited with code ${code}. Often means OAuth token revoked ` +
              `(see ~/Documents/Claude/Projects/BUG_PREVENTION.md). stderr: ${err.trim().slice(0, 400)}`,
          ),
        );
        return;
      }
      const trimmed = out.trim();
      if (!trimmed) {
        rejectCli(
          new Error(
            `claude-cli batch returned empty stdout (exit 0). stderr: ${err.trim().slice(0, 400)}`,
          ),
        );
        return;
      }
      resolveCli(trimmed);
    });
  });

  const parsed = parseBatchedResponse(text, inputs.length);
  return inputs.map((input, i) => ({
    source: "claude-cli" as PredictionSource,
    expected_post_state: parsed[i]!,
    confidence: 0.75,
    cost_usd: 0,
  }));
}

function buildBatchedOraclePrompt(inputs: OracleInputs[]): string {
  // All inputs in a batch SHOULD share the same spec / projectName /
  // targetUrl / description (they all come from the same run). We assert
  // that rather than silently using the first one — a future caller that
  // mixes runs together would get wrong predictions otherwise.
  const first = inputs[0]!;
  for (const inp of inputs) {
    if (inp.specText !== first.specText) {
      throw new Error(
        `predictManyWithClaudeCli: batch contains permutations from different specs; refusing to mix`,
      );
    }
    if (inp.projectName !== first.projectName || inp.targetUrl !== first.targetUrl) {
      throw new Error(
        `predictManyWithClaudeCli: batch contains permutations from different projects/targets`,
      );
    }
  }

  const descLine = first.projectDescription
    ? `Project description: ${first.projectDescription}`
    : `Project description: (none provided at vouch init)`;

  const sequenceBlocks: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i]!;
    sequenceBlocks.push(
      `## Permutation ${i + 1} (id=${inp.permutation.id}, length=${inp.permutation.action_ids.length})\n` +
        describeSequence(inp),
    );
  }

  return [
    `# Assignment`,
    ``,
    `You are the Oracle for Vouch, an agentic Model-Based Testing pipeline. Vouch maps the interactable surface of a product, generates action permutations, and asks you to predict the EXPECTED post-state for each permutation given the product's spec. Vouch then replays each permutation in a real browser and compares your prediction against the observed outcome.`,
    ``,
    `Your prediction IS the expected behavior. Vouch's verdict engine uses it as the source of truth for what should happen. If a prediction is vague or wrong, the verdict engine cannot tell pass from fail.`,
    ``,
    `In this call you are predicting for ${inputs.length} permutations at once (batched for throughput). Return one prediction per permutation, in order, in a JSON array.`,
    ``,
    `# Context summary`,
    ``,
    `Project: ${first.projectName}`,
    descLine,
    `Target URL: ${first.targetUrl}`,
    ``,
    `# Spec (the source of truth for what this product should do)`,
    ``,
    `"""`,
    first.specText.slice(0, 8000),
    `"""`,
    ``,
    `# Permutations to predict (${inputs.length} total, in order)`,
    ``,
    sequenceBlocks.join("\n\n"),
    ``,
    `# Contract for your response`,
    ``,
    `Return EXACTLY a JSON array of ${inputs.length} objects, in the same order as the permutations above. Schema per object:`,
    `  { "permutation_index": <1-based integer>, "expected_post_state": "<one paragraph, max 80 words>" }`,
    ``,
    `Hard rules for each "expected_post_state":`,
    `- One paragraph. No bullets. No multiple paragraphs.`,
    `- No preamble inside the string. First word is the observation, not "Here..." / "I think..." / "Based on...".`,
    `- Concrete. Name elements that should be visible, URL changes, error message text (quote verbatim if the spec specifies it), validation states.`,
    `- Grounded in the spec. If the spec contradicts a common-sense default, follow the spec.`,
    `- Predict the observable state, not the implementation.`,
    `- Order matters within each permutation. Action 1 happens THEN action 2.`,
    `- "type" actions appear only after a "focus_input" on the same selector. Trust that constraint.`,
    `- If the spec is silent on a behavior, say so briefly ("Spec is silent on X; expect default browser behavior of Y").`,
    ``,
    `Hard rules for the response itself:`,
    `- Emit a SINGLE JSON array. No markdown fence, no preamble, no trailing prose.`,
    `- All ${inputs.length} entries present. permutation_index runs 1..${inputs.length} with no gaps.`,
    `- Valid JSON parseable by JSON.parse on the exact stdout.`,
    ``,
    `Emit only the JSON array.`,
  ].join("\n");
}

function parseBatchedResponse(text: string, expectedCount: number): string[] {
  // Claude occasionally wraps the JSON in ```json fences despite the rule.
  // Strip a fenced block if present so JSON.parse sees clean JSON.
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) cleaned = fenceMatch[1]!.trim();
  // If there's leading prose before a `[` and trailing prose after `]`, snip
  // to the outermost JSON array. Defensive — should not happen given the
  // contract, but the cost is low and the recovery value is high.
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    cleaned = cleaned.slice(firstBracket, lastBracket + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `batched oracle response was not valid JSON: ${(err as Error).message}. First 200 chars: ${text.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`batched oracle response was not a JSON array; got ${typeof parsed}`);
  }
  if (parsed.length !== expectedCount) {
    throw new Error(
      `batched oracle response had ${parsed.length} entries, expected ${expectedCount}`,
    );
  }

  // Index-by-index extraction. We trust the order claude returned because we
  // explicitly asked for it; we still check the permutation_index field
  // matches so a reordered response triggers a clear error rather than a
  // silent misassignment.
  const out: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i] as { permutation_index?: unknown; expected_post_state?: unknown };
    if (typeof row !== "object" || row === null) {
      throw new Error(`batched oracle entry ${i} was not an object`);
    }
    if (row.permutation_index !== i + 1) {
      throw new Error(
        `batched oracle entry ${i} had permutation_index=${row.permutation_index}, expected ${i + 1} (out-of-order response)`,
      );
    }
    if (typeof row.expected_post_state !== "string" || row.expected_post_state.trim() === "") {
      throw new Error(
        `batched oracle entry ${i} had empty or non-string expected_post_state`,
      );
    }
    out.push(row.expected_post_state.trim());
  }
  return out;
}

/**
 * Public batched entry point. Caller-facing wrapper that respects the same
 * source-fallback contract as predictOne: any failure in the batch path
 * falls back to per-perm calls so the user gets a result per input — just
 * at degraded throughput rather than silent loss.
 */
export async function predictManyClaudeCliOrFallback(
  inputs: OracleInputs[],
): Promise<OracleResult[]> {
  if (inputs.length === 0) return [];
  try {
    return await predictManyWithClaudeCli(inputs);
  } catch (err) {
    process.stderr.write(
      `[vouch/oracle] batched claude-cli call failed (${inputs.length} perms); ` +
        `falling back to per-perm calls. Underlying: ${(err as Error).message}\n`,
    );
    const out: OracleResult[] = [];
    for (const input of inputs) {
      try {
        out.push(await predictWithClaudeCli(input));
      } catch (innerErr) {
        process.stderr.write(
          `[vouch/oracle] per-perm fallback also failed for '${input.permutation.id}'; ` +
            `using heuristic. Underlying: ${(innerErr as Error).message}\n`,
        );
        out.push(predictHeuristic(input));
      }
    }
    return out;
  }
}

function predictHeuristic(input: OracleInputs): OracleResult {
  // The heuristic does NOT consult the spec (it has no parser); it composes a
  // sentence per action from generic UI patterns. We do include the project
  // name in the preamble so the dashboard makes clear that the heuristic
  // can't define product-specific expected behavior, only generic patterns.
  const preamble = `On ${input.projectName} (target ${input.targetUrl}), the following generic UI patterns are expected:`;
  const sentences = input.permutation.action_ids.map((id, i) => {
    const a = input.actionsById.get(id);
    if (!a) return `Step ${i + 1}: (unknown action ${id})`;
    const num = i + 1;
    switch (a.kind) {
      case "click":
        return `Step ${num}: the user clicks ${a.description.replace(/^Click /, "")}; expect either a route change, a modal to open, or a state toggle on the same page.`;
      case "focus_input":
        return `Step ${num}: the user focuses ${a.description.replace(/^Focus /, "")}; expect a visible caret in the field and no other change.`;
      case "type":
        return `Step ${num}: the user types "${a.type_value ?? ""}" into ${a.description.replace(/^Type into /, "")}; expect the field's value to update and (on forms with live validation) a validation message if the value violates the field type.`;
      case "toggle_checkbox":
        return `Step ${num}: the user toggles ${a.description.replace(/^Toggle /, "")}; expect the checkbox's checked state to flip and any dependent UI to react.`;
      case "select_option":
        return `Step ${num}: the user selects an option in ${a.description.replace(/^Select option in /, "")}; expect the dropdown's value to update.`;
      case "resize_viewport":
        return `Step ${num}: the user resizes the viewport to 375x812 (mobile); expect a responsive layout shift such as a hamburger menu appearing or columns stacking.`;
    }
  });
  return {
    source: "heuristic",
    expected_post_state: `${preamble} ${sentences.join(" ")}`,
    confidence: 0.5,
    cost_usd: 0,
  };
}

function describeSequence(input: OracleInputs): string {
  const lines: string[] = [];
  for (let i = 0; i < input.permutation.action_ids.length; i++) {
    const a = input.actionsById.get(input.permutation.action_ids[i]!);
    if (!a) {
      lines.push(`${i + 1}. (unknown action id ${input.permutation.action_ids[i]})`);
      continue;
    }
    const sel = a.selector ? ` [selector: ${a.selector}]` : "";
    const val = a.type_value ? ` [types: "${a.type_value}"]` : "";
    lines.push(`${i + 1}. ${a.description}${sel}${val}`);
  }
  return lines.join("\n");
}

/** Build a Prediction row from an OracleResult. */
export function asPrediction(
  permutationId: string,
  result: OracleResult,
  existingNote: { text: string | null; editedAt: string | null } = { text: null, editedAt: null },
): Prediction {
  return {
    permutation_id: permutationId,
    source: result.source,
    expected_post_state: result.expected_post_state,
    confidence: result.confidence,
    cost_usd: result.cost_usd,
    generated_at: new Date().toISOString(),
    user_note_text: existingNote.text,
    user_note_edited_at: existingNote.editedAt,
  };
}
