/**
 * Frontend data-path regression test
 * -----------------------------------
 * Run:  node tests/frontend_dataflow.test.js
 *
 * Covers the parts of app.js that changed, without touching any of the
 * grouping, sorting or rendering code below transformReportData():
 *
 *   - expandSheet() reproduces exactly what the old per-sheet fetcher built
 *   - the v19 bundle produces the same dashboard rows as the v17 payload
 *   - signatureOf() notices a value changing inside an existing row, which
 *     is what the QC automation does when it backfills
 *   - populateFilterOptions() no longer wipes the user's filter selections
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.join(__dirname, '..');

// ---------- a tiny <select> good enough for populateFilterOptions ----------
function parseOptions(html) {
  const out = [];
  const re = /<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g;
  let m;
  while ((m = re.exec(html))) out.push({ value: m[1], label: m[2] });
  return out;
}
function fakeSelect() {
  return {
    _opts: [],
    value: 'all',
    writes: 0,   // how many times the DOM was actually rebuilt
    get innerHTML() { return this._opts.map(o => `<option value="${o.value}">${o.label}</option>`).join(''); },
    set innerHTML(v) {
      this.writes++;
      this._opts = parseOptions(v);
      // A real <select> resets to the first option when its contents are replaced.
      if (!this._opts.some(o => o.value === this.value)) this.value = this._opts.length ? this._opts[0].value : '';
    },
    get options() { return this._opts; },
  };
}

const selects = {
  filterSupervisor: fakeSelect(),
  filterQCName: fakeSelect(),
  filterPipeSize: fakeSelect(),
  filterTrolley: fakeSelect(),
};

const ctx = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  performance: { now: () => Date.now() },
  location: { search: '' },
  document: {
    getElementById: (id) => selects[id] || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => ({ style: {}, appendChild() {} }),
    addEventListener() {},
    body: { appendChild() {} },
    hidden: false,
  },
  window: {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, clear() {} },
  setInterval() {}, setTimeout() {}, fetch() {}, Chart: function () {},
});
// config.js declares the constants app.js expects
vm.runInContext(fs.readFileSync(path.join(REPO, 'config.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app.js'), 'utf8'), ctx);

// ---------- build v17-shaped and v19-shaped payloads from the reference CSV ----------
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const grid = parseCSV(fs.readFileSync(path.join(REPO, 'for ref/Demech_CBDR - Input Level Data.csv'), 'utf8'));
const allHeaders = grid[0];
const dataRows = grid.slice(1).filter(r => r.some(v => v !== ''));

const DROPPED = ['Date_Shift_Supervisor', 'Date_Shift_Supervisor_Helper', 'Lava Temp', 'Homo Temp',
  'TK Temp', 'Temp Eject', 'Air time', 'Pipe Size', 'Size_actual', 'Hour Cycle', 'Check', '% R'];
const keptIdx = allHeaders.map((h, i) => i).filter(i => !DROPPED.includes(allHeaders[i]));

const payloadV17 = { headers: allHeaders, rows: dataRows };
const payloadV19 = { headers: keptIdx.map(i => allHeaders[i]), rows: dataRows.map(r => keptIdx.map(i => r[i] || '')) };

const norm = (d) => JSON.stringify(d, (k, v) => (v instanceof Set ? [...v] : v));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
}

console.log('\n=== 1. expandSheet matches the old per-sheet expansion ===');
{
  // What app.js used to build inline, before the bundle change
  const legacy = payloadV17.rows.map(arr => {
    const o = {};
    for (let i = 0; i < payloadV17.headers.length; i++) o[payloadV17.headers[i]] = arr[i];
    return o;
  });
  check('identical row objects', norm(ctx.expandSheet(payloadV17)) === norm(legacy));
  check('empty payload yields []', norm(ctx.expandSheet(null)) === '[]');
  check('malformed payload yields []', norm(ctx.expandSheet({ headers: ['a'] })) === '[]');
}

console.log('\n=== 2. The 27-column bundle produces the same dashboard rows ===');
{
  const fromV17 = ctx.transformReportData(ctx.expandSheet(payloadV17));
  const fromV19 = ctx.transformReportData(ctx.expandSheet(payloadV19));
  check(`v17 ${payloadV17.headers.length} cols -> ${fromV17.length} rows, ` +
        `v19 ${payloadV19.headers.length} cols -> ${fromV19.length} rows`,
    fromV17.length === fromV19.length);
  check('TRANSFORMED OUTPUT BYTE-IDENTICAL', norm(fromV17) === norm(fromV19));
}

console.log('\n=== 3. signatureOf detects real changes, ignores nothing ===');
{
  const a = JSON.stringify(payloadV19);
  const b = a.replace('Khalate H.S.', 'Khalate H.T.');   // same length, one row edited
  check('identical text -> identical signature', ctx.signatureOf(a) === ctx.signatureOf(a));
  check('edit inside an existing row is detected (same length)', ctx.signatureOf(a) !== ctx.signatureOf(b),
    'this is the QC-backfill case: row count unchanged, values changed');
  check('appended row is detected', ctx.signatureOf(a) !== ctx.signatureOf(a + ' '));
}

console.log('\n=== 4. Background refresh no longer wipes the user filters ===');
{
  // allData/selectedFurnace are `let`-declared, so they are not properties of
  // the VM global; they have to be assigned from inside the context.
  ctx.__testRows = ctx.transformReportData(ctx.expandSheet(payloadV19));
  vm.runInContext('allData = __testRows; selectedFurnace = "all";', ctx);

  ctx.populateFilterOptions();
  const someSupervisor = selects.filterSupervisor.options.map(o => o.value).find(v => v && v !== 'all');
  const someTrolley = selects.filterTrolley.options.map(o => o.value).find(v => v && v !== 'all');
  check('dropdowns were populated', !!someSupervisor && !!someTrolley);

  selects.filterSupervisor.value = someSupervisor;
  selects.filterTrolley.value = someTrolley;

  const writesBefore = selects.filterSupervisor.writes;
  ctx.populateFilterOptions();   // simulates a background refresh, same data

  check('supervisor filter survives a refresh', selects.filterSupervisor.value === someSupervisor,
    `expected "${someSupervisor}", got "${selects.filterSupervisor.value}"`);
  check('trolley filter survives a refresh', selects.filterTrolley.value === someTrolley,
    `expected "${someTrolley}", got "${selects.filterTrolley.value}"`);
  check('unchanged list does not touch the DOM at all',
    selects.filterSupervisor.writes === writesBefore,
    `${selects.filterSupervisor.writes - writesBefore} rebuild(s) happened`);

  // Now the underlying data genuinely changes: the chosen supervisor is gone.
  vm.runInContext(`allData = __testRows.filter(r => r.supervisor !== ${JSON.stringify(someSupervisor)});`, ctx);
  ctx.populateFilterOptions();
  check('list rebuilds when the data really changed', selects.filterSupervisor.writes > writesBefore);
  check('a supervisor who no longer exists falls back to "all"',
    selects.filterSupervisor.value === 'all', `got "${selects.filterSupervisor.value}"`);

  // A different, still-present selection must survive that same rebuild
  vm.runInContext('allData = __testRows;', ctx);
  ctx.populateFilterOptions();
  const stillThere = selects.filterTrolley.options.map(o => o.value).find(v => v && v !== 'all');
  selects.filterTrolley.value = stillThere;
  vm.runInContext(`allData = __testRows.filter(r => r.supervisor !== ${JSON.stringify(someSupervisor)});`, ctx);
  ctx.populateFilterOptions();
  check('unrelated filter survives a rebuild caused by other data changing',
    selects.filterTrolley.value === stillThere, `expected "${stillThere}", got "${selects.filterTrolley.value}"`);
}

console.log('\n=== 5. Background refresh is rate-limited by time, not by trigger ===');
{
  // Stand in for initApp so we can count refreshes without doing any work.
  vm.runInContext('__refreshCalls = 0; initApp = function () { __refreshCalls++; };', ctx);

  // A fetch just happened: repeated triggers (tab switching) must do nothing.
  vm.runInContext('lastFetchAt = Date.now();', ctx);
  for (let i = 0; i < 10; i++) ctx.maybeBackgroundRefresh();
  check('10 tab switches right after a fetch cause 0 refreshes',
    ctx.__refreshCalls === 0, `got ${ctx.__refreshCalls}`);

  // Once the interval has genuinely elapsed, one trigger refreshes.
  vm.runInContext('lastFetchAt = Date.now() - (REFRESH_INTERVAL_MS + 1000);', ctx);
  ctx.maybeBackgroundRefresh();
  check('a trigger after the interval does refresh', ctx.__refreshCalls === 1, `got ${ctx.__refreshCalls}`);

  // `const` is not a property of the VM global, so read it from inside.
  check('refresh interval is 5 minutes',
    vm.runInContext('REFRESH_INTERVAL_MS', ctx) === 5 * 60 * 1000);
}

console.log('\n=== 6. Performance budget on a realistic row count ===');
{
  // The live sheet is ~31,000 rows. Before the column-candidates and
  // memoisation work this took ~6,100 ms, which the browser paid on every
  // load — and twice per load once cache-then-refresh was added.
  const rows = [];
  while (rows.length < 31000) {
    for (const r of payloadV19.rows) { if (rows.length >= 31000) break; rows.push(r); }
  }
  const big = { headers: payloadV19.headers, rows };

  let t = Date.now();
  const objs = ctx.expandSheet(big);
  const expandMs = Date.now() - t;

  t = Date.now();
  const out = ctx.transformReportData(objs);
  const transformMs = Date.now() - t;

  console.log(`        expandSheet ${expandMs} ms · transformReportData ${transformMs} ms · ${out.length} aggregated rows`);
  check(`transformReportData under 3s for 31,000 rows (${transformMs} ms)`, transformMs < 3000);
  check(`expandSheet under 2s for 31,000 rows (${expandMs} ms)`, expandMs < 2000);
}

console.log('\n=== 7. Nothing below transformReportData was touched ===');
{
  const current = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  const marker = 'function transformReportData(';
  const tail = current.slice(current.indexOf(marker));
  check('renderProductionReport still present', tail.includes('function renderProductionReport('));
  check('sortPipes still present', current.includes('function sortPipes('));
  check('formatPipeSize still uses the ordered first-match scan',
    /PIPE_MASTER_ORDER\.find\(p => p\.includes\(formattedDims\)\)/.test(current));
  check('aggregation key unchanged',
    current.includes('`${r.date}|${r.shift}|${r.qcDate}|${r.qcShift}|${r.supervisor}|${r.pipeSize}|${r.trolleyNo}|${r.furnaceNum}`'));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
