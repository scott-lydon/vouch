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

import { chromium, type Browser, type BrowserContext } from "playwright";

import { waitForInteractableContent } from "./page-utils.js";
import {
  type Action,
  type Anomaly,
  type Execution,
  type Permutation,
  type Verdict,
} from "./types.js";

/**
 * Thrown by the executor for failures that are not a single permutation's
 * fault: chromium fails to launch, Playwright binary missing, host starved,
 * etc. The message is the diagnosis. It names the failed operation, lists
 * the most common causes, and points at the literal fix command, so the
 * CLI can print it verbatim and the user can act without grepping source.
 */
export class VouchExecutorError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "VouchExecutorError";
  }
}

export interface ExecuteOptions {
  targetUrl: string;
  /** Timeout for any single Playwright interaction (click, fill, etc.). Default 8s. */
  stepTimeoutMs?: number;
  /** Navigation timeout for goto(). Default 15s. */
  navTimeoutMs?: number;
  /**
   * Hard wallclock cap on `chromium.launch()`. If exceeded, throws
   * VouchExecutorError with diagnostic hints instead of hanging the run
   * forever. Default 30 s.
   *
   * Why a cap: Playwright's launch is unbounded by default. If the Chromium
   * binary is not installed, the host is starved, or sandbox flags block
   * the spawn, the call sits indefinitely and the entire run becomes
   * unrecoverable without a manual kill. 30 s is well above the 1 to 3 s a
   * healthy launch takes and well below any reasonable patience threshold.
   */
  launchTimeoutMs?: number;
  /**
   * Hard wallclock cap on the work for a single permutation: context
   * creation, navigation, hydration wait, every step, observePostState. If
   * the cap fires, the permutation is force closed, an Execution row is
   * written with verdict "timeout" and error_class "perm_wallclock_exceeded",
   * and the run proceeds to the next permutation. Default 90 s.
   *
   * Why distinct from stepTimeoutMs: stepTimeoutMs bounds one interaction
   * (click, focus, type). A depth N permutation can have N steps plus N
   * settles plus the navigation. The step cap does not bound their sum.
   * If an SUT path enters a fetch loop or shows a stuck modal, a single
   * permutation can stall the whole run; this cap is the backstop.
   */
  permTimeoutMs?: number;
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
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_PERM_TIMEOUT_MS = 90_000;

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
  const launchTimeout = opts.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const permTimeout = opts.permTimeoutMs ?? DEFAULT_PERM_TIMEOUT_MS;
  const screenshotsDir = opts.screenshotsDir ?? null;
  const out: Execution[] = [];

  let browser: Browser | null = null;
  try {
    browser = await launchChromiumWithTimeout(launchTimeout);
    for (const perm of permutations) {
      out.push(
        await executeOneCapped(
          browser,
          perm,
          actionsById,
          opts.targetUrl,
          stepTimeout,
          navTimeout,
          screenshotsDir,
          permTimeout,
        ),
      );
    }
  } finally {
    if (browser) {
      // Best effort. The run's results are already in `out`; a close failure
      // here would only mask them. Never swallow the launch error itself,
      // because it surfaced before this finally ran.
      await browser.close().catch(() => {});
    }
  }
  return out;
}

/**
 * Launch Chromium with a hard wallclock cap.
 *
 * If the cap fires while Playwright is still spinning up, the in-flight
 * launch is given a `then` handler that closes any Browser that arrives
 * late, so a slow launcher does not leak a zombie chromium process per
 * timeout. The mapped promise also re-throws so it cannot win the race
 * after we have already given up.
 *
 * Failure messages are diagnostic on purpose: they name the operation, list
 * the four common root causes, and point at the literal fix command. This
 * is the most common "vouch hangs forever" failure mode, so the error path
 * is worth the prose.
 */
async function launchChromiumWithTimeout(timeoutMs: number): Promise<Browser> {
  let timedOut = false;
  const launchPromise = chromium.launch({ headless: true });

  const guarded: Promise<Browser> = launchPromise.then(
    (browser) => {
      if (timedOut) {
        browser.close().catch(() => {});
        throw new VouchExecutorError(
          `internal: chromium.launch() resolved after the ${timeoutMs}ms cap had already fired. The browser was closed; nothing actionable for the user.`,
        );
      }
      return browser;
    },
    (err) => {
      // The real Playwright launch failure. Wrap with a fix hint so the CLI
      // can print one actionable line instead of a stack trace.
      throw new VouchExecutorError(
        `chromium.launch() failed: ${(err as Error).message ?? String(err)}. ` +
          `Most common cause: Chromium is not installed in this Playwright version's cache. ` +
          `Run 'npx playwright install chromium' from the vouch project root, then retry. ` +
          `Docs: https://playwright.dev/docs/intro#installing-playwright`,
        err,
      );
    },
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<Browser>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(
        new VouchExecutorError(
          `chromium.launch() exceeded the ${timeoutMs}ms wallclock cap. ` +
            `Common causes: ` +
            `(1) Chromium not installed in the Playwright cache. Fix: 'npx playwright install chromium'. ` +
            `(2) Host resource starvation (too many parallel runs, low memory). Fix: lower concurrency or run one vouch process at a time. ` +
            `(3) Sandbox restriction in a Linux container. Fix: launch with '--no-sandbox' args or run outside the container. ` +
            `(4) Antivirus quarantining the Chromium binary. ` +
            `Raise the cap via ExecuteOptions.launchTimeoutMs or env VOUCH_LAUNCH_TIMEOUT_MS if your environment actually needs more than ${timeoutMs}ms. ` +
            `Docs: https://playwright.dev/docs/intro#installing-playwright`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([guarded, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Wrap a single permutation in a hard wallclock cap. If the cap fires:
 *   - timedOut is set so the in-flight work knows it's lost the race.
 *   - The browser context is force-closed so any pending Playwright
 *     interaction (a hung navigation, stuck modal, fetch loop) aborts.
 *   - A synthetic Execution row is returned with verdict "timeout" and
 *     error_class "perm_wallclock_exceeded" so the dashboard surfaces
 *     a fix hint rather than a stack trace.
 *
 * If work finishes normally before the cap, the cleanup path closes the
 * context once and clears the timer.
 *
 * Why ctx is created here rather than inside `executeOneInContext`: the
 * timeout handler needs a reference to force-close it; passing it down
 * would create a circular ownership story. Owning ctx here keeps the
 * cleanup responsibility in one place.
 */
async function executeOneCapped(
  browser: Browser,
  perm: Permutation,
  actionsById: Map<string, Action>,
  targetUrl: string,
  stepTimeout: number,
  navTimeout: number,
  screenshotsDir: string | null,
  permTimeoutMs: number,
): Promise<Execution> {
  const startedAt = new Date().toISOString();
  let ctx: BrowserContext;
  try {
    ctx = await browser.newContext();
  } catch (err) {
    // Context creation failed before any step ran. Surface clearly so the
    // operator can tell this from a per-step Playwright error.
    return {
      permutation_id: perm.id,
      verdict: "infrastructure_error",
      step_log: [],
      anomalies: [],
      observed_post_state:
        `browser.newContext() failed before any step ran: ${(err as Error).message ?? String(err)}. ` +
        `If this recurs across many perms, the chromium process likely crashed mid-run; abort and rerun vouch.`,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error_class: "context_create_failed",
    };
  }

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  // Shared step log so the timeout path can snapshot partial evidence.
  // Without this the timeout Execution shipped step_log: [] (qa-adversary
  // Finding 3, 2026-05-22): a depth-5 perm that stalled on step 5 would
  // ship zero step evidence, hiding which earlier step was the actual
  // problem from the dashboard.
  const sharedStepLog: Execution["step_log"] = [];
  // Same pattern for anomalies (yellow-tier evidence): a perm that hangs
  // is often hanging because of a console error or a 500 response, so the
  // anomaly list is exactly what the operator needs to see.
  const sharedAnomalies: Anomaly[] = [];

  const work = executeOneInContext(
    ctx,
    perm,
    actionsById,
    targetUrl,
    stepTimeout,
    navTimeout,
    screenshotsDir,
    startedAt,
    sharedStepLog,
    sharedAnomalies,
  );
  // Suppress an unhandled-rejection log if work loses the race to the cap.
  // The timeout path resolves with a synthetic Execution; the work promise
  // that races against it may still reject later from a force-closed page.
  work.catch(() => {});

  const cap = new Promise<Execution>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      // Best-effort force-close. If close itself stalls, that's a Playwright
      // bug we can't paper over here, but we already have a verdict.
      ctx.close().catch(() => {});
      // Snapshot whatever steps ran before the cap fired. We slice() so the
      // returned Execution holds a frozen copy; the still-running work
      // promise may keep pushing to sharedStepLog briefly before its
      // Playwright calls start throwing from the force-closed context.
      const partialSteps = sharedStepLog.slice();
      const partialAnomalies = sharedAnomalies.slice();
      resolve({
        permutation_id: perm.id,
        verdict: "timeout",
        step_log: partialSteps,
        anomalies: partialAnomalies,
        observed_post_state:
          `Permutation exceeded the per-permutation wallclock cap of ${permTimeoutMs}ms ` +
          `after completing ${partialSteps.length} of ${perm.action_ids.length} steps. ` +
          `The browser context was force-closed and the run continued. ` +
          `If this recurs: ` +
          `(1) Raise opts.permTimeoutMs or env VOUCH_PERM_TIMEOUT_MS. ` +
          `(2) Lower --depth so each permutation has fewer steps. ` +
          `(3) Investigate the SUT path this sequence exercises (likely a fetch loop or stuck modal).`,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error_class: "perm_wallclock_exceeded",
      });
    }, permTimeoutMs);
  });

  try {
    return await Promise.race([work, cap]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (!timedOut) {
      // Normal-completion close. The timeout path already closed ctx itself.
      await ctx.close().catch(() => {});
    }
  }
}

async function executeOneInContext(
  ctx: BrowserContext,
  perm: Permutation,
  actionsById: Map<string, Action>,
  targetUrl: string,
  stepTimeout: number,
  navTimeout: number,
  screenshotsDir: string | null,
  startedAt: string,
  /**
   * Step log owned by the caller (executeOneCapped). We push to it as steps
   * run so that if the per-perm cap fires mid-permutation, the caller can
   * snapshot whatever ran before the cap. Aliasing the array (not copying)
   * is the point: a local-only log would be unreachable from the cap path.
   */
  stepLog: Execution["step_log"],
  /**
   * Anomaly bucket owned by the caller. Console errors, page errors, and
   * failed HTTP responses get pushed here as they happen. Same aliasing
   * rationale as stepLog: the cap path snapshots this on timeout.
   */
  anomalies: Anomaly[],
): Promise<Execution> {
  let verdict: Verdict = "pass";
  let errorClass: string | null = null;
  let observedPostState = "";

  // ctx is owned by executeOneCapped (the wrapper) so this function does NOT
  // close it. The wrapper closes it on both the normal and timeout paths.
  const page = await ctx.newPage();

  // Anomaly listeners — wired BEFORE goto so we capture issues fired during
  // the initial page load. Playwright invokes these asynchronously, so a
  // 500 response or console.error logged 300ms after a click can still
  // land on the right Execution row.
  attachAnomalyListeners(page, anomalies, targetUrl);

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
      anomalies,
      observed_post_state: observedPostState,
      started_at: startedAt,
      finished_at: finishedAt,
      error_class: errorClass,
    };
  }
  // Settle: same hydration wait the Surface Mapper does after goto. Without
  // it, the executor would try to interact with selectors that exist in the
  // discovered-actions table (mapped after settle) but don't yet exist in
  // the page at the moment we navigate fresh for this permutation. The cap
  // is short (3s) because per-permutation freshness is amortized differently
  // than per-run mapping; we pay the cap on every permutation, so overpaying
  // compounds. 3s is enough for typical SPA hydration on a warm browser;
  // pages slower than that hit the cap and proceed with whatever exists,
  // which surfaces as Playwright errors on the first step that references
  // an unrendered element. Those errors are real bugs (the SUT takes too
  // long to render) and are the correct thing for Vouch to report.
  await waitForInteractableContent(page, { timeoutMs: 3_000 });

  // Initial baseline screenshot: capture the post-navigation page before any
  // action runs. Two reasons:
  //   1. The empty-baseline permutation (action_ids: []) has zero steps, so
  //      without this it would produce no screenshot at all and the Sketchy
  //      Checker would have nothing to analyze.
  //   2. Even for non-empty perms, having the pre-action screenshot is the
  //      only way the dashboard can show "before vs after" for the SUT,
  //      which is the most useful regression-diff a human can eyeball.
  //
  // We write it as `step-init.png` (sortable before any `step-00.png`) and
  // record it in the step_log with action_id="__init__" and ok=true so the
  // findings analyzer + sketchy phase can locate it via the same lookup
  // path it uses for ordinary steps. ok=true keeps the verdict pass-able;
  // a non-pass would lie about whether the SUT crashed.
  const initShotPath = await maybeScreenshot(page, screenshotsDir, perm.id, "init");
  if (initShotPath !== null) {
    stepLog.push({
      action_id: "__init__",
      kind: "click",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      ok: true,
      error_message: null,
      screenshot_path: initShotPath,
    });
  }

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
  const finishedAt = new Date().toISOString();
  return {
    permutation_id: perm.id,
    verdict,
    step_log: stepLog,
    anomalies,
    observed_post_state: observedPostState,
    started_at: startedAt,
    finished_at: finishedAt,
    error_class: errorClass,
  };
}

/**
 * Attach Playwright event listeners that collect browser-side anomalies into
 * the caller's shared bucket. We listen for:
 *
 *   - `console.error` messages: any JS error or explicit error log, which
 *     usually means a real bug somewhere in the page even if the click-walk
 *     itself succeeded.
 *   - `pageerror` events: uncaught exceptions bubbled to the page. The
 *     stronger signal than console.error because nothing handled them.
 *   - `response` with HTTP 4xx or 5xx: a backend call that didn't go well.
 *     We filter to responses from the SUT's own origin to avoid noise from
 *     analytics pixels or third-party trackers.
 *   - `requestfailed`: a network request that never produced a response
 *     (CORS, DNS, abort). Same origin filter.
 *
 * Why not feed these into the step_log: the events fire asynchronously and
 * may not line up with any specific step (a setTimeout-triggered fetch
 * could fail 500ms after the step that scheduled it). The anomaly bucket
 * is the correct home for these.
 *
 * Why the same-origin filter on responses: a third-party tracker returning
 * 404 is not a SUT bug, but the operator would have to triage every
 * analytics pixel if we didn't filter. We match by URL origin (everything
 * before the path) instead of substring so a SUT at `example.com/app` does
 * not accidentally include `subdomain.example.com/tracker`.
 */
function attachAnomalyListeners(
  page: import("playwright").Page,
  anomalies: Anomaly[],
  targetUrl: string,
): void {
  let targetOrigin: string;
  try {
    targetOrigin = new URL(targetUrl).origin;
  } catch {
    // If the target URL is not parseable, fall back to capturing everything.
    // The clearer-error path: surface unparseable target as a setup bug
    // rather than silently filtering nothing.
    targetOrigin = "";
  }

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    anomalies.push({
      kind: "console_error",
      message: msg.text().slice(0, 500),
      url: msg.location().url || null,
      status: null,
      at: new Date().toISOString(),
    });
  });

  page.on("pageerror", (err) => {
    anomalies.push({
      kind: "page_error",
      message: (err.message || String(err)).slice(0, 500),
      url: null,
      status: null,
      at: new Date().toISOString(),
    });
  });

  page.on("response", (resp) => {
    const status = resp.status();
    if (status < 400) return;
    const url = resp.url();
    if (targetOrigin && !url.startsWith(targetOrigin)) return;
    anomalies.push({
      kind: status >= 500 ? "http_5xx" : "http_4xx",
      message: `${resp.request().method()} ${url} -> ${status} ${resp.statusText()}`,
      url,
      status,
      at: new Date().toISOString(),
    });
  });

  page.on("requestfailed", (req) => {
    const url = req.url();
    if (targetOrigin && !url.startsWith(targetOrigin)) return;
    const failure = req.failure();
    anomalies.push({
      kind: "request_failed",
      message: `${req.method()} ${url} -> ${failure?.errorText ?? "unknown failure"}`,
      url,
      status: null,
      at: new Date().toISOString(),
    });
  });
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
      // Two-phase settle.
      //
      // PHASE 1 (URL change OR load event, cap 1500 ms): the moment we know
      // whether the click triggered any navigation. For a click that does
      // nothing (button that toggles a local state, dropdown, no-op),
      // neither URL nor load will fire; the 1500 ms cap then expires and we
      // proceed without stalling the run.
      //
      // PHASE 2 (networkidle, cap 3500 ms, ONLY if URL changed): the gap
      // Vouch's 2026-05-22 depth-2 run against Meridian's deployed frontend
      // surfaced. SPAs (Next.js <Link>, react-router) flip the URL
      // synchronously via History.pushState but the new route then fires its
      // own data fetches (Solana RPC, REST, etc.) that take 2-5 s to settle.
      // Reading observed_post_state in that window catches loading skeletons
      // / "Loading on-chain markets..." copy instead of the destination
      // content the Oracle predicted, which trips the verifier as a false
      // positive bug candidate. We only pay this second wait when a route
      // change actually happened — no-op clicks don't compound.
      const phase1Cap = 1_500;
      const phase2Cap = 3_500;
      await Promise.race([
        page.waitForLoadState("load", { timeout: phase1Cap }).catch(() => {}),
        page
          .waitForFunction(
            (oldUrl) => window.location.href !== oldUrl,
            beforeUrl,
            { timeout: phase1Cap, polling: 50 },
          )
          .catch(() => {}),
      ]);
      if (page.url() !== beforeUrl) {
        await page.waitForLoadState("networkidle", { timeout: phase2Cap }).catch(() => {});
      }
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
  /**
   * Numeric step index (0,1,2,...) for post-step captures, or the literal
   * string "init" for the post-navigation baseline. Distinct filenames so
   * sortable listings put init first (`step-init.png` < `step-00.png` by
   * lexicographic ordering when "init" is treated as a label, which is why
   * we DO NOT pad it to two digits).
   */
  stepIdx: number | "init",
): Promise<string | null> {
  if (!screenshotsDir) return null;
  const dir = resolve(screenshotsDir, permId);
  try {
    mkdirSync(dir, { recursive: true });
    const label = stepIdx === "init" ? "init" : String(stepIdx).padStart(2, "0");
    const path = resolve(dir, `step-${label}.png`);
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
