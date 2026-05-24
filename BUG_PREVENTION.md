# Vouch — bug/issue prevention checklist

Project-local addendum to `~/Documents/Claude/Projects/BUG_PREVENTION.md`. Only entries that have a Vouch-specific manifestation live here; cross-project rules stay in the global file. Read both before any new slice.

---

## V1. Hardcoded content-type vs. variable artifact format

**Rule.** When code reads a file from disk AND sends its bytes to an external API that requires a content-type / media_type, NEVER hardcode the type. Derive it from the file path or sniff the magic bytes.

**Vouch manifestation (2026-05-24).** `sketchy.ts` historically hardcoded `media_type: "image/png"` when forwarding a screenshot to the Anthropic vision API. The same call site received whatever path the executor wrote. When the executor's screenshot capture switched from PNG to JPEG (adaptive-screenshot slice), the API call would have shipped JPEG bytes under a PNG label and the model's response would be silently wrong (or the API would 400 with an opaque error).

**Fix shape.** Add a `mediaTypeFor<thing>(path)` helper that maps extension → API media type and THROWS LOUDLY on unknown extensions. Pin behavior with unit tests on every extension you support AND on at least one unknown extension that confirms the loud throw.

**How to detect the next instance.** When reviewing a new external-API call, grep for any literal `image/`, `application/`, `text/` next to a `data: <bytes from file>` field. Each match deserves the question: "could the file format change without this string changing?"

**Test coverage that locks it.** `src/core/sketchy.test.ts` describe `mediaTypeForScreenshot` (6 cases).

---

## V2. Unbounded per-artifact disk growth in run dirs

**Rule.** Any executor that writes per-step artifacts to disk MUST either (a) bound the total disk cost per run with a documented policy, or (b) make the artifacts cheap enough by default that even a worst-case run does not pile up.

**Vouch manifestation (2026-05-24).** Pre-adaptive-screenshot, the executor wrote one full-quality PNG per step at native viewport (~68 KB/step typical). A 200-step run landed at ~14 MB; 30+ MB accumulated across the runs/ tree on a developer machine. The findings-analyzer cleanup pass mitigated this for clean perms (deletes the whole perm dir), but every flagged perm kept its full PNG payload forever and disk crept up linearly with usage.

**Fix shape.** Two-tier capture:
- Low-cost default (JPEG quality 60 for screenshots) on every step.
- High-cost capture (full PNG) only where the auditor demonstrably needs it (failing steps + post-loop final state).

The findings cleanup pass still removes per-perm dirs for clean perms, so the lores JPEG is bounded by the same policy that bounded PNGs before — but the active set is now ~10x smaller.

**How to detect the next instance.** When adding a new per-step artifact kind (videos, HAR files, console-log dumps, etc.), ask before merging: "what does this cost per step at the worst-case depth, and what's the cleanup policy when the perm produces no finding?"

**Test coverage that locks it.** The capture-format choice is encoded in `SCREENSHOT_JPEG_QUALITY` in `src/core/executor.ts` — if a future change reverts to PNG-everywhere, the constant becomes dead and the comment becomes a lie, which both stand out in review.

---

## V3. Screenshot path → URL boundary leaks

**Rule.** Filesystem paths the executor writes (under `runs/...`) are absolute on disk and MUST be translated to URLs at the dashboard server boundary. Never let the UI receive a raw absolute path and try to construct a URL from it.

**Vouch manifestation.** The dashboard server scopes a static route to `RUNS_ROOT` and exposes a `screenshotUrlForAbsPath` helper that returns null when the path is outside the runs root (defense-in-depth against a stale row) or when the file no longer exists on disk (clean-perm prune already removed it). The UI treats URLs as opaque strings.

**How to detect the next instance.** Any time the API response shape adds a new path-shaped field, ask: "could this be an absolute filesystem path? Does the UI know how to render it as a URL? What happens when the file is gone but the row remains?"

**Test coverage that locks it.** No automated test yet; the failure mode would surface as `404 /Users/...` or `403 /opt/...` requests in the browser console. Worth adding an integration test that hits the perms endpoint and asserts every screenshot URL starts with `/runs/`.
