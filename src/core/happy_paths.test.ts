// Tests for the happy-path manifest fetcher + lowering.
//
// We don't hit a real network for the fetcher tests — vitest's
// `vi.stubGlobal` swaps `globalThis.fetch` for the duration of each test.
// The lowering logic is pure and tested directly.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  buildManifestUrl,
  fetchHappyPathManifest,
  lowerHappyPathToRows,
  HappyPathManifestSchema,
  type HappyPath,
} from "./happy_paths.js";

// ---------------------------------------------------------------------------
// buildManifestUrl
// ---------------------------------------------------------------------------

describe("buildManifestUrl", () => {
  it("returns the origin-scoped well-known URL when target is the origin", () => {
    expect(buildManifestUrl("https://example.com")).toBe(
      "https://example.com/.well-known/vouch-happy-paths.json",
    );
  });

  it("strips the path when target has one", () => {
    expect(buildManifestUrl("https://example.com/foo/bar?x=1")).toBe(
      "https://example.com/.well-known/vouch-happy-paths.json",
    );
  });

  it("preserves non-default ports", () => {
    expect(buildManifestUrl("http://localhost:3000/login")).toBe(
      "http://localhost:3000/.well-known/vouch-happy-paths.json",
    );
  });
});

// ---------------------------------------------------------------------------
// HappyPathManifestSchema
// ---------------------------------------------------------------------------

describe("HappyPathManifestSchema", () => {
  it("accepts a valid v1 manifest", () => {
    const ok = HappyPathManifestSchema.safeParse({
      version: "1",
      paths: [
        {
          name: "valid vin",
          actions: [{ kind: "click", selector: "#send" }],
          expectedOutcome: "VIN lookup shown",
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a manifest with the wrong version", () => {
    const out = HappyPathManifestSchema.safeParse({
      version: "2",
      paths: [],
    });
    expect(out.success).toBe(false);
  });

  it("rejects a path with empty actions[]", () => {
    const out = HappyPathManifestSchema.safeParse({
      version: "1",
      paths: [{ name: "x", actions: [], expectedOutcome: "y" }],
    });
    expect(out.success).toBe(false);
  });

  it("rejects a path with no expectedOutcome", () => {
    const out = HappyPathManifestSchema.safeParse({
      version: "1",
      paths: [
        {
          name: "x",
          actions: [{ kind: "click", selector: "#a" }],
        },
      ],
    });
    expect(out.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchHappyPathManifest
// ---------------------------------------------------------------------------

describe("fetchHappyPathManifest", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns null when the SUT does not publish a manifest (404)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const out = await fetchHappyPathManifest("https://example.com");
    expect(out).toBeNull();
  });

  it("returns null on network error (DNS, refused, etc.)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const out = await fetchHappyPathManifest("https://example.com");
    expect(out).toBeNull();
  });

  it("returns the parsed manifest on 200 + valid JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          version: "1",
          paths: [
            {
              name: "valid vin",
              actions: [{ kind: "click", selector: "#send" }],
              expectedOutcome: "shows lookup",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;
    const out = await fetchHappyPathManifest("https://example.com");
    expect(out).not.toBeNull();
    expect(out!.paths).toHaveLength(1);
    expect(out!.paths[0]!.name).toBe("valid vin");
  });

  it("throws with a useful message when the body is not JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<html>nope</html>", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await expect(fetchHappyPathManifest("https://example.com")).rejects.toThrow(
      /not JSON|JSON|syntax/i,
    );
  });

  it("throws with validation detail when the schema doesn't match", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ version: "1", paths: [{ name: "x" }] }), {
        status: 200,
      }),
    ) as unknown as typeof globalThis.fetch;
    await expect(fetchHappyPathManifest("https://example.com")).rejects.toThrow(
      /schema|actions|expectedOutcome/i,
    );
  });
});

// ---------------------------------------------------------------------------
// lowerHappyPathToRows
// ---------------------------------------------------------------------------

describe("lowerHappyPathToRows", () => {
  const path: HappyPath = {
    name: "Valid VIN entry",
    description: "User types a known good VIN",
    actions: [
      { kind: "focus_input", selector: "[data-testid=chat-input]" },
      { kind: "type", selector: "[data-testid=chat-input]", value: "WZY1433" },
      { kind: "click", selector: "[data-testid=chat-send]" },
    ],
    expectedOutcome: "Chat shows the VIN lookup with vehicle details.",
  };

  it("produces one Action per step", () => {
    const out = lowerHappyPathToRows(path, "run_test", 0);
    expect(out.actions).toHaveLength(3);
    expect(out.actions.map((a) => a.kind)).toEqual(["focus_input", "type", "click"]);
  });

  it("produces a single Permutation referencing each action by id in order", () => {
    const out = lowerHappyPathToRows(path, "run_test", 0);
    expect(out.permutation.action_ids).toEqual(out.actions.map((a) => a.id));
  });

  it("synthesized action ids are stable and slug-prefixed", () => {
    const out = lowerHappyPathToRows(path, "run_test", 0);
    for (const a of out.actions) {
      expect(a.id).toMatch(/^happy__valid-vin-entry__\d\d__(focus_input|type|click)$/);
    }
  });

  it("carries the type value into the type action's type_value field", () => {
    const out = lowerHappyPathToRows(path, "run_test", 0);
    const typeAction = out.actions.find((a) => a.kind === "type")!;
    expect(typeAction.type_value).toBe("WZY1433");
  });

  it("flags the action source as happy_path_manifest in meta", () => {
    const out = lowerHappyPathToRows(path, "run_test", 0);
    for (const a of out.actions) {
      expect(a.meta["source"]).toBe("happy_path_manifest");
      expect(a.meta["happy_path_name"]).toBe("Valid VIN entry");
    }
  });

  it("returns the expected outcome string for the Oracle to use as prediction", () => {
    const out = lowerHappyPathToRows(path, "run_test", 0);
    expect(out.predictionExpected).toBe(
      "Chat shows the VIN lookup with vehicle details.",
    );
  });

  it("permutation index is what the caller passed in (allows merging into a larger plan)", () => {
    const out = lowerHappyPathToRows(path, "run_test", 42);
    expect(out.permutation.index).toBe(42);
  });
});
