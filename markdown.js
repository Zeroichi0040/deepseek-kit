/* DeepSeek Kit - small Markdown renderer for the code-block Preview.
 * Builds DOM nodes with createElement and textContent only: nothing is ever parsed as HTML, so a Markdown source
 * cannot inject markup, scripts or resource loads. Images are never loaded (shown as text). Links are limited to
 * http, https and mailto. Pure: no storage, no network, no page access beyond the document it is given. */
(function () {
  'use strict';

  const MAX_CHARS = 200000;
  const MAX_DEPTH = 12;

  // ---------- inline ----------
  function safeUrl(u) {
    const url = String(u || '').trim().replace(/[\u0000-\u001f\u007f\s]+/g, '');
    return /^(https?:\/\/|mailto:)[^\s]+$/i.test(url) ? url : '';
  }

  function link(doc, href, parent) {
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
    parent.appendChild(a);
    return a;
  }

  // Finds the closing run of `mark` for an opener at `from`, skipping code spans and escapes. -1 when there is none.
  function closer(s, from, mark) {
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (c === '`') {
        let n = 0;
        while (s[i + n] === '`') n++;
        const end = s.indexOf('`'.repeat(n), i + n);
        if (end < 0) { i += n - 1; continue; }
        i = end + n - 1;
        continue;
      }
      if (s.startsWith(mark, i)) {
        const prev = s[i - 1];
        if (i > from && !/\s/.test(prev) && (mark[0] !== '_' || !/[A-Za-z0-9]/.test(s[i + mark.length] || ''))) return i;
      }
    }
    return -1;
  }

  // Reads "(destination "optional title")" starting at the "(" at index p. Parentheses inside the destination may
  // nest. Returns [destination, characters used] or null.
  function linkTail(s, p) {
    let i = p + 1;
    while (s[i] === ' ') i++;
    let dest = '';
    if (s[i] === '<') {
      const e = s.indexOf('>', i);
      if (e < 0 || s.slice(i, e).indexOf('\n') >= 0) return null;
      dest = s.slice(i + 1, e);
      i = e + 1;
    } else {
      let depth = 0;
      for (; i < s.length; i++) {
        const d = s[i];
        if (/\s/.test(d)) break;
        if (d === '(') depth++;
        else if (d === ')') { if (depth === 0) break; depth--; }
        dest += d;
      }
    }
    while (s[i] === ' ') i++;
    if (s[i] === '"' || s[i] === "'") {
      const e = s.indexOf(s[i], i + 1);
      if (e < 0) return null;
      i = e + 1;
      while (s[i] === ' ') i++;
    }
    if (s[i] !== ')') return null;
    return [dest, i + 1 - p];
  }

  function inline(doc, parent, s, depth) {
    let buf = '';
    const flush = () => { if (buf) { parent.appendChild(doc.createTextNode(buf)); buf = ''; } };
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) {
        if (s[i + 1] === '\n') { flush(); parent.appendChild(doc.createElement('br')); i += 2; continue; }
        if (/[!-\/:-@\[-`{-~]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      }
      if (c === '\n') {
        // two spaces before a line break make a hard break; otherwise it is just a space
        if (/ {2,}$/.test(buf)) { buf = buf.replace(/ +$/, ''); flush(); parent.appendChild(doc.createElement('br')); } else { buf = buf.replace(/ +$/, '') + ' '; }
        i++;
        while (s[i] === ' ') i++;
        continue;
      }
      if (c === '`') {
        let n = 0;
        while (s[i + n] === '`') n++;
        const end = s.indexOf('`'.repeat(n), i + n);
        if (end > 0) {
          flush();
          const code = doc.createElement('code');
          let t = s.slice(i + n, end).replace(/\n/g, ' ');
          if (t.length > 2 && t[0] === ' ' && t[t.length - 1] === ' ' && t.trim()) t = t.slice(1, -1);
          code.textContent = t;
          parent.appendChild(code);
          i = end + n;
          continue;
        }
        buf += s.slice(i, i + n);
        i += n;
        continue;
      }
      if (depth < MAX_DEPTH && (c === '[' || (c === '!' && s[i + 1] === '['))) {
        const img = c === '!';
        const open = img ? i + 1 : i;
        // matching ] (nesting counted, code spans and escapes skipped)
        let lvl = 0;
        let j = open;
        for (; j < s.length; j++) {
          const d = s[j];
          if (d === '\\') { j++; continue; }
          if (d === '`') { const e = s.indexOf('`', j + 1); if (e > 0) { j = e; continue; } }
          if (d === '[') lvl++;
          else if (d === ']') { lvl--; if (lvl === 0) break; }
        }
        if (j < s.length && s[j + 1] === '(') {
          const m = linkTail(s, j + 1);
          if (m) {
            const label = s.slice(open + 1, j);
            const href = m[0];
            flush();
            if (img) {
              // never loaded: no request is made for an image in a preview
              const span = doc.createElement('span');
              span.className = 'dck-md-img';
              span.textContent = '[image' + (label ? ': ' + label : '') + ']';
              parent.appendChild(span);
            } else {
              const ok = safeUrl(href);
              const holder = ok ? link(doc, ok, parent) : parent;
              inline(doc, holder, label, depth + 1);
            }
            i = j + 1 + m[1];
            continue;
          }
        }
      }
      if (c === '<') {
        const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i, i + 2000));
        if (m) { flush(); const a = link(doc, safeUrl(m[1]) || '#', parent); a.textContent = m[1]; i += m[0].length; continue; }
      }
      if ((c === 'h' || c === 'H') && (i === 0 || /[\s(]/.test(s[i - 1]))) {
        const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i, i + 2000));
        if (m) {
          let url = m[0].replace(/[.,;:!?)\]'"]+$/, '');
          if (safeUrl(url)) { flush(); const a = link(doc, safeUrl(url), parent); a.textContent = url; i += url.length; continue; }
        }
      }
      if (depth < MAX_DEPTH && (c === '*' || c === '_' || c === '~')) {
        let mark = '';
        if (s.startsWith('**', i) || s.startsWith('__', i) || s.startsWith('~~', i)) mark = c + c;
        else if (c !== '~') mark = c;
        const intraword = c === '_' && /[A-Za-z0-9]/.test(s[i - 1] || '');
        if (mark && !intraword && s[i + mark.length] && !/\s/.test(s[i + mark.length])) {
          const end = closer(s, i + mark.length, mark);
          if (end > i + mark.length) {
            flush();
            const tag = mark === '~~' ? 'del' : mark.length === 2 ? 'strong' : 'em';
            const el = doc.createElement(tag);
            inline(doc, el, s.slice(i + mark.length, end), depth + 1);
            parent.appendChild(el);
            i = end + mark.length;
            continue;
          }
        }
      }
      buf += c;
      i++;
    }
    flush();
  }

  // ---------- blocks ----------
  const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
  const RE_HEAD = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
  const RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const RE_QUOTE = /^ {0,3}>\s?(.*)$/;
  const RE_LIST = /^( {0,3})([-+*]|\d{1,9}[.)])(?:\s+(.*)|\s*)$/;
  const RE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function cells(line) {
    let t = line.trim();
    if (t[0] === '|') t = t.slice(1);
    if (t[t.length - 1] === '|' && t[t.length - 2] !== '\\') t = t.slice(0, -1);
    const out = [];
    let cur = '';
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
      if (t[i] === '`') { const e = t.indexOf('`', i + 1); if (e > 0) { cur += t.slice(i, e + 1); i = e; continue; } }
      if (t[i] === '|') { out.push(cur.trim()); cur = ''; continue; }
      cur += t[i];
    }
    out.push(cur.trim());
    return out;
  }

  function startsBlock(line, afterParagraph) {
    if (RE_FENCE.test(line) || RE_HEAD.test(line) || RE_HR.test(line) || RE_QUOTE.test(line)) return true;
    const m = RE_LIST.exec(line);
    if (m && m[3] !== undefined && (!afterParagraph || /^[-+*]$/.test(m[2]) || /^1[.)]$/.test(m[2]))) return true;
    return false;
  }

  function blocks(doc, parent, lines, depth) {
    let i = 0;
    const n = lines.length;
    const blank = (l) => !/\S/.test(l);
    while (i < n) {
      let line = lines[i];
      if (blank(line)) { i++; continue; }

      let m = RE_FENCE.exec(line);
      if (m) {
        const fence = m[1];
        const indent = /^ */.exec(line)[0].length;
        const body = [];
        i++;
        while (i < n && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && /^\s*[`~]+\s*$/.test(lines[i]))) { body.push(lines[i].replace(new RegExp('^ {0,' + indent + '}'), '')); i++; }
        i++;
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        if (m[2]) code.setAttribute('data-lang', m[2].slice(0, 30));
        code.textContent = body.join('\n');
        pre.appendChild(code);
        parent.appendChild(pre);
        continue;
      }

      m = RE_HEAD.exec(line);
      if (m) {
        const h = doc.createElement('h' + m[1].length);
        inline(doc, h, m[2] || '', 0);
        parent.appendChild(h);
        i++;
        continue;
      }

      if (RE_HR.test(line)) { parent.appendChild(doc.createElement('hr')); i++; continue; }

      if (RE_QUOTE.test(line)) {
        const inner = [];
        while (i < n && !blank(lines[i])) {
          const q = RE_QUOTE.exec(lines[i]);
          if (q) inner.push(q[1]);
          else if (startsBlock(lines[i], true)) break;
          else inner.push(lines[i]); // lazy continuation of a quoted paragraph
          i++;
        }
        const bq = doc.createElement('blockquote');
        if (depth < MAX_DEPTH) blocks(doc, bq, inner, depth + 1); else bq.textContent = inner.join('\n');
        parent.appendChild(bq);
        continue;
      }

      m = RE_LIST.exec(line);
      if (m && m[3] !== undefined) {
        const ordered = /\d/.test(m[2]);
        const list = doc.createElement(ordered ? 'ol' : 'ul');
        if (ordered && parseInt(m[2], 10) !== 1) list.setAttribute('start', String(Math.min(parseInt(m[2], 10), 999999999)));
        const bulletKind = m[2].slice(-1);
        while (i < n) {
          const lm = RE_LIST.exec(lines[i]);
          if (!lm || lm[3] === undefined || /\d/.test(lm[2]) !== ordered || (ordered ? lm[2].slice(-1) : lm[2]) !== (ordered ? bulletKind : m[2])) break;
          const markWidth = lm[1].length + lm[2].length + 1;
          const item = [lm[3] || ''];
          i++;
          while (i < n) {
            const l = lines[i];
            if (blank(l)) {
              // a blank line ends the item unless the next non-blank line is indented under it
              let k = i;
              while (k < n && blank(lines[k])) k++;
              if (k < n && /^ +/.test(lines[k]) && /^ */.exec(lines[k])[0].length >= markWidth) { item.push(''); i++; continue; }
              break;
            }
            const ind = /^ */.exec(l)[0].length;
            if (ind >= markWidth) { item.push(l.slice(markWidth)); i++; continue; }
            if (startsBlock(l, true) || RE_LIST.test(l)) break;
            item.push(l.trim()); // lazy continuation
            i++;
          }
          const li = doc.createElement('li');
          let first = item[0];
          const task = /^\[([ xX])\]\s+/.exec(first);
          if (task) {
            const box = doc.createElement('input');
            box.setAttribute('type', 'checkbox');
            box.setAttribute('disabled', '');
            if (task[1] !== ' ') box.setAttribute('checked', '');
            li.appendChild(box);
            item[0] = first.slice(task[0].length);
          }
          const tight = !item.some((x) => x === '') || item.every((x, idx) => x !== '' || idx === item.length - 1);
          const holder = doc.createElement('div');
          if (depth < MAX_DEPTH) blocks(doc, holder, item, depth + 1); else holder.textContent = item.join('\n');
          // a one-paragraph item shows its text directly so list rows stay compact
          if (tight && holder.children.length && holder.firstElementChild.tagName === 'P') {
            const p = holder.firstElementChild;
            while (p.firstChild) li.appendChild(p.firstChild);
            p.remove();
          }
          while (holder.firstChild) li.appendChild(holder.firstChild);
          list.appendChild(li);
          while (i < n && blank(lines[i]) && i + 1 < n && RE_LIST.test(lines[i + 1])) i++;
        }
        parent.appendChild(list);
        continue;
      }

      // table: a header row followed by a separator row
      if (line.indexOf('|') >= 0 && i + 1 < n && RE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0 && cells(lines[i + 1]).length === cells(line).length) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''));
        const table = doc.createElement('table');
        const thead = doc.createElement('thead');
        const tr = doc.createElement('tr');
        head.forEach((c, k) => { const th = doc.createElement('th'); if (align[k]) th.style.textAlign = align[k]; inline(doc, th, c, 0); tr.appendChild(th); });
        thead.appendChild(tr);
        table.appendChild(thead);
        const tbody = doc.createElement('tbody');
        i += 2;
        while (i < n && !blank(lines[i]) && lines[i].indexOf('|') >= 0 && !startsBlock(lines[i], true)) {
          const row = cells(lines[i]);
          const r = doc.createElement('tr');
          for (let k = 0; k < head.length; k++) { const td = doc.createElement('td'); if (align[k]) td.style.textAlign = align[k]; inline(doc, td, row[k] || '', 0); r.appendChild(td); }
          tbody.appendChild(r);
          i++;
        }
        table.appendChild(tbody);
        parent.appendChild(table);
        continue;
      }

      // indented code (only when it starts a block)
      if (/^( {4}|\t)/.test(line)) {
        const body = [];
        while (i < n && (blank(lines[i]) || /^( {4}|\t)/.test(lines[i]))) { body.push(lines[i].replace(/^( {4}|\t)/, '')); i++; }
        while (body.length && !body[body.length - 1].trim()) body.pop();
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        code.textContent = body.join('\n');
        pre.appendChild(code);
        parent.appendChild(pre);
        continue;
      }

      // paragraph (a line of === or --- underneath makes it a heading)
      const para = [line];
      i++;
      let level = 0;
      while (i < n && !blank(lines[i])) {
        if (/^ {0,3}=+\s*$/.test(lines[i])) { level = 1; i++; break; }
        if (/^ {0,3}-+\s*$/.test(lines[i])) { level = 2; i++; break; }
        if (startsBlock(lines[i], true)) break;
        para.push(lines[i]);
        i++;
      }
      const el = doc.createElement(level ? 'h' + level : 'p');
      inline(doc, el, para.map((l) => l.replace(/^\s+/, '')).join('\n').replace(/\s+$/, ''), 0);
      parent.appendChild(el);
    }
  }

  // Renders Markdown text into a new <div class="dck-md">. Returns null when the text is too long to preview.
  function render(doc, src) {
    const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    if (text.length > MAX_CHARS) return null;
    const root = doc.createElement('div');
    root.className = 'dck-md';
    try {
      blocks(doc, root, text.split('\n'), 0);
    } catch (e) {
      const pre = doc.createElement('pre');
      pre.textContent = text; // never show nothing: fall back to the source as plain text
      root.textContent = '';
      root.appendChild(pre);
    }
    return root;
  }

  const api = { render, safeUrl, MAX_CHARS };
  if (typeof globalThis !== 'undefined') globalThis.DCK_MD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
