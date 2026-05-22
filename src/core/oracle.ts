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

import { spawn } from "node:child_process";

import Anthropic from "@anthropic-ai/sdk";

import { type Action, type Permutation, type Prediction, type PredictionSource } from "./types.js";

const MODEL = "claude-haiku-4-5-20251001";

export interface OracleInputs {
  permutation: Permutation;
  actionsById: Map<string, Action>;
  specText: string;
}

export interface OracleResult {
  source: PredictionSource;
  expected_post_state: string;
  confidence: number;
  cost_usd: number;
}

/**
 * The user can override the auto-detected source with --oracle. When omitted,
 * Vouch picks the best available: anthropic-haiku if ANTHROPIC_API_KEY is set,
 * otherwise heuristic. The user has to explicitly opt into claude-cli with
 * --oracle claude-cli because it's slower and counts against their Claude
 * subscription rate limit.
 */
export function detectOracleSource(): PredictionSource {
  return process.env.ANTHROPIC_API_KEY ? "anthropic-haiku" : "heuristic";
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

async function predictWithAnthropic(input: OracleInputs): Promise<OracleResult> {
  const client = new Anthropic({});
  const sequenceText = describeSequence(input);
  const prompt =
    `You are predicting what a user will OBSERVE after running a short interaction ` +
    `sequence against a web page. Use the project spec to ground your answer in real expected behavior.\n\n` +
    `Project spec:\n"""\n${input.specText.slice(0, 8000)}\n"""\n\n` +
    `Interaction sequence (in order):\n${sequenceText}\n\n` +
    `Respond with ONE paragraph (max 80 words) describing the expected post-state. ` +
    `Be concrete: name elements that should be visible, URL changes, or error messages. ` +
    `Do not include any preamble or meta-commentary; emit only the paragraph.`;

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
  const sequenceText = describeSequence(input);
  const prompt =
    `You are predicting what a user will OBSERVE after running a short interaction ` +
    `sequence against a web page. Use the project spec to ground your answer in real expected behavior.\n\n` +
    `Project spec:\n"""\n${input.specText.slice(0, 8000)}\n"""\n\n` +
    `Interaction sequence (in order):\n${sequenceText}\n\n` +
    `Respond with ONE paragraph (max 80 words) describing the expected post-state. ` +
    `Be concrete: name elements that should be visible, URL changes, or error messages. ` +
    `Do not include any preamble or meta-commentary; emit only the paragraph.`;

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

function predictHeuristic(input: OracleInputs): OracleResult {
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
    expected_post_state: sentences.join(" "),
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
