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

import { chromium, type Browser, type Page } from "playwright";

import { type Action, type ActionKind } from "./types.js";

export interface MapOptions {
  /** Per-page navigation + DOM-settle timeout in ms. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Walk the SUT and return discovered actions. Always launches its own browser
 * so a crash mid-walk cannot leave a dangling Playwright process.
 */
export async function mapSurface(targetUrl: string, opts: MapOptions = {}): Promise<Action[]> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    return await walkPage(page);
  } finally {
    if (browser) await browser.close();
  }
}

async function walkPage(page: Page): Promise<Action[]> {
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
          return ["text", "email", "password", "search", "url", "tel", "number", "checkbox", "radio"].includes(type);
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

  return synthesizeActions(raw);
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
  return `${kind}__${safe}${salt ? `__${salt}` : ""}`;
}

interface TypeVariant {
  /** Short identifier appended to the action id (e.g. `valid`, `empty`, `negative`). */
  key: string;
  /** Literal text Vouch will type. */
  value: string;
  /** One-line human description shown on the dashboard. */
  description: string;
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
function plausibleValuesFor(node: RawNode): TypeVariant[] {
  const t = (node.type ?? "text").toLowerCase();
  const hint = (node.placeholder ?? node.nameAttr ?? node.idAttr ?? "").toLowerCase();

  if (t === "email" || hint.includes("email")) {
    return [
      { key: "valid", value: "vouch+probe@example.com", description: "well-formed email" },
      { key: "empty", value: "", description: "empty string (tests required-field validation)" },
      { key: "no_at", value: "not-an-email.com", description: "missing '@' (invalid format)" },
      { key: "no_domain", value: "bad@", description: "missing domain after '@' (invalid format)" },
      { key: "whitespace_only", value: "   ", description: "whitespace only (catches trim-not-applied)" },
      { key: "unicode", value: "正常@例え.com", description: "unicode domain + local part" },
    ];
  }
  if (t === "password" || hint.includes("password")) {
    return [
      { key: "valid", value: "VouchProbe!2026", description: "meets typical minlength + complexity" },
      { key: "empty", value: "", description: "empty string (tests required-field validation)" },
      { key: "too_short", value: "abc", description: "below typical 8-char minimum" },
      { key: "very_long", value: "x".repeat(200), description: "200 chars (tests maxlength + perf)" },
      { key: "whitespace_only", value: "        ", description: "whitespace only at minlength (catches trim-not-applied)" },
    ];
  }
  if (t === "number" || hint.includes("age") || hint.includes("count") || hint.includes("number")) {
    return [
      { key: "positive", value: "42", description: "positive integer" },
      { key: "zero", value: "0", description: "zero (boundary)" },
      { key: "negative", value: "-5", description: "negative integer (some forms reject)" },
      { key: "very_large", value: "999999999999", description: "very large (tests overflow handling)" },
      { key: "decimal", value: "3.14", description: "decimal in an integer field" },
    ];
  }
  if (t === "url" || hint.includes("url") || hint.includes("link")) {
    return [
      { key: "valid", value: "https://example.com", description: "well-formed URL" },
      { key: "empty", value: "", description: "empty string" },
      { key: "not_url", value: "just some text", description: "not a URL (tests format validation)" },
      { key: "javascript_proto", value: "javascript:alert(1)", description: "javascript: protocol (tests scheme filtering)" },
    ];
  }
  if (t === "tel" || hint.includes("phone") || hint.includes("tel")) {
    return [
      { key: "valid", value: "5551234567", description: "10-digit phone number" },
      { key: "empty", value: "", description: "empty string" },
      { key: "letters", value: "abcdefghij", description: "letters in a tel field (often rejected)" },
    ];
  }
  if (t === "search" || hint.includes("search")) {
    return [
      { key: "valid", value: "vouch probe", description: "normal search text" },
      { key: "empty", value: "", description: "empty search" },
      { key: "xss_like", value: "<script>alert('x')</script>", description: "script-injection-looking input (tests output escaping)" },
    ];
  }
  // Default text / textarea.
  return [
    { key: "valid", value: "vouch probe text", description: "normal text input" },
    { key: "empty", value: "", description: "empty string" },
    { key: "whitespace_only", value: "   ", description: "whitespace only (catches trim-not-applied)" },
    { key: "unicode", value: "日本語テスト 🚀", description: "unicode + emoji (tests encoding round-trip)" },
    { key: "xss_like", value: "<script>alert('x')</script>", description: "script-injection-looking input (tests output escaping)" },
  ];
}

function synthesizeActions(rawNodes: RawNode[]): Action[] {
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
      const variants = plausibleValuesFor(node);
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
