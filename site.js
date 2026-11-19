/* DeepSeek Kit - everything that knows what chat.deepseek.com's markup looks like lives here.
 * If the site changes, this is the one file to adjust. content.js only calls these finders.
 * Loaded after lib.js and before content.js; exposes globalThis.DCK_SITE (module.exports under Node). */
(function () {
  'use strict';

  const OURS = '#dck-drawer, #dck-picker, #dck-chips, #dck-zipchip, #dck-toast, #dck-fab, .dck-vis';
  // A reasoning ("Thought for N seconds") block is the element carrying this inline custom property.
  const BLOCK_SEL = '[style*="--collapsible-area-title-height"]';

  // ----- shared helpers

  // Runs fn at most once per animation frame, however often it is asked for.
  function oncePerFrame(fn) {
    let queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn(); });
    };
  }

  // Text nodes under root, in document order, that pass the optional filter.
  function textNodes(root, filter) {
    const out = [];
    const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    let n;
    while ((n = walker.nextNode())) { if (!filter || filter(n)) out.push(n); }
    return out;
  }

  // Elements under root whose own visible text is exactly one of `texts`. Each hit is widened to the outermost
  // element that still holds only that text, stopping below `root`, so a label wrapped in spans gives its button.
  function findByText(root, texts, skip) {
    const hits = [];
    textNodes(root, (n) => texts.indexOf(n.nodeValue.trim()) >= 0).forEach((n) => {
      if (skip && skip(n)) return;
      const t = n.nodeValue.trim();
      let el = n.parentElement;
      if (!el) return;
      while (el.parentElement && el.parentElement !== root && el.parentElement.textContent.trim() === t) el = el.parentElement;
      hits.push(el);
    });
    return hits;
  }

  // The first text node of an element that has visible text, or null.
  function firstText(el) {
    return textNodes(el, (n) => !!n.nodeValue.trim())[0] || null;
  }

  // ----- the message box

  // The message box: of the visible textareas outside our own UI and dialogs, the lowest on screen (editing an earlier
  // message opens another textarea higher up). With no layout (or none visible) the first one is used.
  function composer(doc) {
    const d = doc || document;
    const all = Array.from(d.querySelectorAll('textarea')).filter((t) => !t.closest(OURS) && !t.closest('dialog, [role="dialog"], [aria-modal="true"]'));
    const shown = all.filter((t) => t.getClientRects().length > 0 && t.getBoundingClientRect().width > 0);
    const pool = shown.length ? shown : all;
    let best = null;
    pool.forEach((t) => { if (!best || t.getBoundingClientRect().bottom > best.getBoundingClientRect().bottom) best = t; });
    return best;
  }

  const NOT_SEND = /attach|upload|file|mic|voice|record|search|think|reason|model|stop|cancel|clear|emoji/i;
  const IS_SEND = /send|submit|\u53d1\u9001/i;
  const nameOf = (b) => [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'), b.getAttribute('name'), b.id].filter(Boolean).join(' ');

  // The send button for the message box. Candidates are the enabled icon buttons around the box that are not ours.
  // A button named like "send" or type=submit wins; buttons named like attach, voice, search and so on are never
  // chosen; otherwise the right-most one is taken (the send button sits at the right end of the toolbar).
  function sendButton(el) {
    let node = el;
    for (let i = 0; i < 6 && node && node.parentElement; i++) {
      node = node.parentElement;
      const btns = Array.from(node.querySelectorAll('[role="button"], button')).filter(
        (b) => !b.closest(OURS) && b.querySelector('svg') && b.getAttribute('aria-disabled') !== 'true' && !b.disabled
      );
      if (!btns.length) continue;
      const named = btns.filter((b) => IS_SEND.test(nameOf(b)) || b.getAttribute('type') === 'submit');
      if (named.length) return named[named.length - 1];
      const rest = btns.filter((b) => !NOT_SEND.test(nameOf(b)));
      if (!rest.length) continue;
      let best = rest[rest.length - 1];
      rest.forEach((b) => { if (b.getBoundingClientRect().right > best.getBoundingClientRect().right + 1) best = b; });
      return best;
    }
    return null;
  }

  // The rounded box that visually holds the message input (it wraps the textarea in padding and a toolbar).
  // Null when no such box is found.
  function composerBox(el) {
    const own = el.getBoundingClientRect();
    let best = null;
    let node = el.parentElement;
    for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.width > own.width + 200) break; // too wide to be the input box
      let radius = 0;
      try { radius = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0; } catch (e) { /* ignore */ }
      if (radius >= 8 && r.width >= own.width && r.height >= own.height) best = node;
    }
    return best;
  }

  // The toolbar pills (DeepThink, Search) inside the box, in order.
  function toolbarPills(box) {
    if (!box) return [];
    return findByText(box, ['DeepThink', 'Search'], (n) => !!n.parentElement.closest('#dck-chips'))
      .filter((p) => p.parentElement && p.parentElement !== box);
  }

  // ----- code blocks

  // The site's own "Copy" button for a block, found by its text. Null when the block has no header.
  function copyButton(pre) {
    let box = pre.parentElement;
    for (let i = 0; i < 4 && box && box !== document.body; i++, box = box.parentElement) {
      if (Array.from(box.querySelectorAll('pre')).filter((x) => !x.closest('.dck-mdprev')).length > 1) return null; // a Markdown preview's own code blocks do not count
      const hit = findByText(box, ['Copy', 'Copy code'], (n) => pre.contains(n) || !!n.parentElement.closest('[data-dck-act]'))
        .find((btn) => btn.parentElement && !(pre.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (hit) return hit;
    }
    return null;
  }

  function codeBlocks() {
    return Array.from(document.querySelectorAll('pre')).filter((p) => !p.closest('#dck-drawer, .dck-mdprev'));
  }

  // The element that holds the whole block (header and code); our cards go right after it.
  function blockBox(pre) {
    return pre.closest('.md-code-block') || pre.parentElement || pre;
  }

  // The language of a block, lower case: from the code element's class when the site sets one, otherwise the first word
  // of the header label. '' when unknown.
  function blockLang(pre) {
    const code = pre.querySelector('code');
    const m = (((code && code.className) || '') + ' ' + (pre.className || '')).match(/language-([\w+-]+)/);
    if (m) return m[1].toLowerCase();
    const box = pre.parentElement;
    const head = box && box.firstElementChild !== pre ? box.firstElementChild : pre.previousElementSibling;
    const first = head ? firstText(head) : null; // not textContent: our own header buttons would run into the label
    const word = first ? first.nodeValue.trim().split(/\s+/)[0] : '';
    return word.length && word.length <= 20 ? word.toLowerCase() : '';
  }

  // True while the site is still writing a block: its Copy button is dimmed or disabled until the reply finishes.
  function blockBusy(pre) {
    const copy = copyButton(pre);
    if (!copy) return false;
    if (copy.getAttribute('aria-disabled') === 'true' || copy.disabled) return true;
    try { return getComputedStyle(copy).cursor === 'not-allowed'; } catch (e) { return false; }
  }

  // ----- reasoning blocks

  function reasoningBlocks() {
    return Array.from(document.querySelectorAll(BLOCK_SEL)).filter((b) => !b.closest('#dck-drawer'));
  }

  // Is this element the header of a reasoning block? Returns the block or null.
  function blockOfHeader(el) {
    const block = el.parentElement;
    return block && el === block.firstElementChild && block.matches(BLOCK_SEL) ? block : null;
  }

  // Item keys are positions within one chat, so the chat's path is part of the key.
  function blockKey(block) {
    const item = block.closest('[data-virtual-list-item-key]');
    return item ? location.pathname + '#' + String(item.getAttribute('data-virtual-list-item-key')) : '';
  }

  // A block with a `.ds-think-content` child is open as far as the site knows.
  function blockIsOpen(block) { return !!block.querySelector(':scope > .ds-think-content'); }

  // The label inside a block's header ("Thinking" while it writes, "Thought for N seconds" once done), or null.
  function blockLabel(block) {
    const head = block.firstElementChild;
    const t = head ? firstText(head) : null; // not textContent: our own timer would run into the label
    return t ? t.parentElement : null;
  }

  // Is this block still being written? While it is, the label reads "Thinking" and carries a shimmer element whose
  // inline style says `animation-play-state: running`. A finished block reads "Thought for N seconds" with no shimmer.
  // The shimmer is the primary signal (it does not depend on the site's language); the text is the fallback.
  function blockLive(block) {
    const label = blockLabel(block);
    if (!label) return false;
    const text = (firstText(block.firstElementChild).nodeValue || '').trim();
    if (/^Thought/i.test(text)) return false;
    const shimmer = label.querySelector('[style*="animation-play-state"]');
    if (shimmer) return !/paused/i.test(shimmer.getAttribute('style') || '');
    return /^Thinking/i.test(text);
  }

  // How much reasoning text the block holds right now (open or folded, the text is in the page either way).
  function blockThoughtLength(block) {
    const body = block.querySelector(':scope > .ds-think-content');
    return body ? body.textContent.length : 0;
  }

  // ----- probe: what was found, hook by hook (for Diagnostics)
  function probe() {
    const el = composer();
    const box = el ? composerBox(el) : null;
    const pills = box ? toolbarPills(box) : [];
    const pres = codeBlocks();
    const headed = pres.filter((p) => !!copyButton(p)).length;
    const blocks = reasoningBlocks();
    return {
      composer: !!el,
      composerTag: el ? el.tagName.toLowerCase() : '',
      box: !!box,
      boxWidth: box ? Math.round(box.getBoundingClientRect().width) : 0,
      send: !!(el && sendButton(el)),
      pills: pills.length,
      codeBlocks: pres.length,
      codeHeaders: headed,
      reasoning: blocks.length,
      reasoningOpen: blocks.filter(blockIsOpen).length,
      reasoningLive: blocks.filter(blockLive).length,
    };
  }

  const api = {
    BLOCK_SEL, oncePerFrame, textNodes, findByText, firstText, composer, sendButton, composerBox, toolbarPills,
    copyButton, codeBlocks, blockBox, blockLang, blockBusy, reasoningBlocks, blockOfHeader, blockKey, blockIsOpen, blockLabel, blockLive, blockThoughtLength, probe,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.DCK_SITE = api;
})();
