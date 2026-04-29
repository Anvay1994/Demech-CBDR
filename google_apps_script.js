// ============================================
// Demech CBDR — QC Automation v16 (SAFE BATCH SYNC)
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
    var sheet = ss.getSheetByName("Input Level Data");
    if (!sheet) return;

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    // --- A. DYNAMIC COLUMN MAPPING ---
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    var colMap = { remarks: [] };
    
    headers.forEach(function(h, i) {
      var name = String(h).toLowerCase().trim();
      
      // Production Columns (Sources for Batch Identification)
      if (name === "trolley no." || name === "trolley id" || name === "trolley") colMap.trolley = i + 1;
      if (name === "input date" || name === "production date") colMap.inputDate = i + 1;
      if (name === "input shift" || name === "production shift") colMap.inputShift = i + 1;
      if (name === "production supervisor" || name === "prod. supervisor") colMap.prodSuper = i + 1;

      // Quality Columns (Targets for Syncing - X to AA)
      if (name === "date for output") colMap.dateOut = i + 1;
      if (name === "shift" && i > 15) colMap.shift = i + 1; 
      if (name === "qc supervisor") colMap.super = i + 1;
      if (name === "qc time") colMap.time = i + 1;
      
      // Remark columns (Sync Triggers)
      if (/cavity|cracks|r cracks|ovality|others/.test(name)) colMap.remarks.push(i + 1);
    });

    // --- B. SCAN WINDOW (Last 600 rows is enough for active work) ---
    var scanRange = 600; 
    var startRow = Math.max(2, lastRow - scanRange + 1);
    var dataRange = sheet.getRange(startRow, 1, lastRow - startRow + 1, headers.length);
    var displayData = dataRange.getDisplayValues();

    var trolleyMasters = {};

    // Phase 1: Identify Masters in the recent window
    for (var i = 0; i < displayData.length; i++) {
        var dRow = displayData[i];
        
        var tId = String(dRow[colMap.trolley - 1]).trim();
        var iD  = String(dRow[colMap.inputDate - 1]).trim();
        var iS  = String(dRow[colMap.inputShift - 1]).trim().toLowerCase();
        var pS  = String(dRow[colMap.prodSuper - 1]).trim().toLowerCase();

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
        }
    }

    // Phase 2: Synchronize (V14 Safety Rules Apply)
    var rowsUpdated = 0;
    for (var k = 0; k < displayData.length; k++) {
        var dRowValues = displayData[k];
        var curRowNumber = startRow + k;

        var fingerprint = String(dRowValues[colMap.trolley - 1]).trim() + "|" + 
                          String(dRowValues[colMap.inputDate - 1]).trim() + "|" + 
                          String(dRowValues[colMap.inputShift - 1]).trim().toLowerCase();

        var master = trolleyMasters[fingerprint];
        
        // Safety Guard 1: Must have QC remarks
        var hasQCData = colMap.remarks.some(function(colIdx) {
            return dRowValues[colIdx - 1] !== "" && dRowValues[colIdx - 1] !== null;
        });

        // Safety Guard 2: Date for Output MUST BE EMPTY (Prevent historical overwrite)
        var isDateEmpty = (dRowValues[colMap.dateOut - 1] === "");

        if (hasQCData && isDateEmpty && master) {
            console.log("Safely dragging down QC info for trolley batch: " + fingerprint);

            sheet.getRange(curRowNumber, colMap.dateOut).setValue(master.date);
            sheet.getRange(curRowNumber, colMap.shift).setValue(master.shift);
            sheet.getRange(curRowNumber, colMap.super).setValue(master.supervisor);
            sheet.getRange(curRowNumber, colMap.time).setValue(master.time);
            
            rowsUpdated++;
        }
    }
    console.log("Auto-sync completed. Updated " + rowsUpdated + " rows safely.");

  } catch (e) {
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
        var results = [];
        var timeZone = Session.getScriptTimeZone();

        for (var i = 1; i < data.length; i++) {
            var obj = {};
            var hasVal = false;
            for (var j = 0; j < headers.length; j++) {
                var key = String(headers[j]).trim();
                var val = data[i][j];
                
                // Smart Formatting for Dashboard
                if (val instanceof Date) {
                  // Time-only detection logic
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
    } catch (err) {
        return JSON_RESPONSE({ error: err.toString() });
    }
}

function JSON_RESPONSE(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
