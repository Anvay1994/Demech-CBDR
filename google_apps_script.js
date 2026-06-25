// ============================================
// Demech CBDR — QC Automation v17 (DIAGNOSTIC & HIGH-SPEED)
// ============================================

var API_TOKEN = 'demech_secure_2025';

/**
 * 1. AUTOMATION: handleQCAutomation
 * Synchronizes QC Metadata while strictly protecting historical data.
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
        var action = e.parameter.action;
        var ss = SpreadsheetApp.getActiveSpreadsheet();
        var incomingToken = e.parameter.token;
        if (incomingToken !== API_TOKEN) return JSON_RESPONSE({ error: 'Unauthorized' });

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

        // --- DATA SERVING ---
        var sheetName = e.parameter.sheet || 'Input Level Data';
        var sheet = ss.getSheetByName(sheetName);
        if (!sheet) return JSON_RESPONSE({ error: 'Sheet not found' });
        
        var data = sheet.getDataRange().getValues();
        var headers = data[0];
        var timeZone = Session.getScriptTimeZone();
        var format = e.parameter.format;

        if (format === '2d') {
            // HIGH-SPEED 2D COMPRESSION MODE (Reduces payload size by ~60%)
            var rows = [];
            for (var i = 1; i < data.length; i++) {
                var rowArray = [];
                var hasVal = false;
                for (var j = 0; j < headers.length; j++) {
                    var val = data[i][j];
                    if (val instanceof Date) {
                        if (val.getFullYear() < 1970) {
                            val = Utilities.formatDate(val, timeZone, 'HH:mm:ss');
                        } else {
                            val = Utilities.formatDate(val, timeZone, 'dd-MM-yyyy');
                        }
                    }
                    rowArray.push(val);
                    if (val !== '' && val !== 0 && val !== null) hasVal = true;
                }
                if (hasVal) rows.push(rowArray);
            }
            return JSON_RESPONSE({ data: { headers: headers.map(function(h) { return String(h).trim(); }), rows: rows } });
        } else {
            // LEGACY JSON OBJECT MODE
            var results = [];
            for (var i = 1; i < data.length; i++) {
                var obj = {};
                var hasVal = false;
                for (var j = 0; j < headers.length; j++) {
                    var key = String(headers[j]).trim();
                    var val = data[i][j];
                    
                    if (val instanceof Date) {
                      if (val.getFullYear() < 1970) {
                         val = Utilities.formatDate(val, timeZone, 'HH:mm:ss');
                      } else {
                         val = Utilities.formatDate(val, timeZone, 'dd-MM-yyyy');
                      }
                    }
                    obj[key] = val;
                    if (val !== '' && val !== 0 && val !== null) hasVal = true;
                }
                if (hasVal) results.push(obj);
            }
            return JSON_RESPONSE({ data: results });
        }
    } catch (err) {
        return JSON_RESPONSE({ error: err.toString() });
    }
}

function JSON_RESPONSE(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
