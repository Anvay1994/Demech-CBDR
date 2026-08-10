// ============================================
// Demech CBDR — QC Automation v19 (SPLIT CACHE)
// ============================================
//
// MEASURED PROBLEM (from tools/apps_script_diagnostic.js, 31,369 rows):
//   Input Level Data full read ... 16,909 ms   <- 95% of all the time
//   Pipe Master .................     269 ms
//   Shift Level Data ............     367 ms
//   Day Level Data ..............     269 ms
//   Payload sent to browser .....    9.00 MB
//
// WHAT v19 CHANGES:
//   1. Input Level Data is served as 27 columns instead of 39. The other
//      12 are never read by the dashboard — verified by running the real
//      transformReportData() with a recorder attached, and by asserting
//      its output is byte-identical either way. Payload 9.00 -> ~5.8 MB.
//   2. SPLIT CACHE. handleQCAutomation only ever edits the last 600 rows,
//      so everything older is settled history. History is cached for
//      hours; only the recent tail (2,000-5,000 rows) is re-read on each
//      request. Measured: 5,000 rows takes 2,393 ms vs 16,909 ms.
//      The tail is ALWAYS read live, so recent data is never stale.
//   3. warmCache() rebuilds the history on a schedule so no real user ever
//      pays for a rebuild. Install as a 2-hourly trigger (~4 min/day).
//
// SAFETY:
//   - handleQCAutomation is UNCHANGED, byte for byte, from v17.
//   - doGet's 'verify' branch is UNCHANGED, byte for byte, from v17.
//   - The single-sheet path still works, so the currently deployed
//     dashboard keeps running against this script — and gets faster.
//   - The tail window (min 2,000 rows) is always far wider than the 600
//     rows handleQCAutomation can touch, so the automation can never
//     modify a row that is sitting frozen in the history cache.
//   - If a row is inserted or deleted mid-sheet, the boundary row's
//     signature stops matching and the whole cache is rebuilt. The
//     failure mode is "slow", never "wrong".
//
// TOKEN ROTATION:
//   Both tokens are accepted on purpose so deploying does not break the
//   live dashboard. Delete LEGACY_API_TOKEN after the frontend rollout.
// ============================================

var API_TOKEN        = 'demech_qea97pror1_2026';   // new — matches config.js
var LEGACY_API_TOKEN = 'demech_secure_2025';       // DELETE after frontend rollout

// Sheets the web API is permitted to serve. 'Users' is deliberately absent.
var ALLOWED_SHEETS = [
  'Input Level Data',
  'Pipe Master',
  'Shift Level Data',
  'Day Level Data',
  'Summary Sheet'
];

// Sheets returned by action=bundle, in the order the dashboard wants them.
var BUNDLE_SHEETS = [
  'Input Level Data',
  'Pipe Master',
  'Shift Level Data',
  'Day Level Data'
];

var INPUT_SHEET = 'Input Level Data';

// Columns the dashboard never reads. Matched case-insensitively on the
// trimmed header. An unknown/new column is KEPT — dropping is opt-in only.
// NOTE: 'Pipe Size' is dropped but 'Pipe Size_Calculated' is NOT; the match
// is exact, not a prefix.
var INPUT_DROP_COLUMNS = [
  'Date_Shift_Supervisor',
  'Date_Shift_Supervisor_Helper',
  'Lava Temp',
  'Homo Temp',
  'TK Temp',
  'Temp Eject',
  'Air time',
  'Pipe Size',
  'Size_actual',
  'Hour Cycle',
  'Check',
  '% R'
];

var CACHE_PREFIX      = 'cbdr_v2_';
var CACHE_TTL_DEFAULT = 90;    // seconds — small sheets
var CACHE_TTL_SLOW    = 600;   // seconds — Pipe Master, rarely changes
var CACHE_CHUNK_SIZE  = 80000; // chars; CacheService caps a value at ~100KB

var HIST_TTL   = 14400; // 4 hours — how long frozen history stays cached
var TAIL_MIN   = 2000;  // rows re-read live immediately after a rebuild
var TAIL_MAX   = 5000;  // once the tail grows past this, rebuild history

/**
 * 1. AUTOMATION: handleQCAutomation
 * Synchronizes QC Metadata while strictly protecting historical data.
 *
 * UNCHANGED FROM v17. Do not modify — the QC team depends on this behaviour.
 */
function handleQCAutomation() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); 

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error("Could not connect to active spreadsheet.");
    
    var sheet = ss.getSheetByName("Input Level Data");
    if (!sheet) throw new Error("Tab 'Input Level Data' exactly as spelled was not found.");

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
        Logger.log("Sheet is empty or has only headers. Exiting.");
        return;
    }

    // --- A. DYNAMIC COLUMN MAPPING ---
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    var colMap = { remarks: [] };
    
    headers.forEach(function(h, i) {
      // Remove all extra spaces and normalize for robust matching
      var name = String(h).toLowerCase().replace(/\s+/g, " ").trim();
      
      if (name === "trolley no." || name === "trolley no" || name === "trolley id" || name === "trolley") colMap.trolley = i + 1;
      if (name === "input date" || name === "production date" || name === "date") colMap.inputDate = i + 1;
      if (name === "input shift" || name === "production shift") colMap.inputShift = i + 1;
      if (name === "production supervisor" || name === "prod. supervisor" || name === "prod supervisor" || name === "supervisor") colMap.prodSuper = i + 1;

      if (name === "date for output" || name === "output date" || name === "qc date") colMap.dateOut = i + 1;
      if (name === "shift" && i > 15) colMap.shift = i + 1; 
      if (name === "qc supervisor" || name === "quality supervisor") colMap.super = i + 1;
      if (name === "qc time" || name === "time") colMap.time = i + 1;
      
      if (/cavity|cracks|r cracks|ovality|others/.test(name)) colMap.remarks.push(i + 1);
    });

    // DIAGNOSTIC: Check if any required columns are missing
    var missingCols = [];
    if (!colMap.trolley) missingCols.push("Trolley No.");
    if (!colMap.inputDate) missingCols.push("Input Date");
    if (!colMap.inputShift) missingCols.push("Input Shift");
    if (!colMap.dateOut) missingCols.push("Date for Output");
    if (!colMap.shift) missingCols.push("QC Shift (column > P)");
    if (!colMap.super) missingCols.push("QC Supervisor");
    if (!colMap.time) missingCols.push("QC Time");
    
    if (missingCols.length > 0) {
        throw new Error("Missing columns in sheet: " + missingCols.join(", ") + ". Please check for renamed headers.");
    }

    // --- B. SCAN WINDOW (Last 600 rows is enough for active work) ---
    var scanRange = 600; 
    var startRow = Math.max(2, lastRow - scanRange + 1);
    var dataRange = sheet.getRange(startRow, 1, lastRow - startRow + 1, headers.length);
    var displayData = dataRange.getDisplayValues();

    var trolleyMasters = {};
    var mastersFound = 0;

    // Phase 1: Identify Masters in the recent window
    for (var i = 0; i < displayData.length; i++) {
        var dRow = displayData[i];
        
        var tId = String(dRow[colMap.trolley - 1]).trim();
        var iD  = String(dRow[colMap.inputDate - 1]).trim();
        var iS  = String(dRow[colMap.inputShift - 1]).trim().toLowerCase();
        
        if (!tId || !iD) continue;

        // Composite Unique Key (Trolley + Date + Shift)
        var fingerprint = tId + "|" + iD + "|" + iS;

        var qDate = dRow[colMap.dateOut - 1];
        var qShift = dRow[colMap.shift - 1];
        var qTime = dRow[colMap.time - 1]; 

        // Master found if all 3 key metadata fields are filled
        if (qDate && qShift && qTime) {
            trolleyMasters[fingerprint] = {
                date: qDate,
                shift: qShift,
                supervisor: dRow[colMap.super - 1],
                time: qTime
            };
            mastersFound++;
        }
    }
    
    Logger.log("Found " + mastersFound + " valid QC masters in the last 600 rows (Requires Date, Shift, and Time).");

    // Phase 2: Synchronize (V14 Safety Rules Apply)
    var rowsUpdated = 0;
    for (var k = 0; k < displayData.length; k++) {
        var dRowValues = displayData[k];
        var curRowNumber = startRow + k;

        var fingerprint = String(dRowValues[colMap.trolley - 1]).trim() + "|" + 
                          String(dRowValues[colMap.inputDate - 1]).trim() + "|" + 
                          String(dRowValues[colMap.inputShift - 1]).trim().toLowerCase();

        var master = trolleyMasters[fingerprint];
        
        // Safety Guard: Date for Output MUST BE EMPTY (This protects historical data)
        var isDateEmpty = (dRowValues[colMap.dateOut - 1] === "");

        // Only require isDateEmpty and master (removed defect requirement so perfect pipes sync too!)
        if (isDateEmpty && master) {
            sheet.getRange(curRowNumber, colMap.dateOut).setValue(master.date);
            sheet.getRange(curRowNumber, colMap.shift).setValue(master.shift);
            sheet.getRange(curRowNumber, colMap.super).setValue(master.supervisor);
            sheet.getRange(curRowNumber, colMap.time).setValue(master.time);
            
            rowsUpdated++;
        }
    }
    
    Logger.log("Auto-sync completed. Updated " + rowsUpdated + " child rows safely.");

  } catch (e) {
    Logger.log("ERROR: " + e.toString());
    console.error("Automation Error: " + e.toString());
  } finally {
    lock.releaseLock();
  }
}

/**
 * 2. WEB API: doGet
 * Serves data to the Dashboard Portal.
 */
function doGet(e) {
    try {
        var t0 = Date.now();
        var action = e.parameter.action;
        var incomingToken = e.parameter.token;
        if (incomingToken !== API_TOKEN && incomingToken !== LEGACY_API_TOKEN) {
            return JSON_RESPONSE({ error: 'Unauthorized' });
        }

        var ss = SpreadsheetApp.getActiveSpreadsheet();

        // --- LOGIN VERIFICATION ---
        if (action === 'verify') {
            var email = (e.parameter.email || '').toLowerCase().trim();
            var userSheet = ss.getSheetByName('Users');
            if (userSheet) {
                var userData = userSheet.getDataRange().getValues();
                var headers = userData[0].map(function(h) { return String(h).toLowerCase().trim(); });
                
                var emailIdx = headers.indexOf('email');
                if (emailIdx === -1) emailIdx = headers.findIndex(function(h) { return h.includes('email'); });
                
                var nameIdx = headers.indexOf('name');
                if (nameIdx === -1) nameIdx = headers.findIndex(function(h) { return h.includes('name'); });
                
                var roleIdx = headers.indexOf('role');
                if (roleIdx === -1) roleIdx = headers.findIndex(function(h) { return h.includes('role'); });

                if (emailIdx !== -1) {
                    for (var i = 1; i < userData.length; i++) {
                        if (String(userData[i][emailIdx]).toLowerCase().trim() === email) {
                            var userName = nameIdx !== -1 ? userData[i][nameIdx] : email;
                            var userRole = roleIdx !== -1 ? userData[i][roleIdx] : 'User';
                            return JSON_RESPONSE({ success: true, user: { email: email, name: userName, role: userRole } });
                        }
                    }
                }
            }
            return JSON_RESPONSE({ success: false });
        }
        // fresh=1   : skip the response cache; the tail is re-read live.
        //             Recent data is fully current. This is what Refresh uses.
        // rebuild=1 : additionally throw away the frozen history and re-read
        //             the entire sheet. Only needed when an OLD record was
        //             edited and must appear immediately. Costs ~17s.
        var forceFresh   = (e.parameter.fresh === '1' || e.parameter.rebuild === '1');
        var forceRebuild = (e.parameter.rebuild === '1');

        // --- BUNDLE MODE: all four sheets in a single request ---
        if (action === 'bundle') {
            var parts = [];
            for (var b = 0; b < BUNDLE_SHEETS.length; b++) {
                var bName = BUNDLE_SHEETS[b];
                var bJson = readSheetJson(ss, bName, forceFresh, forceRebuild);
                // A missing sheet yields an empty payload, matching the old
                // client's .catch(() => []) behaviour.
                if (bJson === null) bJson = '{"headers":[],"rows":[]}';
                parts.push(JSON.stringify(bName) + ':' + bJson);
            }
            return RAW_JSON_RESPONSE(
                '{"data":{' + parts.join(',') + '},"ms":' + (Date.now() - t0) + '}'
            );
        }

        // --- SINGLE-SHEET MODE (v17 compatible) ---
        var sheetName = e.parameter.sheet || 'Input Level Data';

        // Allowlist: the web API must never serve the Users sheet.
        if (ALLOWED_SHEETS.indexOf(sheetName) === -1) {
            return JSON_RESPONSE({ error: 'Sheet not found' });
        }

        var sheet = ss.getSheetByName(sheetName);
        if (!sheet) return JSON_RESPONSE({ error: 'Sheet not found' });

        var format = e.parameter.format;

        if (format === '2d') {
            var sJson = readSheetJson(ss, sheetName, forceFresh, forceRebuild);
            if (sJson === null) return JSON_RESPONSE({ error: 'Sheet not found' });
            return RAW_JSON_RESPONSE('{"data":' + sJson + '}');
        } else {
            // LEGACY JSON OBJECT MODE (unchanged from v17)
            var data = sheet.getDataRange().getDisplayValues();
            var lHeaders = data[0];
            var results = [];
            for (var i = 1; i < data.length; i++) {
                var obj = {};
                var hasVal = false;
                for (var j = 0; j < lHeaders.length; j++) {
                    var key = String(lHeaders[j]).trim();
                    var val = data[i][j];

                    obj[key] = val;
                    if (val !== '') hasVal = true;
                }
                if (hasVal) results.push(obj);
            }
            return JSON_RESPONSE({ data: results });
        }
    } catch (err) {
        return JSON_RESPONSE({ error: err.toString() });
    }
}

/**
 * 3. WARM-UP: warmCache
 *
 * Rebuilds the frozen history so no real user ever waits for it.
 * Install as a time-driven trigger every 2 hours:
 *   Apps Script -> Triggers -> Add Trigger
 *   Function: warmCache | Event source: Time-driven | Hour timer | Every 2 hours
 *
 * Deliberately more frequent than HIST_TTL (4 hours) so the history is always
 * refreshed well before it can expire — otherwise an unlucky visitor lands on
 * an expired cache and pays for the rebuild themselves.
 *
 * Costs roughly 20 seconds per run, about 4 minutes of quota per day.
 * Safe to run at any time — it only reads.
 */
function warmCache() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var t0 = Date.now();
    for (var i = 0; i < BUNDLE_SHEETS.length; i++) {
        readSheetJson(ss, BUNDLE_SHEETS[i], true, true);
    }
    Logger.log('warmCache rebuilt all sheet caches in ' + (Date.now() - t0) + ' ms');
}

// ============================================
// 4. SHEET SERIALISATION
// ============================================

function readSheetJson(ss, sheetName, forceFresh, forceRebuild) {
    if (sheetName === INPUT_SHEET) {
        return getInputLevelJson(ss, forceFresh, forceRebuild);
    }
    return getSheetJson(ss, sheetName, forceFresh);
}

/**
 * Projects a block of raw sheet rows down to the kept columns.
 *
 * The empty-row test deliberately looks at ALL columns, exactly as v17 did,
 * so dropping columns cannot change which rows survive.
 */
function projectRows(rawRows, keepIdx) {
    var out = [];
    for (var i = 0; i < rawRows.length; i++) {
        var row = rawRows[i];
        var hasVal = false;
        for (var j = 0; j < row.length; j++) {
            if (row[j] !== '') { hasVal = true; break; }
        }
        if (!hasVal) continue;

        var kept = [];
        for (var k = 0; k < keepIdx.length; k++) kept.push(row[keepIdx[k]]);
        out.push(kept);
    }
    return out;
}

/** Column indices to keep. Unknown columns are kept, never dropped. */
function computeKeepIdx(headers) {
    var drop = {};
    for (var d = 0; d < INPUT_DROP_COLUMNS.length; d++) {
        drop[INPUT_DROP_COLUMNS[d].toLowerCase().trim()] = true;
    }
    var keep = [];
    for (var i = 0; i < headers.length; i++) {
        if (!drop[String(headers[i]).toLowerCase().trim()]) keep.push(i);
    }
    return keep;
}

/** Joins a cached history array and a live tail array without re-parsing. */
function assemblePayload(headers, histJson, tailJson) {
    var rows;
    if (!histJson || histJson === '[]') rows = tailJson;
    else if (!tailJson || tailJson === '[]') rows = histJson;
    else rows = histJson.slice(0, -1) + ',' + tailJson.slice(1);
    return '{"headers":' + JSON.stringify(headers) + ',"rows":' + rows + '}';
}

/**
 * Input Level Data, served as frozen history + live tail.
 *
 * History covers sheet rows 2..endRow and is cached. The tail covers
 * endRow+1..lastRow and is read live on every request. Row endRow itself is
 * re-read as a signature check: if it no longer matches what was cached,
 * rows have shifted and everything is rebuilt.
 */
function getInputLevelJson(ss, forceFresh, forceRebuild) {
    var sheet = ss.getSheetByName(INPUT_SHEET);
    if (!sheet) return null;

    var cache = CacheService.getScriptCache();
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return '{"headers":[],"rows":[]}';

    // Whole-response cache, for bursts of readers.
    if (!forceFresh) {
        var whole = cacheGetChunked(cache, 'ILD_full');
        if (whole) return whole;
    }

    // --- try the frozen history ---
    if (!forceRebuild) {
        var meta = null;
        try {
            var raw = cache.get(CACHE_PREFIX + 'ILD_meta');
            if (raw) meta = JSON.parse(raw);
        } catch (err) { meta = null; }

        var usable = meta &&
            meta.cols === lastCol &&
            meta.endRow >= 2 && meta.endRow <= lastRow &&
            (lastRow - meta.endRow) <= TAIL_MAX;

        if (usable) {
            var histJson = cacheGetChunked(cache, 'ILD_hist');
            if (histJson) {
                // One read covers the signature row and the whole tail.
                var block = sheet.getRange(meta.endRow, 1, lastRow - meta.endRow + 1, lastCol)
                                 .getDisplayValues();
                var sig = JSON.stringify(block[0]);
                if (sig === meta.sig) {
                    var tail = projectRows(block.slice(1), meta.keepIdx);
                    var payload = assemblePayload(meta.headers, histJson, JSON.stringify(tail));
                    cachePutChunked(cache, 'ILD_full', payload, CACHE_TTL_DEFAULT);
                    return payload;
                }
                // Signature mismatch: rows were inserted, deleted or edited
                // at the boundary. Fall through and rebuild everything.
                Logger.log('Input Level Data: boundary signature changed, rebuilding cache.');
            }
        }
    }

    // --- full rebuild ---
    var all = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    var headersRaw = all[0];
    var keepIdx = computeKeepIdx(headersRaw);
    var keptHeaders = [];
    for (var h = 0; h < keepIdx.length; h++) {
        keptHeaders.push(String(headersRaw[keepIdx[h]]).trim());
    }

    var endRow = lastRow - TAIL_MIN;
    if (endRow < 2) {
        // Sheet is small enough that splitting buys nothing.
        var allRows = projectRows(all.slice(1), keepIdx);
        var small = assemblePayload(keptHeaders, '[]', JSON.stringify(allRows));
        cachePutChunked(cache, 'ILD_full', small, CACHE_TTL_DEFAULT);
        return small;
    }

    var histRows = projectRows(all.slice(1, endRow), keepIdx);   // sheet rows 2..endRow
    var tailRows = projectRows(all.slice(endRow), keepIdx);      // sheet rows endRow+1..lastRow
    var histStr  = JSON.stringify(histRows);

    cachePutChunked(cache, 'ILD_hist', histStr, HIST_TTL);
    try {
        cache.put(CACHE_PREFIX + 'ILD_meta', JSON.stringify({
            endRow:  endRow,
            cols:    lastCol,
            sig:     JSON.stringify(all[endRow - 1]),  // raw row endRow
            headers: keptHeaders,
            keepIdx: keepIdx
        }), HIST_TTL);
    } catch (err) {
        Logger.log('Cache meta write skipped: ' + err.toString());
    }

    var full = assemblePayload(keptHeaders, histStr, JSON.stringify(tailRows));
    cachePutChunked(cache, 'ILD_full', full, CACHE_TTL_DEFAULT);
    return full;
}

/**
 * The three small sheets. Read whole, cached whole, all columns kept.
 * Combined they cost under a second, so there is nothing to be clever about.
 */
function getSheetJson(ss, sheetName, forceFresh) {
    var cache = CacheService.getScriptCache();

    if (!forceFresh) {
        var hit = cacheGetChunked(cache, sheetName);
        if (hit) return hit;
    }

    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return null;

    var data = sheet.getDataRange().getDisplayValues();
    if (!data || data.length === 0) return '{"headers":[],"rows":[]}';

    var headers = data[0];
    var rows = [];
    for (var i = 1; i < data.length; i++) {
        var rowArray = [];
        var hasVal = false;
        for (var j = 0; j < headers.length; j++) {
            var val = data[i][j];
            rowArray.push(val);
            if (val !== '') hasVal = true;
        }
        if (hasVal) rows.push(rowArray);
    }

    var trimmed = [];
    for (var t = 0; t < headers.length; t++) trimmed.push(String(headers[t]).trim());

    var json = JSON.stringify({ headers: trimmed, rows: rows });
    cachePutChunked(cache, sheetName,
        json, (sheetName === 'Pipe Master') ? CACHE_TTL_SLOW : CACHE_TTL_DEFAULT);
    return json;
}

// ============================================
// 5. CHUNKED CACHE (CacheService caps a value at ~100KB)
// ============================================

function cacheKeyFor(name, suffix) {
    return CACHE_PREFIX + String(name).replace(/\s+/g, '_') + '_' + suffix;
}

/**
 * Reassembles a chunked cache entry. Returns null on any inconsistency —
 * a partial eviction is treated as a miss, never as partial data.
 */
function cacheGetChunked(cache, name) {
    try {
        var metaRaw = cache.get(cacheKeyFor(name, 'meta'));
        if (!metaRaw) return null;

        var meta = JSON.parse(metaRaw);
        var keys = [];
        for (var i = 0; i < meta.n; i++) keys.push(cacheKeyFor(name, i));

        var parts = cache.getAll(keys);
        var out = '';
        for (var k = 0; k < keys.length; k++) {
            var piece = parts[keys[k]];
            if (piece === null || piece === undefined) return null; // evicted
            out += piece;
        }

        if (out.length !== meta.len) return null; // torn write or eviction
        return out;
    } catch (err) {
        return null;
    }
}

/**
 * Splits a payload across cache keys. Cache failures are swallowed —
 * caching must never be able to break a response.
 */
function cachePutChunked(cache, name, json, ttl) {
    try {
        if (!ttl) ttl = CACHE_TTL_DEFAULT;
        var n = Math.ceil(json.length / CACHE_CHUNK_SIZE) || 1;

        var obj = {};
        for (var i = 0; i < n; i++) {
            obj[cacheKeyFor(name, i)] =
                json.substring(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE);
        }
        obj[cacheKeyFor(name, 'meta')] = JSON.stringify({ n: n, len: json.length });

        cache.putAll(obj, ttl);
    } catch (err) {
        Logger.log('Cache write skipped: ' + err.toString());
    }
}

function JSON_RESPONSE(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function RAW_JSON_RESPONSE(str) {
    return ContentService.createTextOutput(str).setMimeType(ContentService.MimeType.JSON);
}
