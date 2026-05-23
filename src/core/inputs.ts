/**
 * Input catalog — operator-supplied real values that Vouch can use when
 * filling forms or driving actions on the target system.
 *
 * Why this exists. The default `plausibleValuesFor` in `surface.ts` emits
 * synthetic variants (`vouch+probe@example.com`, `7ABC123` … wait, actually
 * the synthetic plate would never be real). For target systems that validate
 * inputs against external systems (DMV lookup, VIN decode, wallet balance,
 * face match against a real driver license), synthetic values fail the
 * server-side check and every permutation gets a false negative. The
 * operator needs a way to say "for fields like X, use Y" without baking
 * Y into the source tree or shipping it in a commit.
 *
 * The catalog lives at `<project-root>/vouch.inputs.yaml`. Vouch reads
 * it on every `init` and every `run`. Missing file is fine — the catalog
 * is empty and `surface.ts` falls back to its synthetic variants.
 *
 * Secrets posture. Wallet seed phrases and API keys are never written
 * to the file as literals. The file references an env var by NAME via
 * `seed_from_env:` or `value_from_env:`, and the loader resolves the
 * value at run time. The resolved value is held in memory only — never
 * persisted to the SQLite DB, never sent to the dashboard, never logged.
 * The catalog ENTRY NAME (e.g. "solana_devnet_funded") is what the
 * dashboard surfaces.
 *
 * Match precedence when wiring an entry to a field:
 *   1. Explicit `selector:` (exact CSS selector match — operator-declared)
 *   2. Exact match of entry `name:` against placeholder / name / aria-label
 *      / id / nearby label text (case-insensitive, normalized)
 *   3. Substring match of entry `name:` against the same surface fields
 *
 * If two entries both match the same field, the higher-precedence entry
 * wins. Ties at the same precedence raise an error at run start so the
 * operator notices the ambiguity rather than getting a silent wrong-pick.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

const CATALOG_FILENAME = "vouch.inputs.yaml";

/** A regex over an entry's `name:` to catch obviously-secret keys in the file. */
const FORBIDDEN_KEY_PATTERNS = [
  /^seed$/i,
  /^seed_phrase$/i,
  /^mnemonic$/i,
  /^private_key$/i,
  /^secret$/i,
  /^password$/i,
  /^api_key$/i,
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const NameSchema = z
  .string()
  .min(1, "name must be at least 1 character")
  .max(64, "name must be 64 chars or fewer")
  .regex(/^[a-z][a-z0-9_]*$/i, "name must be alphanumeric + underscore, leading letter");

const TextEntrySchema = z
  .object({
    name: NameSchema,
    description: z.string().optional(),
    selector: z.string().optional(),
    value: z.string().optional(),
    value_from_env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "env var names are UPPER_SNAKE_CASE")
      .optional(),
  })
  .refine((e) => (e.value !== undefined) !== (e.value_from_env !== undefined), {
    message: "text entry must set exactly one of `value` or `value_from_env`",
  });

const FileEntrySchema = z.object({
  name: NameSchema,
  description: z.string().optional(),
  selector: z.string().optional(),
  /** Absolute or project-root-relative path to the file on disk. */
  path: z.string().min(1, "files entry must specify `path`"),
  /** MIME type hint surfaced on the dashboard. Optional. */
  mime: z.string().optional(),
});

const WalletEntrySchema = z
  .object({
    name: NameSchema,
    description: z.string().optional(),
    chain: z.enum(["ethereum", "solana", "polygon", "base", "other"]),
    address: z.string().min(1, "wallet entry must specify `address`"),
    /** Env var holding the seed phrase. NEVER the literal seed in the file. */
    seed_from_env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "env var names are UPPER_SNAKE_CASE")
      .optional(),
  })
  // Explicitly forbid common literal-secret keys at the wallet level too.
  .superRefine((e, ctx) => {
    for (const forbidden of ["seed", "seed_phrase", "mnemonic", "private_key", "secret"] as const) {
      if (forbidden in (e as Record<string, unknown>)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `wallet entry must not declare \`${forbidden}\` directly. ` +
            `Put the value in an env var and reference it via \`seed_from_env: VAR_NAME\`. ` +
            `Vouch never writes seed phrases to disk or DB.`,
          path: [forbidden],
        });
      }
    }
  });

const CatalogFileSchema = z
  .object({
    text: z.array(TextEntrySchema).default([]),
    files: z.array(FileEntrySchema).default([]),
    wallets: z.array(WalletEntrySchema).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Types — what callers consume after resolution
// ---------------------------------------------------------------------------

export interface ResolvedTextEntry {
  readonly kind: "text";
  readonly name: string;
  readonly description?: string;
  readonly selector?: string;
  /** Resolved value (env var already substituted, if applicable). */
  readonly value: string;
  /** True iff this entry's value came from an env var (don't surface in UI). */
  readonly sensitive: boolean;
}

export interface ResolvedFileEntry {
  readonly kind: "file";
  readonly name: string;
  readonly description?: string;
  readonly selector?: string;
  /** Absolute path, ready to feed to Playwright `setInputFiles`. */
  readonly absolutePath: string;
  readonly mime?: string;
}

export interface ResolvedWalletEntry {
  readonly kind: "wallet";
  readonly name: string;
  readonly description?: string;
  readonly chain: "ethereum" | "solana" | "polygon" | "base" | "other";
  readonly address: string;
  /** Resolved seed; only present when `seed_from_env` is set + env var found. */
  readonly seed?: string;
  /** True iff this entry has a seed (and thus must not be UI-surfaced). */
  readonly sensitive: boolean;
}

export type ResolvedEntry =
  | ResolvedTextEntry
  | ResolvedFileEntry
  | ResolvedWalletEntry;

export interface InputCatalog {
  readonly text: readonly ResolvedTextEntry[];
  readonly files: readonly ResolvedFileEntry[];
  readonly wallets: readonly ResolvedWalletEntry[];
  /** Empty when no `vouch.inputs.yaml` exists at the project root. */
  readonly isEmpty: boolean;
  /** Path the catalog was loaded from (or would have been loaded from). */
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and resolve the catalog at `<projectDir>/vouch.inputs.yaml`.
 *
 * Returns an empty catalog when the file does not exist (no-op for projects
 * that haven't supplied inputs yet). Throws with file path + actionable
 * remediation on any of:
 *   - YAML parse error (file path + line:column from the parser)
 *   - schema validation error (path inside the document + why it failed)
 *   - duplicate `name:` within the same section
 *   - forbidden literal-secret key at any depth
 *   - referenced `value_from_env` / `seed_from_env` env var is not set
 *   - referenced file path does not exist on disk
 *
 * Throwing at load time (rather than mid-run) is the whole point: an
 * operator who typo'd an env var name finds out before Playwright spins
 * up a browser, not on permutation 47.
 */
export function loadCatalog(projectDir: string): InputCatalog {
  const path = resolve(projectDir, CATALOG_FILENAME);
  if (!existsSync(path)) {
    return {
      text: [],
      files: [],
      wallets: [],
      isEmpty: true,
      path,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `inputs: failed to read catalog at '${path}'. ` +
        `Check file permissions. Underlying error: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const pos = err.linePos?.[0];
      const loc = pos ? `${pos.line}:${pos.col}` : "(unknown position)";
      throw new Error(
        `inputs: YAML parse error in '${path}' at ${loc}: ${err.message}. ` +
          `Open the file in your editor; YAML is whitespace-sensitive, ` +
          `the most common cause is a misaligned indent on a list item.`,
      );
    }
    throw err;
  }
  if (parsed === null || parsed === undefined) {
    // Empty file is treated like a missing file.
    return { text: [], files: [], wallets: [], isEmpty: true, path };
  }

  // Pre-Zod scan for forbidden literal-secret KEYS at any depth. Zod's
  // default object behavior strips unknown keys silently, which would let
  // a `seed: "..."` line slip through as a no-op rather than throwing.
  // We refuse to silently drop any key whose NAME suggests a literal secret.
  assertNoLiteralSecretKeys(parsed, path, []);

  const validated = CatalogFileSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `inputs: catalog at '${path}' failed schema validation:\n${issues}\n` +
        `Fix the entries above. See the template at the top of the file ` +
        `(or run \`vouch init\` to regenerate it) for the expected shape.`,
    );
  }
  const doc = validated.data;

  // Per-section duplicate-name check. We do this OUTSIDE Zod because it
  // requires a cross-array view and the error is more actionable here.
  enforceUniqueNames(doc.text, "text", path);
  enforceUniqueNames(doc.files, "files", path);
  enforceUniqueNames(doc.wallets, "wallets", path);

  // Reject forbidden top-level entry names (catches `name: seed` etc.).
  for (const section of ["text", "files", "wallets"] as const) {
    for (const entry of doc[section]) {
      for (const pat of FORBIDDEN_KEY_PATTERNS) {
        if (pat.test(entry.name)) {
          throw new Error(
            `inputs: entry '${section}[${entry.name}]' in '${path}' uses a forbidden name. ` +
              `Vouch refuses to surface any entry whose name suggests a literal secret ` +
              `(seed, mnemonic, private_key, password, api_key, secret). ` +
              `Rename the entry to describe its purpose (e.g. 'solana_devnet_funded') ` +
              `and reference any secret value via \`*_from_env: VAR_NAME\`.`,
          );
        }
      }
    }
  }

  // Resolve text entries: substitute env vars where requested.
  const resolvedText: ResolvedTextEntry[] = doc.text.map((e) => {
    if (e.value !== undefined) {
      return {
        kind: "text",
        name: e.name,
        description: e.description,
        selector: e.selector,
        value: e.value,
        sensitive: false,
      };
    }
    const envName = e.value_from_env!;
    const v = process.env[envName];
    if (v === undefined || v === "") {
      throw new Error(
        `inputs: text entry '${e.name}' references env var '${envName}' but it is unset or empty. ` +
          `Set the variable in your shell (export ${envName}=...) and re-run, or remove the entry.`,
      );
    }
    return {
      kind: "text",
      name: e.name,
      description: e.description,
      selector: e.selector,
      value: v,
      sensitive: true,
    };
  });

  // Resolve file entries: confirm path exists on disk NOW.
  const resolvedFiles: ResolvedFileEntry[] = doc.files.map((e) => {
    const absolute = resolve(projectDir, e.path);
    if (!existsSync(absolute)) {
      throw new Error(
        `inputs: files entry '${e.name}' references a path that does not exist: '${absolute}'. ` +
          `The catalog says \`path: ${e.path}\` (resolved against the project root '${projectDir}'). ` +
          `Either fix the path or remove the entry.`,
      );
    }
    return {
      kind: "file",
      name: e.name,
      description: e.description,
      selector: e.selector,
      absolutePath: absolute,
      mime: e.mime,
    };
  });

  // Resolve wallet entries: env-substitute the seed if requested.
  const resolvedWallets: ResolvedWalletEntry[] = doc.wallets.map((e) => {
    let seed: string | undefined;
    let sensitive = false;
    if (e.seed_from_env !== undefined) {
      const envName = e.seed_from_env;
      const v = process.env[envName];
      if (v === undefined || v === "") {
        throw new Error(
          `inputs: wallet entry '${e.name}' references env var '${envName}' but it is unset or empty. ` +
            `Set the variable in your shell (export ${envName}=...) and re-run, or remove \`seed_from_env\`.`,
        );
      }
      seed = v;
      sensitive = true;
    }
    return {
      kind: "wallet",
      name: e.name,
      description: e.description,
      chain: e.chain,
      address: e.address,
      seed,
      sensitive,
    };
  });

  return {
    text: resolvedText,
    files: resolvedFiles,
    wallets: resolvedWallets,
    isEmpty:
      resolvedText.length === 0 &&
      resolvedFiles.length === 0 &&
      resolvedWallets.length === 0,
    path,
  };
}

/**
 * Recursively walk a parsed YAML doc and throw if any key name matches a
 * forbidden literal-secret pattern (seed, mnemonic, private_key, password,
 * api_key, secret). Runs BEFORE Zod parses so the offending key isn't
 * silently stripped.
 *
 * Path is reported via a JSON-Pointer-like dotted breadcrumb so the
 * operator finds the line fast (e.g. `wallets[0].seed`).
 */
function assertNoLiteralSecretKeys(
  node: unknown,
  filePath: string,
  pathParts: readonly string[],
): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      assertNoLiteralSecretKeys(node[i], filePath, [...pathParts, `[${i}]`]);
    }
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    for (const pat of FORBIDDEN_KEY_PATTERNS) {
      if (pat.test(key)) {
        const where = [...pathParts, key].join(".") || key;
        throw new Error(
          `inputs: '${path(filePath)}' contains a forbidden literal-secret key '${key}' at '${where}'. ` +
            `Vouch refuses to read seed phrases / mnemonics / private keys / passwords / API keys / secrets ` +
            `from the catalog file. Move the value into an env var and reference it via ` +
            `\`*_from_env: VAR_NAME\` (e.g. \`seed_from_env: WALLET_SEED\`). ` +
            `For wallets specifically, this means the entry should declare \`seed_from_env\`, not \`${key}\`.`,
        );
      }
    }
    assertNoLiteralSecretKeys(value, filePath, [...pathParts, key]);
  }
}

/** Pass-through identity used only to suppress an unused-var warning on `filePath` inside the message. */
function path(p: string): string { return p; }

function enforceUniqueNames(
  entries: readonly { name: string }[],
  sectionName: string,
  filePath: string,
): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.name)) {
      throw new Error(
        `inputs: duplicate name '${e.name}' in section '${sectionName}' of '${filePath}'. ` +
          `Each entry name must be unique within its section.`,
      );
    }
    seen.add(e.name);
  }
}

// ---------------------------------------------------------------------------
// Field → catalog match resolver
// ---------------------------------------------------------------------------

/**
 * Identifying surface fields on a node that we use for heuristic matching.
 * Mirrors what `surface.ts` already captures, so this module doesn't need
 * to import RawNode (avoiding a circular dep).
 */
export interface FieldSurface {
  readonly selector?: string;
  readonly placeholder?: string;
  readonly nameAttr?: string;
  readonly idAttr?: string;
  readonly ariaLabel?: string;
  readonly labelText?: string;
}

export interface MatchResult<T extends ResolvedEntry> {
  readonly entry: T;
  /** Precedence: 1 = selector, 2 = exact name, 3 = substring name. */
  readonly precedence: 1 | 2 | 3;
}

/**
 * Find the best-matching text-catalog entry for a given field. Returns
 * null when no entry matches. Throws when two entries tie at the same
 * precedence (the operator should disambiguate by adding a `selector:`).
 */
export function matchTextEntry(
  field: FieldSurface,
  catalog: InputCatalog,
): MatchResult<ResolvedTextEntry> | null {
  return matchEntry(field, catalog.text);
}

export function matchFileEntry(
  field: FieldSurface,
  catalog: InputCatalog,
): MatchResult<ResolvedFileEntry> | null {
  return matchEntry(field, catalog.files);
}

function matchEntry<T extends ResolvedTextEntry | ResolvedFileEntry>(
  field: FieldSurface,
  entries: readonly T[],
): MatchResult<T> | null {
  // Precedence 1: explicit selector.
  const selectorMatches = entries.filter(
    (e) => e.selector !== undefined && field.selector !== undefined && e.selector === field.selector,
  );
  if (selectorMatches.length > 1) {
    throw new Error(
      `inputs: ambiguous selector match — entries [${selectorMatches.map((e) => e.name).join(", ")}] ` +
        `all declare \`selector: ${field.selector}\`. Each selector must map to at most one entry.`,
    );
  }
  if (selectorMatches.length === 1) {
    return { entry: selectorMatches[0]!, precedence: 1 };
  }

  // Precedence 2 + 3 operate on a normalized haystack of identifying strings.
  const haystackParts = [
    field.placeholder,
    field.nameAttr,
    field.idAttr,
    field.ariaLabel,
    field.labelText,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map(normalize);

  // Precedence 2: exact normalized match against any haystack part.
  const exactMatches = entries.filter((e) =>
    haystackParts.some((h) => h === normalize(e.name)),
  );
  if (exactMatches.length > 1) {
    throw new Error(
      `inputs: ambiguous exact-name match — entries [${exactMatches.map((e) => e.name).join(", ")}] ` +
        `all match the same field by name. Add a \`selector:\` to one of them to disambiguate.`,
    );
  }
  if (exactMatches.length === 1) {
    return { entry: exactMatches[0]!, precedence: 2 };
  }

  // Precedence 3: substring (entry name appears anywhere in the haystack).
  const substringMatches = entries.filter((e) => {
    const needle = normalize(e.name);
    return haystackParts.some((h) => h.includes(needle));
  });
  if (substringMatches.length > 1) {
    throw new Error(
      `inputs: ambiguous substring match — entries [${substringMatches.map((e) => e.name).join(", ")}] ` +
        `all appear within the same field's labels. Add a \`selector:\` to one of them to disambiguate.`,
    );
  }
  if (substringMatches.length === 1) {
    return { entry: substringMatches[0]!, precedence: 3 };
  }

  return null;
}

/** Lowercase, strip non-alphanumeric, collapse repeats. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
// Template (used by `vouch init` when no catalog file exists yet)
// ---------------------------------------------------------------------------

/**
 * The exact contents of the template `vouch.inputs.yaml` that `vouch init`
 * writes when the project doesn't have one yet. Every example is commented
 * out so the file is INERT until the operator un-comments and edits.
 */
export const INPUTS_TEMPLATE: string = `# vouch.inputs.yaml — operator-supplied real values
#
# Vouch reads this file on every \`vouch run\`. Each entry below becomes
# an extra "valid_real" variant on any matching field surfaced by the
# crawler, alongside the synthetic valid/empty/negative variants that
# Vouch already generates.
#
# MATCHING. Vouch picks an entry for a field by:
#   1. Exact \`selector:\` match  (you write the selector explicitly)
#   2. Exact name match           (\`name:\` matches placeholder / name /
#                                   aria-label / id / label text after
#                                   case + punctuation normalization)
#   3. Substring name match       (entry name appears inside one of the
#                                   labels above)
#
# SECRETS. Wallet seed phrases, API keys, passwords are NEVER written here
# as literals. Reference an env var by name via \`seed_from_env: VAR_NAME\`
# or \`value_from_env: VAR_NAME\`. Vouch resolves at run time, holds the
# value in memory only, and never persists it to disk or the dashboard.
#
# Uncomment and edit the examples below for your project.

text: []
# text:
#   - name: license_plate
#     value: "7ABC123"
#     description: "California plate registered in test fleet"
#   - name: vin
#     value: "1HGBH41JXMN109186"
#   - name: email
#     selector: "input[name=email]"
#     value: "scott+vouch@example.com"
#   - name: api_token  # entry name describes purpose, NOT the secret itself
#     value_from_env: VOUCH_TARGET_API_TOKEN
#     description: "bearer token for the staging API"

files: []
# files:
#   - name: drivers_license_front
#     path: ./fixtures/dl-front.jpg
#     mime: image/jpeg
#     description: "Driver's license front; passes face-match in staging"

wallets: []
# wallets:
#   - name: solana_devnet_funded
#     chain: solana
#     address: "8x...ABC"
#     seed_from_env: VOUCH_WALLET_SOLANA_DEVNET_SEED
#     description: "Devnet wallet pre-funded with 5 SOL"
`;
