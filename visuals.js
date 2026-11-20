/* DeepSeek Kit - inline visuals: a small SVG chart renderer and the document for sandboxed widgets.
 * Pure rendering code. It never touches the network; content.js decides where cards go.
 * Loaded after lib.js and site.js; exposes globalThis.DCK_VIS (module.exports under Node). */
(function () {
  'use strict';

  const CHART_TYPES = ['bar', 'line', 'area', 'scatter', 'pie', 'donut'];
  const MAX_SERIES = 12;
  const MAX_POINTS = 500;
  const MAX_CHART_CHARS = 256 * 1024; // checked before JSON.parse so a huge block cannot freeze the tab
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------- chart spec

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  // Reads the JSON the model wrote. Tolerates a stray code fence, comments-free trailing commas and extra text around
  // the object. Returns { ok: true, spec } or { ok: false, error }.
  function parseChartSpec(text) {
    let raw = String(text == null ? '' : text).trim();
    if (raw.length > MAX_CHART_CHARS) return { ok: false, error: 'The chart is too large (over ' + (MAX_CHART_CHARS / 1024) + ' KB)' };
    raw = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    let obj = null;
    const attempts = [raw, raw.replace(/,\s*([}\]])/g, '$1')];
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) attempts.push(raw.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1'));
    for (let i = 0; i < attempts.length && obj === null; i++) {
      try { obj = JSON.parse(attempts[i]); } catch (e) { obj = null; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'The chart is not valid JSON' };
    const type = String(obj.type || 'bar').toLowerCase();
    if (CHART_TYPES.indexOf(type) < 0) return { ok: false, error: 'Unknown chart type "' + type + '" (use ' + CHART_TYPES.join(', ') + ')' };
    if (!Array.isArray(obj.series) || !obj.series.length) return { ok: false, error: 'The chart has no "series"' };
    if (obj.series.length > MAX_SERIES) return { ok: false, error: 'Too many series (max ' + MAX_SERIES + ')' };
    const spec = {
      type: type,
      title: String(obj.title || ''),
      subtitle: String(obj.subtitle || ''),
      xTitle: String(obj.xTitle || ''),
      yTitle: String(obj.yTitle || ''),
      unit: String(obj.unit || ''),
      stacked: !!obj.stacked,
      labels: [],
      series: [],
    };
    if (type === 'scatter') {
      spec.series = obj.series.map((s, i) => {
        const pts = [];
        (Array.isArray(s && s.points) ? s.points : []).forEach((p) => {
          const x = num(Array.isArray(p) ? p[0] : p && p.x);
          const y = num(Array.isArray(p) ? p[1] : p && p.y);
          if (x !== null && y !== null) pts.push([x, y]);
        });
        return { name: String((s && s.name) || 'Series ' + (i + 1)), points: pts };
      });
      const total = spec.series.reduce((n, s) => n + s.points.length, 0);
      if (!total) return { ok: false, error: 'The scatter chart has no numeric points (use series[].points as [[x, y], ...])' };
      if (spec.series.some((s) => s.points.length > MAX_POINTS)) return { ok: false, error: 'Too many points (max ' + MAX_POINTS + ' per series)' };
      return { ok: true, spec: spec };
    }
    let n = 0;
    spec.series = obj.series.map((s, i) => {
      const vals = (Array.isArray(s && s.values) ? s.values : []).map(num);
      n = Math.max(n, vals.length);
      return { name: String((s && s.name) || 'Series ' + (i + 1)), values: vals };
    });
    if (!n || !spec.series.some((s) => s.values.some((v) => v !== null))) return { ok: false, error: 'The chart has no numeric "values"' };
    if (n > MAX_POINTS) return { ok: false, error: 'Too many values (max ' + MAX_POINTS + ')' };
    const labels = Array.isArray(obj.labels) ? obj.labels.map((l) => String(l)) : [];
    for (let i = 0; i < n; i++) if (labels[i] === undefined) labels[i] = String(i + 1);
    spec.labels = labels.slice(0, n);
    spec.series.forEach((s) => { while (s.values.length < n) s.values.push(null); });
    if (type === 'pie' || type === 'donut') {
      spec.series = [spec.series[0]];
      if (spec.series[0].values.some((v) => v !== null && v < 0)) return { ok: false, error: 'A pie chart cannot have negative values' };
      if (!spec.series[0].values.some((v) => v > 0)) return { ok: false, error: 'A pie chart needs at least one positive value' };
    }
    return { ok: true, spec: spec };
  }

  // ---------- numbers

  // A tidy axis: { min, max, step, ticks } covering [lo, hi] in about `target` steps.
  function niceScale(lo, hi, target) {
    target = target || 5;
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (lo === hi) { if (lo === 0) hi = 1; else { lo = Math.min(lo, 0); hi = Math.max(hi, 0); if (lo === hi) hi = lo + 1; } }
    const raw = (hi - lo) / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    const min = Math.floor(lo / step + 1e-9) * step;
    const max = Math.ceil(hi / step - 1e-9) * step;
    const ticks = [];
    for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v / step * 1e6) / 1e6 * step);
    return { min: min, max: max, step: step, ticks: ticks };
  }

  function formatNum(v, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '-';
    const a = Math.abs(v);
    let s;
    if (a >= 1e9) s = trim(v / 1e9) + 'B';
    else if (a >= 1e6) s = trim(v / 1e6) + 'M';
    else if (a >= 1e4) s = trim(v / 1e3) + 'k';
    else s = trim(v);
    return s + (unit ? (/^[%$]/.test(unit) ? unit : ' ' + unit) : '');
  }
  function trim(v) {
    const a = Math.abs(v);
    return String(Math.round(v * (a < 10 ? 100 : a < 100 ? 10 : 1)) / (a < 10 ? 100 : a < 100 ? 10 : 1));
  }
  function fullNum(v, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '-';
    return (Math.round(v * 1000) / 1000).toLocaleString('en-US') + (unit ? (/^[%$]/.test(unit) ? unit : ' ' + unit) : '');
  }

  // ---------- svg building

  function svgEl(doc, tag, attrs, text) {
    const n = doc.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach((k) => { if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, String(attrs[k])); });
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function htmlEl(doc, tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  const color = (i) => 'var(--v-c' + ((i % 6) + 1) + ')';
  const f1 = (n) => Math.round(n * 10) / 10;

  const W = 640;
  const H = 300;

  function cartesian(doc, spec) {
    const svg = svgEl(doc, 'svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'dck-csvg', role: 'img', 'aria-label': spec.title || 'Chart', preserveAspectRatio: 'xMidYMid meet' });
    const isScatter = spec.type === 'scatter';
    const isBar = spec.type === 'bar';
    const stacked = spec.stacked && (isBar || spec.type === 'area');
    const n = spec.labels.length;

    // value range
    let lo = Infinity;
    let hi = -Infinity;
    if (isScatter) {
      spec.series.forEach((s) => s.points.forEach((p) => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }));
    } else if (stacked) {
      for (let i = 0; i < n; i++) {
        let pos = 0;
        spec.series.forEach((s) => { pos += Math.max(0, s.values[i] || 0); });
        hi = Math.max(hi, pos); lo = Math.min(lo, 0);
      }
    } else {
      spec.series.forEach((s) => s.values.forEach((v) => { if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    const tight = spec.type === 'line' && lo > 0 && lo > hi * 0.5;
    if (!isScatter && !tight) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const yS = niceScale(lo, hi, 5);

    let xS = null;
    if (isScatter) {
      let xl = Infinity;
      let xh = -Infinity;
      spec.series.forEach((s) => s.points.forEach((p) => { xl = Math.min(xl, p[0]); xh = Math.max(xh, p[0]); }));
      xS = niceScale(xl, xh, 6);
    }

    const yLabels = yS.ticks.map((t) => formatNum(t, ''));
    const maxY = yLabels.reduce((m, s) => Math.max(m, s.length), 1);
    const left = Math.round(maxY * 6.6 + 14) + (spec.yTitle ? 16 : 0);
    const top = 10;
    const right = 14;
    const pw = W - left - right;
    // Category labels: all of them if they fit, else tilted (up to 24 of them), else every few
    const maxLen = isScatter ? 0 : spec.labels.reduce((m, l) => Math.max(m, Math.min(l.length, 16)), 1);
    const flat = Math.max(1, Math.floor(pw / (maxLen * 6.4 + 10)));
    const tilt = !isScatter && n > flat && n <= 24;
    const every = isScatter || tilt ? 1 : Math.ceil(n / flat);
    const bottom = 26 + (tilt ? Math.round(maxLen * 3.4) : 0) + (spec.xTitle ? 16 : 0);
    const ph = H - top - bottom;
    const yPos = (v) => top + ph - (v - yS.min) / (yS.max - yS.min) * ph;
    const g = svgEl(doc, 'g');
    svg.appendChild(g);

    // grid and y ticks
    yS.ticks.forEach((t, i) => {
      const y = f1(yPos(t));
      g.appendChild(svgEl(doc, 'line', { x1: left, x2: left + pw, y1: y, y2: y, class: t === 0 ? 'dck-axis' : 'dck-grid' }));
      g.appendChild(svgEl(doc, 'text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'dck-tick' }, yLabels[i]));
    });
    if (spec.yTitle) {
      g.appendChild(svgEl(doc, 'text', { x: 12, y: top + ph / 2, 'text-anchor': 'middle', transform: 'rotate(-90 12 ' + f1(top + ph / 2) + ')', class: 'dck-atitle' }, spec.yTitle));
    }
    if (spec.xTitle) g.appendChild(svgEl(doc, 'text', { x: left + pw / 2, y: H - 4, 'text-anchor': 'middle', class: 'dck-atitle' }, spec.xTitle));

    const tipOf = (i) => {
      const lines = [spec.labels[i]];
      spec.series.forEach((s) => lines.push((spec.series.length > 1 ? s.name + ': ' : '') + fullNum(s.values[i], spec.unit)));
      return lines.join('\n');
    };

    if (isScatter) {
      const xPos = (v) => left + (v - xS.min) / (xS.max - xS.min) * pw;
      xS.ticks.forEach((t) => {
        const x = f1(xPos(t));
        g.appendChild(svgEl(doc, 'text', { x: x, y: top + ph + 17, 'text-anchor': 'middle', class: 'dck-tick' }, formatNum(t, '')));
      });
      spec.series.forEach((s, si) => {
        s.points.forEach((p) => {
          g.appendChild(svgEl(doc, 'circle', {
            cx: f1(xPos(p[0])), cy: f1(yPos(p[1])), r: 5, fill: color(si), 'fill-opacity': 0.75, class: 'dck-dot',
            'data-tip': (spec.series.length > 1 ? s.name + '\n' : '') + 'x: ' + fullNum(p[0], '') + '\ny: ' + fullNum(p[1], spec.unit),
          }));
        });
      });
      return svg;
    }

    // x labels (skip some when crowded)
    const band = pw / Math.max(1, n);
    const xMid = (i) => (isBar ? left + band * (i + 0.5) : n === 1 ? left + pw / 2 : left + pw * (i / (n - 1)));
    spec.labels.forEach((l, i) => {
      if (i % every) return;
      const txt = l.length > 16 ? l.slice(0, 15) + '...' : l;
      const lx = f1(xMid(i));
      g.appendChild(tilt
        ? svgEl(doc, 'text', { x: lx, y: top + ph + 14, 'text-anchor': 'end', transform: 'rotate(-35 ' + lx + ' ' + (top + ph + 14) + ')', class: 'dck-tick' }, txt)
        : svgEl(doc, 'text', { x: lx, y: top + ph + 17, 'text-anchor': 'middle', class: 'dck-tick' }, txt));
    });

    if (isBar) {
      const groupW = band * 0.72;
      const barW = stacked ? groupW : groupW / spec.series.length;
      for (let i = 0; i < n; i++) {
        let acc = 0;
        spec.series.forEach((s, si) => {
          const v = s.values[i];
          if (v === null) return;
          let y0;
          let y1;
          if (stacked) { y0 = yPos(acc); acc += Math.max(0, v); y1 = yPos(acc); } else { y0 = yPos(0); y1 = yPos(v); }
          const x = stacked ? xMid(i) - groupW / 2 : xMid(i) - groupW / 2 + si * barW;
          const top2 = Math.min(y0, y1);
          const hgt = Math.max(1, Math.abs(y0 - y1));
          g.appendChild(svgEl(doc, 'rect', { x: f1(x + (stacked ? 0 : 1)), y: f1(top2), width: f1(Math.max(1, barW - (stacked ? 0 : 2))), height: f1(hgt), rx: 3, fill: color(si), class: 'dck-bar' }));
        });
        g.appendChild(svgEl(doc, 'rect', { x: f1(left + band * i), y: top, width: f1(band), height: ph, fill: 'transparent', class: 'dck-hit', 'data-tip': tipOf(i) }));
      }
      return svg;
    }

    // line / area
    const acc = new Array(n).fill(0);
    spec.series.forEach((s, si) => {
      const ptsArr = [];
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v === null) { ptsArr.push(null); continue; }
        let y;
        if (stacked) { acc[i] += Math.max(0, v); y = yPos(acc[i]); } else y = yPos(v);
        ptsArr.push([xMid(i), y]);
      }
      let d = '';
      let pen = false;
      ptsArr.forEach((p) => { if (!p) { pen = false; return; } d += (pen ? 'L' : 'M') + f1(p[0]) + ' ' + f1(p[1]); pen = true; });
      if (spec.type === 'area') {
        const run = ptsArr.filter((p) => p);
        if (run.length > 1) {
          const base = yPos(Math.max(yS.min, 0));
          g.appendChild(svgEl(doc, 'path', { d: d + 'L' + f1(run[run.length - 1][0]) + ' ' + f1(base) + 'L' + f1(run[0][0]) + ' ' + f1(base) + 'Z', fill: color(si), 'fill-opacity': 0.16, stroke: 'none' }));
        }
      }
      g.appendChild(svgEl(doc, 'path', { d: d, fill: 'none', stroke: color(si), 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (n <= 40) ptsArr.forEach((p) => { if (p) g.appendChild(svgEl(doc, 'circle', { cx: f1(p[0]), cy: f1(p[1]), r: 3.5, fill: color(si), class: 'dck-pt' })); });
    });
    for (let i = 0; i < n; i++) {
      const x0 = n === 1 ? left : xMid(i) - (n === 1 ? pw : pw / (n - 1)) / 2;
      const w0 = n === 1 ? pw : pw / (n - 1);
      g.appendChild(svgEl(doc, 'rect', { x: f1(Math.max(left, x0)), y: top, width: f1(Math.min(w0, left + pw - Math.max(left, x0))), height: ph, fill: 'transparent', class: 'dck-hit', 'data-tip': tipOf(i) }));
    }
    return svg;
  }

  function pie(doc, spec) {
    const PH = 260;
    const svg = svgEl(doc, 'svg', { viewBox: '0 0 ' + W + ' ' + PH, class: 'dck-csvg', role: 'img', 'aria-label': spec.title || 'Chart', preserveAspectRatio: 'xMidYMid meet' });
    const vals = spec.series[0].values.map((v) => (v === null || v < 0 ? 0 : v));
    const total = vals.reduce((a, b) => a + b, 0);
    const cx = W / 2;
    const cy = PH / 2;
    const R = 112;
    const r = spec.type === 'donut' ? R * 0.6 : 0;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      if (v <= 0) return;
      const frac = v / total;
      const a1 = a0 + frac * Math.PI * 2;
      const tip = spec.labels[i] + '\n' + fullNum(v, spec.unit) + ' (' + Math.round(frac * 1000) / 10 + '%)';
      if (frac > 0.9999) {
        svg.appendChild(svgEl(doc, 'circle', { cx: cx, cy: cy, r: R, fill: color(i), class: 'dck-slice', 'data-tip': tip }));
        if (r) svg.appendChild(svgEl(doc, 'circle', { cx: cx, cy: cy, r: r, class: 'dck-hole' }));
      } else {
        const p = (a, rad) => f1(cx + Math.cos(a) * rad) + ' ' + f1(cy + Math.sin(a) * rad);
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const d = 'M' + p(a0, R) + 'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + p(a1, R) + (r ? 'L' + p(a1, r) + 'A' + r + ' ' + r + ' 0 ' + large + ' 0 ' + p(a0, r) + 'Z' : 'L' + cx + ' ' + cy + 'Z');
        svg.appendChild(svgEl(doc, 'path', { d: d, fill: color(i), class: 'dck-slice', 'data-tip': tip }));
      }
      a0 = a1;
    });
    return svg;
  }

  // The whole chart block: title, subtitle, svg, legend. Returns { el, svg }.
  function buildChart(doc, spec) {
    const el = htmlEl(doc, 'div', 'dck-chart');
    if (spec.title) el.appendChild(htmlEl(doc, 'div', 'dck-ctitle', spec.title));
    if (spec.subtitle) el.appendChild(htmlEl(doc, 'div', 'dck-csub', spec.subtitle));
    const wrap = htmlEl(doc, 'div', 'dck-cwrap');
    const svg = (spec.type === 'pie' || spec.type === 'donut') ? pie(doc, spec) : cartesian(doc, spec);
    wrap.appendChild(svg);
    const tip = htmlEl(doc, 'div', 'dck-tip');
    tip.style.display = 'none';
    wrap.appendChild(tip);
    wrap.addEventListener('pointermove', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t) { tip.style.display = 'none'; return; }
      tip.textContent = '';
      t.getAttribute('data-tip').split('\n').forEach((line, i) => tip.appendChild(htmlEl(doc, 'div', i ? 'dck-tipline' : 'dck-tiphead', line)));
      tip.style.display = 'block';
      const r = wrap.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      tip.style.left = Math.max(4, Math.min(r.width - tip.offsetWidth - 4, x + 12)) + 'px';
      tip.style.top = Math.max(4, y - tip.offsetHeight - 10) + 'px';
    });
    wrap.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
    el.appendChild(wrap);
    const pieLike = spec.type === 'pie' || spec.type === 'donut';
    if (pieLike || spec.series.length > 1) {
      const legend = htmlEl(doc, 'div', 'dck-legend');
      const items = pieLike ? spec.labels : spec.series.map((s) => s.name);
      const total = pieLike ? spec.series[0].values.reduce((a, v) => a + (v > 0 ? v : 0), 0) : 0;
      items.forEach((name, i) => {
        const it = htmlEl(doc, 'span', 'dck-legitem');
        const sw = htmlEl(doc, 'span', 'dck-swatch');
        sw.style.background = color(i);
        it.appendChild(sw);
        let label = name;
        if (pieLike && total > 0 && spec.series[0].values[i] > 0) {
          const pct = spec.series[0].values[i] / total * 100;
          label += pct < 0.1 ? ' <0.1%' : ' ' + Math.round(pct * 10) / 10 + '%';
        }
        it.appendChild(doc.createTextNode(label));
        legend.appendChild(it);
      });
      el.appendChild(legend);
    }
    return { el: el, svg: svg };
  }

  // The chart's svg as a standalone string with the page's colours written in (for Download).
  // `host` is an element inside the card, so its computed custom properties are the right ones.
  function svgToString(svg, host) {
    const cs = host.ownerDocument.defaultView.getComputedStyle(host);
    const clone = svg.cloneNode(true);
    const val = (name) => cs.getPropertyValue(name).trim() || '#888';
    const sub = (s) => String(s || '').replace(/var\((--[a-z0-9-]+)\)/g, (m, n) => val(n));
    const walk = (n) => {
      if (n.nodeType !== 1) return;
      ['fill', 'stroke'].forEach((a) => { if (n.hasAttribute(a)) n.setAttribute(a, sub(n.getAttribute(a))); });
      const cls = n.getAttribute('class') || '';
      if (cls === 'dck-grid') { n.setAttribute('stroke', val('--v-grid')); }
      else if (cls === 'dck-axis') { n.setAttribute('stroke', val('--v-axis')); }
      else if (cls === 'dck-tick' || cls === 'dck-atitle') { n.setAttribute('fill', val('--v-muted')); n.setAttribute('font-size', '11'); n.setAttribute('font-family', 'sans-serif'); }
      else if (cls === 'dck-hole') { n.setAttribute('fill', val('--v-bg')); }
      else if (cls === 'dck-hit') { n.remove(); return; }
      Array.prototype.slice.call(n.childNodes).forEach(walk);
    };
    walk(clone);
    clone.setAttribute('xmlns', SVG_NS);
    const bg = svgEl(clone.ownerDocument, 'rect', { x: 0, y: 0, width: '100%', height: '100%', fill: val('--v-bg') });
    clone.insertBefore(bg, clone.firstChild);
    return new host.ownerDocument.defaultView.XMLSerializer().serializeToString(clone);
  }

  // ---------- widgets

  // Fetches and embedded resources are denied. The iframe sandbox blocks popups and navigation out of the frame,
  // but browsers still permit a document to navigate itself; CSP has no portable directive for that case.
  const CSP = "default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

  function widgetCss(t) {
    return ':root{--v-bg:transparent;--v-text:' + t.text + ';--v-muted:' + t.muted + ';--v-border:' + t.border + ';--v-surface:' + t.surface + ';--v-accent:' + t.accent + ';--v-radius:12px;color-scheme:' + (t.dark ? 'dark' : 'light') + '}' +
      'html,body{margin:0}body{padding:12px;background:transparent;color:var(--v-text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-x:hidden}' +
      '.v-card{background:var(--v-surface);border:1px solid var(--v-border);border-radius:var(--v-radius);padding:14px 16px}' +
      '.v-title{font-size:15px;font-weight:600;margin:0 0 10px}.v-label{font-size:12px;color:var(--v-muted)}' +
      '.v-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.v-control-group{display:flex;flex-direction:column;gap:8px;margin-top:12px}' +
      '.v-stat{font:600 13px ui-monospace,Menlo,Consolas,monospace;background:rgba(77,107,254,.14);color:var(--v-accent);padding:2px 8px;border-radius:6px}' +
      'button,.v-btn{font:inherit;font-weight:500;background:var(--v-accent);color:#fff;border:0;border-radius:8px;padding:7px 14px;cursor:pointer}' +
      'button:hover{filter:brightness(1.1)}.v-btn-outline{background:transparent;color:var(--v-accent);border:1px solid var(--v-accent)}' +
      'input[type=text],input[type=number],select,textarea{font:inherit;color:var(--v-text);background:var(--v-surface);border:1px solid var(--v-border);border-radius:8px;padding:6px 10px}' +
      'input[type=range]{accent-color:var(--v-accent);width:100%}input[type=checkbox]{accent-color:var(--v-accent)}' +
      'canvas{max-width:100%}pre,code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}';
  }

  function widgetScripts(id) {
    return '<script>(function(){var ID=' + JSON.stringify(String(id)).replace(/</g, '\\u003c') + ',last=0;' +
      'function post(m){try{parent.postMessage(m,"*")}catch(e){}}' +
      'function err(msg,stack){post({type:"DCK_VIS_ERROR",id:ID,message:String(msg||"Script error"),stack:stack?String(stack):""})}' +
      'addEventListener("error",function(e){err(e.message,e.error&&e.error.stack)});' +
      'addEventListener("unhandledrejection",function(e){var r=e.reason;err(r&&r.message?r.message:String(r||"Unhandled rejection"),r&&r.stack)});' +
      'function size(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h&&h!==last){last=h;post({type:"DCK_VIS_HEIGHT",id:ID,height:h})}}' +
      'addEventListener("load",function(){size();if(window.ResizeObserver)new ResizeObserver(size).observe(document.documentElement);setTimeout(size,250);setTimeout(size,1000)});' +
      '})();<\/script>';
  }

  // The srcdoc for a widget iframe: restricted resource loading, the Kit styles, an error and height reporter.
  // `theme` is { dark, text, muted, border, surface, accent }.
  function buildWidgetDocument(code, theme, id) {
    const body = String(code == null ? '' : code).trim();
    const head = '<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="' + CSP + '"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' + widgetCss(theme) + '</style>' + widgetScripts(id);
    if (/<html[\s>]/i.test(body)) {
      if (/<head[\s>]/i.test(body)) return body.replace(/<head[^>]*>/i, (m) => m + head);
      return body.replace(/<html[^>]*>/i, (m) => m + '<head>' + head + '</head>');
    }
    return '<!DOCTYPE html><html><head>' + head + '</head><body>' + body + '</body></html>';
  }

  const api = { CHART_TYPES, parseChartSpec, niceScale, formatNum, buildChart, svgToString, buildWidgetDocument, CSP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.DCK_VIS = api;
})();
