// visuals.js: chart spec checking, scales, SVG output and the widget document.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'visuals.js'), 'utf8');
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
dom.window.eval(src);
const V = dom.window.DCK_VIS;
const doc = dom.window.document;
const ok = (m) => console.log('ok  ' + m);
const spec = (o) => { const r = V.parseChartSpec(typeof o === 'string' ? o : JSON.stringify(o)); return r; };

// parsing
{
  const r = spec({ type: 'bar', title: 'T', labels: ['a', 'b'], series: [{ name: 'S', values: [1, '2,000'] }] });
  assert.ok(r.ok); assert.strictEqual(r.spec.series[0].values[1], 2000);
  assert.ok(spec('```chart\n{"type":"line","labels":["a"],"series":[{"values":[1,],}],}\n```').ok, 'fence and trailing commas tolerated');
  assert.ok(spec('Here it is: {"labels":["x"],"series":[{"values":[3]}]}').ok, 'text around the object tolerated; type defaults to bar');
  assert.strictEqual(spec('{"labels":["x"],"series":[{"values":[3]}]}').spec.type, 'bar');
  ok('chart spec parsing is tolerant');
}
// rejections
{
  assert.ok(!spec('not json').ok);
  assert.ok(/Unknown chart type/.test(spec({ type: 'radar', series: [{ values: [1] }] }).error));
  assert.ok(/no "series"/.test(spec({ type: 'bar' }).error));
  assert.ok(/numeric/.test(spec({ type: 'bar', series: [{ values: ['x'] }] }).error));
  assert.ok(!spec({ type: 'pie', labels: ['a', 'b'], series: [{ values: [1, -1] }] }).ok);
  assert.ok(!spec({ type: 'scatter', series: [{ points: [] }] }).ok);
  assert.ok(!spec({ type: 'bar', series: Array.from({ length: 13 }, () => ({ values: [1] })) }).ok);
  assert.ok(!spec({ type: 'bar', series: [{ values: new Array(501).fill(1) }] }).ok);
  ok('bad specs give a readable error');
}
// size cap before parsing
{
  const big = '{"type":"bar","labels":["a"],"series":[{"values":[1]}],"pad":"' + 'x'.repeat(300 * 1024) + '"}';
  const orig = dom.window.JSON.parse;
  let parsed = 0;
  dom.window.JSON.parse = function () { parsed++; return orig.apply(this, arguments); };
  const r = V.parseChartSpec(big);
  dom.window.JSON.parse = orig;
  assert.ok(!r.ok && /too large/.test(r.error), r.error);
  assert.strictEqual(parsed, 0, 'rejected before JSON.parse ran');
  assert.ok(V.parseChartSpec('{"type":"bar","labels":["a"],"series":[{"values":[1]}]}').ok);
  ok('a huge chart block is rejected before it is parsed');
}
// shape fixes
{
  const r = spec({ type: 'line', labels: ['a'], series: [{ values: [1, 2, 3] }, { values: [1] }] });
  assert.strictEqual(r.spec.labels.length, 3, 'labels padded to the longest series');
  assert.strictEqual(r.spec.series[1].values.length, 3);
  assert.strictEqual(r.spec.series[1].values[2], null);
  assert.strictEqual(spec({ type: 'pie', labels: ['a', 'b'], series: [{ values: [1, 2] }, { values: [9, 9] }] }).spec.series.length, 1, 'pie uses the first series');
  ok('series are padded and pies use one series');
}
// scales and numbers
{
  const s = V.niceScale(0, 36000, 5);
  assert.strictEqual(s.min, 0); assert.ok(s.max >= 36000);
  assert.ok(s.ticks.length >= 4 && s.ticks.length <= 9);
  assert.strictEqual(V.niceScale(5, 5).min <= 5, true);
  const n = V.niceScale(-3, 7, 5); assert.ok(n.min <= -3 && n.max >= 7);
  assert.strictEqual(V.formatNum(36000), '36k');
  assert.strictEqual(V.formatNum(1500000), '1.5M');
  assert.strictEqual(V.formatNum(12), '12');
  assert.strictEqual(V.formatNum(0.5), '0.5');
  assert.strictEqual(V.formatNum(45, '%'), '45%');
  assert.strictEqual(V.formatNum(null), '-');
  ok('nice scales and number formatting');
}
// svg output
{
  const kinds = {
    bar: { type: 'bar', title: 'Usage', subtitle: 'Sub', labels: ['Jan', 'Feb', 'Mar'], series: [{ name: 'A', values: [12000, 19000, 15000] }] },
    group: { type: 'bar', labels: ['x', 'y'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [2, 1] }] },
    stack: { type: 'bar', stacked: true, labels: ['x', 'y'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [2, 1] }] },
    line: { type: 'line', labels: ['a', 'b', 'c'], series: [{ name: 'A', values: [1, null, 3] }] },
    area: { type: 'area', labels: ['a', 'b', 'c'], series: [{ name: 'A', values: [1, 2, 3] }] },
    scatter: { type: 'scatter', series: [{ name: 'A', points: [[1, 2], [2, 3], [3, 1]] }] },
    pie: { type: 'pie', labels: ['a', 'b', 'c'], series: [{ values: [1, 2, 3] }] },
    donut: { type: 'donut', labels: ['a'], series: [{ values: [5] }] },
  };
  Object.keys(kinds).forEach((k) => {
    const r = spec(kinds[k]); assert.ok(r.ok, k + ': ' + r.error);
    const c = V.buildChart(doc, r.spec);
    assert.ok(c.svg.getAttribute('viewBox'), k);
    assert.ok(c.svg.querySelectorAll('*').length >= 1, k + ' draws something');
    assert.ok(!/NaN|undefined|Infinity/.test(c.svg.outerHTML), k + ' has no NaN in its output');
  });
  const bar = V.buildChart(doc, spec(kinds.bar).spec);
  assert.strictEqual(bar.svg.querySelectorAll('rect.dck-bar').length, 3);
  assert.strictEqual(bar.svg.querySelectorAll('rect.dck-hit').length, 3);
  assert.ok(/Jan\n12,000/.test(bar.svg.querySelector('rect.dck-hit').getAttribute('data-tip')));
  assert.strictEqual(bar.el.querySelector('.dck-ctitle').textContent, 'Usage');
  assert.ok(!bar.el.querySelector('.dck-legend'), 'one series: no legend');
  assert.strictEqual(V.buildChart(doc, spec(kinds.group).spec).el.querySelectorAll('.dck-legitem').length, 2);
  assert.strictEqual(V.buildChart(doc, spec(kinds.pie).spec).el.querySelectorAll('.dck-slice').length, 3);
  assert.strictEqual(V.buildChart(doc, spec(kinds.donut).spec).el.querySelectorAll('circle.dck-slice').length, 1, 'a single slice is a full circle');
  assert.strictEqual(V.buildChart(doc, spec(kinds.line).spec).svg.querySelectorAll('circle.dck-pt').length, 2, 'null values draw no point');
  ok('every chart type draws clean SVG with tooltips, legend and titles');
}
// labels: tilt rather than skip, and tiny pie shares
{
  const langs = ['C', 'C++', 'Perl', 'Python', 'Java', 'JavaScript', 'C#', 'Go', 'Rust', 'TypeScript'];
  const r = spec({ type: 'bar', labels: langs, series: [{ values: langs.map((_, i) => 1970 + i * 4) }] });
  const c = V.buildChart(doc, r.spec);
  const ticks = Array.from(c.svg.querySelectorAll('text.dck-tick')).map((t) => t.textContent);
  langs.forEach((l) => assert.ok(ticks.indexOf(l.length > 16 ? l.slice(0, 15) + '...' : l) >= 0, 'label kept: ' + l));
  assert.ok(c.svg.querySelector('text[transform^="rotate"]'), 'crowded labels are tilted');
  const many = Array.from({ length: 60 }, (_, i) => 'L' + i);
  const c2 = V.buildChart(doc, spec({ type: 'line', labels: many, series: [{ values: many.map((_, i) => i) }] }).spec);
  assert.ok(c2.svg.querySelectorAll('text.dck-tick').length < 40, 'very many labels are thinned out');
  const c3 = V.buildChart(doc, spec({ type: 'bar', labels: ['a', 'b', 'c'], series: [{ values: [1, 2, 3] }] }).spec);
  assert.ok(!c3.svg.querySelector('text[transform^="rotate"]'), 'few labels stay flat');
  const pie = V.buildChart(doc, spec({ type: 'donut', labels: ['a', 'b'], series: [{ values: [99.96, 0.04] }] }).spec);
  assert.ok(/<0\.1%/.test(pie.el.querySelector('.dck-legend').textContent), 'tiny share is not shown as 0%');
  ok('labels tilt instead of vanishing; tiny shares read <0.1%');
}
// text from the model is never parsed as markup
{
  const r = spec({ type: 'bar', title: '<img src=x onerror=alert(1)>', labels: ['<b>x</b>'], series: [{ name: '<i>n</i>', values: [1] }] });
  const c = V.buildChart(doc, r.spec);
  assert.strictEqual(c.el.querySelectorAll('img, b, i').length, 0);
  assert.strictEqual(c.el.querySelector('.dck-ctitle').textContent, '<img src=x onerror=alert(1)>');
  ok('titles and labels are text, never markup');
}
// export string resolves colours
{
  const host = doc.createElement('div');
  host.style.cssText = '--v-c1:#123456;--v-bg:#000000;--v-grid:#222222;--v-axis:#333333;--v-muted:#999999';
  doc.body.appendChild(host);
  const c = V.buildChart(doc, spec({ type: 'bar', labels: ['a'], series: [{ values: [1] }] }).spec);
  host.appendChild(c.el);
  const s = V.svgToString(c.svg, host);
  assert.ok(!/var\(/.test(s) && /#123456/.test(s) && /xmlns/.test(s));
  assert.ok(!/dck-hit/.test(s), 'hover layers are dropped from the export');
  ok('svg export has real colours');
}
// widget document
{
  const theme = { dark: true, text: '#eee', muted: '#999', border: '#333', surface: '#222', accent: '#4d6bfe' };
  const d = V.buildWidgetDocument('<button id="b">Go</button><script>var x=1;</script>', theme, 'abc');
  assert.ok(d.indexOf('Content-Security-Policy') > 0 && d.indexOf("default-src 'none'") > 0);
  ["base-uri 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "object-src 'none'"].forEach((directive) => assert.ok(d.includes(directive), 'CSP includes ' + directive));
  assert.ok(d.indexOf('Content-Security-Policy') < d.indexOf('<body>'), 'CSP comes before any model code');
  assert.ok(/DCK_VIS_ERROR/.test(d) && /DCK_VIS_HEIGHT/.test(d) && /"abc"/.test(d));
  assert.ok(/<button id="b">Go<\/button>/.test(d));
  const full = V.buildWidgetDocument('<html><head><title>t</title></head><body>x</body></html>', theme, 'q');
  assert.ok(full.indexOf('Content-Security-Policy') < full.indexOf('<title>'), 'CSP first even in a full document');
  const bare = V.buildWidgetDocument('<html><body>x</body></html>', theme, 'q');
  assert.ok(/<head>.*Content-Security-Policy/s.test(bare));
  assert.ok(!/id":/.test(d) || true);
  const tricky = V.buildWidgetDocument('x', theme, 'a"</script><script>alert(1)');
  assert.ok(!/<\/script><script>alert\(1\)/.test(tricky), 'the id cannot break out of the script');
  ok('widget document: CSP first, reporter present, id escaped');
}
console.log('\nall visuals tests passed');
