// Secrets-at-rest redaction contract tests.
//
// Covers the cross-module contract that catalog-sourced cleartext values
// (`*_from_env` entries in vouch.inputs.yaml) must never reach disk, must
// never reach the Oracle's predictions / prompts, and must never reach the
// findings report. The contract has four sites:
//
//   1. db.insertActions  — writes REDACTED_TYPE_VALUE in place of cleartext
//                          when meta.sensitive=true. Throws when sensitive
//                          but catalog_entry_name is missing.
//
//   2. executor.resolveTypeValue
//                       — resolves the cleartext from the in-memory catalog
//                          at type-time. Fail-fast on every recoverable
//                          misconfiguration so a Vouch run never silently
//                          types the redaction sentinel into the SUT.
//
//   3. oracle.describeTypeValueForPrompt
//      oracle.describeTypeValueForSequence
//                       — render sensitive actions with a structural
//                          placeholder (catalog entry name only) instead of
//                          interpolating the cleartext into the Haiku prompt.
//
//   4. findings rendering
//                       — when the action_sequence carries sensitive=true,
//                          the findings.md line shows
//                          `<catalog entry 'NAME', value redacted>`, never
//                          the cleartext, never even the sentinel string.
//
// Cross-cutting invariant: the cleartext string `s3cret-token-value` must
// not appear in ANY persistence path or rendered string in this test file's
// outputs, even though every test deliberately puts that string through
// the system.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { insertActions, insertProject, insertRun, openDB, type DBHandle } from "./db.js";
import { resolveTypeValue } from "./executor.js";
import {
  describeTypeValueForPrompt,
  describeTypeValueForSequence,
} from "./oracle.js";
import { REDACTED_TYPE_VALUE, type InputCatalog } from "./inputs.js";
import { type Action } from "./types.js";
import { analyzeRun, renderFindingsMarkdown } from "./findings.js";
import { redactSensitiveActionsForDisplay } from "./surface.js";
import { upsertExecution } from "./db.js";
import { insertPermutations } from "./db.js";

const SECRET = "s3cret-token-value";

function makeSensitiveTypeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "type__email__sensitive",
    kind: "type",
    selector: "input[name=email]",
    description: "Type the sensitive operator value into email field",
    type_value: SECRET,
    rules: [],
    meta: {
      sensitive: true,
      catalog_entry_name: "operator_email",
    },
    ...overrides,
  };
}

function makeSyntheticTypeAction(): Action {
  return {
    id: "type__email__synthetic",
    kind: "type",
    selector: "input[name=email]",
    description: "Type vouch+probe@example.com into email field",
    type_value: "vouch+probe@example.com",
    rules: [],
    meta: { variant_key: "valid", variant_description: "valid synthetic email" },
  };
}

function openTmpDB(): { db: DBHandle; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "vouch-redaction-test-"));
  const db = openDB(join(dir, "vouch.db"));
  return { db, dir };
}

function cleanupTmpDB(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("db.insertActions: secrets-at-rest contract", () => {
  it("writes the redaction sentinel for sensitive actions, never the cleartext", () => {
    const { db, dir } = openTmpDB();
    try {
      insertProject(db, {
        id: "proj_test",
        name: "test",
        description: "",
        spec_text: "",
        created_at: new Date().toISOString(),
      });
      insertRun(db, {
        id: "run_test",
        project_id: "proj_test",
        target_url: "http://localhost",
        spec_text: "",
        spec_sha256: "",
        strategy: "exhaustive",
        depth: 1,
        started_at: new Date().toISOString(),
        finished_at: null,
        prediction_source: "heuristic",
      });
      insertActions(db, "run_test", [makeSensitiveTypeAction()]);

      const row = db.raw
        .prepare(`SELECT type_value FROM actions WHERE id = ?`)
        .get("type__email__sensitive") as { type_value: string | null };

      expect(row.type_value).toBe(REDACTED_TYPE_VALUE);
      expect(row.type_value).not.toContain(SECRET);

      // Belt-and-suspenders: scan EVERY column in the row for the cleartext.
      const fullRow = db.raw
        .prepare(`SELECT * FROM actions WHERE id = ?`)
        .get("type__email__sensitive") as Record<string, unknown>;
      for (const [col, val] of Object.entries(fullRow)) {
        if (typeof val === "string") {
          expect(val, `column '${col}' must not contain the cleartext secret`).not.toContain(SECRET);
        }
      }
    } finally {
      cleanupTmpDB(dir);
    }
  });

  it("preserves non-sensitive type_value verbatim", () => {
    const { db, dir } = openTmpDB();
    try {
      insertProject(db, {
        id: "proj_test",
        name: "test",
        description: "",
        spec_text: "",
        created_at: new Date().toISOString(),
      });
      insertRun(db, {
        id: "run_test",
        project_id: "proj_test",
        target_url: "http://localhost",
        spec_text: "",
        spec_sha256: "",
        strategy: "exhaustive",
        depth: 1,
        started_at: new Date().toISOString(),
        finished_at: null,
        prediction_source: "heuristic",
      });
      insertActions(db, "run_test", [makeSyntheticTypeAction()]);

      const row = db.raw
        .prepare(`SELECT type_value FROM actions WHERE id = ?`)
        .get("type__email__synthetic") as { type_value: string | null };

      expect(row.type_value).toBe("vouch+probe@example.com");
    } finally {
      cleanupTmpDB(dir);
    }
  });

  it("throws when meta.sensitive=true but meta.catalog_entry_name is missing", () => {
    const { db, dir } = openTmpDB();
    try {
      insertProject(db, {
        id: "proj_test",
        name: "test",
        description: "",
        spec_text: "",
        created_at: new Date().toISOString(),
      });
      insertRun(db, {
        id: "run_test",
        project_id: "proj_test",
        target_url: "http://localhost",
        spec_text: "",
        spec_sha256: "",
        strategy: "exhaustive",
        depth: 1,
        started_at: new Date().toISOString(),
        finished_at: null,
        prediction_source: "heuristic",
      });
      const bad = makeSensitiveTypeAction({ meta: { sensitive: true } });
      expect(() => insertActions(db, "run_test", [bad])).toThrow(
        /no meta\.catalog_entry_name/,
      );

      // Nothing was inserted on the failed transaction.
      const count = (
        db.raw.prepare(`SELECT COUNT(*) AS c FROM actions`).get() as { c: number }
      ).c;
      expect(count).toBe(0);
    } finally {
      cleanupTmpDB(dir);
    }
  });
});

describe("executor.resolveTypeValue: at-runtime catalog lookup", () => {
  const catalogWithEntry: InputCatalog = {
    text: [
      {
        kind: "text",
        name: "operator_email",
        value: SECRET,
        sensitive: true,
      },
    ],
    files: [],
    wallets: [],
    isEmpty: false,
    path: "/tmp/vouch.inputs.yaml",
  };

  it("returns the cleartext for sensitive actions when the catalog entry exists", () => {
    const a = makeSensitiveTypeAction();
    expect(resolveTypeValue(a, catalogWithEntry)).toBe(SECRET);
  });

  it("returns type_value verbatim for non-sensitive actions, ignoring the catalog", () => {
    const a = makeSyntheticTypeAction();
    expect(resolveTypeValue(a, catalogWithEntry)).toBe("vouch+probe@example.com");
  });

  it("returns empty string for a non-sensitive action with null type_value", () => {
    const a: Action = {
      ...makeSyntheticTypeAction(),
      type_value: null,
    };
    expect(resolveTypeValue(a, catalogWithEntry)).toBe("");
  });

  it("throws when sensitive but the catalog was not plumbed through", () => {
    const a = makeSensitiveTypeAction();
    expect(() => resolveTypeValue(a, undefined)).toThrow(
      /without ExecuteOptions\.catalog/,
    );
  });

  it("throws when sensitive but meta.catalog_entry_name is missing", () => {
    const a = makeSensitiveTypeAction({ meta: { sensitive: true } });
    expect(() => resolveTypeValue(a, catalogWithEntry)).toThrow(
      /no meta\.catalog_entry_name/,
    );
  });

  it("throws when sensitive but the named entry is not in the catalog", () => {
    const emptyCatalog: InputCatalog = {
      text: [],
      files: [],
      wallets: [],
      isEmpty: true,
      path: "/tmp/vouch.inputs.yaml",
    };
    const a = makeSensitiveTypeAction();
    expect(() => resolveTypeValue(a, emptyCatalog)).toThrow(
      /no such text entry exists in the in-memory catalog/,
    );
  });
});

describe("oracle: render functions never interpolate sensitive cleartext", () => {
  it("describeTypeValueForPrompt returns a structural placeholder for sensitive actions", () => {
    const a = makeSensitiveTypeAction();
    const rendered = describeTypeValueForPrompt(a);
    expect(rendered).toContain("operator_email");
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(REDACTED_TYPE_VALUE);
  });

  it("describeTypeValueForPrompt quotes the value for non-sensitive actions", () => {
    const a = makeSyntheticTypeAction();
    expect(describeTypeValueForPrompt(a)).toBe(`"vouch+probe@example.com"`);
  });

  it("describeTypeValueForSequence brackets a redaction marker for sensitive actions", () => {
    const a = makeSensitiveTypeAction();
    const rendered = describeTypeValueForSequence(a);
    expect(rendered).toContain("operator_email");
    expect(rendered).toContain("redacted");
    expect(rendered).not.toContain(SECRET);
  });

  it("describeTypeValueForSequence brackets the literal value for non-sensitive actions", () => {
    const a = makeSyntheticTypeAction();
    expect(describeTypeValueForSequence(a)).toBe(` [types: "vouch+probe@example.com"]`);
  });

  it("describeTypeValueForSequence emits empty string for non-sensitive actions with null type_value", () => {
    const a: Action = { ...makeSyntheticTypeAction(), type_value: null };
    expect(describeTypeValueForSequence(a)).toBe("");
  });
});

describe("findings: rendered report never contains sensitive cleartext", () => {
  it("propagates meta.sensitive + meta.catalog_entry_name onto action_sequence and uses them in the renderer", () => {
    // We test the propagation directly through analyzeRun → action_sequence.
    // The rendered markdown is tested implicitly by the renderer in
    // findings.ts because action_sequence carries the redaction-aware fields.
    const { db, dir } = openTmpDB();
    try {
      insertProject(db, {
        id: "proj_test",
        name: "test",
        description: "",
        spec_text: "",
        created_at: new Date().toISOString(),
      });
      insertRun(db, {
        id: "run_test",
        project_id: "proj_test",
        target_url: "http://localhost",
        spec_text: "",
        spec_sha256: "",
        strategy: "exhaustive",
        depth: 1,
        started_at: new Date().toISOString(),
        finished_at: null,
        prediction_source: "heuristic",
      });
      insertActions(db, "run_test", [makeSensitiveTypeAction()]);
      insertPermutations(db, [
        {
          id: "perm_test",
          run_id: "run_test",
          action_ids: ["type__email__sensitive"],
          index: 0,
        },
      ]);
      upsertExecution(db, {
        permutation_id: "perm_test",
        verdict: "fail",
        step_log: [],
        anomalies: [],
        observed_post_state: "boom",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error_class: "test_failure",
        final_state_screenshot_path: null,
      });

      const report = analyzeRun(db, "run_test");
      const finding = report.findings[0]!;
      const step = finding.action_sequence[0]!;

      expect(step.sensitive).toBe(true);
      expect(step.catalog_entry_name).toBe("operator_email");
      // type_value on the persisted row is the sentinel, not the secret.
      expect(step.type_value).toBe(REDACTED_TYPE_VALUE);
      expect(step.type_value).not.toContain(SECRET);
      // Every string field on the finding is secret-free.
      expect(JSON.stringify(finding)).not.toContain(SECRET);
    } finally {
      cleanupTmpDB(dir);
    }
  });

  // Regression test for the markdown renderer specifically. The describe block
  // above tests the JSON payload; this one pins the markdown contract so a
  // future debug-print in `renderFindingsMarkdown` cannot reintroduce the leak
  // without a failing test.
  it("renderFindingsMarkdown never emits sensitive cleartext or the raw sentinel string", () => {
    const { db, dir } = openTmpDB();
    try {
      insertProject(db, {
        id: "proj_test_md",
        name: "test_md",
        description: "",
        spec_text: "",
        created_at: new Date().toISOString(),
      });
      insertRun(db, {
        id: "run_test_md",
        project_id: "proj_test_md",
        target_url: "http://localhost",
        spec_text: "",
        spec_sha256: "",
        strategy: "exhaustive",
        depth: 1,
        started_at: new Date().toISOString(),
        finished_at: null,
        prediction_source: "heuristic",
      });
      insertActions(db, "run_test_md", [makeSensitiveTypeAction()]);
      insertPermutations(db, [
        {
          id: "perm_test_md",
          run_id: "run_test_md",
          action_ids: ["type__email__sensitive"],
          index: 0,
        },
      ]);
      upsertExecution(db, {
        permutation_id: "perm_test_md",
        verdict: "fail",
        step_log: [],
        anomalies: [],
        observed_post_state: "boom",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error_class: "test_failure",
        final_state_screenshot_path: null,
      });

      const report = analyzeRun(db, "run_test_md");
      const md = renderFindingsMarkdown(report);

      // The cleartext must never appear in the rendered markdown.
      expect(md).not.toContain(SECRET);
      // The raw sentinel must also not appear — the renderer's sensitive
      // branch substitutes a structural placeholder that is more useful to a
      // human auditor than the bare sentinel string.
      expect(md).not.toContain(REDACTED_TYPE_VALUE);
      // The structural placeholder IS present.
      expect(md).toContain("operator_email");
      expect(md).toContain("value redacted");
    } finally {
      cleanupTmpDB(dir);
    }
  });
});

describe("surface.redactSensitiveActionsForDisplay: vouch map stdout contract", () => {
  // Why these tests exist: the `vouch map` command's earlier implementation
  // dumped `Action[]` to stdout via `JSON.stringify` directly. For catalog
  // entries marked `sensitive: true` (i.e. `*_from_env` rows), `type_value`
  // on the in-memory action carries the cleartext because the executor needs
  // it at type-time. Without the redaction-at-display helper, the cleartext
  // hit terminal scrollback and shell history every time an operator ran
  // `vouch map --target ...` against a real catalog. These tests pin the
  // contract that the helper redacts sensitive `type_value` to the sentinel
  // while preserving the catalog entry name for human auditors.
  it("replaces type_value with the sentinel for sensitive actions and preserves catalog_entry_name", () => {
    const sensitive = makeSensitiveTypeAction();
    const [redacted] = redactSensitiveActionsForDisplay([sensitive]);
    if (!redacted) throw new Error("expected one redacted action");
    expect(redacted.type_value).toBe(REDACTED_TYPE_VALUE);
    expect(redacted.meta?.["catalog_entry_name"]).toBe("operator_email");
    expect(redacted.meta?.["sensitive"]).toBe(true);
  });

  it("leaves non-sensitive actions untouched (synthetic values pass through)", () => {
    const synthetic = makeSyntheticTypeAction();
    const [unchanged] = redactSensitiveActionsForDisplay([synthetic]);
    if (!unchanged) throw new Error("expected one passthrough action");
    expect(unchanged).toBe(synthetic); // referential equality — no clone for non-sensitive
    expect(unchanged.type_value).toBe("vouch+probe@example.com");
  });

  it("JSON.stringify of redacted actions does NOT contain the cleartext", () => {
    // This is the literal `vouch map` stdout call path: redact, then
    // JSON.stringify, then write. The cleartext must not survive that pipeline.
    const sensitive = makeSensitiveTypeAction();
    const synthetic = makeSyntheticTypeAction();
    const redacted = redactSensitiveActionsForDisplay([sensitive, synthetic]);
    const serialized = JSON.stringify(redacted, null, 2);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain(REDACTED_TYPE_VALUE);
    // The non-sensitive action's value still shows up.
    expect(serialized).toContain("vouch+probe@example.com");
  });

  it("documents the BUG (pre-fix behavior): JSON.stringify of raw actions DOES contain cleartext", () => {
    // This is the regression we just fixed in `vouch map`. The unredacted
    // action's `type_value` is the cleartext; if any future caller serializes
    // a sensitive Action without going through `redactSensitiveActionsForDisplay`
    // first, they hit this leak. Keeping the test asserts the producer-side
    // invariant (cleartext IS present on the in-memory action) so a reader
    // understands why the redaction helper is mandatory at every serialization
    // boundary.
    const sensitive = makeSensitiveTypeAction();
    const serialized = JSON.stringify([sensitive], null, 2);
    expect(serialized).toContain(SECRET); // unredacted = leak
  });

  it("handles an empty array", () => {
    expect(redactSensitiveActionsForDisplay([])).toEqual([]);
  });
});
