// ============================================================
// DEMECH CBDR — READ-ONLY DIAGNOSTIC
// ============================================================
//
// SAFE TO RUN. This file only READS. It contains no setValue,
// no delete, no write of any kind. It does not touch doGet or
// handleQCAutomation, and running it does NOT require a redeploy.
// Your live dashboard is completely unaffected.
//
// HOW TO USE
//   1. Apps Script editor -> Files -> "+" -> Script
//   2. Name it: Diagnostic
//   3. Paste this whole file in, replacing the sample myFunction()
//   4. Save (Ctrl+S)
//   5. In the function dropdown at the top, pick "runDiagnostics"
//   6. Click Run.  It takes roughly 30-60 seconds — that is expected.
//   7. Open "Execution log" and copy everything it printed.
//
// WHAT IT ANSWERS
//   - What is really sitting in the empty-looking rows at the bottom
//   - Whether a cheap 3-column scan finds the same last row as reading
//     all 39 columns (this is what Fix A depends on)
//   - How big the data actually is
//   - How fast a "recent rows only" read would be (this is Fix C)
// ============================================================

var DIAG_SHEETS = [
  'Input Level Data',
  'Pipe Master',
  'Shift Level Data',
  'Day Level Data'
];

// Columns used to cheaply locate the true last row of real data.
var DIAG_SPINE = ['ID', 'Input Date', 'Trolley no'];

// The "recent window" Fix C would re-read on every request.
var DIAG_TAIL_ROWS = 5000;

function runDiagnostics() {
  var lines = [];
  function say(s) { lines.push(s); }

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  say('==================================================');
  say(' DEMECH CBDR - READ-ONLY DIAGNOSTIC');
  say(' ' + new Date());
  say(' Spreadsheet: ' + ss.getName());
  say('==================================================');

  var mainStats = null;

  for (var s = 0; s < DIAG_SHEETS.length; s++) {
    var name = DIAG_SHEETS[s];
    var sh = ss.getSheetByName(name);

    say('');
    say('--------------------------------------------------');
    say(' SHEET: ' + name);
    say('--------------------------------------------------');

    if (!sh) { say('  !! NOT FOUND'); continue; }

    var maxRows = sh.getMaxRows();
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();

    say('  Grid allocated (max rows)   : ' + maxRows);
    say('  Google says last row is     : ' + lastRow);
    say('  Last column                 : ' + lastCol);

    var t0 = Date.now();
    var data = sh.getDataRange().getDisplayValues();
    var readMs = Date.now() - t0;

    say('  FULL READ TIME              : ' + readMs + ' ms');
    say('  Cells read                  : ' + (lastRow * lastCol));

    // Single pass: find last row with real content, count non-empty rows
    var lastRealRow = 1;
    var nonEmpty = 0;
    var emptyFlags = [];
    for (var i = 1; i < data.length; i++) {
      var has = false;
      var row = data[i];
      for (var j = 0; j < row.length; j++) {
        if (row[j] !== '') { has = true; break; }
      }
      emptyFlags.push(!has);
      if (has) { nonEmpty++; lastRealRow = i + 1; }
    }

    // Blank rows sitting BETWEEN real rows (these are already filtered
    // out today and are not what Fix A is about)
    var gaps = 0;
    for (var k = 0; k < lastRealRow - 1; k++) {
      if (emptyFlags[k]) gaps++;
    }

    say('  Last row with REAL data     : ' + lastRealRow);
    say('  Non-empty data rows         : ' + nonEmpty);
    say('  Blank rows IN BETWEEN       : ' + gaps + '   (already ignored today)');
    say('  WASTED rows at the BOTTOM   : ' + (lastRow - lastRealRow) + '   <-- what Fix A removes');

    // What is actually down there in the wasted region?
    if (lastRow > lastRealRow) {
      var probeFrom = lastRealRow + 1;
      var probeCount = Math.min(3, lastRow - lastRealRow);
      say('  Sampling the "empty" tail rows ' + probeFrom + '-' + (probeFrom + probeCount - 1) + ':');
      for (var p = 0; p < probeCount; p++) {
        var idx = probeFrom - 1 + p;
        var content = [];
        if (data[idx]) {
          for (var c = 0; c < data[idx].length; c++) {
            if (data[idx][c] !== '') content.push('col' + (c + 1) + '=' + JSON.stringify(data[idx][c]));
          }
        }
        say('     row ' + (probeFrom + p) + ' : ' + (content.length ? content.join(', ') : '(completely empty)'));
      }
    }

    // Payload size actually sent to the browser
    var t1 = Date.now();
    var rowsOut = [];
    for (var i2 = 1; i2 < data.length; i2++) {
      if (!emptyFlags[i2 - 1]) rowsOut.push(data[i2]);
    }
    var json = JSON.stringify({ headers: data[0], rows: rowsOut });
    say('  Payload build time          : ' + (Date.now() - t1) + ' ms');
    say('  PAYLOAD SIZE                : ' + (json.length / 1048576).toFixed(2) + ' MB');

    if (name === 'Input Level Data') {
      mainStats = { sheet: sh, headers: data[0], lastRow: lastRow, lastCol: lastCol, lastRealRow: lastRealRow };
    }

    data = null;
    rowsOut = null;
    json = null;
  }

  // ==========================================================
  // FIX A TEST: can 3 narrow columns find the same last row?
  // ==========================================================
  if (mainStats) {
    say('');
    say('==================================================');
    say(' FIX A TEST - cheap way to find the true last row');
    say('==================================================');

    var headers = mainStats.headers;
    var spineBest = 0;
    var spineMs = 0;

    for (var q = 0; q < DIAG_SPINE.length; q++) {
      var wanted = DIAG_SPINE[q];
      var colIdx = -1;
      for (var h = 0; h < headers.length; h++) {
        if (String(headers[h]).trim().toLowerCase() === wanted.toLowerCase()) { colIdx = h + 1; break; }
      }
      if (colIdx === -1) { say('  Column "' + wanted + '" NOT FOUND in headers'); continue; }

      var ts = Date.now();
      var colVals = mainStats.sheet.getRange(1, colIdx, mainStats.lastRow, 1).getDisplayValues();
      var ms = Date.now() - ts;
      spineMs += ms;

      var last = 0;
      for (var r = colVals.length - 1; r >= 1; r--) {
        if (colVals[r][0] !== '') { last = r + 1; break; }
      }
      if (last > spineBest) spineBest = last;
      say('  "' + wanted + '" (col ' + colIdx + ') -> last filled row ' + last + '   [' + ms + ' ms]');
    }

    say('');
    say('  Cheap 3-column scan says   : ' + spineBest);
    say('  Full 39-column scan says   : ' + mainStats.lastRealRow);
    say('  Total cost of cheap scan   : ' + spineMs + ' ms');
    if (spineBest === mainStats.lastRealRow) {
      say('  RESULT: MATCH - Fix A is safe using these columns.');
    } else {
      say('  RESULT: MISMATCH of ' + (mainStats.lastRealRow - spineBest) + ' rows.');
      say('          Fix A would need a safety margin larger than this.');
    }

    // ==========================================================
    // FIX C TEST: how fast is a "recent rows only" read?
    // ==========================================================
    say('');
    say('==================================================');
    say(' FIX C TEST - reading only the recent tail');
    say('==================================================');

    var tailStart = Math.max(2, mainStats.lastRealRow - DIAG_TAIL_ROWS + 1);
    var tailCount = mainStats.lastRealRow - tailStart + 1;

    var tc = Date.now();
    var tail = mainStats.sheet.getRange(tailStart, 1, tailCount, mainStats.lastCol).getDisplayValues();
    var tailMs = Date.now() - tc;

    say('  Rows read                  : ' + tailCount + ' (rows ' + tailStart + '-' + mainStats.lastRealRow + ')');
    say('  TAIL READ TIME             : ' + tailMs + ' ms   <-- Fix C cold cost');
    say('  Compare with full read at the top of this log.');
    tail = null;
  }

  say('');
  say('==================================================');
  say(' DONE - copy everything above and send it back');
  say('==================================================');

  Logger.log(lines.join('\n'));
}
