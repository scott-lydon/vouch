// Expectation Verifier.
//
// After the Executor records `observed_post_state` for each permutation, this
// module compares it against the Oracle's `expected_post_state`. The "do
// these describe the same outcome" question is what turns a green Playwright
// run into actual bug-finding: a permutation that produces a verdict of
// `pass` in Playwright but a `mismatch` here is a candidate SUT bug.
//
// Source selection mirrors the Oracle:
//   - claude-cli — uses the local Claude CLI; auto-loads vouch/CLAUDE.md.
//   - anthropic-haiku — direct API; cheapest with sufficient capability.
//   - heuristic — deterministic substring overlap, no LLM. Coarse but free.
//
// The user can A/B sources by passing --verify-source on `vouch campaign`.

import { spawn } from "node:child_process";

import Anthropic from "@anthropic-ai/sdk";

import { type PredictionSource } from "./types.js";

const MODEL = "claude-haiku-4-5-20251001";

export interface ExpectationVerdict {
  permutation_id: string;
  /** Did the observed state match the expected state? */
  match: boolean;
  /** Source-attributed reasoning. */
  reasoning: string;
  /** Same source vocabulary as Prediction. */
  source: PredictionSource;
  cost_usd: number;
  generated_at: string;
}

export interface VerifyInputs {
  permutationId: string;
  expectedPostState: string;
  observedPostState: string;
  /** Project context for the LLM prompt. */
  projectName: string;
  targetUrl: string;
}

export async function verifyExpectation(
  input: VerifyInputs,
  source: PredictionSource,
): Promise<ExpectationVerdict> {
  if (source === "anthropic-haiku") {
    try {
      return await verifyWithAnthropic(input);
    } catch (err) {
      process.stderr.write(
        `[vouch/verify] Anthropic call failed for '${input.permutationId}'; ` +
          `falling back to heuristic. Underlying: ${(err as Error).message}\n`,
      );
      return verifyHeuristic(input);
    }
  }
  if (source === "claude-cli") {
    try {
      return await verifyWithClaudeCli(input);
    } catch (err) {
      process.stderr.write(
        `[vouch/verify] claude-cli call failed for '${input.permutationId}'; ` +
          `falling back to heuristic. Underlying: ${(err as Error).message}\n`,
      );
      return verifyHeuristic(input);
    }
  }
  return verifyHeuristic(input);
}

function buildVerifyPrompt(input: VerifyInputs): string {
  return [
    `# Assignment`,
    ``,
    `You are the Expectation Verifier for Vouch, an agentic Model-Based Testing pipeline.`,
    `For one permutation, the Oracle predicted what a user would observe after the action sequence.`,
    `The Executor then actually ran the sequence in a real browser and captured what was actually observed.`,
    ``,
    `Your job: tell Vouch whether the two describe the SAME OUTCOME.`,
    ``,
    `# Context`,
    ``,
    `Project: ${input.projectName}`,
    `Target URL: ${input.targetUrl}`,
    ``,
    `# Expected (Oracle's prediction)`,
    ``,
    `"""`,
    input.expectedPostState,
    `"""`,
    ``,
    `# Observed (Executor's capture from the real browser)`,
    ``,
    `"""`,
    input.observedPostState,
    `"""`,
    ``,
    `# Contract for your response`,
    ``,
    `Respond with EXACTLY two lines, in this order:`,
    `Line 1: the word MATCH or MISMATCH (uppercase, nothing else on the line).`,
    `Line 2: one sentence (max 40 words) explaining the call. If MISMATCH, name the specific divergence AND classify it with one of these prefixes:`,
    ``,
    `  "Likely SUT bug:" — the divergence is in required structure, action behavior, named error messages, navigation, validation messages, or other things the spec says should always happen the same way regardless of data. Example: spec says clicking "Sign up" with an empty form shows a specific error; observed shows nothing.`,
    ``,
    `  "Likely spec brittleness:" — the divergence is ONLY in specific counts, names, ids, dates, dollar amounts, or other data that legitimately varies between test runs, AND the structural behavior is otherwise consistent with the spec. Example: spec says "1 project listed"; observed shows 3 projects but the list rendering and project-card shape are correct.`,
    ``,
    `When in doubt, prefer "Likely SUT bug:" — the operator can downgrade after review, but a spec-brittleness misclassification of a real bug means the bug ships.`,
    ``,
    `Be strict on MATCH vs MISMATCH. Vouch uses your verdict to decide whether a permutation found a real bug candidate. A permutation that should have shown a success message but instead showed nothing is a MISMATCH (Likely SUT bug), not a MATCH-with-caveat. The classification prefix on line 2 helps the operator triage; it does NOT soften the MISMATCH itself.`,
    ``,
    `Emit nothing else: no preamble, no markdown, no JSON, just the two lines.`,
  ].join("\n");
}

function parseVerdictText(
  text: string,
  source: PredictionSource,
  permutationId: string,
  cost_usd: number,
): ExpectationVerdict {
  const lines = text.trim().split(/\r?\n/);
  const first = (lines[0] ?? "").trim().toUpperCase();
  const reasoning = (lines.slice(1).join(" ").trim()) || "(no reasoning provided)";
  let match: boolean;
  if (first === "MATCH") match = true;
  else if (first === "MISMATCH") match = false;
  else {
    // Best-effort recovery: scan the response for either keyword.
    if (/MATCH(?!\w)/.test(text) && !/MISMATCH/.test(text)) match = true;
    else if (/MISMATCH/.test(text)) match = false;
    else {
      throw new Error(
        `verify: ${source} returned a response that did not contain MATCH or MISMATCH on the first line. ` +
          `Raw: ${text.slice(0, 200)}`,
      );
    }
  }
  return {
    permutation_id: permutationId,
    match,
    reasoning,
    source,
    cost_usd,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Caching + cost helpers, mirrored from oracle.ts. Pricing constants are
// duplicated rather than imported because the verifier may diverge model
// choices in the future (e.g. a cheaper rubric-only model). Today both paths
// run Haiku 4.5 at the same prices.
// ---------------------------------------------------------------------------

interface AnthropicCacheUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

const PRICE_INPUT_PER_MTOK = 1.0;
const PRICE_OUTPUT_PER_MTOK = 5.0;
const PRICE_CACHE_WRITE_PER_MTOK = 1.25;
const PRICE_CACHE_READ_PER_MTOK = 0.1;

function computeAnthropicCost(usage: AnthropicCacheUsage): number {
  const fresh = usage.input_tokens / 1_000_000;
  const cw = (usage.cache_creation_input_tokens ?? 0) / 1_000_000;
  const cr = (usage.cache_read_input_tokens ?? 0) / 1_000_000;
  const out = usage.output_tokens / 1_000_000;
  return (
    fresh * PRICE_INPUT_PER_MTOK +
    cw * PRICE_CACHE_WRITE_PER_MTOK +
    cr * PRICE_CACHE_READ_PER_MTOK +
    out * PRICE_OUTPUT_PER_MTOK
  );
}

/**
 * Verifier system prompt: the contract boilerplate + classification rubric.
 * Stable across every case in a run, so we mark it cacheable. Project name
 * and target URL go here too because they are constant for the run.
 *
 * The block may sometimes fall below Anthropic's minimum-cacheable threshold
 * (1024 tokens for Haiku). Setting cache_control is still safe: the API
 * treats it as a hint and silently skips caching when the threshold is not
 * met. We always pay batched savings either way.
 */
function buildCachedVerifySystemPrompt(input: VerifyInputs): string {
  return [
    `You are the Expectation Verifier for Vouch, an agentic Model-Based Testing pipeline.`,
    `For one or more (expected, observed) pairs, decide whether the two describe the SAME OUTCOME.`,
    ``,
    `# Context (stable for this run)`,
    ``,
    `Project: ${input.projectName}`,
    `Target URL: ${input.targetUrl}`,
    ``,
    `# Classification rubric (use the same prefixes regardless of how this call is shaped)`,
    ``,
    `When MISMATCH or match=false, prefix the reasoning with one of:`,
    `  "Likely SUT bug:" — the divergence is in required structure, action behavior, named error messages, navigation, validation, or other behavior the spec says should always happen the same way regardless of data.`,
    `  "Likely spec brittleness:" — the divergence is ONLY in specific counts, names, ids, dates, dollar amounts, or other data that legitimately varies between test runs, AND the structural behavior is otherwise consistent with the spec.`,
    `When in doubt, prefer "Likely SUT bug:" — a misclassified bug ships; a misclassified brittleness gets quickly downgraded in review.`,
    ``,
    `Be strict on match vs mismatch. A permutation that should have shown a success message but instead showed nothing is a MISMATCH, not a match-with-caveat. The classification prefix on the reasoning line helps the operator triage; it does NOT soften the mismatch itself.`,
  ].join("\n");
}

/** Variable per-call content for the single-case path. */
function buildVerifyUserPrompt(input: VerifyInputs): string {
  return [
    `# Expected (Oracle's prediction)`,
    ``,
    `"""`,
    input.expectedPostState,
    `"""`,
    ``,
    `# Observed (Executor's capture from the real browser)`,
    ``,
    `"""`,
    input.observedPostState,
    `"""`,
    ``,
    `# Contract for your response`,
    ``,
    `Respond with EXACTLY two lines, in this order:`,
    `Line 1: the word MATCH or MISMATCH (uppercase, nothing else on the line).`,
    `Line 2: one sentence (max 40 words) explaining the call. If MISMATCH, name the specific divergence and prefix with the classification described above.`,
    ``,
    `Emit nothing else: no preamble, no markdown, no JSON, just the two lines.`,
  ].join("\n");
}

async function verifyWithAnthropic(input: VerifyInputs): Promise<ExpectationVerdict> {
  const client = new Anthropic({});
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 128,
    system: [
      {
        type: "text",
        text: buildCachedVerifySystemPrompt(input),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildVerifyUserPrompt(input) }],
  });
  const text = resp.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error(`Anthropic returned empty response (stop_reason=${resp.stop_reason})`);
  }
  const cost = computeAnthropicCost(resp.usage as AnthropicCacheUsage);
  return parseVerdictText(text, "anthropic-haiku", input.permutationId, Number(cost.toFixed(6)));
}

async function verifyWithClaudeCli(input: VerifyInputs): Promise<ExpectationVerdict> {
  const prompt = buildVerifyPrompt(input);
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
      rejectCli(new Error(`claude-cli timed out after 60s for verify of '${input.permutationId}'.`));
    }, 60_000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", (e: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      rejectCli(new Error(`claude-cli spawn failed: ${e.message}`));
    });
    child.on("close", (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectCli(new Error(`claude-cli exited ${code}. stderr: ${err.trim().slice(0, 200)}`));
        return;
      }
      const trimmed = out.trim();
      if (!trimmed) {
        rejectCli(new Error(`claude-cli returned empty stdout (exit 0). stderr: ${err.trim().slice(0, 200)}`));
        return;
      }
      resolveCli(trimmed);
    });
  });
  return parseVerdictText(text, "claude-cli", input.permutationId, 0);
}

/**
 * BATCHED claude-cli verifier. Mirrors predictManyWithClaudeCli in oracle.ts
 * for the same reason: the per-call subprocess spawn dominates wallclock on
 * claude-cli, so paying it once per N perms gives ~Nx speedup on the verify
 * phase. With the oracle and verifier both batched, a 289-perm depth-2 run
 * drops from ~2 hours to ~15-20 minutes wallclock end-to-end.
 *
 * Same trade-off as the oracle: a malformed JSON response loses the whole
 * batch, but the public wrapper falls back to per-perm calls so the user
 * gets a verdict per input.
 *
 * Hard rule kept from per-perm path: a permutation whose verdict cannot be
 * parsed produces an ExpectationVerdict, not an exception, so the run still
 * writes one verdict-row per execution.
 */
async function verifyManyWithClaudeCli(
  inputs: VerifyInputs[],
): Promise<ExpectationVerdict[]> {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) {
    return [await verifyWithClaudeCli(inputs[0]!)];
  }

  const prompt = buildBatchedVerifyPrompt(inputs);

  const text = await new Promise<string>((resolveCli, rejectCli) => {
    const child = spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let resolved = false;
    // 180s budget for a 30-perm verify batch — each verdict is two lines so
    // the model output is ~30 × ~50 words ≈ 1500 tokens, which is faster
    // than the oracle's 3200-token batch.
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      rejectCli(
        new Error(
          `claude-cli verify batch of ${inputs.length} timed out after 180s.`,
        ),
      );
    }, 180_000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", (e: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      rejectCli(new Error(`claude-cli verify batch spawn failed: ${e.message}`));
    });
    child.on("close", (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectCli(
          new Error(
            `claude-cli verify batch exited ${code}. stderr: ${err.trim().slice(0, 200)}`,
          ),
        );
        return;
      }
      const trimmed = out.trim();
      if (!trimmed) {
        rejectCli(
          new Error(
            `claude-cli verify batch empty stdout (exit 0). stderr: ${err.trim().slice(0, 200)}`,
          ),
        );
        return;
      }
      resolveCli(trimmed);
    });
  });

  const parsed = parseBatchedVerifyResponse(text, inputs.length);
  return inputs.map((input, i) => ({
    permutation_id: input.permutationId,
    match: parsed[i]!.match,
    reasoning: parsed[i]!.reasoning,
    source: "claude-cli" as PredictionSource,
    cost_usd: 0,
    generated_at: new Date().toISOString(),
  }));
}

function buildBatchedVerifyPrompt(inputs: VerifyInputs[]): string {
  const first = inputs[0]!;
  for (const inp of inputs) {
    if (inp.projectName !== first.projectName || inp.targetUrl !== first.targetUrl) {
      throw new Error(
        `verifyManyWithClaudeCli: batch contains perms from different projects/targets`,
      );
    }
  }

  const cases: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i]!;
    cases.push(
      `## Case ${i + 1} (permutation_id=${inp.permutationId})\n` +
        `### Expected (Oracle's prediction)\n"""\n${inp.expectedPostState}\n"""\n` +
        `### Observed (Executor's capture)\n"""\n${inp.observedPostState}\n"""`,
    );
  }

  return [
    `# Assignment`,
    ``,
    `You are the Expectation Verifier for Vouch, an agentic Model-Based Testing pipeline. For each (expected, observed) pair below, decide whether the two describe the SAME OUTCOME.`,
    ``,
    `In this call you are verifying ${inputs.length} cases at once (batched for throughput). Return one verdict per case, in order, in a JSON array.`,
    ``,
    `# Context`,
    ``,
    `Project: ${first.projectName}`,
    `Target URL: ${first.targetUrl}`,
    ``,
    `# Cases to verify (${inputs.length} total, in order)`,
    ``,
    cases.join("\n\n"),
    ``,
    `# Contract for your response`,
    ``,
    `Return EXACTLY a JSON array of ${inputs.length} objects, in the same order as the cases above. Schema per object:`,
    `  { "case_index": <1-based integer>, "match": <true | false>, "reasoning": "<one sentence, max 40 words>" }`,
    ``,
    `Rules for each verdict:`,
    `- match=true means the expected and observed describe the same outcome.`,
    `- match=false means they diverge in a way a user would notice.`,
    `- reasoning is one sentence. If match=false, name the specific divergence AND prefix with a classification so the operator can triage:`,
    `    "Likely SUT bug: <divergence>" — required structure, action behavior, named error messages, navigation, validation — things the spec says should always happen the same way regardless of data.`,
    `    "Likely spec brittleness: <divergence>" — the divergence is ONLY in specific counts, names, ids, dates, dollar amounts, or other data that legitimately varies between test runs, AND the structural behavior is otherwise consistent with the spec.`,
    `  When in doubt, prefer "Likely SUT bug:" — a misclassified bug ships; a misclassified brittleness gets quickly downgraded in review.`,
    `- Be strict on match. A permutation that should have shown a success message but instead showed nothing is match=false (Likely SUT bug), not match=true-with-caveat.`,
    ``,
    `Rules for the response itself:`,
    `- Emit a SINGLE JSON array. No markdown fence, no preamble, no trailing prose.`,
    `- All ${inputs.length} entries present. case_index runs 1..${inputs.length} with no gaps.`,
    `- match is a JSON boolean (true/false), not the string "MATCH"/"MISMATCH".`,
    `- Valid JSON parseable by JSON.parse on the exact stdout.`,
    ``,
    `Emit only the JSON array.`,
  ].join("\n");
}

function parseBatchedVerifyResponse(
  text: string,
  expectedCount: number,
): { match: boolean; reasoning: string }[] {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) cleaned = fenceMatch[1]!.trim();
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
      `batched verify response was not valid JSON: ${(err as Error).message}. First 200 chars: ${text.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`batched verify response was not a JSON array; got ${typeof parsed}`);
  }
  if (parsed.length !== expectedCount) {
    throw new Error(
      `batched verify response had ${parsed.length} entries, expected ${expectedCount}`,
    );
  }

  const out: { match: boolean; reasoning: string }[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i] as {
      case_index?: unknown;
      match?: unknown;
      reasoning?: unknown;
    };
    if (typeof row !== "object" || row === null) {
      throw new Error(`batched verify entry ${i} was not an object`);
    }
    if (row.case_index !== i + 1) {
      throw new Error(
        `batched verify entry ${i} had case_index=${row.case_index}, expected ${i + 1} (out-of-order response)`,
      );
    }
    if (typeof row.match !== "boolean") {
      throw new Error(
        `batched verify entry ${i} had non-boolean match=${JSON.stringify(row.match)}`,
      );
    }
    const reasoning =
      typeof row.reasoning === "string" && row.reasoning.trim() !== ""
        ? row.reasoning.trim()
        : "(no reasoning provided)";
    out.push({ match: row.match, reasoning });
  }
  return out;
}

/**
 * Public batched entry point. Same fallback contract as the oracle wrapper.
 */
export async function verifyManyClaudeCliOrFallback(
  inputs: VerifyInputs[],
): Promise<ExpectationVerdict[]> {
  if (inputs.length === 0) return [];
  try {
    return await verifyManyWithClaudeCli(inputs);
  } catch (err) {
    process.stderr.write(
      `[vouch/verify] batched claude-cli call failed (${inputs.length} perms); ` +
        `falling back to per-perm calls. Underlying: ${(err as Error).message}\n`,
    );
    const out: ExpectationVerdict[] = [];
    for (const input of inputs) {
      try {
        out.push(await verifyWithClaudeCli(input));
      } catch (innerErr) {
        process.stderr.write(
          `[vouch/verify] per-perm fallback also failed for '${input.permutationId}'; ` +
            `using heuristic. Underlying: ${(innerErr as Error).message}\n`,
        );
        out.push(verifyHeuristic(input));
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Batched Anthropic verifier with the same caching pattern as the oracle:
// the contract preamble + classification rubric live in the cached system
// block, and the variable per-case content (expected + observed) lives in
// the user message. Combined with N-case batching this brings a verify pass
// to single-digit cents on a typical run, vs the subscription drain caused
// by claude-cli when run at depth.
// ---------------------------------------------------------------------------

function buildBatchedVerifyUserPrompt(inputs: VerifyInputs[]): string {
  const cases: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i]!;
    cases.push(
      `## Case ${i + 1} (permutation_id=${inp.permutationId})\n` +
        `### Expected (Oracle's prediction)\n"""\n${inp.expectedPostState}\n"""\n` +
        `### Observed (Executor's capture)\n"""\n${inp.observedPostState}\n"""`,
    );
  }
  return [
    `In this call you are verifying ${inputs.length} cases at once (batched for throughput). Return one verdict per case, in order, in a JSON array.`,
    ``,
    `# Cases to verify (${inputs.length} total, in order)`,
    ``,
    cases.join("\n\n"),
    ``,
    `# Contract for your response`,
    ``,
    `Return EXACTLY a JSON array of ${inputs.length} objects, in the same order as the cases above. Schema per object:`,
    `  { "case_index": <1-based integer>, "match": <true | false>, "reasoning": "<one sentence, max 40 words>" }`,
    ``,
    `For each verdict:`,
    `- match=true means expected and observed describe the same outcome.`,
    `- match=false means they diverge in a way a user would notice.`,
    `- reasoning is one sentence. If match=false, follow the classification rubric in the system prompt (prefix with "Likely SUT bug:" or "Likely spec brittleness:").`,
    ``,
    `Hard rules for the response itself:`,
    `- Emit a SINGLE JSON array. No markdown fence, no preamble, no trailing prose.`,
    `- All ${inputs.length} entries present. case_index runs 1..${inputs.length} with no gaps.`,
    `- match is a JSON boolean (true/false), not the string "MATCH"/"MISMATCH".`,
    `- Valid JSON parseable by JSON.parse on the exact stdout.`,
    ``,
    `Emit only the JSON array.`,
  ].join("\n");
}

export async function verifyManyWithAnthropic(
  inputs: VerifyInputs[],
): Promise<ExpectationVerdict[]> {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) {
    return [await verifyWithAnthropic(inputs[0]!)];
  }

  const first = inputs[0]!;
  for (const inp of inputs) {
    if (inp.projectName !== first.projectName || inp.targetUrl !== first.targetUrl) {
      throw new Error(
        `verifyManyWithAnthropic: batch contains cases from different projects/targets.`,
      );
    }
  }

  const client = new Anthropic({});
  const resp = await client.messages.create({
    model: MODEL,
    // Two lines per case at ~50 tokens each + JSON scaffolding. Capped to
    // stop a runaway from blowing the output budget.
    max_tokens: Math.min(8192, 120 * inputs.length + 256),
    system: [
      {
        type: "text",
        text: buildCachedVerifySystemPrompt(first),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildBatchedVerifyUserPrompt(inputs) }],
  });
  const text = resp.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error(
      `Anthropic batched verify call returned empty response (id=${resp.id}, stop_reason=${resp.stop_reason}). ` +
        `If stop_reason is "max_tokens", the batch is too large; lower the batch size in cli.ts.`,
    );
  }

  const parsed = parseBatchedVerifyResponse(text, inputs.length);
  const batchCost = computeAnthropicCost(resp.usage as AnthropicCacheUsage);
  const perPerm = Number((batchCost / inputs.length).toFixed(6));
  return inputs.map((input, i) => ({
    permutation_id: input.permutationId,
    match: parsed[i]!.match,
    reasoning: parsed[i]!.reasoning,
    source: "anthropic-haiku" as PredictionSource,
    cost_usd: perPerm,
    generated_at: new Date().toISOString(),
  }));
}

/** Public batched entry point with the same fallback contract as the CLI wrapper. */
export async function verifyManyAnthropicOrFallback(
  inputs: VerifyInputs[],
): Promise<ExpectationVerdict[]> {
  if (inputs.length === 0) return [];
  try {
    return await verifyManyWithAnthropic(inputs);
  } catch (err) {
    process.stderr.write(
      `[vouch/verify] batched Anthropic call failed (${inputs.length} perms); ` +
        `falling back to per-perm Anthropic calls. Underlying: ${(err as Error).message}\n`,
    );
    const out: ExpectationVerdict[] = [];
    for (const input of inputs) {
      try {
        out.push(await verifyWithAnthropic(input));
      } catch (innerErr) {
        process.stderr.write(
          `[vouch/verify] per-perm Anthropic fallback also failed for '${input.permutationId}'; ` +
            `using heuristic. Underlying: ${(innerErr as Error).message}\n`,
        );
        out.push(verifyHeuristic(input));
      }
    }
    return out;
  }
}

/**
 * Heuristic: substring + token overlap. No LLM. Returns match=true if the
 * observed post-state contains at least 60% of the "salient" tokens from the
 * expected (lower-cased, length >= 4, excluding stop-words). The threshold is
 * intentionally lenient because the heuristic can't reason about semantic
 * equivalence; we'd rather under-flag than over-flag in the no-LLM case.
 */
function verifyHeuristic(input: VerifyInputs): ExpectationVerdict {
  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
    "to", "of", "in", "on", "at", "for", "with", "by", "from", "as", "that", "this",
    "it", "its", "should", "would", "could", "will", "may", "might", "user",
  ]);
  const tokenize = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !stop.has(t));
  const expected = new Set(tokenize(input.expectedPostState));
  const observed = new Set(tokenize(input.observedPostState));
  if (expected.size === 0) {
    return {
      permutation_id: input.permutationId,
      match: true,
      reasoning: "Heuristic: expected text had no salient tokens to check against; cannot disprove match.",
      source: "heuristic",
      cost_usd: 0,
      generated_at: new Date().toISOString(),
    };
  }
  let overlap = 0;
  for (const t of expected) if (observed.has(t)) overlap++;
  const ratio = overlap / expected.size;
  const match = ratio >= 0.6;
  return {
    permutation_id: input.permutationId,
    match,
    reasoning:
      `Heuristic: ${overlap}/${expected.size} salient tokens from expected appear in observed (${Math.round(ratio * 100)}%). ` +
      `Threshold 60%. ${match ? "Match." : "Mismatch."} (For semantic comparison, set ANTHROPIC_API_KEY or install Claude CLI.)`,
    source: "heuristic",
    cost_usd: 0,
    generated_at: new Date().toISOString(),
  };
}
