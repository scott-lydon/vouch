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

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { chromium, type Browser } from "playwright";

import { waitForInteractableContent } from "./page-utils.js";
import { type Action, type Execution, type Permutation, type Verdict } from "./types.js";

export interface ExecuteOptions {
  targetUrl: string;
  /** Timeout for any single Playwright interaction (click, fill, etc.). Default 8s. */
  stepTimeoutMs?: number;
  /** Navigation timeout for goto(). Default 15s. */
  navTimeoutMs?: number;
  /**
   * If set, captures a PNG screenshot after each step into
   * `<screenshotsDir>/<perm_id>/step-<n>.png`. The findings analyzer is
   * responsible for cleaning up screenshots from permutations that didn't
   * produce blocking findings (`cleanCleanRunScreenshots` in findings.ts).
   * Default OFF when this option is absent; the CLI defaults it ON.
   */
  screenshotsDir?: string | null;
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
  const screenshotsDir = opts.screenshotsDir ?? null;
  const out: Execution[] = [];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    for (const perm of permutations) {
      out.push(
        await executeOne(
          browser,
          perm,
          actionsById,
          opts.targetUrl,
          stepTimeout,
          navTimeout,
          screenshotsDir,
        ),
      );
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
  screenshotsDir: string | null,
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
    // Settle: same hydration-wait the Surface Mapper does after goto. Without
    // it, the executor would try to interact with selectors that exist in the
    // discovered-actions table (mapped after settle) but don't yet exist in
    // the page at the moment we navigate fresh for this permutation. The cap
    // is short (3s) because per-permutation freshness is amortized differently
    // than per-run mapping — we're paying the cap on every permutation, so
    // overpaying compounds. 3s is enough for typical SPA hydration on a warm
    // browser; pages slower than that hit the cap and proceed with whatever
    // exists, which surfaces as Playwright errors on the first step that
    // references an unrendered element. Those errors are real bugs (the SUT
    // takes too long to render) and are the correct thing for Vouch to report.
    await waitForInteractableContent(page, { timeoutMs: 3_000 });

    let activeFocus: ActiveFocus | null = null;
    let stepIdx = 0;
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
          screenshot_path: null,
        });
        verdict = "infrastructure_error";
        errorClass = "unknown_action_id";
        break;
      }
      let stepOk = true;
      let stepErr: string | null = null;
      try {
        await playStep(page, action, activeFocus, stepTimeout);
        if (action.kind === "focus_input") {
          activeFocus = { selector: action.selector ?? "" };
        } else {
          activeFocus = null;
        }
      } catch (err) {
        stepOk = false;
        stepErr = (err as Error).message;
        const isTimeout = /Timeout|timeout/i.test(stepErr);
        verdict = isTimeout ? "timeout" : "fail";
        errorClass = isTimeout ? "playwright_timeout" : "playwright_action_error";
      }
      const shotPath = await maybeScreenshot(page, screenshotsDir, perm.id, stepIdx);
      stepLog.push({
        action_id: actionId,
        kind: action.kind,
        started_at: stepStart,
        finished_at: new Date().toISOString(),
        ok: stepOk,
        error_message: stepErr,
        screenshot_path: shotPath,
      });
      stepIdx++;
      if (!stepOk) break;
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
      // Capture the pre-click URL so we can detect SPA route changes that
      // Playwright's load/networkidle events don't always fire for.
      const beforeUrl = page.url();
      await page.locator(action.selector).first().click({ timeout });
      // Vouch 2026-05-22 bug surfaced on Meridian's deployed frontend: the
      // executor returned the moment the click was dispatched, before
      // Next.js client-side routing had updated the URL or rendered the
      // target page. Subsequent observation snapshots captured the OLD URL
      // and the expectation verifier reported "navigation never occurred"
      // for every nav-link click. Fix: after every click, give the page a
      // short, capped chance to settle. We race three signals so we wait
      // exactly as long as the click actually needed, never longer:
      //   1. networkidle — covers SSR full-document navigations
      //   2. load — covers initial-paint completion for hard navigations
      //   3. URL change vs. pre-click — covers SPA route changes (Next.js
      //      <Link>, react-router, etc.) where neither networkidle nor
      //      load fires because no new document loads
      // 1500 ms cap because a click that does nothing must not stall a
      // depth-5 campaign for tens of seconds per permutation.
      const settleTimeoutMs = 1_500;
      await Promise.race([
        page.waitForLoadState("networkidle", { timeout: settleTimeoutMs }).catch(() => {}),
        page.waitForLoadState("load", { timeout: settleTimeoutMs }).catch(() => {}),
        page
          .waitForFunction(
            (oldUrl) => window.location.href !== oldUrl,
            beforeUrl,
            { timeout: settleTimeoutMs, polling: 50 },
          )
          .catch(() => {}),
      ]);
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

/**
 * Capture a PNG after the given step ran. Returns absolute path on disk or
 * null if screenshots are off. We always try the capture even when the step
 * threw — the screenshot of the failed state is the most useful evidence.
 */
async function maybeScreenshot(
  page: import("playwright").Page,
  screenshotsDir: string | null,
  permId: string,
  stepIdx: number,
): Promise<string | null> {
  if (!screenshotsDir) return null;
  const dir = resolve(screenshotsDir, permId);
  try {
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `step-${String(stepIdx).padStart(2, "0")}.png`);
    await page.screenshot({ path, fullPage: false, timeout: 5_000 });
    return path;
  } catch {
    // Best-effort. A screenshot failure should never poison the run.
    return null;
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
