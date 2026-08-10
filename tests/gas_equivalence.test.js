/**
 * Apps Script equivalence + split-cache regression test
 * ------------------------------------------------------
 * Run:  node tests/gas_equivalence.test.js
 *
 * v19 deliberately sends fewer columns than v17, so the payloads are NOT
 * byte-identical any more. The test therefore asserts something stronger:
 * feed both payloads through the dashboard's REAL transformReportData()
 * and require the resulting rows to be byte-identical. That is the thing
 * users actually see.
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

const BASE_INPUT = parseCSV(fs.readFileSync(path.join(REPO, 'for ref/Demech_CBDR - Input Level Data.csv'), 'utf8'));
const BASE_SHIFT = parseCSV(fs.readFileSync(path.join(REPO, 'for ref/Demech_CBDR - Shift Level Data.csv'), 'utf8'));

function freshSheets(inputGrid) {
  return {
    'Input Level Data': inputGrid || BASE_INPUT.map(r => r.slice()),
    'Shift Level Data': BASE_SHIFT.map(r => r.slice()),
    'Pipe Master': [['Unique Pipe Size'], ['P_489*500*20'], ['P_436*500*20']],
    'Day Level Data': [['Date', 'Furnace Num', 'Electricity Consumption'], ['27-03-2026', 'F2', '1200']],
    'Users': [['Email', 'Name', 'Role'], ['a@demechindia.com', 'A Person', 'Admin']],
  };
}

function makeSandbox(sheets) {
  const store = new Map();
  const stats = { cells: 0, calls: 0 };

  const lastRowOf = (g) => {
    for (let i = g.length - 1; i >= 0; i--) if (g[i].some(v => v !== '' && v !== undefined)) return i + 1;
    return 0;
  };
  const lastColOf = (g) => g.reduce((m, r) => {
    for (let j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] !== undefined) return Math.max(m, j + 1);
    return m;
  }, 0);

  function makeSheet(grid) {
    const lr = lastRowOf(grid), lc = lastColOf(grid);
    const slice = (r, c, nr, nc) => {
      stats.calls++; stats.cells += nr * nc;
      const out = [];
      for (let i = 0; i < nr; i++) {
        const src = grid[r - 1 + i] || [];
        const o = [];
        for (let j = 0; j < nc; j++) o.push(src[c - 1 + j] === undefined ? '' : src[c - 1 + j]);
        out.push(o);
      }
      return out;
    };
    return {
      getLastRow: () => lr,
      getLastColumn: () => lc,
      getMaxRows: () => grid.length,
      getDataRange: () => ({
        getDisplayValues: () => slice(1, 1, lr, lc),
        getValues: () => slice(1, 1, lr, lc),
      }),
      getRange: (r, c, nr, nc) => ({
        getDisplayValues: () => slice(r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc),
        setValue: () => {},
      }),
    };
  }

  return {
    stats, store,
    sandbox: {
      console,
      Logger: { log: () => {} },
      LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
      SpreadsheetApp: {
        getActiveSpreadsheet: () => ({ getSheetByName: (n) => (sheets[n] ? makeSheet(sheets[n]) : null) }),
      },
      CacheService: {
        getScriptCache: () => ({
          get: (k) => (store.has(k) ? store.get(k) : null),
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

/** Loads a script once; the returned ctx keeps its cache between calls. */
function load(scriptPath, sheets, overrides) {
  const ctx = makeSandbox(sheets);
  const context = vm.createContext(ctx.sandbox);
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context);
  if (overrides) Object.keys(overrides).forEach(k => { context[k] = overrides[k]; });
  ctx.call = (params) => vm.runInContext(
    '__R__ = doGet({parameter: ' + JSON.stringify(params) + '});__R__.getContent();', context);
  ctx.context = context;
  return ctx;
}

// --- the dashboard's real transform, for output comparison ---
const appCtx = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
  window: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, clear() {} },
  setInterval() {}, setTimeout() {}, fetch() {}, Chart: function () {},
});
vm.runInContext(fs.readFileSync(path.join(REPO, 'app.js'), 'utf8'), appCtx);

/** Mirrors app.js fetchSheetData: 2D payload -> array of row objects. */
function expand(payload) {
  const objs = payload.rows.map(arr => {
    const o = {};
    for (let i = 0; i < payload.headers.length; i++) o[payload.headers[i]] = arr[i];
    return o;
  });
  return appCtx.transformReportData(objs);
}
const norm = (d) => JSON.stringify(d, (k, v) => (v instanceof Set ? [...v] : v));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
}

console.log('\n=== 1. What the DASHBOARD sees is unchanged (v17 vs v19) ===');
{
  const a = JSON.parse(load(OLD, freshSheets()).call({ token: OLD_TOKEN, sheet: 'Input Level Data', format: '2d' })).data;
  const b = JSON.parse(load(NEW, freshSheets()).call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d' })).data;

  check(`v17 sends ${a.headers.length} columns, v19 sends ${b.headers.length}`,
    a.headers.length === 39 && b.headers.length === 27);
  check('same number of rows', a.rows.length === b.rows.length, `${a.rows.length} vs ${b.rows.length}`);
  check('TRANSFORMED OUTPUT BYTE-IDENTICAL', norm(expand(a)) === norm(expand(b)));
  check('payload is smaller', JSON.stringify(b).length < JSON.stringify(a).length,
    `${JSON.stringify(a).length} -> ${JSON.stringify(b).length} bytes ` +
    `(${(100 - JSON.stringify(b).length / JSON.stringify(a).length * 100).toFixed(0)}% smaller)`);

  for (const sheet of ['Shift Level Data', 'Pipe Master', 'Day Level Data']) {
    const x = load(OLD, freshSheets()).call({ token: OLD_TOKEN, sheet, format: '2d' });
    const y = load(NEW, freshSheets()).call({ token: NEW_TOKEN, sheet, format: '2d' });
    check(`"${sheet}" still byte-identical (untouched)`, x === y);
  }
}

console.log('\n=== 2. Split cache returns exactly what a full read returns ===');
{
  // Shrink the tail window so the 1,064-row sample exercises the split.
  const SPLIT = { TAIL_MIN: 50, TAIL_MAX: 200 };
  const ctx = load(NEW, freshSheets(), SPLIT);

  const first = ctx.call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d' });   // rebuild
  const cellsAfterBuild = ctx.stats.cells;

  const second = ctx.call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d', fresh: '1' }); // history + live tail
  const tailCells = ctx.stats.cells - cellsAfterBuild;

  check('split-cache result identical to full read', first === second);
  check(`tail read is far cheaper (${cellsAfterBuild} cells to build, ${tailCells} on the next request)`,
    tailCells < cellsAfterBuild / 4);

  const ref = JSON.parse(load(NEW, freshSheets()).call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d' })).data;
  check('rows match a cold uncached read', norm(JSON.parse(second).data.rows) === norm(ref.rows));
}

console.log('\n=== 3. Appending rows: new data appears without a rebuild ===');
{
  const SPLIT = { TAIL_MIN: 50, TAIL_MAX: 200 };
  const sheets = freshSheets();
  const ctx = load(NEW, sheets, SPLIT);
  ctx.call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d' });     // build history

  const width = sheets['Input Level Data'][0].length;
  const newRow = new Array(width).fill('');
  newRow[0] = 'BRANDNEW1'; newRow[6] = '09-08-2026'; newRow[8] = '99';
  sheets['Input Level Data'].push(newRow);

  const after = JSON.parse(ctx.call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d', fresh: '1' })).data;
  check('appended row is served immediately', JSON.stringify(after.rows).includes('BRANDNEW1'));
}

console.log('\n=== 4. Mid-sheet DELETE is detected and forces a rebuild ===');
{
  const SPLIT = { TAIL_MIN: 50, TAIL_MAX: 200 };
  const sheets = freshSheets();
  const ctx = load(NEW, sheets, SPLIT);
  ctx.call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d' });     // build history

  sheets['Input Level Data'].splice(500, 1);                                   // delete a middle row

  const after = JSON.parse(ctx.call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d', fresh: '1' })).data;
  const truth = JSON.parse(load(NEW, freshSheets(sheets['Input Level Data'].map(r => r.slice())))
    .call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d' })).data;

  check('result still correct after a mid-sheet delete', norm(after.rows) === norm(truth.rows));
  check('no duplicated or lost rows', after.rows.length === truth.rows.length,
    `${after.rows.length} vs ${truth.rows.length}`);
}

console.log('\n=== 5. Mid-sheet EDIT inside the frozen history ===');
{
  const SPLIT = { TAIL_MIN: 50, TAIL_MAX: 200 };
  const sheets = freshSheets();
  const ctx = load(NEW, sheets, SPLIT);
  ctx.call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d' });

  sheets['Input Level Data'][300][5] = 'EDITED_SUPERVISOR';                    // old row, deep in history

  const stale = JSON.parse(ctx.call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d', fresh: '1' })).data;
  check('KNOWN LIMITATION: old-row edit not visible until rebuild',
    !JSON.stringify(stale.rows).includes('EDITED_SUPERVISOR'));

  const rebuilt = JSON.parse(ctx.call({ token: NEW_TOKEN, sheet: 'Input Level Data', format: '2d', rebuild: '1' })).data;
  check('rebuild=1 picks the old-row edit up immediately',
    JSON.stringify(rebuilt.rows).includes('EDITED_SUPERVISOR'));
}

console.log('\n=== 6. Bundle matches the single-sheet payloads ===');
{
  const ctx = load(NEW, freshSheets());
  const bundle = JSON.parse(ctx.call({ token: NEW_TOKEN, action: 'bundle' }));
  for (const sheet of ['Input Level Data', 'Pipe Master', 'Shift Level Data', 'Day Level Data']) {
    const single = JSON.parse(load(NEW, freshSheets()).call({ token: NEW_TOKEN, sheet, format: '2d' })).data;
    check(`"${sheet}" matches`, norm(bundle.data[sheet]) === norm(single));
  }
  check('bundle reports timing', typeof bundle.ms === 'number');
}

console.log('\n=== 7. warmCache() only reads, and leaves a usable cache ===');
{
  const ctx = load(NEW, freshSheets());
  vm.runInContext('warmCache();', ctx.context);
  const cells = ctx.stats.cells;
  const after = ctx.call({ token: NEW_TOKEN, action: 'bundle' });
  check('warmCache populated the cache (next request read nothing)', ctx.stats.cells === cells);
  check('cached bundle is valid', JSON.parse(after).data['Input Level Data'].rows.length > 0);
}

console.log('\n=== 8. Security: sheet allowlist ===');
{
  const oldUsers = load(OLD, freshSheets()).call({ token: OLD_TOKEN, sheet: 'Users', format: '2d' });
  const newUsers = load(NEW, freshSheets()).call({ token: NEW_TOKEN, sheet: 'Users', format: '2d' });
  check('v17 baseline DID expose the Users sheet', oldUsers.includes('demechindia.com'));
  check('current refuses the Users sheet', newUsers === '{"error":"Sheet not found"}', newUsers.slice(0, 120));
  check('current leaks nothing in the refusal', !newUsers.includes('demechindia.com'));
}

console.log('\n=== 9. Token handling during rollout ===');
{
  const f = (tok) => load(NEW, freshSheets()).call({ token: tok, sheet: 'Pipe Master', format: '2d' });
  check('new token accepted', !f(NEW_TOKEN).includes('Unauthorized'));
  check('legacy token still accepted (live dashboard keeps working)', !f(OLD_TOKEN).includes('Unauthorized'));
  check('bad token rejected', f('wrong') === '{"error":"Unauthorized"}');
}

console.log('\n=== 10. verify branch unchanged ===');
{
  const pairs = [['a@demechindia.com', 'known user'], ['nobody@x.com', 'unknown user']];
  for (const [email, label] of pairs) {
    const a = load(OLD, freshSheets()).call({ token: OLD_TOKEN, action: 'verify', email });
    const b = load(NEW, freshSheets()).call({ token: NEW_TOKEN, action: 'verify', email });
    check(`${label}: identical response`, a === b, a + ' vs ' + b);
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
