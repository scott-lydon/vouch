// Sketchy-checker unit tests.
//
// We don't hit the Anthropic API in these tests — that's expensive,
// flaky, and would force every CI to have a key. Instead we cover the
// pure pieces:
//   1. detectSketchySource: env-driven decision tree.
//   2. buildSketchyPromptContent: stable prompt shape.
//   3. parseSketchyReply: parses the model's structured reply and is
//      defensive against off-script output.
//   4. The DB roundtrip (upsert / get) and the empty-baseline planner
//      option are covered by separate test files alongside their owners.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  buildSketchyPromptContent,
  detectSketchySource,
  mediaTypeForScreenshot,
  parseSketchyReply,
  type SketchyCheckInputs,
} from "./sketchy.js";

// ----------------------------------------------------------------------------
// 1. detectSketchySource
// ----------------------------------------------------------------------------

describe("detectSketchySource", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("returns 'unavailable' when ANTHROPIC_API_KEY is unset", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(detectSketchySource()).toBe("unavailable");
  });

  it("returns 'anthropic-haiku-vision' when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key";
    expect(detectSketchySource()).toBe("anthropic-haiku-vision");
  });
});

// ----------------------------------------------------------------------------
// 2. buildSketchyPromptContent
// ----------------------------------------------------------------------------

describe("buildSketchyPromptContent", () => {
  const baseInput: SketchyCheckInputs = {
    permutationId: "test_perm_1",
    screenshotPath: "/tmp/test.png",
    specText: "The app helps users sell their car.",
    projectName: "carvana-clone",
    targetUrl: "https://example.com",
  };

  it("includes the project name, URL, and spec text in the user message", () => {
    const { userText } = buildSketchyPromptContent(baseInput);
    expect(userText).toContain("carvana-clone");
    expect(userText).toContain("https://example.com");
    expect(userText).toContain("The app helps users sell their car.");
  });

  it("system prompt lists the named sketchy patterns (regression guard)", () => {
    const { system } = buildSketchyPromptContent(baseInput);
    // These are the patterns Carvana's missed bugs fell under. If a future
    // edit drops one of these from the prompt, the kind of bug it catches
    // goes back to being invisible.
    for (const phrase of [
      "Low-contrast text",
      "Misaligned",
      "Engineering jargon",
      "markdown",
      "Counters / timers",
      "Get my offer",
      "Schedule pickup",
    ]) {
      expect(system).toContain(phrase);
    }
  });

  it("requires a structured VERDICT / ISSUES reply (parser depends on it)", () => {
    const { system } = buildSketchyPromptContent(baseInput);
    expect(system).toContain("VERDICT: <clean|sketchy>");
    expect(system).toContain("ISSUES:");
  });

  it("truncates a giant spec text so we don't blow the per-call token budget", () => {
    const huge = "X".repeat(20_000);
    const { userText } = buildSketchyPromptContent({ ...baseInput, specText: huge });
    // 6000 is the cap inside buildSketchyPromptContent. The full 20000 would
    // be ~25% over the input-token cost budget at typical char-to-token
    // ratios; the cap keeps a single huge spec from dominating cost.
    expect(userText.length).toBeLessThan(huge.length);
  });
});

// ----------------------------------------------------------------------------
// 3. parseSketchyReply
// ----------------------------------------------------------------------------

describe("parseSketchyReply", () => {
  it("parses a clean verdict with no issues", () => {
    const out = parseSketchyReply("VERDICT: clean\nISSUES:\n");
    expect(out.verdict).toBe("clean");
    expect(out.issues).toEqual([]);
  });

  it("parses a sketchy verdict with multiple issues", () => {
    const out = parseSketchyReply(
      "VERDICT: sketchy\nISSUES:\n" +
        "Hero subtitle text is illegible against the off-white background.\n" +
        "State dropdown is vertically misaligned with the license-plate input.\n" +
        "Counter 'Elapsed: 15 min' adds stress with no purpose.\n",
    );
    expect(out.verdict).toBe("sketchy");
    expect(out.issues).toHaveLength(3);
    expect(out.issues[0]).toMatch(/Hero subtitle/);
    expect(out.issues[2]).toMatch(/Elapsed/);
  });

  it("strips bullet / numeric prefixes from issue lines", () => {
    const out = parseSketchyReply(
      "VERDICT: sketchy\nISSUES:\n- First issue.\n* Second issue.\n1. Third issue.\n",
    );
    expect(out.verdict).toBe("sketchy");
    expect(out.issues).toEqual(["First issue.", "Second issue.", "Third issue."]);
  });

  it("downgrades sketchy-with-no-issues to clean to suppress noise", () => {
    // If the model says VERDICT: sketchy but doesn't list any issues, the
    // dashboard would show a brown flag with no explanation. That's worse
    // than no flag at all. The parser should downgrade to clean.
    const out = parseSketchyReply("VERDICT: sketchy\nISSUES:\n");
    expect(out.verdict).toBe("clean");
    expect(out.issues[0]).toMatch(/Downgraded to clean/);
  });

  it("defends against off-script model output by defaulting to clean", () => {
    const out = parseSketchyReply("I cannot evaluate this image.");
    expect(out.verdict).toBe("clean");
    expect(out.issues[0]).toMatch(/did not contain a VERDICT line/);
  });

  it("caps issue count and per-issue length to bound runaway model cost", () => {
    const tenIssues = Array.from({ length: 12 }, (_, i) => `Issue number ${i}.`).join("\n");
    const out = parseSketchyReply(`VERDICT: sketchy\nISSUES:\n${tenIssues}`);
    expect(out.issues.length).toBeLessThanOrEqual(8); // MAX_ISSUES
  });

  it("is case-insensitive on the VERDICT label", () => {
    const out = parseSketchyReply("verdict: Sketchy\nIssues:\n- alpha\n");
    expect(out.verdict).toBe("sketchy");
    expect(out.issues).toEqual(["alpha"]);
  });
});

// ----------------------------------------------------------------------------
// 4. mediaTypeForScreenshot — guards against the 2026-05-24 regression where
//    sketchy.ts hardcoded "image/png" while the executor wrote JPEGs. The
//    mismatch would have shipped JPEG bytes under a PNG content-type header
//    and the Anthropic vision API would silently reject or misinterpret them.
//    Pin every extension we expect to encounter and lock in the loud failure
//    on anything else so a future capture-format change can't silently break
//    the vision path again.
// ----------------------------------------------------------------------------

describe("mediaTypeForScreenshot", () => {
  it("maps .jpg to image/jpeg", () => {
    expect(mediaTypeForScreenshot("/runs/abc/screenshots/perm_001/step-00.jpg")).toBe("image/jpeg");
  });

  it("maps .jpeg to image/jpeg", () => {
    expect(mediaTypeForScreenshot("/tmp/foo.jpeg")).toBe("image/jpeg");
  });

  it("maps .png to image/png", () => {
    expect(mediaTypeForScreenshot("/runs/abc/screenshots/perm_001/step-final.png")).toBe("image/png");
  });

  it("is case-insensitive on the extension", () => {
    expect(mediaTypeForScreenshot("/runs/X/STEP-00.JPG")).toBe("image/jpeg");
    expect(mediaTypeForScreenshot("/runs/X/STEP-00.PNG")).toBe("image/png");
  });

  it("maps .gif and .webp for completeness (the API accepts them)", () => {
    expect(mediaTypeForScreenshot("/tmp/a.gif")).toBe("image/gif");
    expect(mediaTypeForScreenshot("/tmp/a.webp")).toBe("image/webp");
  });

  it("throws loudly on an unknown extension instead of silently defaulting", () => {
    expect(() => mediaTypeForScreenshot("/tmp/a.bmp")).toThrow(/cannot derive Anthropic media_type/);
    expect(() => mediaTypeForScreenshot("/tmp/a")).toThrow(/cannot derive Anthropic media_type/);
  });
});
