/* Runs inside the sandboxed preview page (preview.html). No network access of its own. */
(function () {
  'use strict';
  var out = document.getElementById('out');
  var parentWin = window.parent;
  var mermaidLoading = null;
  var token = 0;

  function note(text, isErr) {
    out.className = 'pad';
    out.textContent = '';
    var d = document.createElement('div');
    if (isErr) d.className = 'err';
    d.textContent = text;
    out.appendChild(d);
  }

  function csp(allowExternal) {
    var ext = allowExternal ? ' https:' : '';
    return "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'" + ext +
      "; style-src 'unsafe-inline'" + ext + "; img-src data: blob:" + ext +
      "; font-src data:" + ext + "; media-src data: blob:" + ext + "; connect-src 'none'; form-action 'none'";
  }

  // Put a CSP meta first in <head>, so nothing in the page can run before the policy applies.
  function withPolicy(code, allowExternal) {
    var doc = new DOMParser().parseFromString(code, 'text/html');
    var meta = doc.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', csp(allowExternal));
    doc.head.insertBefore(meta, doc.head.firstChild);
    return '<!doctype html>' + doc.documentElement.outerHTML;
  }

  function showHtml(code, allowExternal) {
    out.className = '';
    out.textContent = '';
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-modals');
    f.srcdoc = withPolicy(code, allowExternal);
    out.appendChild(f);
  }

  function showSvg(code) {
    out.className = 'pad';
    out.textContent = '';
    var img = document.createElement('img');
    img.className = 'svg';
    img.alt = 'SVG preview';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(code);
    img.onerror = function () { note('This is not valid SVG.', true); };
    out.appendChild(img);
  }

  function showMarkdown(code) {
    out.className = 'pad';
    var html = DOMPurify.sanitize(marked.parse(code, { async: false }), { USE_PROFILES: { html: true } });
    out.innerHTML = html;
  }

  function loadMermaid() {
    if (window.mermaid) return Promise.resolve();
    if (!mermaidLoading) {
      mermaidLoading = new Promise(function (ok, bad) {
        var s = document.createElement('script');
        s.src = 'vendor/mermaid.min.js';
        s.onload = ok;
        s.onerror = function () { mermaidLoading = null; bad(new Error('Could not load the Mermaid library')); };
        document.head.appendChild(s);
      });
    }
    return mermaidLoading;
  }

  function showMermaid(code, dark, mine) {
    note('Rendering diagram...', false);
    loadMermaid().then(function () {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
      return window.mermaid.render('dck-m' + mine, code);
    }).then(function (res) {
      if (mine !== token) return;
      out.className = 'pad';
      out.innerHTML = res.svg;
    }).catch(function (e) {
      if (mine !== token) return;
      note(String((e && e.message) || e), true);
    });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== parentWin) return;
    var d = ev.data;
    if (!d || d.dck !== 'render' || typeof d.code !== 'string') return;
    token += 1;
    document.body.className = d.dark ? 'dark' : '';
    try {
      if (d.kind === 'html') showHtml(d.code, !!d.allowExternal);
      else if (d.kind === 'svg') showSvg(d.code);
      else if (d.kind === 'markdown') showMarkdown(d.code);
      else if (d.kind === 'mermaid') showMermaid(d.code, !!d.dark, token);
      else note('Nothing to preview for this block.', false);
    } catch (e) {
      note(String((e && e.message) || e), true);
    }
  });

  parentWin.postMessage({ dck: 'ready' }, '*');
})();
