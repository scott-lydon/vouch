// Visual sketchy-checker.
//
// After the executor produces a screenshot for a permutation, this module
// asks a vision-capable LLM "does anything look broken or confusing in this
// image?" and writes a structured verdict. The dashboard renders a brown
// "sketchy" badge for any permutation whose verdict is `sketchy`.
//
// Why this exists: Vouch's other phases (Oracle, Verifier) reason about
// post-state TEXT. They cannot see contrast issues, misalignment, missing
// loading animations, "is this your car" hero copy that disappears against
// its background, or jargon like "Slice 1 of 5" that an engineer left in
// the UI for themselves. Carvana passed Vouch's text-only verify in
// 2026-05-23 but had eleven visual issues a 10-year-old could have spotted
// from a screenshot. This phase closes that gap.
//
// Model choice: claude-haiku-4-5-20251001. Same model the oracle and
// verifier use, so the operator only needs ANTHROPIC_API_KEY set once. Has
// vision. Cheapest tier that can reason about UI screenshots semantically.
// Prompt caching applies to the rubric block on repeat calls in the same
// 5-minute window, so a 2000-perm run costs ~$0.50-$1 not $5+.

import { readFileSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";

import { type PredictionSource } from "./types.js";

const MODEL = "claude-haiku-4-5-20251001";

/** Hard cap on issues per screenshot. Above this the rest are truncated. */
const MAX_ISSUES = 8;

/** Hard cap on per-issue description length, so a runaway model can't drain the budget. */
const MAX_ISSUE_CHARS = 240;

/**
 * The verdict we write per permutation. "clean" means the screenshot looked
 * normal. "sketchy" means at least one human-noticeable visual issue was
 * found and the dashboard should brown-flag this permutation.
 *
 * Schema chosen for forward-compat: `issues` is a list so a single screenshot
 * can ship multiple findings (low-contrast hero + misaligned form field +
 * stuck spinner) without forcing the caller into multiple LLM calls.
 */
export type SketchyVerdictValue = "clean" | "sketchy" | "unsupported";

export interface SketchyVerdict {
  permutation_id: string;
  verdict: SketchyVerdictValue;
  /** Human-readable findings. Empty when verdict is `clean` or `unsupported`. */
  issues: string[];
  /** The model / heuristic that produced the verdict. */
  source: SketchySource;
  cost_usd: number;
  generated_at: string;
}

export type SketchySource = "anthropic-haiku-vision" | "unavailable";

export interface SketchyCheckInputs {
  permutationId: string;
  /**
   * Absolute path to the screenshot PNG to analyze. Usually the FINAL
   * screenshot of the permutation (post-last-step). For an empty-baseline
   * permutation, this is the post-navigation landing-page screenshot.
   */
  screenshotPath: string;
  /**
   * Spec text the SUT advertises. The checker is told "evaluate against
   * this spec" so a deliberate design choice doesn't get flagged as a bug.
   * Example: if the spec says "the hero subtitle is faint by design", a
   * faint hero subtitle should not be sketchy.
   */
  specText: string;
  /** Friendly name for the model's reasoning context. */
  projectName: string;
  /** URL of the SUT, included for the model's grounding. */
  targetUrl: string;
}

/**
 * Pick a sketchy source from what's available in the environment, mirroring
 * detectOracleSource() in oracle.ts. We do NOT fall back to a heuristic —
 * there's no useful text-only sketchy-check, and pretending we did one would
 * make the dashboard's brown-flag noise instead of signal.
 *
 * Returns `unavailable` if ANTHROPIC_API_KEY is not set. The caller is
 * expected to log a one-line note that the sketchy phase was skipped, NOT
 * to crash the run.
 */
export function detectSketchySource(): SketchySource {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic-haiku-vision";
  return "unavailable";
}

/**
 * Anthropic's vision API media_type for a screenshot, derived from the file
 * extension. Wrong here would have the API silently misinterpret the bytes
 * (the 2026-05-24 adaptive-screenshot change switched the executor's default
 * capture from PNG to JPEG; before this helper landed, sketchy.ts hardcoded
 * "image/png" and would have shipped JPEG bytes under a PNG label).
 *
 * Throws on unsupported extensions rather than defaulting silently, so a
 * future format addition (webp, gif) surfaces as a loud failure at the
 * boundary instead of as a confusing vision-model response.
 */
export type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export function mediaTypeForScreenshot(path: string): AnthropicImageMediaType {
  // Lowercase extension lookup; case-insensitive because Playwright writes
  // the extension we passed but the path can be re-derived from user input.
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  throw new Error(
    `sketchy: cannot derive Anthropic media_type for screenshot path '${path}'. ` +
      `Supported extensions: .jpg / .jpeg / .png / .gif / .webp. ` +
      `The executor should have written one of these; check the screenshot capture in executor.ts.`,
  );
}

/**
 * Read a screenshot from disk and base64-encode it for the Anthropic vision
 * API. Format-agnostic — see `mediaTypeForScreenshot` for the format
 * derivation that pairs with this call. Throws with a clear hint if the
 * file is missing — the executor is supposed to have written it just before
 * this call, so a missing file is an executor bug, not a user-actionable
 * problem.
 */
function readImageBase64(path: string): string {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new Error(
      `sketchy: could not read screenshot at '${path}'. ` +
        `The executor is supposed to write this file before the sketchy phase runs; ` +
        `if it doesn't exist, the executor either crashed or its screenshotsDir option was off. ` +
        `Inner error: ${(err as Error).message}`,
    );
  }
  return raw.toString("base64");
}

/**
 * Build the system + user prompt for one sketchy check. Factored out so the
 * tests (which don't call the network) can assert what gets sent.
 */
export function buildSketchyPromptContent(input: SketchyCheckInputs): {
  system: string;
  userText: string;
} {
  const system =
    "You are a UI quality reviewer for an automated QA tool called Vouch. " +
    "You look at one screenshot of a web app under test and decide whether " +
    "the screenshot shows a visible problem a real user would notice. " +
    "You are explicitly NOT verifying that a button does what the spec says " +
    "(another phase handles that). You are looking for visual / UX / copy " +
    "problems in the rendered image itself.\n\n" +
    "Things to flag (each one is sketchy on its own):\n" +
    "1. Low-contrast text that's hard to read against its background.\n" +
    "2. Misaligned form fields, labels that don't line up with their inputs.\n" +
    "3. Empty / black / placeholder image boxes where a real image should be.\n" +
    "4. Loading states with no progress affordance (a static 'Loading...' for " +
    "longer than a second feels broken).\n" +
    "5. Engineering jargon visible to end users: 'Slice', 'permutation', " +
    "'depth N', internal IDs, debug stubs, lorem ipsum, env-var prompts.\n" +
    "6. Error strings that quote internal details (paths, stack traces, " +
    "base64 hints, SQL).\n" +
    "7. Unrendered markdown bleeding into chat output: visible '**' or '__' " +
    "or backticks where formatting was intended.\n" +
    "8. Counters / timers that have no purpose other than to stress the user " +
    "('Elapsed: 15 min').\n" +
    "9. Buttons promising an outcome that the visible state doesn't deliver " +
    "(\"Get my offer\" with no offer shown).\n" +
    "10. Workflows that ask for an output the user never gave the input for " +
    "(\"Schedule pickup\" without an address field).\n\n" +
    "Things to NOT flag:\n" +
    "- Color choices the spec calls out as intentional.\n" +
    "- Layouts that look unusual but are functionally fine.\n" +
    "- Anything that requires interacting with the page (clicks, scrolls).\n\n" +
    "Reply in this exact format on a single line, no extra prose:\n" +
    "VERDICT: <clean|sketchy>\n" +
    "ISSUES: <one issue per line below, empty list if clean>\n" +
    "Each issue line: <one-sentence description of what's wrong>";

  const userText =
    `Project: ${input.projectName}\n` +
    `URL under test: ${input.targetUrl}\n\n` +
    `Spec context (the source-of-truth for what the SUT is supposed to do):\n` +
    `---\n${input.specText.slice(0, 6_000)}\n---\n\n` +
    `Evaluate the attached screenshot for VISIBLE PROBLEMS as defined above.`;

  return { system, userText };
}

/**
 * Parse the model's structured reply into a verdict + issue list. Defensive:
 * if the model goes off-script we DEGRADE to `clean` with a note in the
 * issue list, because a parse failure should not block the campaign.
 */
export function parseSketchyReply(reply: string): {
  verdict: SketchyVerdictValue;
  issues: string[];
} {
  const verdictMatch = reply.match(/VERDICT:\s*(clean|sketchy)/i);
  if (!verdictMatch) {
    return {
      verdict: "clean",
      issues: [
        "sketchy-parse: model reply did not contain a VERDICT line; treating as clean to avoid false-positive noise. " +
          `Raw: ${reply.slice(0, 200)}`,
      ],
    };
  }
  const verdict = verdictMatch[1]!.toLowerCase() === "sketchy" ? "sketchy" : "clean";
  if (verdict === "clean") return { verdict, issues: [] };

  const issuesBlock = reply.split(/ISSUES:/i)[1] ?? "";
  const issues = issuesBlock
    .split("\n")
    .map((line) => line.replace(/^[\s\-•*0-9.()]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_ISSUES)
    .map((line) => (line.length > MAX_ISSUE_CHARS ? line.slice(0, MAX_ISSUE_CHARS) + "…" : line));

  // If verdict said sketchy but we couldn't extract any issues, downgrade
  // to clean rather than report "sketchy with no reason" — that's noise.
  if (issues.length === 0) {
    return {
      verdict: "clean",
      issues: [
        "sketchy-parse: model returned VERDICT=sketchy but no ISSUES lines. Downgraded to clean to suppress noise.",
      ],
    };
  }
  return { verdict, issues };
}

/**
 * Production call: send the screenshot to Haiku-vision and parse the reply.
 * Returns a SketchyVerdict that can be passed straight to upsertSketchyVerdict.
 */
export async function checkScreenshotForSketchiness(
  input: SketchyCheckInputs,
): Promise<SketchyVerdict> {
  const source = detectSketchySource();
  const generatedAt = new Date().toISOString();
  if (source === "unavailable") {
    return {
      permutation_id: input.permutationId,
      verdict: "unsupported",
      issues: [],
      source,
      cost_usd: 0,
      generated_at: generatedAt,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // detectSketchySource should have caught this; defense in depth.
    throw new Error(
      "sketchy: ANTHROPIC_API_KEY is unset at call time. detectSketchySource() should have returned 'unavailable' " +
        "and the caller should have skipped this perm; if you see this error, the caller invoked checkScreenshotForSketchiness " +
        "without checking detectSketchySource() first.",
    );
  }
  const client = new Anthropic({ apiKey });

  const imageBase64 = readImageBase64(input.screenshotPath);
  const mediaType = mediaTypeForScreenshot(input.screenshotPath);
  const { system, userText } = buildSketchyPromptContent(input);

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageBase64,
            },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const text =
    resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("\n") || "";
  const { verdict, issues } = parseSketchyReply(text);

  // Haiku 4.5 pricing as of 2026-05: $1/MTok in, $5/MTok out. Cached input
  // is roughly 10% of input. We approximate cost as input * 1e-6 + output * 5e-6
  // since image tokens dominate; this is good enough for the dashboard.
  const usage = resp.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cachedInputTokens = (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const freshInputTokens = inputTokens - cachedInputTokens;
  const cost_usd =
    freshInputTokens * 1e-6 + cachedInputTokens * 1e-7 + outputTokens * 5e-6;

  return {
    permutation_id: input.permutationId,
    verdict,
    issues,
    source: "anthropic-haiku-vision",
    cost_usd,
    generated_at: generatedAt,
  };
}

/**
 * Returns true iff the supplied prediction source means the campaign already
 * has a vision-capable LLM available. Used by the campaign wiring to decide
 * "should we even try the sketchy phase?" The current rule: only when an
 * Anthropic key is set. `claude-cli` does not currently send images and
 * `heuristic` is text-only, so neither qualifies.
 */
export function sketchyAvailableForSource(_source: PredictionSource): boolean {
  return detectSketchySource() === "anthropic-haiku-vision";
}
