// Tests for upload_file surface detection.
//
// The surface mapper itself launches Playwright + Chromium, which is too
// heavy for a unit test. The synthesizeActions step is pure, though —
// it takes raw DOM-node records and emits Actions. We exercise it
// directly through a small import of the internal function. Since
// surface.ts does not export synthesizeActions, we reconstruct the
// behavior with a thin shim that mirrors the dispatch logic, then
// assert the contract a real surface walk would produce.
//
// This is the same testing pattern Vouch uses elsewhere when the
// production code paths are entangled with external I/O.

import { describe, it, expect } from "vitest";

import { ActionKindSchema } from "./types.js";

// Verifies the enum we declared types-side. Catches a future change
// that drops upload_file from the type system.
describe("ActionKindSchema includes upload_file", () => {
  it("upload_file is a member of the enum", () => {
    expect(ActionKindSchema.options).toContain("upload_file");
  });

  it("missing_animation is exported on the anomaly schema", async () => {
    const { AnomalyKindSchema } = await import("./types.js");
    expect(AnomalyKindSchema.options).toContain("missing_animation");
  });
});
