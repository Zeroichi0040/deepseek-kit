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

**Snippets**: reusable text. Search them here, or type `/` in the message box to open the picker (keep typing to filter, Up/Down to move, Enter or Tab to insert, Esc to close). Variable chips insert `{{date}}` and friends at the cursor.

**Settings**: grouped into sections that open one at a time: Messages, Code blocks, Variables, Diagnostics and Backup (export/import), with Reset all pinned at the bottom.

**Pinned footer** (Prompts and Memory): **Insert now** adds the context to your message immediately, ignoring schedules. **Preview** shows exactly what would be added.

## In the chat

A small chip row shows what will be attached (Default, Concise tone, 2 memories) and whether context is Visible or Hidden. It sits in the message box toolbar next to the DeepThink and Search pills (hover it for the token estimate), and falls back to just above the message box when the toolbar is not found or the box is narrow. *Chips in the toolbar* (on by default) shows or hides the row.

## DeepThink reasoning: collapse

Settings > Messages > *Collapse reasoning* (off by default). Reasoning blocks are folded to their header, both while the model is still thinking and once it says "Thought for N seconds", in every message, so they are also folded after a refresh.

Kit does this with a stylesheet rule, not by clicking the site's own header. With the setting on, `<html>` gets the class `dck-fold` and a rule in `content.css` hides everything in a reasoning block except the header and the two empty spacer divs, which is exactly what a block the site has closed consists of (same height, to the pixel). Nothing is clicked and no site state changes. This matters because the site's virtual list measures a message once drawn: closing blocks by clicking made them shrink after they had been measured, and scrolling up after a refresh then made the page jump. A folded block is the right height from the start.

Click a folded header to open it; click again to close it. The first click is handled by Kit (the site thinks the block is already open, so passing the click on would close it), the later ones by the site. A block you opened stays open: Kit remembers it by the message's list key for as long as the page is open, and re-applies it when the site rebuilds that message as you scroll. That memory is not saved, so after a refresh the block is folded again.

The setting was called *Collapse reasoning while thinking* before and only closed the newest, still-thinking block; the stored setting is the same, so an existing opt-in carries over to the new behaviour.

It relies on the site's markup: a block is the element with an inline `--collapsible-area-title-height`, directly containing a `.ds-think-content`. If DeepSeek changes that, adjust the selector in `content.css` and `BLOCK_SEL` in `content.js` (`applyFold()`, `initThinkTracker()`). The `:has()` selector needs Chrome 105 or newer.

## Code blocks: collapse and ZIP

Kit adds buttons (each with a small icon) to each code block's header, next to the site's own Copy and Download (turn it off in Settings > Code blocks). If a block has no header the buttons appear in a small bar when you hover it.

- **Line numbers** (Settings > Code blocks, off by default): numbers each line, with wrapped lines hanging under their number. The numbers are drawn by CSS, so selecting, copying and the site's Copy / Download are unchanged. Blocks the site renders without per-line elements are left alone.
- **Collapse / Expand**: folds a long block down to a few lines. *Collapse long blocks* starts blocks over 20 lines collapsed; a block you expand stays open.
- **+ ZIP**: collects blocks. A pill at the bottom of the page then offers **Download ZIP (n)** (duplicate names get -2, -3). File names come from a comment such as `// file: app.js` in the first lines, otherwise `snippet-N.ext`.

DeepSeek already has its own Run/preview, so Kit does not add one.

## Show / hide inserted context

- **Visible (default)**: pressing Enter puts the context into your message box. Review or edit it, then press Enter again to send. Nothing is sent for you.
- **Hidden**: pressing Enter attaches the context and sends the message in one step. The inserted block is hidden in the chat view, but it is part of the message that is sent. This mode presses Enter / clicks the send button for you, so it behaves more like an automation tool than the default mode does. Use it knowingly.

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

## Upgrading from 0.4

Data carries over. Existing notes get no category and stay switched on; the memory budget starts at 0 (no limit).

## Upgrading from 0.3

Your data carries over. The old single "system prompt" box and the multi-prompt switch are gone: a single prompt you had written becomes the first entry under **Yours** (kept switched off if you were using multi-prompt mode, where it was inactive).

## How "first message" is decided

The extension counts the messages you send in each chat and saves the count, so refreshing the page does not make it think a conversation has just started. A chat it has no record of (for example one that was open before you installed or updated it) is treated as already started, so "first message" prompts only attach in a new chat. `{{message_number}}` is approximate in those chats until a few messages have been sent. Reset all clears the saved counts.

## Caveats

- Not tested against the live site. The message box is found with `document.querySelector('textarea')`, the chip row is placed just above it, and hidden mode finds the send button heuristically. If DeepSeek changes its markup, adjust `getComposer()`, `positionChips()` and `clickSend()` in `content.js`. Code blocks are found as `pre` elements, with the Copy button located by its text; if the site changes that, adjust `initCodeTools()`.
- In hidden mode the inserted block is stripped from user messages in the page. If DeepSeek renders messages in a way that splits the block across elements, it may remain visible. Chat titles generated from the first message may include part of it.
- Using any extension on a consumer site is at your own risk, and nothing here can promise it won't affect your account.

## Development

`lib.js` holds the pure logic (settings migration, schedules, variables, memory budget, summary, snippet search, code-block detection, ZIP writer) and exports it under Node for testing; `content.js` is the browser code:

```
node tests/logic.test.js
```

The JS and CSS files are plain ASCII on purpose, because Chrome refuses content scripts that are not valid UTF-8.
