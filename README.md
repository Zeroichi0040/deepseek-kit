# DeepSeek Kit

A tiny, local-only browser extension for chat.deepseek.com. It stores system prompts and memory notes, and inserts them into your message box, visibly, so you can read and edit them before you send.

## What it does not do

- It does not patch `fetch` or XHR, or modify requests in flight.
- It does not send messages, make background requests, or contact any server.
- It does not hide anything: the inserted text appears in your message and in the chat history.

Everything is stored in `chrome.storage.local`.

## Install (Chrome / Edge / Brave)

1. Unzip this folder.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and choose the folder (if upgrading, click the reload icon on the extension card instead).
4. Open chat.deepseek.com. A **Kit** button appears top-right.

## Use

- Write a system prompt and add memory notes in the drawer.
- **Multi-system prompt mode**: turn it on to keep several prompts, each with its own on/off switch and schedule (first message, every N messages, or every message). Use Edit to change a prompt's name, text or schedule. Prompts that are due are all inserted together.
- Type a message and press **Enter**. The context is inserted into the box. Review it, then press **Enter** again to send.
- "Insert now" in the drawer inserts on demand, ignoring schedules.
- Memory notes marked *always* go in every time; *only when mentioned* ones are included when a word from the key appears in your message.
- Export/Import backs up everything as JSON.

## Caveats

- Not tested against the live site: it finds the composer with `document.querySelector('textarea')`. If DeepSeek changes its markup, adjust `getComposer()` in `content.js`.
- Using any extension on a consumer site is at your own risk, and I can't promise it won't affect your account.
