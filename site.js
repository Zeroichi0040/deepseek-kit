/* DeepSeek Kit - everything that knows what chat.deepseek.com's markup looks like lives here.
 * If the site changes, this is the one file to adjust. content.js only calls these finders.
 * Loaded after lib.js and before content.js; exposes globalThis.DCK_SITE (module.exports under Node). */
(function () {
  'use strict';

  const OURS = '#dck-drawer, #dck-picker, #dck-chips, #dck-zipchip, #dck-toast, #dck-fab';
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

  function composer(doc) { return (doc || document).querySelector('textarea'); }

  // The last icon button near the box that is not ours or disabled: the send button.
  function sendButton(el) {
    let node = el;
    for (let i = 0; i < 6 && node && node.parentElement; i++) {
      node = node.parentElement;
      const btns = Array.from(node.querySelectorAll('[role="button"], button')).filter(
        (b) => !b.closest(OURS) && b.querySelector('svg') && b.getAttribute('aria-disabled') !== 'true' && !b.disabled
      );
      if (btns.length) return btns[btns.length - 1];
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
      if (box.querySelectorAll('pre').length > 1) return null;
      const hit = findByText(box, ['Copy', 'Copy code'], (n) => pre.contains(n) || !!n.parentElement.closest('[data-dck-act]'))
        .find((btn) => btn.parentElement && !(pre.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (hit) return hit;
    }
    return null;
  }

  function codeBlocks() {
    return Array.from(document.querySelectorAll('pre')).filter((p) => !p.closest('#dck-drawer'));
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
    };
  }

  const api = {
    BLOCK_SEL, oncePerFrame, textNodes, findByText, firstText, composer, sendButton, composerBox, toolbarPills,
    copyButton, codeBlocks, blockBox, blockLang, blockBusy, reasoningBlocks, blockOfHeader, blockKey, blockIsOpen, probe,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.DCK_SITE = api;
})();
