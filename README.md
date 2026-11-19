# DeepSeek Kit

A local-first toolkit for **DeepSeek Chat**. Add reusable prompts, lightweight memory, slash snippets, richer code blocks, interactive questions, and inline visuals to `chat.deepseek.com` — without turning your browser into a client for another service.

DeepSeek Kit is an independent, community-made browser extension. It is not affiliated with or endorsed by DeepSeek.

> **Current version:** 0.18.0  
> **Compatibility:** Chrome and Chromium-based browsers (including Edge and Brave), Chrome 105+

## What it adds

| Area | What you get |
| --- | --- |
| **Prompts** | A built-in baseline prompt plus as many custom prompts as you want. Schedule each for the first message, every *N* messages, or every message. |
| **Memory** | Small notes that are always included or included when a matching key is mentioned. Group notes by category and set a per-message token budget. |
| **Snippets** | Reusable text with slash-command autocomplete. Type `/` in the composer to search, navigate, and insert a snippet. |
| **Context controls** | See what will be added to your next message, preview it, or insert it immediately. Choose whether inserted context stays visible for review or is hidden and sent automatically. |
| **Code blocks** | Collapse long blocks, show line numbers, preview Markdown, and collect multiple code blocks into a ZIP. |
| **Question forms** | Turn model-generated `ask` blocks into forms with single-choice, multiple-choice, and free-text questions. |
| **Charts and widgets** | Render JSON charts as SVG and run small interactive HTML demos in an isolated sandbox. |
| **Composer helpers** | Continue numbered and bulleted lists with Shift+Enter. Optionally fold DeepSeek's reasoning blocks. |
| **Settings and backup** | Diagnostics, import/export, and settings that sync between open tabs through local extension storage. |

## Install

There is no build step.

1. Download the repository (or clone it).
2. Open `chrome://extensions` in Chrome, Edge, or Brave.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the repository folder.
5. Open [DeepSeek Chat](https://chat.deepseek.com/). A **Kit** tab appears along the right edge of the page.

To update an existing installation, pull or download the latest files, then click the extension's **Reload** button on the extensions page. Reload the DeepSeek tab too.

The Kit tab can be dragged to either side of the page. It remembers its position; **Settings → Messages → Reset** restores the default position.

## Using the Kit

Open the **Kit** tab to access four main areas:

### Prompts

The built-in **Default** prompt gives DeepSeek general response guidance. You can disable it, edit it, change its schedule, or restore the original text.

Add custom prompts under **Yours**. Each prompt has its own enabled switch and schedule:

- **First message** — once at the start of a chat.
- **Every N messages** — at the interval you choose.
- **Every message** — each time you send a message.

Prompts that are due are combined in the same context block. **Insert now** ignores schedules, while **Preview** shows what would be inserted.

### Memory

Create notes with a key, a value, and an optional category.

- **Always** notes are eligible for every context insertion.
- **When mentioned** notes are eligible when a word from their key appears in your message.
- Disable individual notes without deleting them.
- Set a token budget to limit how much memory can be included. Always notes are considered first; notes that do not fit are marked **Over budget**.

The token count shown in the Kit is an estimate based on characters, not an exact model tokenizer count.

### Snippets

Snippets are reusable pieces of text. Type `/` in the DeepSeek message box to open the picker. Keep typing to filter, use **Up/Down** to move, and press **Enter** or **Tab** to insert. **Esc** closes the picker.

A new installation has no snippets. Add your own in the Snippets tab.

Snippets support variables. Click a variable chip in the editor to insert it at the cursor.

### Settings

Settings are grouped into sections that open one at a time. They include message behavior, code-block tools, variables, diagnostics, and backup.

**Reset all** clears every setting, prompt, note and snippet.

## In the chat

### Context chips

A compact row near the message box shows which prompts and memories are due, along with whether context is **Visible** or **Hidden**. Hover over it for the approximate token count.

If the DeepSeek toolbar cannot be found or the composer is too narrow, the row falls back to a position above the message box. You can hide it with **Settings → Messages → Chips in the toolbar**.

### Visible and Hidden context

This setting controls what happens when you send a message that is due to receive context.

- **Visible:** Kit inserts the context into the message box. Review or edit it, then press Enter yourself.
- **Hidden (default):** Kit attaches the context, hides the inserted block in the chat view, and submits the message for you.

Hidden mode is more automated, and it is the default on a new install. Kit waits for the page to accept Enter and only tries the send button as a fallback if the composer has not cleared. If it cannot confirm submission, it reports that instead of repeatedly trying. The full text, including context, remains present when editing the sent message.

Switch to Visible mode if you want to inspect every prompt and memory before sending.

### List continuation

List continuation is on by default. You can turn it off in **Settings → Messages → Continue lists with Shift+Enter**. While it is on, Shift+Enter continues a list as you type:

- `1. ` becomes `2. `
- `- `, `* `, and `+ ` continue as bullets
- `> ` continues as a quote line
- Indentation is preserved
- Shift+Enter on an empty list item removes its marker

It only applies when the cursor is at the end of a list line. It does not change Enter behavior or operate inside code fences. Ctrl+Z undoes the change.

### Reasoning blocks

**Settings → Messages → Collapse reasoning** folds DeepSeek's reasoning blocks to their headers, both while the model is thinking and after the response finishes. Click a folded header to open it.

The Kit adds a live clock after the "Thinking" label while the model is still thinking, such as `23s` or `86s` (seconds only, like DeepSeek's own label). It counts from the moment the Kit sees the block start thinking, makes no requests, and disappears when DeepSeek writes its own "Thought for N seconds". If you refresh the page in the middle of a thought, that block gets no clock, because the real start time is unknown. The clock stays visible when the block is folded.

Kit uses CSS to fold the content rather than clicking DeepSeek's own collapse control. This avoids changing the page's internal open/closed state and helps preserve the block's measured height in DeepSeek's virtualized chat list. Blocks opened by you stay open while the page remains loaded; a refresh folds them again.

This feature depends on DeepSeek's current page markup. If that markup changes, the selector may need updating.

## Code blocks

Kit adds its own controls to code-block headers. Turn them off under **Settings → Code blocks**.

- **Collapse / Expand:** Long blocks start collapsed (20 lines by default). Expand a block to keep it open while the page is loaded.
- **Line numbers:** Optional CSS line numbers that do not affect selection, copying, or downloading.
- **Markdown preview:** Blocks tagged `markdown` or `md` get a rendered preview. Switch between **Preview** and **Source**.
- **+ ZIP:** Collect code blocks and download them together. Kit uses a `// file: filename.ext` comment near the top of a block when available; otherwise it assigns a name such as `snippet-1.ext`. The built-in Default prompt asks DeepSeek to put such a comment at the top of each file when a reply has several files (it is sent with the first message of a chat; if you edited the Default prompt, add the line yourself). The comment stays in the downloaded file, which is why JSON and other formats without comments are left out. Duplicate names receive a numeric suffix.

The Markdown preview builds DOM elements directly rather than parsing source as HTML. Raw HTML is shown as text, images are represented by placeholders, and only HTTP, HTTPS, and mailto links are retained. The original source remains available for copying, downloading, and ZIP collection.

DeepSeek already provides its own code execution and preview controls, so Kit does not add another code runner.

## Interactive questions

When DeepSeek needs you to make a choice, it can return a fenced code block tagged `ask`. Kit turns supported JSON in that block into a form.

Supported question types:

- **Single choice**
- **Multiple choice**
- **Free text**

Choice questions include an **Other** field by default. A question can mark one option as recommended; the badge is informational and never preselects an answer.

For multi-question forms, questions appear one at a time with a counter and navigation arrows. Selecting a single-choice answer advances to the next question. After submission, the form becomes read-only; choose **Answer again** to edit it.

Answers are submitted straight away by default. To have them added to the message box for you to review and send yourself, turn off **Settings → Questions → Send answers straight away**. If first-message context is still due, Hidden mode attaches it and sends; in Visible mode Kit inserts that context first and lets you review it as usual.

The built-in **Questions** prompt teaches DeepSeek the expected format. You can disable or edit it in the Prompts area.

## Charts and interactive widgets

The built-in **Visuals** prompt teaches DeepSeek two optional output formats. When a finished code block uses one of these language tags, Kit renders it as a card.

### Charts: `chart`

A chart block contains one JSON object. Supported types are `bar`, `line`, `area`, `scatter`, `pie`, and `donut`.

Example:

```chart
{
  "type": "bar",
  "title": "Monthly signups",
  "labels": ["Jan", "Feb", "Mar"],
  "series": [
    { "name": "Signups", "values": [12, 19, 15] }
  ],
  "unit": "users"
}
```

Charts are drawn as SVG by Kit and support hover details, legends, a full-size view, and PNG/SVG export. Chart labels and titles are treated as text, not markup.

### Widgets: `viz`

A widget block contains a self-contained HTML snippet (HTML, CSS, and JavaScript) for a small interactive demo, calculator, or diagram.

Widgets run in an isolated iframe with scripts enabled but without same-origin access. A restrictive Content Security Policy blocks network connections and external resources. The widget cannot access the DeepSeek page.

The sandbox provides a small set of ready-made classes, including `v-card`, `v-title`, `v-btn`, `v-btn-outline`, `v-row`, `v-control-group`, `v-label`, and `v-stat`. Keep the background transparent and size content to itself; viewport-height sizing is not supported.

If a chart or widget fails, its card explains the error. **Send error to DeepSeek** puts the error into your message box; it does not send it automatically. **Code** shows the original block.

Under **Settings → Visuals**, you can separately enable rendering and the built-in Visuals prompt. **Settings → Diagnostics** includes a sandbox check. If isolated frames cannot run on the current page, charts can still work even when widgets cannot.

## Variables

Variables can be used in prompts, memory values, and snippets.

| Variable | Expands to |
| --- | --- |
| `{{date}}` | Local date in YYYY-MM-DD format |
| `{{time}}` | Local time in 24-hour format |
| `{{datetime}}` | Local date and time |
| `{{weekday}}` | Local weekday |
| `{{timezone}}` | Local time zone identifier |
| `{{message_number}}` | Approximate message number in the current chat |
| `{{selection}}` | Text currently selected on the page |

Unknown variables are left unchanged.

## Storage and privacy

DeepSeek Kit is designed to work locally:

- It uses the browser's `chrome.storage.local` API for its settings, prompts, memories, snippets, and related state.
- The extension does not make its own network requests.
- It does not patch `fetch` or XHR.
- It does not send your prompts, memories, snippets, or widget content to a Kit-operated server.
- It requests the browser's `storage` permission; it does not request broad access to unrelated websites.

The extension runs on the DeepSeek Chat page and interacts with that page's message box and interface. **Visible mode leaves sending to you. Hidden mode can submit messages on your behalf.** As with any browser extension that modifies a third-party website, use it at your own discretion.

## New installs and upgrades

A new installation starts with the Default prompt and no snippets or notes.

Existing installations keep their own prompts, memories, snippets, and code-block settings when updated. Settings are migrated as needed; your own content is never replaced.

Data from the 0.3 and 0.4 settings formats is migrated automatically. Existing notes remain enabled, and the memory token budget defaults to unlimited.

If the extension is open in multiple DeepSeek tabs, a save in one tab is picked up by the others.

## Known limitations

DeepSeek Kit is an independent project and is not yet guaranteed to work with every change to DeepSeek Chat.

- It relies on DeepSeek's page structure to find the composer, toolbar, send button, code-block headers, and reasoning blocks.
- If DeepSeek changes its markup, some features may stop working until the relevant selectors or finders are updated. **Settings → Diagnostics** helps identify which page elements Kit can no longer find.
- Hidden mode depends on the site's composer and send behavior. If submission cannot be confirmed, Kit reports the problem rather than repeatedly sending.
- The message number is approximate for chats that existed before Kit began tracking them.
- The extension has not been exhaustively tested against every live DeepSeek interface variant.

## Development

The extension is plain JavaScript and CSS. It has no runtime dependencies, bundler, or build step.

### Run the tests

```sh
npm ci
npm test
```

The test suite covers pure logic, DeepSeek page finders, UI behavior, question forms, Markdown rendering, chart rendering, hardening, refresh behavior, and real-Chromium integration. The Chromium checks are skipped if Playwright or its browser is unavailable.

To install the Playwright Chromium browser for the integration tests:

```sh
npx playwright install chromium
```

You can also run the browser integration tests directly:

```sh
npm run test:e2e
```

### Project structure

| File | Responsibility |
| --- | --- |
| `manifest.json` | Manifest V3 configuration and content-script loading order |
| `content.js` | Extension runtime, panel UI, storage, context insertion, and feature coordination |
| `lib.js` | Pure logic: settings migration, schedules, variables, memory budgeting, snippets, and ZIP creation |
| `site.js` | DeepSeek-specific DOM finders and diagnostics probes |
| `ask.js` | Parsing and rendering interactive question forms |
| `markdown.js` | Safe Markdown preview renderer |
| `visuals.js` | SVG chart renderer and isolated widget document |
| `content.css` | Extension interface and page-level styles |
| `tests/` | Unit, UI, hardening, refresh, and browser integration tests |

---

DeepSeek Kit is an independent open-source project. DeepSeek and related product names are trademarks of their respective owners.
