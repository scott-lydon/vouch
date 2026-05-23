// Surface Mapper.
//
// Given a target URL, launches a headless Chromium via Playwright, walks the
// DOM, and emits one `Action` per interaction kind the page exposes. The
// classifier is intentionally conservative — we'd rather miss a marginally
// interactable element than emit a fake one (no-stub-data rule).
//
// Discovery rules (in priority order):
//   1. `<button>`, `<a href>`, `[role=button]`, `[role=link]` -> click
//   2. `<input type=text|email|password|search|url|tel|number>`, `<textarea>` -> focus_input AND type
//      (type carries a rule: requires_prior_action focus_input on same selector)
//   3. `<input type=checkbox|radio>` -> toggle_checkbox
//   4. `<select>` -> select_option
//   5. Always emit one global `resize_viewport` action
//
// Stable selector preference: data-testid > [name] > ARIA role+name > nth-of-type CSS path.

import { createHash } from "node:crypto";

import { chromium, type Browser, type Page } from "playwright";

import {
  matchFileEntry,
  matchTextEntry,
  type InputCatalog,
  type FieldSurface,
} from "./inputs.js";
import { waitForInteractableContent } from "./page-utils.js";
import { type Action, type ActionKind } from "./types.js";

export interface MapOptions {
  /** Per-page navigation + DOM-settle timeout in ms. Default 15s. */
  timeoutMs?: number;
  /**
   * Hard cap on the post-navigation settle wait. SPAs (Next.js, React Router,
   * Vite, the Vouch dashboard) render their interactable content AFTER
   * `domcontentloaded`. Without waiting, the Mapper sees the loading shell
   * (typically 0-2 interactables) instead of the real surface. Default 5s.
   */
  settleTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Walk the SUT and return discovered actions. Always launches its own browser
 * so a crash mid-walk cannot leave a dangling Playwright process.
 *
 * After navigation, waits for the SPA (if any) to render interactable content
 * before walking the DOM. Vouch 2026-05-22 vouch-on-vouch run found 2 actions
 * on the dashboard's landing page where 17+ exist; root cause was the Mapper
 * walking after `domcontentloaded` but before the `fetch('/api/projects')`
 * resolved and `<main>` got replaced with the rendered project cards. The
 * settle wait closes that gap.
 */
/**
 * Map a target's surface into Actions.
 *
 * @param targetUrl  URL the browser will navigate to.
 * @param opts       Mapper options (timeouts).
 * @param catalog    Optional operator-supplied real-value catalog. When
 *                   provided, matching entries generate additional Actions:
 *                   text fields gain a `valid_real_<name>` type variant,
 *                   and file inputs gain a per-catalog-file upload_file
 *                   Action alongside the default synthetic png_1x1 fixture.
 *                   Pass `undefined` (or omit) for the original behavior.
 */
export async function mapSurface(
  targetUrl: string,
  opts: MapOptions = {},
  catalog?: InputCatalog,
): Promise<Action[]> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout });
    } catch (err) {
      throw new Error(
        `mapSurface: failed to navigate to '${targetUrl}'. ` +
          `Common causes: the URL is not reachable from this host (check VPN, firewall, or that the local dev server is running), ` +
          `or the page exceeded the ${timeout}ms timeout. ` +
          `Underlying error: ${String((err as Error).message ?? err)}`,
      );
    }
    // Settle: wait for SPAs to render before walking. Returns {settled, finalCount}
    // for logging; the Mapper proceeds in either case so a genuinely sparse page
    // (or one whose hydration never completes) still gets mapped with whatever
    // is in the DOM at the cap.
    const settleResult = await waitForInteractableContent(page, { timeoutMs: settleTimeoutMs });
    if (!settleResult.settled) {
      process.stderr.write(
        `[vouch/surface] settle cap (${settleTimeoutMs}ms) reached on '${targetUrl}'. ` +
          `Only ${settleResult.finalCount} interactable elements present. ` +
          `Either the page is genuinely sparse, or its hydration takes longer than the cap. ` +
          `Mapping what's there. To wait longer, pass --settle-timeout-ms <ms>.\n`,
      );
    }
    return await walkPage(page, catalog);
  } finally {
    if (browser) await browser.close();
  }
}

async function walkPage(page: Page, catalog?: InputCatalog): Promise<Action[]> {
  // Strategy: ask the page itself for the interactable nodes via a single
  // evaluate call (one round-trip, no per-node IPC). The script returns
  // plain serializable records; classification + selector synthesis happen
  // in Node so the page sees no Vouch state.
  type RawNode = {
    tag: string;
    type: string | null;
    role: string | null;
    name: string | null;
    text: string | null;
    placeholder: string | null;
    idAttr: string | null;
    testid: string | null;
    nameAttr: string | null;
    cssPath: string;
  };

  // IMPORTANT: the callback runs in the BROWSER context, not Node. tsx /
  // esbuild transpiles TS at runtime and, when it sees named function
  // declarations, inserts `__name(fn, "fnName")` calls for stack-trace
  // hygiene. Those `__name` helpers don't exist in the browser, so the
  // evaluate throws `ReferenceError: __name is not defined`.
  //
  // The reliable workaround that's compatible with both tsx and `tsc` builds
  // is to pass a STRING to page.evaluate (no transpiler wrapping at all) and
  // use only arrow functions inside. This is documented in
  // https://github.com/microsoft/playwright/issues/26354.
  const browserScript = `
    (() => {
      const isInteractable = (el) => {
        const t = el.tagName.toLowerCase();
        if (t === "button" || t === "select" || t === "textarea") return true;
        if (t === "a" && el.href) return true;
        if (t === "input") {
          const type = (el.type || "text").toLowerCase();
          return ["text", "email", "password", "search", "url", "tel", "number", "checkbox", "radio", "file"].includes(type);
        }
        const role = el.getAttribute("role");
        if (role && ["button", "link", "checkbox", "radio", "menuitem", "tab"].includes(role)) return true;
        return false;
      };

      const cssPath = (el) => {
        const tid = el.getAttribute("data-testid");
        if (tid) return '[data-testid="' + tid + '"]';
        const id = el.id;
        if (id) return "#" + CSS.escape(id);
        const nameAttr = el.name;
        if (nameAttr) return el.tagName.toLowerCase() + '[name="' + nameAttr + '"]';
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== "html") {
          const parent = cur.parentElement;
          if (!parent) break;
          const curTag = cur.tagName;
          const siblings = Array.from(parent.children).filter((c) => c.tagName === curTag);
          const idx = siblings.indexOf(cur) + 1;
          parts.unshift(cur.tagName.toLowerCase() + ":nth-of-type(" + idx + ")");
          cur = parent;
        }
        return parts.join(" > ");
      };

      const all = Array.from(document.querySelectorAll("*"));
      const out = [];
      for (const el of all) {
        if (!isInteractable(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          role: el.getAttribute("role"),
          name: el.getAttribute("aria-label") || null,
          text: ((el.textContent || "").trim().slice(0, 60)) || null,
          placeholder: el.getAttribute("placeholder"),
          idAttr: el.id || null,
          testid: el.getAttribute("data-testid"),
          nameAttr: el.name || null,
          cssPath: cssPath(el),
        });
      }
      return out;
    })()
  `;
  const raw: RawNode[] = (await page.evaluate(browserScript)) as RawNode[];

  return synthesizeActions(raw, catalog);
}

interface RawNode {
  tag: string;
  type: string | null;
  role: string | null;
  name: string | null;
  text: string | null;
  placeholder: string | null;
  idAttr: string | null;
  testid: string | null;
  nameAttr: string | null;
  cssPath: string;
}

function describe(node: RawNode): string {
  const label = node.name || node.text || node.placeholder || node.nameAttr || node.idAttr || node.tag;
  if (node.tag === "input" || node.tag === "textarea") {
    return `${node.type ?? "text"} field "${label}"`;
  }
  if (node.tag === "select") return `select "${label}"`;
  if (node.tag === "button") return `button "${label}"`;
  if (node.tag === "a") return `link "${label}"`;
  return `${node.tag} "${label}"`;
}

function actionIdFromSelector(kind: ActionKind, selector: string | null, salt = ""): string {
  const base = selector ?? "global";
  // Sanitize for filesystem / URL safety; not cryptographic.
  const safe = base
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  // A 60-char prefix is fine for sample-form fixtures where every selector is
  // short and unique. On real React / Next.js apps (e.g. Meridian) many
  // deeply-nested element selectors share long auto-generated class prefixes
  // so the sliced `safe` collides across DISTINCT cssPaths — but the dedupe
  // key in synthesizeActions uses the full cssPath, so both survive synthesis
  // and the duplicate-id row trips the SQLite PRIMARY KEY(run_id, id)
  // UNIQUE constraint when the run is persisted. Append a short deterministic
  // hash of the FULL (pre-slice, pre-sanitize) selector + salt so the id stays
  // human-readable AND globally unique within a run. Hash is sha256[..8] so a
  // collision is ~1 in 2^32 — fine for selector uniqueness, not security.
  const fingerprint = createHash("sha256")
    .update(`${kind}::${base}::${salt}`)
    .digest("hex")
    .slice(0, 8);
  return `${kind}__${safe}${salt ? `__${salt}` : ""}__${fingerprint}`;
}

interface TypeVariant {
  /** Short identifier appended to the action id (e.g. `valid`, `empty`, `negative`). */
  key: string;
  /** Literal text Vouch will type. */
  value: string;
  /** One-line human description shown on the dashboard. */
  description: string;
  /**
   * When true, the value MUST NOT be surfaced raw on the dashboard or in the
   * SQLite execution row — it came from an env-referenced catalog entry
   * (wallet seed, API token, etc.). The executor still types it because
   * Playwright needs the literal; downstream UI / persistence consult this
   * flag and redact before display.
   */
  sensitive?: boolean;
  /**
   * Name of the catalog entry that produced this variant, when applicable.
   * Surfaced in the dashboard as "via catalog: <name>". Undefined for
   * synthetic variants.
   */
  catalogEntryName?: string;
}

/**
 * Returns the plausible test values for a text-like field. Each variant becomes
 * its own action so permutations can exercise the field with multiple inputs
 * within a single run. Variants are deterministic so re-runs are reproducible.
 *
 * Variant counts per field type (tunable; growth is geometric in depth):
 *   email:    4 (valid, empty, no_at, no_domain)
 *   password: 4 (valid, empty, too_short, very_long)
 *   number:   3 (positive, zero, negative)  — user-requested
 *   url:      3 (valid, empty, not_url)
 *   tel:      3 (valid, empty, letters)
 *   search:   2 (valid, empty)
 *   text:     2 (valid, empty)
 */
/**
 * Map a RawNode to the FieldSurface shape the catalog matcher consumes.
 * Kept here (rather than living in inputs.ts) so this surface module owns
 * the translation from its own crawl shape to the matcher's input.
 */
function nodeToFieldSurface(node: RawNode): FieldSurface {
  return {
    selector: node.cssPath || undefined,
    placeholder: node.placeholder ?? undefined,
    nameAttr: node.nameAttr ?? undefined,
    idAttr: node.idAttr ?? undefined,
    ariaLabel: node.name ?? undefined,
    labelText: node.text ?? undefined,
  };
}

function plausibleValuesFor(node: RawNode, catalog?: InputCatalog): TypeVariant[] {
  const t = (node.type ?? "text").toLowerCase();
  const hint = (node.placeholder ?? node.nameAttr ?? node.idAttr ?? "").toLowerCase();

  // Operator-supplied "real" value gets PREPENDED so it leads each
  // variant set. The synthetic boundary / negative variants still run —
  // the real value adds a happy-path positive case the synthetic ones
  // can't satisfy (DMV lookup, VIN decode, server-side validation, etc.).
  const realPrefix = realVariantFor(node, catalog);
  const append = (rest: TypeVariant[]): TypeVariant[] =>
    realPrefix ? [realPrefix, ...rest] : rest;

  if (t === "email" || hint.includes("email")) {
    return append([
      { key: "valid", value: "vouch+probe@example.com", description: "well-formed email" },
      { key: "empty", value: "", description: "empty string (tests required-field validation)" },
      { key: "no_at", value: "not-an-email.com", description: "missing '@' (invalid format)" },
      { key: "no_domain", value: "bad@", description: "missing domain after '@' (invalid format)" },
      { key: "whitespace_only", value: "   ", description: "whitespace only (catches trim-not-applied)" },
      { key: "unicode", value: "正常@例え.com", description: "unicode domain + local part" },
    ]);
  }
  if (t === "password" || hint.includes("password")) {
    return append([
      { key: "valid", value: "VouchProbe!2026", description: "meets typical minlength + complexity" },
      { key: "empty", value: "", description: "empty string (tests required-field validation)" },
      { key: "too_short", value: "abc", description: "below typical 8-char minimum" },
      { key: "very_long", value: "x".repeat(200), description: "200 chars (tests maxlength + perf)" },
      { key: "whitespace_only", value: "        ", description: "whitespace only at minlength (catches trim-not-applied)" },
    ]);
  }
  if (t === "number" || hint.includes("age") || hint.includes("count") || hint.includes("number")) {
    return append([
      { key: "positive", value: "42", description: "positive integer" },
      { key: "zero", value: "0", description: "zero (boundary)" },
      { key: "negative", value: "-5", description: "negative integer (some forms reject)" },
      { key: "very_large", value: "999999999999", description: "very large (tests overflow handling)" },
      { key: "decimal", value: "3.14", description: "decimal in an integer field" },
    ]);
  }
  if (t === "url" || hint.includes("url") || hint.includes("link")) {
    return append([
      { key: "valid", value: "https://example.com", description: "well-formed URL" },
      { key: "empty", value: "", description: "empty string" },
      { key: "not_url", value: "just some text", description: "not a URL (tests format validation)" },
      { key: "javascript_proto", value: "javascript:alert(1)", description: "javascript: protocol (tests scheme filtering)" },
    ]);
  }
  if (t === "tel" || hint.includes("phone") || hint.includes("tel")) {
    return append([
      { key: "valid", value: "5551234567", description: "10-digit phone number" },
      { key: "empty", value: "", description: "empty string" },
      { key: "letters", value: "abcdefghij", description: "letters in a tel field (often rejected)" },
    ]);
  }
  if (t === "search" || hint.includes("search")) {
    return append([
      { key: "valid", value: "vouch probe", description: "normal search text" },
      { key: "empty", value: "", description: "empty search" },
      { key: "xss_like", value: "<script>alert('x')</script>", description: "script-injection-looking input (tests output escaping)" },
    ]);
  }
  // Default text / textarea.
  return append([
    { key: "valid", value: "vouch probe text", description: "normal text input" },
    { key: "empty", value: "", description: "empty string" },
    { key: "whitespace_only", value: "   ", description: "whitespace only (catches trim-not-applied)" },
    { key: "unicode", value: "日本語テスト 🚀", description: "unicode + emoji (tests encoding round-trip)" },
    { key: "xss_like", value: "<script>alert('x')</script>", description: "script-injection-looking input (tests output escaping)" },
  ]);
}

/**
 * Look up an operator-supplied text value for `node` in the catalog and
 * shape it into a TypeVariant. Returns null when no catalog is supplied
 * or no entry matches.
 *
 * The variant key embeds the catalog entry name so the resulting action id
 * (e.g. `type__form_input__valid_real_license_plate`) is uniquely
 * traceable to its source.
 *
 * NOTE: when a matched entry is `sensitive` (came from `value_from_env`),
 * the variant DESCRIPTION names the entry, not the value. Action.type_value
 * still carries the secret because Playwright needs it to actually type;
 * callers that persist or display Action.type_value must consult the entry's
 * `sensitive` flag before doing so. This module's job is to wire — the
 * dashboard / DB layer owns redaction.
 */
function realVariantFor(node: RawNode, catalog?: InputCatalog): TypeVariant | null {
  if (!catalog || catalog.isEmpty) return null;
  const match = matchTextEntry(nodeToFieldSurface(node), catalog);
  if (!match) return null;
  const entry = match.entry;
  return {
    key: `valid_real_${entry.name}`,
    value: entry.value,
    description: entry.sensitive
      ? `operator-supplied value from catalog entry '${entry.name}' (sensitive, redacted)`
      : `operator-supplied value from catalog entry '${entry.name}'` +
        (entry.description ? ` — ${entry.description}` : ""),
    sensitive: entry.sensitive,
    catalogEntryName: entry.name,
  };
}

function synthesizeActions(rawNodes: RawNode[], catalog?: InputCatalog): Action[] {
  const seenSelectors = new Set<string>();
  const out: Action[] = [];

  for (const node of rawNodes) {
    if (!node.cssPath) continue;
    if (seenSelectors.has(`${node.cssPath}::${node.tag}::${node.type ?? ""}`)) continue;
    seenSelectors.add(`${node.cssPath}::${node.tag}::${node.type ?? ""}`);

    const description = describe(node);

    if (
      (node.tag === "input" &&
        ["text", "email", "password", "search", "url", "tel", "number"].includes(
          (node.type ?? "text").toLowerCase(),
        )) ||
      node.tag === "textarea"
    ) {
      // ONE focus_input per field. MULTIPLE type actions, one per plausible
      // value — each variant is its own action with a value-key suffix on its
      // id (e.g. `type__email_input__valid`, `type__email_input__empty`).
      // The permutation generator treats each variant as a distinct action,
      // so depth-2 runs exercise the field with several inputs paired against
      // every other action.
      const focusId = actionIdFromSelector("focus_input", node.cssPath);
      out.push({
        id: focusId,
        kind: "focus_input",
        selector: node.cssPath,
        description: `Focus ${description}`,
        type_value: null,
        rules: [],
        meta: {
          tag: node.tag,
          type: node.type ?? "text",
          placeholder: node.placeholder,
          name: node.nameAttr,
        },
      });
      const variants = plausibleValuesFor(node, catalog);
      for (const v of variants) {
        out.push({
          id: actionIdFromSelector("type", node.cssPath, v.key),
          kind: "type",
          selector: node.cssPath,
          description: `Type ${v.description} into ${description}`,
          type_value: v.value,
          rules: [
            {
              kind: "requires_prior_action",
              prior_kind: "focus_input",
              same_selector: true,
              description: `Requires a prior focus_input on '${node.cssPath}' in the sequence.`,
            },
          ],
          meta: {
            tag: node.tag,
            type: node.type ?? "text",
            name: node.nameAttr,
            variant_key: v.key,
            variant_description: v.description,
            // Catalog provenance. Both keys are absent for synthetic
            // variants. `sensitive: true` is the redact-before-display
            // signal for the dashboard server.
            ...(v.catalogEntryName ? { catalog_entry_name: v.catalogEntryName } : {}),
            ...(v.sensitive ? { sensitive: true } : {}),
          },
        });
      }
      continue;
    }

    if (node.tag === "input" && (node.type ?? "").toLowerCase() === "file") {
      // <input type="file"> upload. We do NOT add a focus_input + type pair
      // here — the OS file picker isn't reachable via Playwright's text
      // input model, and `setInputFiles` populates the input directly. We
      // also do NOT impose a rule that requires a prior click on a label /
      // upload button: many SUTs wire the visible button to a hidden file
      // input via a `<label>` association, and Vouch's executor can drive
      // the hidden input straight without a label tap. If a future SUT
      // genuinely requires the prior click (e.g. opens a modal that
      // injects the input on demand), the surface-mapper sees that case
      // because the file input simply isn't present until after the click,
      // and the depth-2 permutation [click upload-button, upload_file]
      // remains the only viable sequence — which the planner emits
      // naturally without any rule.
      // Always emit the synthetic png_1x1 fixture upload. This is the
      // minimum-viable positive case (valid PNG bytes, harmless 1x1) that
      // works even when no catalog is supplied.
      out.push({
        id: actionIdFromSelector("upload_file", node.cssPath),
        kind: "upload_file",
        selector: node.cssPath,
        description: `Upload a PNG test fixture into ${description}`,
        type_value: null,
        rules: [],
        meta: {
          tag: node.tag,
          type: "file",
          fixture_kind: "png_1x1",
          name: node.nameAttr,
        },
      });
      // If the operator's catalog has a matching files entry, emit an
      // ADDITIONAL upload_file action that points at that real file.
      // This is what lets a target system's face-match / VIN-decode /
      // doc-type validator actually succeed during a Vouch run.
      const fileMatch = catalog ? matchFileEntry(nodeToFieldSurface(node), catalog) : null;
      if (fileMatch) {
        const entry = fileMatch.entry;
        out.push({
          id: actionIdFromSelector("upload_file", node.cssPath, `catalog_${entry.name}`),
          kind: "upload_file",
          selector: node.cssPath,
          description:
            `Upload operator-supplied file from catalog entry '${entry.name}' into ${description}` +
            (entry.description ? ` — ${entry.description}` : ""),
          type_value: null,
          rules: [],
          meta: {
            tag: node.tag,
            type: "file",
            fixture_kind: "catalog",
            catalog_entry_name: entry.name,
            catalog_absolute_path: entry.absolutePath,
            catalog_mime: entry.mime,
            name: node.nameAttr,
          },
        });
      }
      continue;
    }

    if (node.tag === "input" && ["checkbox", "radio"].includes((node.type ?? "").toLowerCase())) {
      out.push({
        id: actionIdFromSelector("toggle_checkbox", node.cssPath),
        kind: "toggle_checkbox",
        selector: node.cssPath,
        description: `Toggle ${description}`,
        type_value: null,
        rules: [],
        meta: { tag: node.tag, type: node.type ?? "checkbox", name: node.nameAttr },
      });
      continue;
    }

    if (node.tag === "select") {
      out.push({
        id: actionIdFromSelector("select_option", node.cssPath),
        kind: "select_option",
        selector: node.cssPath,
        description: `Select option in ${description}`,
        type_value: null,
        rules: [],
        meta: { tag: node.tag, name: node.nameAttr },
      });
      continue;
    }

    if (node.tag === "button" || node.tag === "a" || node.role === "button" || node.role === "link") {
      out.push({
        id: actionIdFromSelector("click", node.cssPath),
        kind: "click",
        selector: node.cssPath,
        description: `Click ${description}`,
        type_value: null,
        rules: [],
        meta: { tag: node.tag, role: node.role },
      });
      continue;
    }
  }

  // Always emit one global viewport-resize action so plans include at least
  // one non-element-bound interaction.
  out.push({
    id: "resize_viewport__global",
    kind: "resize_viewport",
    selector: null,
    description: "Resize viewport to mobile breakpoint (375x812)",
    type_value: null,
    rules: [],
    meta: { width: 375, height: 812 },
  });

  return out;
}
