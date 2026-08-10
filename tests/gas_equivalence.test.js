/**
 * Apps Script equivalence + cache regression test
 * ------------------------------------------------
 * Run:  node tests/gas_equivalence.test.js
 *
 * Purpose: prove that changes to google_apps_script.js do not change the
 * bytes the dashboard receives. The v17 baseline in tests/fixtures/ is the
 * version that was live and verified in production; it is pinned on purpose
 * and should not be updated casually.
 *
 * Runs entirely offline against the reference CSVs in "for ref/", inside a
 * mocked Apps Script environment. No network, no Google account needed.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.join(__dirname, '..');
const OLD = path.join(__dirname, 'fixtures', 'google_apps_script.v17.js');
const NEW = path.join(REPO, 'google_apps_script.js');

// Tokens are not secrets — they ship in client-side JS and are public by
// necessity. They appear here only so the harness can exercise both paths.
const OLD_TOKEN = 'demech_secure_2025';
const NEW_TOKEN = 'demech_qea97pror1_2026';

// --- minimal CSV -> grid of strings (mimics Range.getDisplayValues) ---
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const SHEETS = {
  'Input Level Data': parseCSV(fs.readFileSync(path.join(REPO, 'for ref/Demech_CBDR - Input Level Data.csv'), 'utf8')),
  'Shift Level Data': parseCSV(fs.readFileSync(path.join(REPO, 'for ref/Demech_CBDR - Shift Level Data.csv'), 'utf8')),
  'Pipe Master': [['Unique Pipe Size'], ['P_489*500*20'], ['P_436*500*20']],
  'Day Level Data': [['Date', 'Furnace Num', 'Electricity Consumption'], ['27-03-2026', 'F2', '1200']],
  'Users': [['Email', 'Name', 'Role'], ['a@demechindia.com', 'A Person', 'Admin']],
};

function makeSandbox() {
  const store = new Map();                       // CacheService backing store
  const stats = { reads: 0, cacheHits: 0, cacheMisses: 0 };

  function makeSheet(grid) {
    return {
      getDataRange: () => ({
        getDisplayValues: () => { stats.reads++; return grid; },
        getValues: () => { stats.reads++; return grid; },
      }),
      getLastRow: () => grid.length,
      getLastColumn: () => (grid[0] || []).length,
      getRange: () => ({ getDisplayValues: () => grid, setValue: () => {} }),
    };
  }

  return {
    stats, store,
    sandbox: {
      console,
      Logger: { log: () => {} },
      LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
      SpreadsheetApp: {
        getActiveSpreadsheet: () => ({
          getSheetByName: (n) => (SHEETS[n] ? makeSheet(SHEETS[n]) : null),
        }),
      },
      CacheService: {
        getScriptCache: () => ({
          get: (k) => { const v = store.has(k) ? store.get(k) : null; v ? stats.cacheHits++ : stats.cacheMisses++; return v; },
          getAll: (keys) => { const o = {}; keys.forEach(k => { if (store.has(k)) o[k] = store.get(k); }); return o; },
          put: (k, v) => store.set(k, v),
          putAll: (o) => Object.keys(o).forEach(k => store.set(k, o[k])),
        }),
      },
      ContentService: {
        MimeType: { JSON: 'application/json' },
        createTextOutput: (s) => ({ _body: s, setMimeType() { return this; }, getContent() { return this._body; } }),
      },
    },
  };
}

function run(scriptPath, params, ctx) {
  const code = fs.readFileSync(scriptPath, 'utf8');
  const context = vm.createContext(ctx.sandbox);
  vm.runInContext(code + '\n;__RESULT__ = doGet({parameter: ' + JSON.stringify(params) + '});', context);
  return context.__RESULT__.getContent();
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
}

console.log('\n=== 1. Payload equivalence: v17 format=2d vs current format=2d ===');
for (const sheet of ['Input Level Data', 'Shift Level Data', 'Pipe Master', 'Day Level Data']) {
  const a = run(OLD, { token: OLD_TOKEN, sheet, format: '2d' }, makeSandbox());
  const b = run(NEW, { token: NEW_TOKEN, sheet, format: '2d' }, makeSandbox());
  check(`"${sheet}" byte-identical (${a.length} bytes)`, a === b,
    a === b ? '' : 'first divergence at index ' + [...a].findIndex((c, i) => c !== b[i]));
}

console.log('\n=== 2. Bundle contains exactly the same per-sheet payloads ===');
{
  const ctx = makeSandbox();
  const bundle = JSON.parse(run(NEW, { token: NEW_TOKEN, action: 'bundle' }, ctx));
  for (const sheet of ['Input Level Data', 'Shift Level Data', 'Pipe Master', 'Day Level Data']) {
    const single = JSON.parse(run(OLD, { token: OLD_TOKEN, sheet, format: '2d' }, makeSandbox())).data;
    check(`"${sheet}" matches single-sheet payload`,
      JSON.stringify(bundle.data[sheet]) === JSON.stringify(single));
  }
  check('bundle reports timing', typeof bundle.ms === 'number');
}

console.log('\n=== 3. Cache: second call serves identical bytes without re-reading ===');
{
  const ctx = makeSandbox();
  const first = run(NEW, { token: NEW_TOKEN, action: 'bundle' }, ctx);
  const readsAfterFirst = ctx.stats.reads;
  const second = run(NEW, { token: NEW_TOKEN, action: 'bundle' }, ctx);
  check('identical row count on cache hit',
    JSON.parse(first).data['Input Level Data'].rows.length ===
    JSON.parse(second).data['Input Level Data'].rows.length);
  check(`zero sheet reads on 2nd call (1st call used ${readsAfterFirst})`,
    ctx.stats.reads === readsAfterFirst);
  check('payload was chunked across cache keys (>1 chunk)',
    [...ctx.store.keys()].filter(k => /Input_Level_Data_\d+$/.test(k)).length > 1);
}

console.log('\n=== 4. fresh=1 bypasses the cache ===');
{
  const ctx = makeSandbox();
  run(NEW, { token: NEW_TOKEN, action: 'bundle' }, ctx);
  const before = ctx.stats.reads;
  run(NEW, { token: NEW_TOKEN, action: 'bundle', fresh: '1' }, ctx);
  check(`fresh=1 re-read the sheets (+${ctx.stats.reads - before} reads)`, ctx.stats.reads > before);
}

console.log('\n=== 5. Partial cache eviction is treated as a miss, never partial data ===');
{
  const ctx = makeSandbox();
  const first = run(NEW, { token: NEW_TOKEN, action: 'bundle' }, ctx);
  const chunkKey = [...ctx.store.keys()].find(k => /Input_Level_Data_1$/.test(k));
  ctx.store.delete(chunkKey);                       // simulate eviction of one chunk
  const after = run(NEW, { token: NEW_TOKEN, action: 'bundle' }, ctx);
  check('recovers full payload after chunk eviction',
    first === after.replace(/"ms":\d+/, first.match(/"ms":\d+/)[0]));
}

console.log('\n=== 6. Security: sheet allowlist ===');
{
  const oldUsers = run(OLD, { token: OLD_TOKEN, sheet: 'Users', format: '2d' }, makeSandbox());
  const newUsers = run(NEW, { token: NEW_TOKEN, sheet: 'Users', format: '2d' }, makeSandbox());
  check('v17 baseline DID expose the Users sheet', oldUsers.includes('demechindia.com'));
  check('current refuses the Users sheet', newUsers === '{"error":"Sheet not found"}', newUsers.slice(0, 120));
  check('current leaks nothing in the refusal', !newUsers.includes('demechindia.com'));
}

console.log('\n=== 7. Token handling during rollout ===');
{
  const withNew = run(NEW, { token: NEW_TOKEN, sheet: 'Pipe Master', format: '2d' }, makeSandbox());
  const withOld = run(NEW, { token: OLD_TOKEN, sheet: 'Pipe Master', format: '2d' }, makeSandbox());
  const withBad = run(NEW, { token: 'wrong', sheet: 'Pipe Master', format: '2d' }, makeSandbox());
  check('new token accepted', !withNew.includes('Unauthorized'));
  check('legacy token still accepted (live dashboard keeps working)', !withOld.includes('Unauthorized'));
  check('bad token rejected', withBad === '{"error":"Unauthorized"}');
}

console.log('\n=== 8. verify branch unchanged ===');
{
  const a = run(OLD, { token: OLD_TOKEN, action: 'verify', email: 'a@demechindia.com' }, makeSandbox());
  const b = run(NEW, { token: NEW_TOKEN, action: 'verify', email: 'a@demechindia.com' }, makeSandbox());
  check('known user: identical response', a === b, a + ' vs ' + b);
  const c = run(OLD, { token: OLD_TOKEN, action: 'verify', email: 'nobody@x.com' }, makeSandbox());
  const d = run(NEW, { token: NEW_TOKEN, action: 'verify', email: 'nobody@x.com' }, makeSandbox());
  check('unknown user: identical response', c === d, c + ' vs ' + d);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
