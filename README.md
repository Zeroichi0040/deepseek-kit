# DeepSeek Kit

A small, local-only browser extension for chat.deepseek.com. It keeps system prompts, memory notes and snippets, and puts them into your message box when you ask.

It makes no network requests of its own and does not patch `fetch` or XHR. Everything is stored in `chrome.storage.local`.

## Install (Chrome / Edge / Brave)

1. Download or clone this repo.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and choose the folder (when upgrading, click the reload icon on the extension card).
4. Open chat.deepseek.com. A **Kit** button appears top-right.

## Features

### System prompts
- **Built-in default prompt**: a sensible general-purpose prompt that ships with the extension. Turn it off, change its schedule, edit it, or reset it to the built-in text.
- **Your own prompt**: one prompt with a schedule (first message, every N messages, every message).
- **Multi-system prompt mode**: several prompts at once, each with its own on/off switch and schedule. All prompts that are due are inserted together.

### Show / hide inserted context
- **Show (default)**: pressing Enter puts the context into your message box. Review or edit it, then press Enter again to send. Nothing is sent for you.
- **Hide**: pressing Enter attaches the context and sends the message in one step. The inserted block is hidden in the chat view, but it is part of the message that is sent. This mode presses Enter / clicks the send button for you, so it behaves more like an automation tool than the default mode does. Use it knowingly.

### Snippets and the slash picker
Save reusable text as snippets. Type `/` in the message box to open the picker; keep typing to filter, use Up/Down to move, Enter or Tab to insert, Esc to close. Variables are filled in when a snippet is inserted.

### Variables
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

### Memory
Notes marked *always* go in whenever context is inserted; *only when mentioned* notes are included when a word from the key appears in your message.

### Backup
Export and Import save everything (settings, prompts, memory, snippets) as JSON. "Insert now" inserts context on demand, ignoring schedules.

## Caveats

- Not tested against the live site. The message box is found with `document.querySelector('textarea')`, and hidden mode finds the send button heuristically. If DeepSeek changes its markup, adjust `getComposer()` and `clickSend()` in `content.js`.
- In hidden mode the inserted block is stripped from user messages in the page. If DeepSeek renders messages in a way that splits the block across elements, it may remain visible. Chat titles generated from the first message may include part of it.
- Using any extension on a consumer site is at your own risk, and nothing here can promise it won't affect your account.

## Development

`content.js` keeps its pure logic (prompt selection, schedules, variables, snippet filtering) separate from the browser code and exports it under Node for testing. The file is plain ASCII on purpose, because Chrome refuses content scripts that are not valid UTF-8.
