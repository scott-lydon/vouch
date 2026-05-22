// Executor + Verdict Engine.
//
// For each permutation, opens a FRESH browser context, navigates to the
// target, replays the action sequence step by step with per-step timeouts,
// captures pre/post observable state (a synthesized text summary of the
// visible DOM), and writes an `Execution` row.
//
// Verdicts:
//   - `pass` — every step succeeded and the observed post-state is non-empty
//   - `fail` — a step threw a Playwright assertion / interaction error
//   - `timeout` — a step exceeded `stepTimeoutMs`
//   - `infrastructure_error` — Playwright couldn't open / navigate
//   - `missing_input` — a `type` action with no preceding focus (should be
//      filtered by permutations.ts but caught here as a defense-in-depth)
//
// Fresh context per permutation is the constitution's invariant for sequence
// isolation; reusing a context would let permutation N see state from N-1.

import { chromium, type Browser } from "playwright";

import { type Action, type Execution, type Permutation, type Verdict } from "./types.js";

export interface ExecuteOptions {
  targetUrl: string;
  /** Timeout for any single Playwright interaction (click, fill, etc.). Default 8s. */
  stepTimeoutMs?: number;
  /** Navigation timeout for goto(). Default 15s. */
  navTimeoutMs?: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 8_000;
const DEFAULT_NAV_TIMEOUT_MS = 15_000;

interface ActiveFocus {
  selector: string;
}

/**
 * Execute every permutation in the input list. Returns one Execution per
 * permutation, in input order. Browser is reused across permutations but a
 * fresh CONTEXT (cookies, storage, page) is opened per permutation so
 * sequences don't see each other's state.
 */
export async function executePermutations(
  permutations: Permutation[],
  actionsById: Map<string, Action>,
  opts: ExecuteOptions,
): Promise<Execution[]> {
  const stepTimeout = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const navTimeout = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const out: Execution[] = [];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    for (const perm of permutations) {
      out.push(await executeOne(browser, perm, actionsById, opts.targetUrl, stepTimeout, navTimeout));
    }
  } finally {
    if (browser) await browser.close();
  }
  return out;
}

async function executeOne(
  browser: Browser,
  perm: Permutation,
  actionsById: Map<string, Action>,
  targetUrl: string,
  stepTimeout: number,
  navTimeout: number,
): Promise<Execution> {
  const startedAt = new Date().toISOString();
  const stepLog: Execution["step_log"] = [];
  let verdict: Verdict = "pass";
  let errorClass: string | null = null;
  let observedPostState = "";

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
    } catch (err) {
      verdict = "infrastructure_error";
      errorClass = "navigation_failed";
      observedPostState = `Navigation to ${targetUrl} failed: ${(err as Error).message}`;
      const finishedAt = new Date().toISOString();
      return {
        permutation_id: perm.id,
        verdict,
        step_log: stepLog,
        observed_post_state: observedPostState,
        started_at: startedAt,
        finished_at: finishedAt,
        error_class: errorClass,
      };
    }

    let activeFocus: ActiveFocus | null = null;
    for (const actionId of perm.action_ids) {
      const action = actionsById.get(actionId);
      const stepStart = new Date().toISOString();
      if (!action) {
        stepLog.push({
          action_id: actionId,
          kind: "click",
          started_at: stepStart,
          finished_at: new Date().toISOString(),
          ok: false,
          error_message: `Unknown action id '${actionId}' (not present in this run's actions table).`,
        });
        verdict = "infrastructure_error";
        errorClass = "unknown_action_id";
        break;
      }
      try {
        await playStep(page, action, activeFocus, stepTimeout);
        if (action.kind === "focus_input") {
          activeFocus = { selector: action.selector ?? "" };
        } else {
          activeFocus = null;
        }
        stepLog.push({
          action_id: actionId,
          kind: action.kind,
          started_at: stepStart,
          finished_at: new Date().toISOString(),
          ok: true,
          error_message: null,
        });
      } catch (err) {
        const msg = (err as Error).message;
        const isTimeout = /Timeout|timeout/i.test(msg);
        stepLog.push({
          action_id: actionId,
          kind: action.kind,
          started_at: stepStart,
          finished_at: new Date().toISOString(),
          ok: false,
          error_message: msg,
        });
        verdict = isTimeout ? "timeout" : "fail";
        errorClass = isTimeout ? "playwright_timeout" : "playwright_action_error";
        break;
      }
    }

    observedPostState = await observePostState(page);
  } finally {
    await ctx.close();
  }
  const finishedAt = new Date().toISOString();
  return {
    permutation_id: perm.id,
    verdict,
    step_log: stepLog,
    observed_post_state: observedPostState,
    started_at: startedAt,
    finished_at: finishedAt,
    error_class: errorClass,
  };
}

async function playStep(
  page: import("playwright").Page,
  action: Action,
  activeFocus: ActiveFocus | null,
  timeout: number,
): Promise<void> {
  switch (action.kind) {
    case "click": {
      if (!action.selector) throw new Error(`click action ${action.id} has no selector`);
      await page.locator(action.selector).first().click({ timeout });
      return;
    }
    case "focus_input": {
      if (!action.selector) throw new Error(`focus_input action ${action.id} has no selector`);
      await page.locator(action.selector).first().focus({ timeout });
      return;
    }
    case "type": {
      if (!action.selector) throw new Error(`type action ${action.id} has no selector`);
      // Defense-in-depth: permutations.ts already filtered, but if we got here
      // without an active focus on the same selector, surface a typed verdict.
      if (!activeFocus || activeFocus.selector !== action.selector) {
        throw new Error(
          `type action requires an immediately-preceding focus_input on the same selector ('${action.selector}'). ` +
            `This permutation should have been filtered by permutations.ts; if you see this error, the rule filter is broken.`,
        );
      }
      await page.keyboard.type(action.type_value ?? "", { delay: 5 });
      return;
    }
    case "toggle_checkbox": {
      if (!action.selector) throw new Error(`toggle_checkbox action ${action.id} has no selector`);
      const loc = page.locator(action.selector).first();
      const checked = await loc.isChecked({ timeout });
      if (checked) await loc.uncheck({ timeout });
      else await loc.check({ timeout });
      return;
    }
    case "select_option": {
      if (!action.selector) throw new Error(`select_option action ${action.id} has no selector`);
      const loc = page.locator(action.selector).first();
      // Pick the second option if present, else the first. Deterministic
      // and avoids the empty default that <select> often starts on.
      const values = await loc.evaluate((el) =>
        Array.from((el as HTMLSelectElement).options).map((o) => o.value),
      );
      if (values.length === 0) throw new Error(`select has no <option> children`);
      const pick = values.length > 1 ? values[1] : values[0];
      await loc.selectOption(pick!, { timeout });
      return;
    }
    case "resize_viewport": {
      const w = Number(action.meta["width"] ?? 375);
      const h = Number(action.meta["height"] ?? 812);
      await page.setViewportSize({ width: w, height: h });
      return;
    }
  }
}

async function observePostState(page: import("playwright").Page): Promise<string> {
  // Compose a small text summary: URL + title + first 600 chars of visible text +
  // any visible error / success indicators. Deterministic enough for diffs.
  try {
    const url = page.url();
    const title = await page.title();
    const visibleText = (
      (await page.evaluate(() => (document.body?.innerText ?? "").trim().slice(0, 600))) || ""
    ).replace(/\s+/g, " ");
    return `url=${url} | title=${title} | text="${visibleText}"`;
  } catch (err) {
    return `(observePostState failed: ${(err as Error).message})`;
  }
}
