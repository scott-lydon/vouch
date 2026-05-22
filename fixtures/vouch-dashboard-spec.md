# Vouch Dashboard spec — what the local dashboard at http://localhost:7321/ should do

The Vouch dashboard is a single-page web application served by Express. It is
the operator-facing surface for reviewing Vouch runs.

## Routing

The dashboard uses hash-based routing. The application is served from a single
`index.html` and `app.js` re-renders `<main id="app">` based on `location.hash`.

- `#/` or no hash — the **Projects page** is rendered.
- `#/project/<projectId>` — the **Project detail page** is rendered.
- `#/run/<runId>` — the **Run detail page** is rendered.

A click on any link with one of those hash hrefs should navigate without a full
page reload, and the new view should replace the previous one.

## Projects page (`#/`)

- The page renders the header "Projects" (gradient text styling).
- Below the header, a one-line summary that says "N projects have used Vouch."
  where N is the actual count of projects in `vouch.db`. The count is
  variable — at minimum it includes `vouch-dashboard` (the project this
  spec is being tested against); on this developer's machine it may also
  include `sample-form`, `meridian`, and others. Do not assume a specific
  count; the structure of the summary is what matters.
- Below the summary, a grid of project cards (one per project). The grid
  contains AT LEAST a card for `vouch-dashboard`; it may contain others.
- Each project card shows the project name in semibold, an accent-color
  relative timestamp ("today", "2h ago", "3d ago") in the top-right, and the
  short id (`proj_...`) at the bottom.
- Clicking a project card navigates to that project's runs page.
- If zero projects exist, the page shows an empty-state panel with the
  message "No projects yet." and a code snippet telling the operator to run
  `vouch init <name> --spec-file spec.md`. In any other case the empty-state
  panel is absent.

## Project detail page (`#/project/<projectId>`)

- The page renders the project's name as the page title.
- Below the title, the operator's `vouch init --description` text if any.
- A panel labeled "Spec captured at init (referenced by every run via
  sha256)" displays the spec text, truncated at 1500 characters with a
  "…(truncated)" marker if longer.
- Below the spec panel, a "N runs" header.
- Below the header, a list of run cards in reverse chronological order
  (newest first).
- Each run card shows:
  - A "depth N" badge in accent color.
  - A source badge: green for `claude-cli` or `anthropic-haiku`, yellow for
    `heuristic`.
  - A status badge: green "finished" if the run completed, yellow
    "in-progress" otherwise.
  - The local-time started_at timestamp in bold.
  - The target URL, displayed in muted color.
  - The run id and spec sha256 in small muted text.
- Clicking a run card navigates to the run detail page.

## Run detail page (`#/run/<runId>`)

- The page renders "Run <runId>" as the title.
- Below the title, the permutation count, depth, and target URL.
- Two buttons immediately below the description: "View Findings report
  (markdown)" (primary accent) and "Findings as JSON" (secondary). Clicking
  either opens the API endpoint in a new tab.
- A collapsed `<details>` panel titled "What does each column on a
  permutation card mean? (click to expand)".
- Six stat cards in a grid showing: Permutations (total), Verified count
  (green), Bug candidate count (red), Flagged (rules) count (yellow),
  Crashed count (red), Source (claude-cli / Haiku / rule-based).
- A collapsed "Step-execution breakdown" details summary below the stats.
- A collapsed "Discovered actions (N)" details panel showing a table of
  every action the Surface Mapper found, with columns: id, kind, description,
  selector, rules.
- An "N permutations" header.
- Below the header, one permutation card per permutation. Each card shows:
  - A bold title "Permutation N (perm_NNNNN)" on the left.
  - A muted explainer sentence below the title.
  - A primary verdict badge on the right: CRASHED, BUG CANDIDATE, FLAGGED
    (rules), VERIFIED, or NOT VERIFIED.
  - The action sequence as a numbered list with "step N" badges, the action
    kind as a chip, the action description, the CSS selector in muted text,
    and the typed value if any.
  - A panel "Expected behavior (AI predicted)" with the prediction text, a
    source badge, confidence percent, and cost or "via Claude subscription".
  - A textarea labeled "Override expected behavior" with a "Copy AI
    prediction into my note" button next to the label. The textarea saves
    on blur with a status line below it.
  - A panel "Observed (what the browser actually showed)" with a steps badge
    and three labeled rows: URL, Page title, Visible text.
  - A panel "Verifier diff (expected vs observed)" with a MATCH or MISMATCH
    badge, a source badge, and the verifier's reasoning sentence.

## Note edit endpoint

A `POST /api/predictions/<permutationId>/note` with a JSON body
`{ "note_text": "..." }` persists the operator's override note for that
permutation. The endpoint returns the updated prediction row. The note
survives across server restarts and across re-runs of the same project.

## Out of scope

- Authentication. The dashboard is local-only; anyone with localhost access
  can view and edit notes.
- Multi-user collaboration. One operator at a time.
- Real-time updates. Pages render on initial load; new runs require a
  manual refresh.
