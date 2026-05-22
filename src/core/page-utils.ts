// Page utilities shared across the Surface Mapper and the Executor.
//
// Vouch's central reliability problem with modern web apps is that
// Playwright's `domcontentloaded` event fires BEFORE a single-page app (Next.js,
// React Router, Vite, the Vouch dashboard itself, anything that fetches its
// own initial content) has rendered interactable nodes. If the Mapper or
// Executor walks the DOM at that instant, it sees the loading shell instead
// of the real interactable surface — typically zero buttons, zero links, an
// empty `<main>`.
//
// `waitForInteractableContent` is the post-navigation settle that closes
// that gap. The post-click settle in executor.ts (race of networkidle / load /
// URL-change) handles a different scenario (SPA route changes after a click
// where neither load nor networkidle fires reliably) and is intentionally
// kept inline; combining the two patterns into a single helper would obscure
// the different semantics. This helper covers the initial-navigation case.

import { type Page } from "playwright";

export interface SettleOptions {
  /** Hard cap on the wait. After this, return whatever the DOM currently has. Default 5s. */
  timeoutMs?: number;
  /**
   * Minimum interactable-element count that signals "the page has rendered".
   * A typical SPA loading shell has 0-2 interactable nodes (a logo link,
   * maybe a nav placeholder). After hydration the count jumps to 10-100+.
   * Default 3 is conservative for both ends: false-positive risk (declaring
   * a sparse page "ready" too early) is bounded because we still cap on
   * timeoutMs; false-negative risk (a real SUT that has only 1-2 actions)
   * is acceptable because hitting the cap returns whatever's there.
   */
  minInteractable?: number;
  /** Poll interval. Default 100ms. */
  pollMs?: number;
}

/**
 * Wait for the page to have rendered at least `minInteractable` interactable
 * elements OR for the timeout cap to fire. Never throws; reaching the cap is
 * a legitimate steady state for a genuinely empty page, and the caller
 * proceeds with whatever's in the DOM.
 *
 * Use this AFTER `page.goto(..., { waitUntil: "domcontentloaded" })`. It is
 * cheap (single waitForFunction with polling) and idempotent.
 */
export async function waitForInteractableContent(
  page: Page,
  opts: SettleOptions = {},
): Promise<{ settled: boolean; finalCount: number }> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const minInteractable = opts.minInteractable ?? 3;
  const pollMs = opts.pollMs ?? 100;

  try {
    await page.waitForFunction(
      (min: number) => {
        const sel = [
          "a[href]",
          "button",
          "input",
          "select",
          "textarea",
          "[role=button]",
          "[role=link]",
          "[role=checkbox]",
          "[role=radio]",
          "[role=menuitem]",
          "[role=tab]",
        ].join(", ");
        return document.querySelectorAll(sel).length >= min;
      },
      minInteractable,
      { timeout: timeoutMs, polling: pollMs },
    );
    const finalCount = await page
      .evaluate(() => {
        const sel = "a[href], button, input, select, textarea, [role=button], [role=link]";
        return document.querySelectorAll(sel).length;
      })
      .catch(() => -1);
    return { settled: true, finalCount };
  } catch {
    // Cap reached. The caller proceeds with whatever the DOM contains; this
    // is the right behavior for genuinely sparse pages and for pages that
    // never hydrate (broken builds, network failures during boot). The
    // Surface Mapper will discover what's there, and a near-empty discovered
    // count is itself a useful signal that something is off with the SUT.
    const finalCount = await page
      .evaluate(() => {
        const sel = "a[href], button, input, select, textarea, [role=button], [role=link]";
        return document.querySelectorAll(sel).length;
      })
      .catch(() => -1);
    return { settled: false, finalCount };
  }
}
