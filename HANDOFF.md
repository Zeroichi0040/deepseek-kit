# DeepSeek Kit - handoff

Written 2026-11-18. `main` was **0.18.0** when this was written; PR #29 (0.18.1, sent question cards survive a reload) was open. Check `git log` and the open PRs before trusting the version numbers here. The user has confirmed the extension works on the live site (Nov 2026) and has paused the project: pick it up when they report an error or ask for a feature. Do not volunteer new features.

## What this is

A local-only Manifest V3 Chrome extension for https://chat.deepseek.com/*. It adds a drawer with memory notes, prompts (Default, Visuals, Questions), snippets, code-block tools, reasoning-block folding, inline chart/widget cards, Markdown preview for code blocks, interactive question forms, and optional list continuation in the message box.

- Repo: https://github.com/Zeroichi0040/deepseek-kit (private; push access). Local clone: `/home/claude/deepseek-kit` (re-clone with the add_repo tool if the container was reset).
- Built to replace Better DeepSeek, after the user's account was suspended while using that extension. Design rule: **no network requests, no patching of fetch/XHR, only the `storage` permission.** Data lives in `chrome.storage.local` (keys `dck_settings`, `dck_memories`, `dck_counts`, `dck_fab`, and `dck_asked` from 0.18.1). Do not add anything that talks to the network.
- The user cannot review code. Verify thoroughly, show evidence, keep explanations short and plain.
- Naming: another npm package called `deepseek-kit` exists (not ours; ours is `"private": true` and never published). The user is thinking about renaming and has not chosen a name. If they do: one PR changing the name strings (manifest.json name/description, package.json and package-lock.json name, README, the header comment of each JS file, the 4 UI strings in content.js, tests/ui.test.js, tests/e2e.test.js). Do NOT rename the `dck_` storage keys or the `dck-` DOM ids/classes. Remind them to export their data first and to keep loading from the same folder (the unpacked extension's ID, and so its saved data, follows the folder path). Renaming the GitHub repo is separate; GitHub redirects the old URL.
- Still unspecified: the user said they want "minor changes" to Markdown preview and the question forms. Ask what they are. 0.17.0/0.18.0 already changed the question forms a lot, so ask again against the current build.

## How the user works with you

- Each version is delivered as a zip with SendUserFile AND as a PR from a branch off `main`.
- They load the zip as an unpacked extension, reload the tab, test on the live site, and report. They work late (Asia/Manila), so be concise.
- They paste screenshots and HTML from DevTools when something is wrong. When you cannot reproduce, ask for: the Diagnostics text (Settings > Diagnostics > Copy report), and the element's outer HTML, or a Console snippet you write. Give exact click steps.
- Decisions so far: do not strip/re-add context in the edit box; Visuals render automatically; questions default to "fill the message box" with a toggle to send straight away; list continuation is off by default and kept small; a lone typed list marker followed by Shift+Enter removes the marker (the user confirmed this is the expected behaviour).
- **The Stop hook is wrong.** It says "N unpushed commits, no remote branch" after every push (it looks for a local tracking ref that does not exist here). Verify quietly with
  `[ "$(git rev-parse HEAD)" = "$(git ls-remote --heads origin <branch> | cut -f1)" ] && echo pushed-ok`
  and, if it matches, answer in one short line. The user has noted the repeated false alarms; do not re-explain at length.
- **Other Claude sessions also work on this repo** (0.12.7 tab sync, 0.16.1 compact Diagnostics, 0.16.2, 0.17.0, 0.18.0, 0.18.1 came from another session). A 0.14.0 attempt at ".md import/export + compact Diagnostics" was reverted (PR #21) and the compact Diagnostics came back as 0.16.1 without import/export. So always `git fetch` and read `git log origin/main` before starting; your local main may be many commits behind.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3, version, content script order: lib.js, site.js, visuals.js, markdown.js, ask.js, content.js, plus content.css. `run_at: document_idle`. `minimum_chrome_version` 105. |
| `lib.js` | Pure logic, no DOM: DEFAULTS, prompts (`VISUALS_PROMPT`, `ASK_PROMPT`, `promptEntries`), memory matching (`keyMatches`, `memoryPlan`), cleaning (`cleanPrompts/Snippets/Memories`), `buildPrefix`, `stripContext`, `MARKER_START`/`MARKER_END`, `migrateSettings`, `continueList`. Exports `globalThis.DCK_LIB`. |
| `site.js` | Every DeepSeek-specific finder (composer, send button, code blocks, reasoning blocks, toolbar pills). Exports `globalThis.DCK_SITE`. When the site changes, this is the file to touch. |
| `visuals.js` | Chart spec parser, SVG chart renderer (bar, line, area, scatter, pie, donut), widget iframe document builder. `globalThis.DCK_VIS`. |
| `markdown.js` | Small Markdown renderer for the code-block Preview. Builds DOM with createElement/textContent only. `globalThis.DCK_MD`. |
| `ask.js` | Question forms: `parseAskSpec`, `compileAnswers`, `buildAsk`. `globalThis.DCK_ASK`. |
| `content.js` | UI and behaviour: drawer, chips, toasts, storage wrapper, send flow, Hidden-mode cleanup, code tools, reasoning fold, visuals and question cards, Markdown preview, list continuation, Diagnostics. |
| `content.css` | All styling, including theme variables and card styles. |
| `tests/` | `run.js` runs logic, site, visuals, markdown, ask, ui, hardening, refresh and e2e. `fixtures/` holds saved DeepSeek HTML. |

Each source file also does `module.exports` under Node so the tests can load it.

## Hard rules

1. **All JS, CSS, JSON and README files must be ASCII.** Chrome refuses content scripts that are not valid UTF-8. Check with `LC_ALL=C grep -nP '[^\x00-\x7F]' *.js content.css manifest.json README.md`.
2. After any scripted edit of content.css, check brace balance (`count('{') == count('}')`). A regex once wiped the theme-variable block.
3. Never put `allow-same-origin` on the widget iframe.
4. Never add permissions or network calls.
5. Never parse HTML from model output (markdown.js and ask.js build DOM from text; images are never loaded; links limited to http/https/mailto).

## Testing

```
export NODE_PATH=$(npm root -g):/tmp/claude-0/-home-claude/3ceda113-b834-5f22-9337-c9638dbb9645/scratchpad/jsd/node_modules
cd /home/claude/deepseek-kit && node tests/run.js
```
If the scratchpad path is gone, run `npm ci` and drop NODE_PATH. The e2e tests use Playwright persistent contexts with `--load-extension` and mock https://chat.deepseek.com/** via `page.route`. Pre-installed Chromium/Playwright is in the container; never run `playwright install`. The full e2e takes about 1.5-2 minutes; give it a 280 s timeout.

- When you fix a bug, add a test and **confirm it fails without the fix** (temporarily revert the fix line, run, restore). This has caught real mistakes.
- jsdom has no layout, so size-related checks belong in the e2e tests. jsdom arrays/objects are cross-realm: compare with join/JSON, not `deepStrictEqual`.
- Exceptions inside content scripts do not show up as `pageerror` in Playwright; use CDP or a temporary console.log.

## Release workflow

1. `git fetch`; branch from current `origin/main`. Check merge state first: PRs sometimes merge before follow-up commits are pushed, so a follow-up needs a NEW branch and PR.
2. Bump the version in `manifest.json` and `package.json` (every user-visible change gets a bump; Diagnostics shows the version).
3. Run all tests, the ASCII check, and the CSS brace check.
4. Commit with these trailers:
   ```
   Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
   Claude-Session: <the current session URL>
   ```
5. `git push -u origin <branch>`, then open the PR with `gh api repos/Zeroichi0040/deepseek-kit/pulls --input pr.json --jq .html_url`. The PR body ends with the robot-emoji "Generated with Claude Code" line plus the session URL.
6. Zip: `zip -q <scratchpad>/deepseek-kit-X.Y.Z.zip manifest.json lib.js site.js visuals.js markdown.js ask.js content.js content.css README.md`, then SendUserFile it. (If you add a new JS file, add it to the manifest, the zip list, the test loaders and `tests/run.js`.)
7. Tell the user what changed, what to test (concrete steps), and what to report back.

## Version history (short)

- 0.11.x cleanup/refactor, ZIP pill placement. 0.12.0 inline Visuals (`chart`/`viz` blocks). 0.12.1-0.12.2 chart fixes and hardening. 0.12.5/0.12.6 Hidden-mode box-size fix (below). 0.12.7 tab sync and robustness.
- 0.14.0 Markdown preview for code blocks marked markdown/md (Preview/Source button; setting in Code blocks).
- 0.15.0 interactive questions (`ask` blocks), Settings > Questions, built-in Questions prompt, Diagnostics row.
- 0.16.0 optional list continuation with Shift+Enter (Settings > Messages, off by default).
- 0.16.1 compact Diagnostics (failed checks first). 0.16.2 Markdown preview table padding.
- 0.17.0 question forms page one at a time, answers as Q1/A1 pairs. 0.18.0 arrows and counter, single-choice auto-next, Recommended badge, read-only once sent, "Answer again" link.
- 0.18.1 (PR #29, check if merged) sent question cards stay locked after a page reload (`dck_asked`, 60 most recent chats).

## The Hidden-mode box-size bug (resolved - read this, it is a trap)

Symptom: in Hidden mode the message box did not grow after Insert, and the edit box of an earlier message opened tiny. Visible mode was fine.

Cause: DeepSeek sizes each textarea from a hidden measuring copy of its text, a `div` next to the textarea (`.ds-textarea__mirror` in the edit box; a generated class such as `b13855df` in the main box) plus an inline `--container-height`. Hidden mode strips the `[Context from my notes] ... [End of context]` block from every text node so the bubble shows only the question; that also stripped the measuring copies.

Fix (in `stripNode`, content.js): skip text inside `[class*="textarea__mirror"]` and text whose parent has a direct `textarea` child (`par.parentElement.querySelector(':scope > textarea')`). The e2e test `mirror()` covers both and fails without the fix.

Lesson: when a size problem appears in only one mode, look at what that mode mutates in the DOM before adding sizing CSS. Do not fight the site's sizing with `field-sizing`/`height` overrides (0.12.3/0.12.4 tried that and were wrong).

## Key technical facts

**Site markup**
- A code block is `div.md-code-block`: header `.md-code-block-banner-wrap` (language label, Copy, Download, Run) and a `pre` with one `<span>` per line.
- A reasoning block carries inline `--collapsible-area-title-height`; first child is the header; the open body is `.ds-think-content`.
- The site dims or disables Copy (`aria-disabled`, or cursor not-allowed) while streaming. That is the `blockBusy` signal.
- Our own header buttons pollute `textContent`; read the header with `firstText(head)`.
- `SITE.codeBlocks()` excludes `#dck-drawer, .dck-mdprev`; `copyButton` ignores `pre`s inside `.dck-mdprev`; the `OURS` selector in site.js includes `.dck-vis`. Forgetting these makes our own cards look like site code blocks.

**Visuals**: a block counts as finished when Copy is enabled and its text has been unchanged for 700 ms (`VIS_SETTLE`). The source block is hidden via `[data-dck-vis-src]:not([data-dck-vis-open]) {display:none !important}`; a Code button toggles it. Charts: custom SVG, tooltips, legend, PNG/SVG export; limits 12 series, 500 points, 256 KB. Widgets: `<iframe sandbox="allow-scripts">` with srcdoc, CSP meta first (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:`), posting `DCK_VIS_ERROR` / `DCK_VIS_HEIGHT` / `DCK_VIS_PROBE`; the parent checks `contentWindow` and a per-card id.

**Markdown preview**: the preview `div.dck-mdprev` is inserted after the `pre` inside the block; CSS `[data-dck-prev] > pre {display:none !important}`; the source stays in the page so Copy/Download/ZIP use the original text. Offered only for lang markdown/md and when the block is not busy; redraws when the source changes. Limits: 200000 chars, depth 12. The site restyles table cells inside code blocks, so the Kit's own table padding needs enough specificity (0.16.2).

**Questions**: fence language `ask` (aliases `question`, `questions`) with JSON; `parseAskSpec` tolerates fences, trailing commas and surrounding text. Limits: 10 questions, 12 options each, 64 KB. Types single/multi/text; every choice question has an Other field by default. Rendered as a `.dck-vis[data-kind=ask]` card through the visuals scanner. "Add to message" replaces earlier added answers instead of duplicating. "Send straight away" (setting `askAutoSend`, default off) dispatches a non-bypassed Enter keydown so the Kit's own Enter handling applies (context prefix on a new chat), then clicks the send button once as fallback; results are 'sent', 'review' or 'failed'. The Kit treats an existing chat path as already started, so first-message context is only due on a new chat (path `/`). Typing inside `.dck-vis` is ignored by the Enter handler and input listener.

**List continuation**: `continueList(value, start, end)` returns null or `{from,to,insert}`. Acts only with a collapsed caret at the end of a line matching a list marker (`1.`, `1)`, `-`, `*`, `+`, `>`), never inside code fences; an empty item removes the marker. Applied with `document.execCommand('insertText'/'delete')` so Ctrl+Z works. Capture keydown handler on document for Shift+Enter; needs `settings.enabled && settings.listContinue`; ignores the drawer, `.dck-vis` and an open slash picker.

**Hidden mode send flow**: Enter is intercepted, the prefix is built and set with the native value setter plus an `input` event, then a synthetic Enter is sent. `waitForSent` polls every 100 ms up to `SEND_WAIT = 1500` ms, falls back to one send-button click, waits again, else toasts "Could not confirm...". A second send is never attempted.

**Storage**: `storeSet()` wraps writes, checks `chrome.runtime.lastError`, toasts at most once per 10 s, logs an event and shows a Diagnostics row.

**Memory matching** (`keyMatches`): keys of 3+ letters match as before; 2-3 character keys match as whole words; CJK keys match by substring.

**Diagnostics** (Settings accordion): since 0.16.1 failed checks come first, OK rows fold under "Other checks", "Recent events" opens on request, and it says "Everything found" when clean. Rows include version, message box, send button, toolbar pills, chip row, widget sandbox, visuals on page, question forms, storage, hidden-mode cleanup, code headers, reasoning blocks, chat, stored data. The user pastes the Copy-report text when reporting problems.

## Known small drifts (left unchanged on purpose)

- In Hidden mode the message count increments on Enter even if the send is never confirmed (a retry does not double-count).
- A message sent from an edit box counts as a new message for "every N" schedules.

## If the site changes and something breaks

1. Ask for the Diagnostics text and, for a layout problem, the element's outer HTML (DevTools: select element, Copy > Copy element) or the output of a short Console snippet you write.
2. Save the HTML into `tests/fixtures/` and reproduce in `site.test.js` / e2e.
3. Change only `site.js` if it is a finder problem.
4. Follow the release workflow above.

## Open items

- The user's unspecified "minor changes" to Markdown preview and question forms.
- Possible rename (see above); no name chosen yet.
- PR #29 (0.18.1) may still be open.
