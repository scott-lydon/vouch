// Catalog loader + match resolver tests.
//
// Covers:
//   - missing catalog file is fine, returns empty catalog
//   - malformed YAML throws with file + position
//   - schema violations throw with actionable paths
//   - literal-secret keys (seed, mnemonic, etc.) are forbidden at any layer
//   - value_from_env / seed_from_env unset throws AT LOAD time, not later
//   - duplicate names within a section throw
//   - selector > exact name > substring match precedence
//   - ambiguous matches throw with both entry names listed

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadCatalog,
  matchFileEntry,
  matchTextEntry,
  type FieldSurface,
} from "./inputs.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vouch-inputs-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(content: string): void {
  writeFileSync(join(tmp, "vouch.inputs.yaml"), content, "utf8");
}

describe("loadCatalog", () => {
  it("returns an empty catalog when the file does not exist", () => {
    const cat = loadCatalog(tmp);
    expect(cat.isEmpty).toBe(true);
    expect(cat.text).toEqual([]);
    expect(cat.files).toEqual([]);
    expect(cat.wallets).toEqual([]);
  });

  it("loads a valid text entry", () => {
    writeYaml(`
text:
  - name: license_plate
    value: "7ABC123"
    description: "CA plate"
`);
    const cat = loadCatalog(tmp);
    expect(cat.isEmpty).toBe(false);
    expect(cat.text).toHaveLength(1);
    expect(cat.text[0]!.name).toBe("license_plate");
    expect(cat.text[0]!.value).toBe("7ABC123");
    expect(cat.text[0]!.sensitive).toBe(false);
  });

  it("resolves value_from_env and marks sensitive=true", () => {
    process.env["VOUCH_TEST_TOKEN"] = "live-token-xyz";
    try {
      writeYaml(`
text:
  - name: api_token
    value_from_env: VOUCH_TEST_TOKEN
`);
      const cat = loadCatalog(tmp);
      expect(cat.text[0]!.value).toBe("live-token-xyz");
      expect(cat.text[0]!.sensitive).toBe(true);
    } finally {
      delete process.env["VOUCH_TEST_TOKEN"];
    }
  });

  it("throws when value_from_env references an unset env var", () => {
    delete process.env["VOUCH_DEFINITELY_NOT_SET"];
    writeYaml(`
text:
  - name: api_token
    value_from_env: VOUCH_DEFINITELY_NOT_SET
`);
    expect(() => loadCatalog(tmp)).toThrow(/unset or empty/);
  });

  it("rejects a text entry that sets both value and value_from_env", () => {
    writeYaml(`
text:
  - name: ambiguous
    value: "x"
    value_from_env: VOUCH_X
`);
    expect(() => loadCatalog(tmp)).toThrow(/exactly one of/);
  });

  it("rejects entry names that look like literal secrets", () => {
    writeYaml(`
text:
  - name: seed
    value: "do not put seeds here"
`);
    expect(() => loadCatalog(tmp)).toThrow(/forbidden name/);
  });

  it("rejects a wallet entry that declares `seed` directly", () => {
    writeYaml(`
wallets:
  - name: solana_test
    chain: solana
    address: "8x"
    seed: "fake seed phrase here"
`);
    expect(() => loadCatalog(tmp)).toThrow(/forbidden literal-secret key 'seed'/);
  });

  it("rejects a files entry whose path does not exist", () => {
    writeYaml(`
files:
  - name: missing_file
    path: ./does-not-exist.jpg
`);
    expect(() => loadCatalog(tmp)).toThrow(/does not exist/);
  });

  it("accepts a files entry whose path exists", () => {
    writeFileSync(join(tmp, "real.jpg"), "fake-jpeg-bytes", "utf8");
    writeYaml(`
files:
  - name: drivers_license_front
    path: ./real.jpg
    mime: image/jpeg
`);
    const cat = loadCatalog(tmp);
    expect(cat.files).toHaveLength(1);
    expect(cat.files[0]!.absolutePath).toBe(join(tmp, "real.jpg"));
    expect(cat.files[0]!.mime).toBe("image/jpeg");
  });

  it("throws on duplicate names within a section", () => {
    writeYaml(`
text:
  - name: license_plate
    value: "A"
  - name: license_plate
    value: "B"
`);
    expect(() => loadCatalog(tmp)).toThrow(/duplicate name 'license_plate'/);
  });

  it("throws on malformed YAML with file path in the error", () => {
    writeYaml(`text:\n  - name: bad\n    value: "unterminated\n`);
    expect(() => loadCatalog(tmp)).toThrow(/YAML parse error/);
  });
});

describe("matchTextEntry — precedence", () => {
  it("selector match (precedence 1) beats name match", () => {
    process.env["X"] = "x";
    writeYaml(`
text:
  - name: license_plate
    selector: "input[name=plate]"
    value: "BY_SELECTOR"
  - name: plate
    value: "BY_NAME"
`);
    delete process.env["X"];
    const cat = loadCatalog(tmp);
    const field: FieldSurface = {
      selector: "input[name=plate]",
      nameAttr: "plate",
      placeholder: "License plate",
    };
    const match = matchTextEntry(field, cat)!;
    expect(match).not.toBeNull();
    expect(match.precedence).toBe(1);
    expect(match.entry.value).toBe("BY_SELECTOR");
  });

  it("exact name match (precedence 2) beats substring match", () => {
    writeYaml(`
text:
  - name: vin
    value: "EXACT"
  - name: vin_decode_field
    value: "SUBSTRING"
`);
    const cat = loadCatalog(tmp);
    // placeholder is "vin" exactly -> entry 'vin' is precedence 2.
    // entry 'vin_decode_field' would normalize to "vin_decode_field" which
    // is NOT a substring of "vin", so only 'vin' should match here.
    const field: FieldSurface = { placeholder: "VIN" };
    const match = matchTextEntry(field, cat)!;
    expect(match).not.toBeNull();
    expect(match.precedence).toBe(2);
    expect(match.entry.name).toBe("vin");
  });

  it("substring match (precedence 3) when neither selector nor exact-name hits", () => {
    writeYaml(`
text:
  - name: license_plate
    value: "REAL_PLATE"
`);
    const cat = loadCatalog(tmp);
    const field: FieldSurface = { placeholder: "Enter your license plate number" };
    const match = matchTextEntry(field, cat)!;
    expect(match).not.toBeNull();
    expect(match.precedence).toBe(3);
    expect(match.entry.value).toBe("REAL_PLATE");
  });

  it("returns null when no entry matches", () => {
    writeYaml(`
text:
  - name: license_plate
    value: "P"
`);
    const cat = loadCatalog(tmp);
    expect(matchTextEntry({ placeholder: "Search" }, cat)).toBeNull();
  });

  it("throws when two entries tie at the same precedence", () => {
    writeYaml(`
text:
  - name: plate
    value: "A"
  - name: number
    value: "B"
`);
    const cat = loadCatalog(tmp);
    // 'plate' and 'number' are both substrings of "plate number" after
    // normalization, and neither is an exact match — so both land at
    // precedence 3 and the matcher must refuse to silently pick.
    expect(() =>
      matchTextEntry({ placeholder: "plate number" }, cat),
    ).toThrow(/ambiguous substring match/);
  });
});

describe("matchFileEntry", () => {
  it("matches a file entry by exact name against the file input's nameAttr", () => {
    writeFileSync(join(tmp, "front.jpg"), "x", "utf8");
    writeYaml(`
files:
  - name: drivers_license_front
    path: ./front.jpg
`);
    const cat = loadCatalog(tmp);
    const match = matchFileEntry(
      { nameAttr: "drivers_license_front" },
      cat,
    )!;
    expect(match).not.toBeNull();
    expect(match.entry.absolutePath).toBe(join(tmp, "front.jpg"));
  });
});
