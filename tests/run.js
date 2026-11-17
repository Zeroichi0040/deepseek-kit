// One command for everything: node tests/run.js  (or: npm test)
const { spawnSync } = require('child_process');
const path = require('path');
const files = ['logic.test.js', 'site.test.js', 'visuals.test.js', 'markdown.test.js', 'ask.test.js', 'ui.test.js', 'hardening.test.js', 'refresh.test.js', 'e2e.test.js'];
let failed = [];
for (const f of files) {
  console.log('\n=== ' + f);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}
console.log('\n' + (failed.length ? 'FAILED: ' + failed.join(', ') : 'ALL TEST FILES PASSED'));
process.exit(failed.length ? 1 : 0);
