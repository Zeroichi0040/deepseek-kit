# DeepSeek Kit

A small, local-only browser extension for chat.deepseek.com. It keeps system prompts, memory notes and snippets, and puts them into your message box when you ask.

It makes no network requests of its own and does not patch `fetch` or XHR. Everything is stored in `chrome.storage.local`.

## Install (Chrome / Edge / Brave)

1. Download or clone this repo.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and choose the folder (when upgrading, click the reload icon on the extension card).
4. Open chat.deepseek.com. A **Kit** tab appears on the right edge. Drag it anywhere; it docks to the nearest side and remembers its position (Settings > Messages > Reset puts it back). While the panel is open, a right-docked tab hides so it never covers the panel.

## The panel

The panel has four tabs, with the controls you use most pinned above and below them.

**Pinned header**
- **On** switch for the whole extension.
- **Context in chat: Visible / Hidden** (see below).
- A one-line summary of what the next message will carry, for example "Default, Concise tone + 2 memories, ~310 tokens". The token figure is a rough estimate (characters / 4).

**Prompts**
- **Built-in** default prompt: a general-purpose prompt that ships with the extension. Switch it off, edit it, change its schedule, or reset it to the built-in text.
- **Yours**: any number of prompts, each with its own on/off switch and schedule (first message, every N messages, every message). All prompts that are due are inserted together. A single prompt is just a list of one.

**Memory**: notes marked *Always* go in whenever context is inserted; *When mentioned* notes are included when a word from the key appears in your message. Edit a note in place (pencil icon), group notes with a category, and switch single notes off without deleting them. Each note shows whether it is in your next message (updates as you type). A **token budget** caps how much memory one message can carry (0 = no limit): *Always* notes are used first, then *When mentioned* ones, and notes that do not fit are shown as "Over budget".

**Snippets**: reusable text. Search them here, or type `/` in the message box to open the picker (keep typing to filter, Up/Down to move, Enter or Tab to insert, Esc to close). Variable chips insert `{{date}}` and friends at the cursor. A new install starts with six: `/summarize`, `/explain`, `/fix`, `/steps`, `/translate` and `/handoff`. `/handoff` asks the model to write one markdown block that carries the conversation into a new chat: send it, press Copy on the block, and paste it into the new chat.

**Settings**: grouped into sections that open one at a time: Messages, Code blocks, Variables, Diagnostics and Backup (export/import, and **Starter content**, which adds any starter snippets and the name note you do not have yet without touching your own), with Reset all pinned at the bottom.

**Pinned footer** (Prompts and Memory): **Insert now** adds the context to your message immediately, ignoring schedules. **Preview** shows exactly what would be added.

## In the chat

A small chip row shows what will be attached (Default, Concise tone, 2 memories) and whether context is Visible or Hidden. It sits in the message box toolbar next to the DeepThink and Search pills (hover it for the token estimate), and falls back to just above the message box when the toolbar is not found or the box is narrow. *Chips in the toolbar* (on by default) shows or hides the row.

**Lists in the message box** (Settings > Messages > *Continue lists with Shift+Enter*, off by default): the message box is plain text, so this only helps with typing. With a plain cursor at the end of a line that starts with `1.`, `-`, `*`, `+` or `>` followed by a space, Shift+Enter starts the next item (`2.`, another bullet, another quote line, with the same indent); on an empty item it removes the marker and leaves the list. It does nothing inside a code fence (a line starting with three backticks or tildes), with the cursor in the middle of a line, or on any line that is not a list item, and Enter itself is never touched. Ctrl+Z undoes it.

## DeepThink reasoning: collapse

Settings > Messages > *Collapse reasoning* (off by default). Reasoning blocks are folded to their header, both while the model is still thinking and once it says "Thought for N seconds", in every message, so they are also folded after a refresh.

Kit does this with a stylesheet rule, not by clicking the site's own header. With the setting on, `<html>` gets the attribute `data-dck-fold` (an attribute, because a site that rewrites `<html class>` would wipe a class) and a rule in `content.css` hides everything in a reasoning block except the header and the two empty spacer divs, which is exactly what a block the site has closed consists of (same height, to the pixel). Nothing is clicked and no site state changes. This matters because the site's virtual list measures a message once drawn: closing blocks by clicking made them shrink after they had been measured, and scrolling up after a refresh then made the page jump. A folded block is the right height from the start; the only exception is the first few tens of milliseconds after a page load, before the extension's storage has answered, which is earlier than the site draws any chat. A block you open stays open until you refresh, remembered per chat, so opening one in a chat does not open blocks in other chats.

Click a folded header to open it; click again to close it. The first click is handled by Kit (the site thinks the block is already open, so passing the click on would close it), the later ones by the site. A block you opened stays open: Kit remembers it by the message's list key for as long as the page is open, and re-applies it when the site rebuilds that message as you scroll. That memory is not saved, so after a refresh the block is folded again.

The setting was called *Collapse reasoning while thinking* before and only closed the newest, still-thinking block; the stored setting is the same, so an existing opt-in carries over to the new behaviour.

It relies on the site's markup: a block is the element with an inline `--collapsible-area-title-height`, directly containing a `.ds-think-content`. If DeepSeek changes that, adjust the selector in `content.css` and `BLOCK_SEL` in `content.js` (`applyFold()`, `initThinkTracker()`). The `:has()` selector needs Chrome 105 or newer.

## Code blocks: collapse and ZIP

Kit adds buttons (each with a small icon) to each code block's header, next to the site's own Copy and Download (turn it off in Settings > Code blocks).

- **Questions**: when DeepSeek needs a choice from you it can put the questions in an `ask` code block and the Kit draws a form: pick one, pick several, or type your own answer (every choice question has an Other field), plus free-text questions. **Add to message** puts your answers into the message box so you can add more and press Enter; with **Send answers straight away** (Settings > Questions) they are sent when you submit. If the Kit still owes the chat its first-message context, it adds that first and waits for you to review, as for any message. A short built-in Questions prompt (Prompts tab, switch it off in Settings) teaches the model the format. If a block is not valid you get a clear message and the source is one click away, and plain-text questions are never touched. Nothing is sent anywhere by the form itself; it only fills or presses Enter in your message box.
- **Markdown preview**: blocks marked `markdown` or `md` get a **Preview** button (once the site has finished writing the block). It shows the rendered headings, bold/italic, lists, quotes, rules, links, inline code, code fences and tables; **Source** switches back. The original block stays in the page (hidden), so Copy, Download and + ZIP still use the exact source. The renderer is built into the kit (`markdown.js`) and creates elements directly instead of parsing HTML, so nothing in the Markdown can run a script or load anything: images show as `[image: name]`, only http, https and mailto links are kept, raw HTML shows as text. Turn it off in Settings > Code blocks.
- **Line numbers** (Settings > Code blocks, on by default for new installs): numbers each line, with wrapped lines hanging under their number. The numbers are drawn by CSS, so selecting, copying and the site's Copy / Download are unchanged. Blocks the site renders without per-line elements are left alone.
- **Collapse / Expand**: folds a long block down to a few lines. *Collapse long blocks* (on by default for new installs) starts blocks over 20 lines collapsed, and the button says how many lines are hidden; a block you expand stays open.
- **+ ZIP**: collects blocks. A pill just above the right end of the message box then offers **Download ZIP (n)** (duplicate names get -2, -3). File names come from a comment such as `// file: app.js` in the first lines, otherwise `snippet-N.ext`.

DeepSeek already has its own Run/preview, so Kit does not add one.

## Show / hide inserted context

- **Visible (default)**: pressing Enter puts the context into your message box. Review or edit it, then press Enter again to send. Nothing is sent for you.
- **Hidden**: pressing Enter attaches the context and sends the message in one step. The inserted block is hidden in the chat view, but it is part of the message that is sent. This mode presses Enter / clicks the send button for you, so it behaves more like an automation tool than the default mode does. It waits up to 1.5 seconds for the site to take the Enter; only if the box has not emptied does it press the send button, once, and if that cannot be confirmed either it tells you instead of trying again. The edit box of an earlier message shows the full text that was sent, context included, and in this mode it is sized to fit that text. Use it knowingly.

## Variables

Usable in prompts, memory values and snippets:

| Variable | Result |
| --- | --- |
| `{{date}}` | `2026-11-14` |
| `{{time}}` | `15:30` (24-hour, local) |
| `{{datetime}}` | date and time together |
| `{{weekday}}` | `Saturday` |
| `{{timezone}}` | e.g. `Asia/Manila` |
| `{{message_number}}` | number of this message in the chat |
| `{{selection}}` | text you have selected on the page |

Unknown `{{names}}` are left as typed.

## New installs and upgrades

A new install starts with a short Default prompt, the six starter snippets above, and a **name** note that is switched off (edit its value and switch it on to use it). This happens once, so anything you delete stays deleted. An install that already has settings is never changed: it keeps its own snippets, notes and code-block settings. If you open the extension in two tabs, a save in one is picked up by the other.

## Upgrading from 0.4

Data carries over. Existing notes get no category and stay switched on; the memory budget starts at 0 (no limit).

## Upgrading from 0.3

Your data carries over. The old single "system prompt" box and the multi-prompt switch are gone: a single prompt you had written becomes the first entry under **Yours** (kept switched off if you were using multi-prompt mode, where it was inactive).

## How "first message" is decided

The extension counts the messages you send in each chat and saves the count, so refreshing the page does not make it think a conversation has just started. A chat it has no record of (for example one that was open before you installed or updated it) is treated as already started, so "first message" prompts only attach in a new chat. `{{message_number}}` is approximate in those chats until a few messages have been sent. Reset all clears the saved counts.

## Caveats

- Not tested against the live site. The message box is found with `document.querySelector('textarea')`, the chip row is placed just above it, and hidden mode finds the send button heuristically. If DeepSeek changes its markup, adjust the finders in `site.js`; Settings > Diagnostics shows which one stopped finding its target.
- In hidden mode the inserted block is stripped from user messages in the page. If DeepSeek renders messages in a way that splits the block across elements, it may remain visible. Chat titles generated from the first message may include part of it.
- Using any extension on a consumer site is at your own risk, and nothing here can promise it won't affect your account.

## Visuals

The model can draw charts and small interactive widgets right in the chat. The built-in **Visuals** prompt (Prompts tab, on by default, first message of a chat) asks it to put them in a code block whose language is `chart` or `viz`. When the block is finished it is replaced by a card; nothing needs clicking. While the site is still writing, a small "Building..." placeholder shows.

- **Charts** (`chart`): one JSON object (bar, line, area, scatter, pie, donut) drawn as SVG by the Kit itself, with hover tooltips, legend, PNG and SVG download and a full-size view. Titles and labels are always text, never markup.
- **Widgets** (`viz`): one HTML snippet that runs in an isolated frame (`sandbox="allow-scripts"`, no same-origin access) with a strict Content-Security-Policy: no network, no external scripts, no access to the DeepSeek page. They get a small set of ready-made classes and size themselves to their content.
- If something fails, the card says what and offers **Send error to DeepSeek**, which puts the error in your message box (it is never sent for you). **Code** shows the original block.
- Settings > Visuals has two switches: draw the cards, and add the Visuals prompt. Settings > Diagnostics has a "Widget sandbox" row that tests whether isolated frames can run scripts on your DeepSeek page; if they cannot, charts still work and widgets will not.

## Development

`lib.js` holds the pure logic (settings migration, schedules, variables, memory budget, summary, snippet search, code-block detection, ZIP writer). `ask.js` reads and draws the question forms. `markdown.js` is the small Markdown renderer behind the code-block Preview. `site.js` holds everything that knows DeepSeek's markup (message box, send button, toolbar pills, code block Copy buttons, reasoning blocks) and the probe behind Diagnostics. `content.js` is the browser code that uses them.

```
npm ci           # once: jsdom and Playwright, exact versions from package-lock.json (Chromium via: npx playwright install chromium)
npm test         # logic, site finders, UI, and real-Chromium tests; the Chromium part is skipped if unavailable
```

Tests live in `tests/`; `tests/fixtures/` holds small pieces of DeepSeek markup the finders are checked against.

The JS and CSS files are plain ASCII on purpose, because Chrome refuses content scripts that are not valid UTF-8.
