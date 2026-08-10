/**
 * transformReportData equivalence test
 * -------------------------------------
 * Run:  node tests/transform_equivalence.test.js
 *
 * transformReportData holds the grouping, aggregation and field-mapping rules
 * the whole dashboard depends on. This test pins its behaviour by running the
 * current implementation and a frozen baseline side by side and requiring
 * byte-identical output.
 *
 * The baseline in tests/fixtures/app.pre-optimisation.js is the version that
 * ran in production before getField() was replaced with precomputed column
 * candidates. Do not refresh it casually — its whole value is that it predates
 * the optimisation.
 *
 * The interesting cases are the fuzz trials. getField's choice of column
 * depended on which cells happened to be empty in a given row, so randomly
 * blanking cells is what would expose any difference in how the replacement
 * picks a column.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BASELINE = fs.readFileSync(path.join(__dirname, 'fixtures', 'app.pre-optimisation.js'), 'utf8');
const CURRENT = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
const CONFIG = fs.readFileSync(path.join(REPO, 'config.js'), 'utf8');

function load(src) {
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ style: {}, appendChild() {} }), addEventListener() {},
      body: { appendChild() {} }, hidden: false,
    },
    window: {}, location: { search: '' }, performance: { now: () => Date.now() },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, clear() {} },
    setInterval() {}, setTimeout() {}, fetch() {}, Chart: function () {},
  });
  vm.runInContext(CONFIG, ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

const norm = (d) => JSON.stringify(d, (k, v) => (v instanceof Set ? [...v] : v));

const grid = fs.readFileSync(path.join(REPO, 'for ref/Demech_CBDR - Input Level Data.csv'), 'utf8')
  .split('\n').filter(l => l.trim()).map(l => l.split(','));
const HEADERS = grid[0];
const BASE = grid.slice(1);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
}

function compare(label, headers, rows) {
  const run = (ctx) => {
    const objs = rows.map(r => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; });
      return o;
    });
    return ctx.transformReportData(objs);
  };
  const a = norm(run(load(BASELINE)));
  const b = norm(run(load(CURRENT)));
  check(label, a === b, a === b ? '' : `output diverges (baseline ${a.length} bytes vs current ${b.length})`);
}

console.log('\n=== A. Real data, both column sets ===');
compare('full 39-column payload', HEADERS, BASE);

const DROPPED = ['Date_Shift_Supervisor', 'Date_Shift_Supervisor_Helper', 'Lava Temp', 'Homo Temp',
  'TK Temp', 'Temp Eject', 'Air time', 'Pipe Size', 'Size_actual', 'Hour Cycle', 'Check', '% R'];
const kept = HEADERS.map((h, i) => i).filter(i => !DROPPED.includes(HEADERS[i]));
compare('trimmed 27-column payload', kept.map(i => HEADERS[i]), BASE.map(r => kept.map(i => r[i] || '')));

console.log('\n=== B. Fuzz: random empty cells ===');
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let trial = 1; trial <= 6; trial++) {
  const rows = BASE.slice(0, 300).map(r => r.map(v => (rnd() < 0.35 ? '' : v)));
  compare(`fuzz trial ${trial} — 35% of cells blanked`, HEADERS, rows);
}

console.log('\n=== C. Awkward header sets ===');
compare('the same name appearing twice', HEADERS.map((h, i) => (i === 5 ? 'Supervisor' : h)), BASE.slice(0, 200));
compare('headers padded with whitespace', HEADERS.map(h => ' ' + h + ' '), BASE.slice(0, 200));
compare('columns in reverse order', HEADERS.slice().reverse(), BASE.slice(0, 200).map(r => r.slice().reverse()));
compare('QC columns missing entirely',
  HEADERS.filter(h => !/qc/i.test(h)),
  BASE.slice(0, 200).map(r => HEADERS.map((h, i) => [h, r[i]]).filter(([h]) => !/qc/i.test(h)).map(([, v]) => v)));
compare('a single row', HEADERS, BASE.slice(0, 1));
compare('every cell empty', HEADERS, [HEADERS.map(() => '')]);

console.log('\n=== D. Memoised helpers cannot serve a stale answer ===');
{
  const old = load(BASELINE), cur = load(CURRENT);
  const sizes = ['489x500x20', '436x500x20', '999x999x99', ''];

  const before = sizes.map(s => [old.formatPipeSize(s), cur.formatPipeSize(s)]);
  check('formatPipeSize agrees initially', before.every(([a, b]) => a === b), JSON.stringify(before));

  // Loading the Pipe Master sheet rewrites PIPE_MASTER_ORDER, which the
  // cached answers depend on.
  const pipeMaster = [{ 'Unique Pipe Size': 'P_999*999*99' }];
  old.updatePipeMasterOrder(pipeMaster);
  cur.updatePipeMasterOrder(pipeMaster);

  const after = sizes.map(s => [old.formatPipeSize(s), cur.formatPipeSize(s)]);
  check('formatPipeSize agrees after the master order changes',
    after.every(([a, b]) => a === b), JSON.stringify(after));
  check('and that change really did alter an answer (so the check has teeth)',
    JSON.stringify(before[2]) !== JSON.stringify(after[2]),
    `${JSON.stringify(before[2])} -> ${JSON.stringify(after[2])}`);

  const dates = ['27-03-2026', '01-Apr-2026', '2026-08-10', '', null, undefined, 'garbage'];
  const results = dates.map(d => [old.formatDate(d), cur.formatDate(d), old.formatDate(d), cur.formatDate(d)]);
  check('formatDate agrees, including repeat calls and junk input',
    results.every(([a, b, a2, b2]) => String(a) === String(b) && String(a2) === String(b2)),
    JSON.stringify(results));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
