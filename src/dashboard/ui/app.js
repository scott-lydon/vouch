// Vouch dashboard client — vanilla JS, hash-based router, no build step.
//
// Routes:
//   #/                          list of projects
//   #/project/:projectId        list of runs for a project
//   #/run/:runId                run detail with permutations + editable notes
//
// Every page renders from a single fetch to the corresponding /api endpoint.
// The note editor saves on blur via POST /api/predictions/:permId/note and
// shows a "saved" indicator; failures show inline error text.

const $app = document.getElementById('app');
const $crumb = document.getElementById('breadcrumb');

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  }
  return node;
}

function fmtLocal(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
  } catch { return iso; }
}

function fmtRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function api(path, init = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ------------- routes ----------------

async function viewProjects() {
  $crumb.textContent = '';
  $app.replaceChildren(el('div', { class: 'muted' }, 'Loading projects…'));
  const { projects } = await api('/api/projects');
  if (projects.length === 0) {
    $app.replaceChildren(
      el('div', { class: 'panel empty' }, [
        el('div', { class: 'empty-glyph' }, '∅'),
        el('h2', { class: 'text-xl font-semibold mt-3' }, 'No projects yet.'),
        el('p', { class: 'muted mt-3' }, 'Run `vouch init <name> --spec-file spec.md` then `vouch run --project <name> --target <url>` to populate this page.'),
      ])
    );
    return;
  }
  $app.replaceChildren(
    el('div', {}, [
      el('h1', { class: 'text-4xl font-bold mb-2 gradient-text' }, 'Projects'),
      el('p', { class: 'muted mb-8' }, `${projects.length} project${projects.length === 1 ? '' : 's'} have used Vouch.`),
      el('div', { class: 'grid md:grid-cols-2 lg:grid-cols-3 gap-4' },
        projects.map((p) =>
          el('a', { href: `#/project/${p.id}`, class: 'panel p-5 block', style: 'text-decoration:none;color:inherit;' }, [
            el('div', { class: 'flex items-center justify-between' }, [
              el('span', { class: 'font-semibold text-lg' }, p.name),
              el('span', { class: 'badge badge-accent' }, fmtRelative(p.created_at)),
            ]),
            p.description ? el('p', { class: 'muted text-sm mt-2' }, p.description) : null,
            el('div', { class: 'muted text-xs mt-3' }, [
              el('span', {}, `id: `),
              el('code', {}, p.id),
            ]),
          ])
        )
      ),
    ])
  );
}

async function viewProject(projectId) {
  $app.replaceChildren(el('div', { class: 'muted' }, 'Loading runs…'));
  const { project, runs } = await api(`/api/projects/${projectId}/runs`);
  $crumb.innerHTML = `<a href="#/">Projects</a> &rsaquo; <strong>${escapeHtml(project.name)}</strong>`;
  if (runs.length === 0) {
    $app.replaceChildren(
      el('div', {}, [
        el('h1', { class: 'text-4xl font-bold mb-2' }, project.name),
        project.description ? el('p', { class: 'muted mb-6' }, project.description) : null,
        el('div', { class: 'panel empty' }, [
          el('div', { class: 'empty-glyph' }, '∅'),
          el('h2', { class: 'text-xl font-semibold mt-3' }, 'No runs yet.'),
          el('p', { class: 'muted mt-3' }, `Run \`vouch run --project ${project.name} --target <url>\` to start the first run.`),
        ])
      ])
    );
    return;
  }
  $app.replaceChildren(
    el('div', {}, [
      el('h1', { class: 'text-4xl font-bold mb-2' }, project.name),
      project.description ? el('p', { class: 'muted mb-6' }, project.description) : null,
      el('div', { class: 'panel p-6 mb-6' }, [
        el('div', { class: 'muted text-sm' }, 'Spec captured at init (referenced by every run via sha256):'),
        el('pre', { style: 'max-height: 200px; overflow-y: auto; background: var(--panel2); padding: 12px; border-radius: 8px; margin-top: 8px; font-size: 0.8em; white-space: pre-wrap;' }, project.spec_text.slice(0, 1500) + (project.spec_text.length > 1500 ? '\n…(truncated)' : '')),
      ]),
      el('h2', { class: 'text-2xl font-semibold mb-4' }, `${runs.length} run${runs.length === 1 ? '' : 's'}`),
      el('div', { class: 'space-y-3' },
        runs.map((r) =>
          el('a', { href: `#/run/${r.id}`, class: 'panel p-5 block', style: 'text-decoration:none;color:inherit;' }, [
            el('div', { class: 'flex flex-wrap items-center gap-3' }, [
              el('span', { class: 'badge badge-accent' }, `depth ${r.depth}`),
              el('span', { class: 'badge ' + ((r.prediction_source === 'heuristic' ? 'badge-warn' : 'badge-good')) }, r.prediction_source),
              el('span', { class: r.finished_at ? 'badge badge-good' : 'badge badge-warn' }, r.finished_at ? 'finished' : 'in-progress'),
            ]),
            el('div', { class: 'mt-2 text-sm' }, [
              el('strong', {}, fmtLocal(r.started_at)),
              el('span', { class: 'muted' }, ` · ${r.target_url}`),
            ]),
            el('div', { class: 'muted text-xs mt-2' }, `id: ${r.id} · spec sha=${r.spec_sha256}`),
          ])
        )
      )
    ])
  );
}

async function viewRun(runId) {
  $app.replaceChildren(el('div', { class: 'muted' }, 'Loading run…'));
  const data = await api(`/api/runs/${runId}`);
  const { run, project, actions, permutations } = data;
  $crumb.innerHTML = `<a href="#/">Projects</a> &rsaquo; <a href="#/project/${project.id}">${escapeHtml(project.name)}</a> &rsaquo; <strong>${escapeHtml(run.id)}</strong>`;

  // Primary-verdict counts. This is what the operator actually cares about
  // and matches the badges on each card below. Playwright-only counts (pass /
  // fail / timeout) are surfaced as a secondary breakdown so both views are
  // available without contradicting each other.
  const primaryCounts = { verified: 0, bug_candidate: 0, flagged: 0, crashed: 0, not_verified: 0, not_executed: 0 };
  const playwrightCounts = { pass: 0, fail: 0, timeout: 0, infrastructure_error: 0, missing_input: 0, pending: 0 };
  for (const p of permutations) {
    const pwVerdict = p.execution?.verdict ?? 'pending';
    playwrightCounts[pwVerdict] = (playwrightCounts[pwVerdict] ?? 0) + 1;
    const primary = primaryVerdict(pwVerdict, p.expectation);
    if (primary.label === 'VERIFIED') primaryCounts.verified++;
    else if (primary.label === 'BUG CANDIDATE') primaryCounts.bug_candidate++;
    else if (primary.label === 'FLAGGED (rules)') primaryCounts.flagged++;
    else if (primary.label === 'CRASHED') primaryCounts.crashed++;
    else if (primary.label === 'NOT VERIFIED') primaryCounts.not_verified++;
    else if (primary.label === 'NOT EXECUTED') primaryCounts.not_executed++;
  }

  $app.replaceChildren(
    el('div', {}, [
      el('h1', { class: 'text-4xl font-bold mb-2 gradient-text' }, `Run ${run.id}`),
      el('p', { class: 'muted mb-6' }, [
        `${permutations.length} permutations at depth ${run.depth}, target: `,
        el('code', {}, run.target_url),
      ]),
      el('div', { class: 'flex gap-3 mb-6' }, [
        el('a', { href: `/api/runs/${run.id}/findings?format=markdown`, target: '_blank', class: 'btn btn-primary' }, 'View Findings report (markdown)'),
        el('a', { href: `/api/runs/${run.id}/findings`, target: '_blank', class: 'btn' }, 'Findings as JSON'),
      ]),
      // Inline help so the badges + labels below aren't cryptic on first read.
      el('details', { class: 'panel p-5 mb-6' }, [
        el('summary', { class: 'cursor-pointer font-semibold', style: 'list-style:none;' }, 'What does each column on a permutation card mean? (click to expand)'),
        el('div', { class: 'mt-4 text-sm muted space-y-2' }, [
          el('p', {}, el('strong', { class: 'accent-text' }, 'Primary verdict (top-right of each card): '),
            'one of CRASHED, BUG CANDIDATE, FLAGGED (rules), VERIFIED, or NOT VERIFIED. CRASHED means Playwright threw at some step. BUG CANDIDATE means Playwright ran clean but the page’s observed end-state semantically disagrees with what the AI predicted — a real candidate SUT bug. FLAGGED (rules) means the same disagreement was found by the no-LLM heuristic verifier, which over-flags by design; treat as a hint, not a confirmation. VERIFIED means Playwright passed AND the verifier said the observed state matches the prediction. NOT VERIFIED means we executed but didn’t run the diff pass.'),
          el('p', {}, el('strong', { class: 'accent-text' }, 'Actions (numbered list): '),
            'the ordered sequence Vouch replayed in a fresh Playwright context. At depth N each card has N steps. Each step shows its kind (click, focus_input, type, ...) and a human description.'),
          el('p', {}, el('strong', { class: 'accent-text' }, 'Expected behavior (AI predicted): '),
            'what the Oracle thinks the user should observe after the final step. Source-tagged: ',
            el('code', {}, 'Claude/Sonnet'),
            ', ',
            el('code', {}, 'Haiku'),
            ', or ',
            el('code', {}, 'rule-based'),
            ' (no LLM, deterministic text composition; over-cautious).'),
          el('p', {}, el('strong', { class: 'accent-text' }, 'Override expected behavior (operator note): '),
            'editable textarea. Type your own definition of what the page SHOULD do. Saves on blur, persists across runs. When set, it’s the authoritative expected behavior. The “Copy AI prediction” button fills the textarea with the current Oracle text so you can edit instead of retyping.'),
          el('p', {}, el('strong', { class: 'accent-text' }, 'Observed: '),
            'what Playwright actually captured at the end of the sequence: the URL, the page title, and the visible body text. The verifier compares this against the expected behavior above.'),
        ]),
      ]),

      // PRIMARY stats — what the operator cares about, matches the cards below.
      el('div', { class: 'grid md:grid-cols-3 lg:grid-cols-6 gap-3 mb-3' }, [
        statCard('Permutations', permutations.length, 'badge-accent'),
        statCard('Verified',     primaryCounts.verified, 'badge-good'),
        statCard('Bug candidate', primaryCounts.bug_candidate, 'badge-bad'),
        statCard('Flagged (rules)', primaryCounts.flagged, 'badge-warn'),
        statCard('Crashed', primaryCounts.crashed, 'badge-bad'),
        statCard('Source', sourceLabel(run.prediction_source), run.prediction_source === 'heuristic' ? 'badge-warn' : 'badge-good'),
      ]),
      // Secondary: raw Playwright-execution breakdown for debugging.
      el('details', { class: 'text-xs muted mb-8' }, [
        el('summary', { class: 'cursor-pointer', style: 'list-style:none;' }, 'Step-execution breakdown (what Playwright did, regardless of SUT correctness) ▾'),
        el('div', { class: 'mt-2 panel p-3', style: 'background: var(--panel2);' }, [
          el('span', {}, `Steps ran: ${playwrightCounts.pass}`),
          ' · ',
          el('span', {}, `Crashed: ${playwrightCounts.fail}`),
          ' · ',
          el('span', {}, `Timed out: ${playwrightCounts.timeout}`),
          ' · ',
          el('span', {}, `Boot failed: ${playwrightCounts.infrastructure_error}`),
          el('p', { class: 'mt-2' },
            'A permutation can have "Steps ran" yet still be a BUG CANDIDATE — that means the actions executed cleanly but the page ended in a state that disagrees with the AI prediction. The cards below show the combined verdict.'),
        ]),
      ]),

      // Actions panel (expandable)
      detailsPanel(
        `Discovered actions (${actions.length})`,
        el('div', {}, [
          el('p', { class: 'muted text-sm mb-3' }, 'The Surface Mapper found these interactable elements on the target. Type actions carry a rule requiring a prior focus_input on the same selector.'),
          el('div', { class: 'overflow-x-auto' },
            el('table', {}, [
              el('thead', {}, el('tr', {}, [
                el('th', {}, 'id'),
                el('th', {}, 'kind'),
                el('th', {}, 'description'),
                el('th', {}, 'selector'),
                el('th', {}, 'rules'),
              ])),
              el('tbody', {}, actions.map((a) =>
                el('tr', {}, [
                  el('td', {}, el('code', {}, a.id)),
                  el('td', {}, el('span', { class: 'badge badge-accent' }, a.kind)),
                  el('td', {}, a.description),
                  el('td', {}, a.selector ? el('code', {}, a.selector) : el('span', { class: 'muted' }, '—')),
                  el('td', {}, a.rules && a.rules.length > 0
                    ? a.rules.map((r) => el('div', { class: 'text-xs muted' }, r.description))
                    : el('span', { class: 'muted text-xs' }, '—')),
                ])
              ))
            ])
          )
        ])
      ),

      // Permutations grid
      el('h2', { class: 'text-2xl font-semibold mt-10 mb-4' }, `${permutations.length} permutations`),
      el('div', {}, permutations.map((p) => renderPermutationCard(p, actions)))
    ])
  );
}

function statCard(label, value, badgeClass) {
  return el('div', { class: 'panel p-4 text-center' }, [
    el('div', { class: 'text-2xl font-bold accent-text' }, String(value)),
    el('div', { class: 'text-xs muted mt-1' }, label),
  ]);
}

function detailsPanel(title, content) {
  const wrap = el('details', { class: 'panel p-5 mb-6' }, [
    el('summary', { class: 'cursor-pointer font-semibold text-lg', style: 'list-style:none;' }, title),
    el('div', { class: 'mt-4' }, content),
  ]);
  return wrap;
}

/**
 * Compute the single primary verdict for a card. Combines Playwright
 * verdict + verifier verdict + verifier source into one human label.
 */
function primaryVerdict(playwrightVerdict, expectation) {
  if (!playwrightVerdict || playwrightVerdict === 'pending') {
    return { label: 'NOT EXECUTED', badge: 'badge-warn', explainer: 'Vouch has not replayed this permutation yet.' };
  }
  if (playwrightVerdict !== 'pass') {
    // Crash / timeout / infrastructure error — always primary.
    return {
      label: 'CRASHED',
      badge: 'badge-bad',
      explainer: `One of the steps failed (${stepsVerdictLabel(playwrightVerdict)}). The page never reached a final state, so there's nothing to verify against the prediction.`,
    };
  }
  if (!expectation) {
    return {
      label: 'NOT VERIFIED',
      badge: 'badge-warn',
      explainer: 'The steps ran clean, but the expectation diff pass did not run for this permutation. Run with --verify to fill in this column.',
    };
  }
  if (expectation.match) {
    return {
      label: 'VERIFIED',
      badge: 'badge-good',
      explainer: `The page's observed state matched the AI's predicted expected behavior (verifier: ${expectation.source}).`,
    };
  }
  // Mismatch. Severity depends on verifier source.
  if (expectation.source === 'heuristic') {
    return {
      label: 'FLAGGED (rules)',
      badge: 'badge-warn',
      explainer: 'The no-LLM rule-based verifier saw low text overlap between expected and observed. This verifier over-flags by design — treat as a hint that warrants a closer look, not a confirmed SUT bug. For a real semantic verdict, run with --verify-source claude-cli or anthropic-haiku.',
    };
  }
  return {
    label: 'BUG CANDIDATE',
    badge: 'badge-bad',
    explainer: `The page's observed state semantically diverges from the AI's prediction (verifier: ${expectation.source}). Either the SUT has a bug, or the prediction was wrong. Edit the operator note below to record the right answer.`,
  };
}

/**
 * Parse the Executor's observed_post_state string into structured rows.
 * Format produced by executor.ts observePostState(): `url=X | title=Y | text="Z"`
 */
function parseObserved(observed) {
  const out = { url: null, title: null, text: null, raw: observed };
  if (typeof observed !== 'string') return out;
  const urlMatch = observed.match(/url=([^|]+?)(?:\s*\||$)/);
  const titleMatch = observed.match(/title=([^|]+?)(?:\s*\||$)/);
  const textMatch = observed.match(/text=\"([\s\S]*?)\"\s*$/);
  if (urlMatch) out.url = urlMatch[1].trim();
  if (titleMatch) out.title = titleMatch[1].trim();
  if (textMatch) out.text = textMatch[1].trim();
  return out;
}

function sourceLabel(src) {
  if (src === 'anthropic-haiku') return 'Claude Haiku (API)';
  if (src === 'claude-cli') return 'local Claude CLI';
  if (src === 'heuristic') return 'rule-based (no LLM)';
  return src || 'unknown';
}

/**
 * Human label for the step-execution verdict (what Playwright did). The badge
 * still uses the same color logic, but the label is in plain terms.
 */
function stepsVerdictLabel(v) {
  if (v === 'pass') return 'ran';
  if (v === 'fail') return 'crashed';
  if (v === 'timeout') return 'timed out';
  if (v === 'infrastructure_error') return 'boot failed';
  if (v === 'missing_input') return 'missing prior focus';
  return v;
}

function renderPermutationCard(p, actions) {
  const playwrightVerdict = p.execution?.verdict ?? 'pending';
  const exp = p.expectation;
  const primary = primaryVerdict(playwrightVerdict, exp);

  // Card border tint based on primary verdict, not just Playwright.
  let cardClass = 'perm-card ';
  if (primary.label === 'VERIFIED') cardClass += 'pass';
  else if (primary.label === 'CRASHED' || primary.label === 'BUG CANDIDATE') cardClass += 'fail';
  else cardClass += 'pending';

  // 1-indexed friendly permutation name.
  const shortId = p.permutation.id.includes('__') ? p.permutation.id.split('__').pop() : p.permutation.id;
  const oneIndexed = (p.permutation.index ?? 0) + 1;
  const permLabel = `Permutation ${oneIndexed} (${shortId})`;

  // Each step is a click-to-expand <details>. Summary stays clean (step N,
  // kind chip, human description); the technical detail (CSS selector, typed
  // value, meta) lives in the expanded body. Default collapsed so the card
  // doesn't drown the eye in nth-of-type selector paths the operator rarely
  // needs to read for a healthy run.
  const actionsList = el(
    'div',
    { class: 'step-list mb-3' },
    (p.action_descriptions ?? []).map((ad, i) => {
      if (!ad) return el('div', { class: 'text-sm bad' }, `(unknown action ${i + 1})`);
      const hasDetail = !!(ad.selector || (ad.type_value !== null && ad.type_value !== undefined));
      const summaryChildren = [
        el('span', { class: 'kbd' }, `step ${i + 1}`),
        ' ',
        el('span', { class: 'badge badge-accent', style: 'margin-right:6px;' }, ad.kind),
        el('span', {}, ad.description),
        hasDetail
          ? el('span', { class: 'muted text-xs ml-2', style: 'opacity:0.6;' }, '› expand')
          : null,
      ];
      if (!hasDetail) {
        return el('div', { class: 'step-row text-sm' }, summaryChildren.slice(0, 3));
      }
      const detailRows = [];
      if (ad.selector) {
        detailRows.push(
          el('div', { class: 'step-detail-row' }, [
            el('span', { class: 'muted text-xs', style: 'min-width: 80px; display: inline-block;' }, 'selector:'),
            el('code', { class: 'text-xs' }, ad.selector),
          ]),
        );
      }
      if (ad.type_value !== null && ad.type_value !== undefined) {
        detailRows.push(
          el('div', { class: 'step-detail-row' }, [
            el('span', { class: 'muted text-xs', style: 'min-width: 80px; display: inline-block;' }, 'types:'),
            el('code', { class: 'text-xs' }, ad.type_value === '' ? '(empty string)' : ad.type_value),
          ]),
        );
      }
      detailRows.push(
        el('div', { class: 'step-detail-row muted text-xs' }, [
          el('span', { style: 'min-width: 80px; display: inline-block;' }, 'action id:'),
          el('code', {}, ad.id),
        ]),
      );
      return el('details', { class: 'step-row' }, [
        el('summary', { class: 'step-summary text-sm', style: 'list-style:none; cursor:pointer;' }, summaryChildren),
        el('div', { class: 'step-detail-body' }, detailRows),
      ]);
    }),
  );

  const prediction = p.prediction;
  const predictionBlock = prediction
    ? el('div', { class: 'panel p-4 mt-3', style: 'background: var(--panel2);' }, [
        el('div', { class: 'flex items-center gap-2 mb-2 flex-wrap' }, [
          el('span', { class: 'text-sm font-semibold' }, 'Expected behavior (AI predicted)'),
          el('span', { class: 'badge ' + (prediction.source === 'heuristic' ? 'badge-warn' : 'badge-good') }, sourceLabel(prediction.source)),
          el('span', { class: 'muted text-xs' }, `confidence ${(prediction.confidence * 100).toFixed(0)}%`),
          prediction.cost_usd > 0
            ? el('span', { class: 'muted text-xs' }, `· $${prediction.cost_usd.toFixed(5)}`)
            : (prediction.source === 'claude-cli' ? el('span', { class: 'muted text-xs' }, '· via Claude subscription') : null),
        ]),
        paraWithInlineCode(prediction.expected_post_state, 'text-sm'),
      ])
    : el('div', { class: 'muted text-xs italic' }, 'No prediction (oracle did not run for this permutation).');

  const note = prediction
    ? noteEditor(p.permutation.id, prediction)
    : null;

  // Parsed observed-state for readability.
  const exec = p.execution;
  const observedParsed = exec ? parseObserved(exec.observed_post_state) : null;
  const execBlock = exec
    ? el('div', { class: 'panel p-4 mt-3', style: 'background: var(--panel2);' }, [
        el('div', { class: 'flex items-center gap-2 mb-3 flex-wrap' }, [
          el('span', { class: 'text-sm font-semibold' }, 'Observed (what the browser actually showed)'),
          el('span', { class: 'badge ' + verdictBadge(exec.verdict) }, 'Steps: ' + stepsVerdictLabel(exec.verdict)),
          el('span', { class: 'muted text-xs' }, `${exec.step_log.length} step${exec.step_log.length === 1 ? '' : 's'} · ${fmtLocal(exec.started_at)}`),
        ]),
        observedParsed && observedParsed.url
          ? el('div', { class: 'text-xs space-y-1' }, [
              el('div', {}, [el('span', { class: 'muted' }, 'URL: '), el('code', {}, observedParsed.url)]),
              observedParsed.title ? el('div', {}, [el('span', { class: 'muted' }, 'Page title: '), el('span', {}, observedParsed.title)]) : null,
              observedParsed.text ? el('div', {}, [
                el('span', { class: 'muted' }, 'Visible text: '),
                el('span', {}, (observedParsed.text.length > 300 ? observedParsed.text.slice(0, 300) + '…' : observedParsed.text)),
              ]) : null,
            ])
          : el('p', { class: 'text-xs muted' }, exec.observed_post_state.slice(0, 400) + (exec.observed_post_state.length > 400 ? '…' : '')),
        exec.error_class ? el('div', { class: 'bad text-xs mt-2' }, `error_class: ${exec.error_class}`) : null,
      ])
    : el('div', { class: 'muted text-xs italic mt-3' }, 'Not executed yet.');

  // Expectation verdict: did observed match expected?
  const expBlock = exp
    ? el('div', { class: 'panel p-4 mt-3', style: 'background: var(--panel2); border-left: 3px solid ' + (exp.match ? 'var(--good)' : (exp.source === 'heuristic' ? 'var(--warn)' : 'var(--bad)')) + ';' }, [
        el('div', { class: 'flex items-center gap-2 mb-2 flex-wrap' }, [
          el('span', { class: 'text-sm font-semibold' }, 'Verifier diff (expected vs observed)'),
          el('span', { class: 'badge ' + (exp.match ? 'badge-good' : (exp.source === 'heuristic' ? 'badge-warn' : 'badge-bad')) }, exp.match ? 'MATCH' : 'MISMATCH'),
          el('span', { class: 'badge ' + (exp.source === 'heuristic' ? 'badge-warn' : 'badge-good') }, sourceLabel(exp.source)),
          exp.cost_usd > 0 ? el('span', { class: 'muted text-xs' }, `· $${exp.cost_usd.toFixed(5)}`) : null,
        ]),
        paraWithInlineCode(exp.reasoning, 'text-xs ' + (exp.match ? 'muted' : (exp.source === 'heuristic' ? 'warn' : 'bad'))),
      ])
    : null;

  return el('div', { class: cardClass }, [
    el('div', { class: 'flex items-start justify-between gap-3 mb-3 flex-wrap' }, [
      el('div', {}, [
        el('div', { class: 'font-semibold text-lg' }, permLabel),
        el('div', { class: 'muted text-xs mt-1', title: primary.explainer }, primary.explainer),
      ]),
      el('span', { class: 'badge ' + primary.badge, style: 'font-size: 0.85rem; padding: 6px 14px;' }, primary.label),
    ]),
    actionsList,
    predictionBlock,
    note,
    execBlock,
    expBlock,
  ]);
}

function noteEditor(permId, prediction) {
  const ta = el('textarea', {
    class: 'note-textarea',
    placeholder: 'Type your own definition of what should happen. Saves automatically when you click away. Leave blank to use the AI prediction above.',
  });
  ta.value = prediction.user_note_text ?? '';
  const status = el(
    'div',
    { class: 'muted text-xs mt-1' },
    prediction.user_note_edited_at
      ? `Note saved ${fmtRelative(prediction.user_note_edited_at)}.`
      : 'No override set yet. The AI prediction above is currently authoritative for the verifier.',
  );

  const save = async () => {
    const v = ta.value.trim();
    if (v === (prediction.user_note_text ?? '').trim()) return; // no-op
    status.textContent = 'Saving…';
    status.className = 'muted text-xs mt-1';
    try {
      const { prediction: updated } = await api(`/api/predictions/${permId}/note`, {
        method: 'POST',
        body: JSON.stringify({ note_text: v }),
      });
      prediction.user_note_text = updated.user_note_text;
      prediction.user_note_edited_at = updated.user_note_edited_at;
      status.textContent = `Note saved ${fmtRelative(updated.user_note_edited_at)}. This is now authoritative.`;
      status.className = 'good text-xs mt-1';
    } catch (err) {
      status.textContent = `Save failed: ${err.message}`;
      status.className = 'bad text-xs mt-1';
    }
  };
  ta.addEventListener('blur', save);

  const copyBtn = el(
    'button',
    {
      class: 'btn',
      style: 'font-size: 0.75rem; padding: 4px 10px;',
      onClick: () => {
        ta.value = prediction.expected_post_state;
        ta.focus();
        status.textContent = 'Copied AI prediction into textarea. Edit if needed, then click away to save.';
        status.className = 'accent-text text-xs mt-1';
      },
    },
    'Copy AI prediction into my note',
  );

  return el('div', { class: 'mt-3' }, [
    el('div', { class: 'flex items-center justify-between gap-3 mb-1 flex-wrap' }, [
      el('div', { class: 'text-xs muted' }, 'Override expected behavior (your authoritative version; the verifier uses this when set):'),
      copyBtn,
    ]),
    ta,
    status,
  ]);
}

function verdictBadge(v) {
  switch (v) {
    case 'pass': return 'badge-good';
    case 'fail': return 'badge-bad';
    case 'timeout':
    case 'infrastructure_error':
    case 'missing_input': return 'badge-warn';
    default: return 'badge-accent';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Render a string that may contain markdown-style inline code spans
 * (backtick-delimited) as a DocumentFragment. Code spans become real `<code>`
 * elements that pick up the dashboard's monospace styling. Text outside
 * backticks renders as plain text. Backslash-escaped backticks (`\``) are
 * literal backticks.
 *
 * Vouch's LLM outputs (Oracle predictions, Verifier reasoning) routinely cite
 * selectors, hashes, file paths, and HTML snippets in backticks. Without this
 * rendering, those appear as raw `` `like this` `` in the dashboard prose,
 * mixing notation with content. Now they render as monospaced chips inline.
 *
 * Single-line scope only — triple-backtick code blocks are not supported and
 * are passed through as `'```'` literal text, which is the right behavior on
 * the rare line that has one (we don't want to consume an unbounded amount
 * of input as a "code block" if the closing fence is missing).
 */
function renderInlineCode(text) {
  const frag = document.createDocumentFragment();
  if (text === null || text === undefined) return frag;
  const s = String(text);
  // Tokenize: a sequence of (escaped backtick | backtick-span | other text).
  // The regex matches either an escaped backtick (kept literal), a single-
  // backtick span (non-greedy, no embedded backticks), or a run of non-`/
  // non-backslash characters. The fall-through `[\s\S]` matches any leftover
  // single character (e.g. a lone backtick with no closing).
  const re = /\\`|`([^`]+)`|[^`\\]+|[\s\S]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '\\`') {
      frag.appendChild(document.createTextNode('`'));
    } else if (m[1] !== undefined) {
      const code = document.createElement('code');
      code.textContent = m[1];
      frag.appendChild(code);
    } else {
      frag.appendChild(document.createTextNode(m[0]));
    }
  }
  return frag;
}

/**
 * Convenience for places that want a <p> element with inline-code rendering.
 * The caller passes className for tailwind / theme classes; the content is
 * the LLM-produced string.
 */
function paraWithInlineCode(text, className = 'text-sm') {
  const p = document.createElement('p');
  p.className = className;
  p.appendChild(renderInlineCode(text));
  return p;
}

// ---- router ----

async function route() {
  const h = location.hash || '#/';
  try {
    if (h === '#/' || h === '#') return viewProjects();
    let m = h.match(/^#\/project\/([\w-]+)$/);
    if (m) return viewProject(m[1]);
    m = h.match(/^#\/run\/([\w-]+)$/);
    if (m) return viewRun(m[1]);
    $app.replaceChildren(el('div', { class: 'bad' }, `Unknown route: ${h}`));
  } catch (err) {
    $app.replaceChildren(el('div', { class: 'panel p-6 bad' }, `Error: ${err.message}`));
  }
}
window.addEventListener('hashchange', route);
route();
