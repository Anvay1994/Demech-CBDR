// ============================================
// Demech CBDR — QC Automation v14 (Trolley Sync)
// ============================================

var API_TOKEN = 'demech_secure_2025';

/**
 * 1. AUTOMATION: handleQCAutomation
 * Runs when the spreadsheet changes (e.g. AppSheet sync).
 * Synchronizes QC Metadata across all pipes in a Trolley cluster.
 */
function handleQCAutomation() {
  var lock = LockService.getScriptLock();
  try {
    // 20-second queue to handle multiple users syncing at once
    lock.waitLock(20000); 

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Input Level Data");
    if (!sheet) {
      console.error("Sheet 'Input Level Data' not found.");
      return;
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    // --- A. DYNAMIC COLUMN MAPPING ---
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    var colMap = { remarks: [] };
    
    headers.forEach(function(h, i) {
      var name = String(h).toLowerCase().trim();
      // Column I: Trolley No.
      if (name === "trolley no." || name === "trolley id" || name === "trolley") colMap.trolley = i + 1;
      // Column X-AM: QC Metadata & Remarks
      if (name === "date for output") colMap.dateOut = i + 1;
      if (name === "shift" && i > 15) colMap.shift = i + 1;
      if (name === "qc supervisor") colMap.super = i + 1;
      if (name === "qc time") colMap.time = i + 1;
      
      // Remark columns (Cavity, Cracks, etc.)
      if (/cavity|cracks|r cracks|ovality|others/.test(name)) colMap.remarks.push(i + 1);
    });

    console.log("Column Map:", colMap);

    // --- B. DEEP SCAN (2000 Rows) ---
    // Production data (A-W) keeps updating at the bottom, so we search deep for QC entries (X-AM)
    var rangeSize = 2000;
    var startRow = Math.max(2, lastRow - rangeSize + 1);
    var dataRange = sheet.getRange(startRow, 1, lastRow - startRow + 1, headers.length);
    var data = dataRange.getValues();

    // Mapping: Trolley ID -> { Date, Shift, Supervisor, Time }
    var trolleyMasters = {};

    console.log("Phase 1: Identifying Trolley Masters in last " + data.length + " rows...");

    // First pass: Find rows with completely filled metadata (The "Master" rows)
    for (var i = 0; i < data.length; i++) {
        var row = data[i];
        var trolleyId = String(row[colMap.trolley - 1]).trim();
        if (!trolleyId) continue;

        var dateVal = row[colMap.dateOut - 1];
        var shiftVal = row[colMap.shift - 1];
        var superVal = row[colMap.super - 1];
        var timeVal  = row[colMap.time - 1];

        // If metadata is filled, this is a potential master for its trolley
        if (dateVal && shiftVal && superVal && timeVal) {
            trolleyMasters[trolleyId] = {
                date: dateVal,
                shift: shiftVal,
                supervisor: superVal,
                time: timeVal
            };
        }
    }

    console.log("Masters Found for " + Object.keys(trolleyMasters).length + " trolleys.");

    // Second pass: Update rows that have QC Remarks but are missing metadata
    var rowsUpdated = 0;
    for (var k = 0; k < data.length; k++) {
        var rowValues = data[k];
        var currentTrolley = String(rowValues[colMap.trolley - 1]).trim();
        var curRowNumber = startRow + k;

        // Check if row has QC remarks (inclusive of '0')
        var hasQCData = colMap.remarks.some(function(colIdx) {
            var val = rowValues[colIdx - 1];
            return val !== "" && val !== null;
        });

        // Trigger synchronization if missing metadata and we have a master for this trolley
        if (hasQCData && !rowValues[colMap.dateOut - 1] && trolleyMasters[currentTrolley]) {
            var master = trolleyMasters[currentTrolley];
            console.log("Synchronizing Row " + curRowNumber + " (Trolley: " + currentTrolley + ")");

            sheet.getRange(curRowNumber, colMap.dateOut).setValue(master.date);
            sheet.getRange(curRowNumber, colMap.shift).setValue(master.shift);
            sheet.getRange(curRowNumber, colMap.super).setValue(master.supervisor);
            sheet.getRange(curRowNumber, colMap.time).setValue(master.time);
            
            rowsUpdated++;
        }
    }

    console.log("Sync Complete. Rows Updated: " + rowsUpdated);

  } catch (err) {
    console.error("Automation Error: " + err.toString());
  } finally {
    lock.releaseLock();
  }
}

/**
 * SHIFT HELPER: Based on Manual IST Date
 */
function getShiftByTime(istDate) {
  var h = istDate.getUTCHours() + (istDate.getUTCMinutes() / 60);
  if (h >= 7 && h < 15.5) return "I";   
  if (h >= 15.5 && h < 23.5) return "II";
  return "III"; 
}

/**
 * 2. API PROXY: doGet (Dashboard Connection)
 * Handles User verification and Sheet Data serving
 */
function doGet(e) {
    try {
        var token = e.parameter.token;
        if (token !== API_TOKEN) return JSON_RESPONSE({ error: 'Unauthorized' });
        var action = e.parameter.action || 'read';
        var ss = SpreadsheetApp.getActiveSpreadsheet();

        // --- AUTH / USER VERIFICATION ---
        if (action === 'verify') {
            var email = (e.parameter.email || '').toLowerCase().trim();
            var userSheet = ss.getSheetByName('Users');
            if (userSheet) {
                var userData = userSheet.getDataRange().getValues();
                var hds = userData[0];
                var emIdx = hds.findIndex(h => /email/i.test(h));
                var nmIdx = hds.findIndex(h => /name/i.test(h));
                var rlIdx = hds.findIndex(h => /role/i.test(h));
                
                for (var i = 1; i < userData.length; i++) {
                    if (String(userData[i][emIdx]).toLowerCase().trim() === email) {
                        return JSON_RESPONSE({ 
                           success: true, 
                           user: { email: email, name: userData[i][nmIdx], role: userData[i][rlIdx] } 
                        });
                    }
                }
            }
            return JSON_RESPONSE({ success: false });
        }

        // --- DATA SERVING (Dashboard Feed) ---
        var sheetName = e.parameter.sheet || 'Input Level Data';
        var sheet = ss.getSheetByName(sheetName);
        if (!sheet) return JSON_RESPONSE({ error: 'Sheet "' + sheetName + '" not found' });
        
        var data = sheet.getDataRange().getValues();
        var headers = data[0];
        var results = [];
        
        for (var i = 1; i < data.length; i++) {
            var obj = {};
            var hasVal = false;
            for (var j = 0; j < headers.length; j++) {
                var key = String(headers[j]).trim();
                var val = data[i][j];
                
                // Force IST formatting for Dates for the dashboard
                if (val instanceof Date) {
                  // Spreadsheet is already IST, so we avoid adding an offset if it leads to date shifts
                  // Instead, we just format it directly.
                  val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'dd-MM-yyyy');
                }
                
                obj[key] = val;
                if (val !== '' && val !== 0 && val !== null) hasVal = true;
            }
            if (hasVal) results.push(obj);
        }
        return JSON_RESPONSE({ data: results });

    } catch (err) {
        return JSON_RESPONSE({ error: 'System Error: ' + err.toString() });
    }
}

function JSON_RESPONSE(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
