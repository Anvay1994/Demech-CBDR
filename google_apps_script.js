// ============================================
// Demech CBDR — QC Automation v13 (Production)
// ============================================

var API_TOKEN = 'demech_secure_2025';

/**
 * 1. AUTOMATION: handleQCAutomation
 * Runs when the spreadsheet changes (e.g. AppSheet sync).
 */
function handleQCAutomation(e) {
  var lock = LockService.getScriptLock();
  try {
    // 20-second queue to handle multiple users syncing at once
    lock.waitLock(20000); 

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Input Level Data");
    if (!sheet) return;

    // --- A. THE MASTER MAP (Hardcoded for your columns) ---
    var colMap = { 
      trolley: 9,   // Column I
      dateOut: 24,  // Column X
      shift: 25,    // Column Y
      super: 26,    // Column Z
      time: 27,     // Column AA
      remarkCols: [] 
    };
    
    // Auto-discover Remark columns (Cavity, Cracks, etc.)
    var headers = sheet.getRange(1, 1, 1, 40).getDisplayValues()[0];
    headers.forEach(function(h, j) {
      if (!h) return;
      var name = h.toString().toLowerCase().trim();
      if (/cavity|cracks|r cracks|ovality|others/.test(name)) colMap.remarkCols.push(j + 1);
    });

    // --- B. BRUTE FORCE TIME CALCULATION (UTC + 5.5 hours) ---
    var lastRow = sheet.getLastRow();
    var startRow = Math.max(2, lastRow - 50);
    var dataRange = sheet.getRange(startRow, 1, lastRow - startRow + 1, 35).getDisplayValues();

    // Force IST manually
    var nowUtc = new Date();
    var istNow = new Date(nowUtc.getTime() + (5.5 * 60 * 60 * 1000)); 
    var dateStr = Utilities.formatDate(istNow, "GMT", "dd-MM-yyyy");
    var timeStr = Utilities.formatDate(istNow, "GMT", "HH:mm:ss");
    var shiftName = getShiftByTime(istNow);

    for (var i = 0; i < dataRange.length; i++) {
        var rowData = dataRange[i];
        var curRow = startRow + i;
        
        var hasRemark = false;
        colMap.remarkCols.forEach(function(c) { if (rowData[c-1] && rowData[c-1] !== "") hasRemark = true; });

        if (hasRemark && (rowData[colMap.dateOut-1] === "" || rowData[colMap.shift-1] === "")) {
            
            // Set forceful IST points
            sheet.getRange(curRow, colMap.dateOut).setValue(dateStr);
            sheet.getRange(curRow, colMap.shift).setValue(shiftName);

            // B. Inheritance
            var currentTrolleyID = rowData[colMap.trolley-1].toString().trim();
            var foundSuper = "";
            var foundTime  = "";

            if (curRow > 2) {
                var prevData = sheet.getRange(2, 1, curRow - 2, 35).getDisplayValues();
                for (var j = prevData.length - 1; j >= 0; j--) {
                    var pR = prevData[j];
                    var pDate = pR[colMap.dateOut-1];
                    if (!foundSuper && pR[colMap.super-1] !== "" && pDate === dateStr) {
                        foundSuper = pR[colMap.super-1];
                    }
                    if (!foundTime && currentTrolleyID !== "" && pR[colMap.trolley-1].toString().trim() === currentTrolleyID && pDate === dateStr) {
                        foundTime = pR[colMap.time-1];
                    }
                    if (foundSuper && foundTime) break;
                }
            }

            var existingSuper = rowData[colMap.super-1].toString().trim();
            if (existingSuper === "" && foundSuper !== "") {
                sheet.getRange(curRow, colMap.super).setValue(foundSuper);
            }
            sheet.getRange(curRow, colMap.time).setValue(foundTime || timeStr);
        }
    }
  } catch (err) {
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Input Level Data").getRange("Z2").setValue("Error: " + err.toString());
  } finally {
    lock.releaseLock();
  }
}

/**
 * 2. SHIFT HELPER: Based on Manual IST Date
 */
function getShiftByTime(istDate) {
  var h = istDate.getUTCHours() + (istDate.getUTCMinutes() / 60);
  if (h >= 7 && h < 15.5) return "I";   
  if (h >= 15.5 && h < 23.5) return "II";
  return "III"; 
}

/**
 * 3. API PROXY: doGet (Dashboard Connection)
 */
function doGet(e) {
    try {
        var token = e.parameter.token;
        if (token !== API_TOKEN) return JSON_RESPONSE({ error: 'Unauthorized' });
        var action = e.parameter.action || 'read';
        var ss = SpreadsheetApp.getActiveSpreadsheet();

        // AUTH / USER MANAGEMENT
        if (action === 'verify') {
            var email = (e.parameter.email || '').toLowerCase().trim();
            var userSheet = ss.getSheetByName('Users');
            if (userSheet) {
                var userData = userSheet.getDataRange().getValues();
                var headers = userData[0];
                var emIdx = -1, nmIdx = -1, rlIdx = -1;
                for (var j = 0; j < headers.length; j++) {
                    var h = String(headers[j]).toLowerCase();
                    if (h.includes('email')) emIdx = j;
                    if (h.includes('name')) nmIdx = j;
                    if (h.includes('role')) rlIdx = j;
                }
                for (var i = 1; i < userData.length; i++) {
                    if (String(userData[i][emIdx]).toLowerCase().trim() === email) {
                        return JSON_RESPONSE({ success: true, user: { email: email, name: userData[i][nmIdx], role: userData[i][rlIdx] } });
                    }
                }
            }
            return JSON_RESPONSE({ success: false });
        }

        if (action === 'addUser') {
            var email = (e.parameter.email || '').toLowerCase().trim();
            var name = e.parameter.name || '';
            var role = e.parameter.role || 'User';
            var userSheet = ss.getSheetByName('Users');
            if (!userSheet) return JSON_RESPONSE({ error: 'Users sheet not found' });
            
            var userData = userSheet.getDataRange().getValues();
            var lastSr = userData.length > 1 ? parseInt(userData[userData.length-1][0]) : 0;
            userSheet.appendRow([lastSr + 1, name, email, role]);
            return JSON_RESPONSE({ success: true, message: 'User added successfully' });
        }

        // DATA
        var sheetName = e.parameter.sheet || 'Input Level Data';
        var sheet = ss.getSheetByName(sheetName);
        if (!sheet) return JSON_RESPONSE({ error: 'Sheet not found' });
        var data = sheet.getDataRange().getValues();
        var hds = data[0];
        var results = [];
        for (var i = 1; i < data.length; i++) {
            var obj = {};
            var hasVal = false;
            for (var j = 0; j < hds.length; j++) {
                var k = String(hds[j]).trim();
                var v = data[i][j];
                // Spreadsheet is already IST — just format directly
                if (v instanceof Date) {
                  v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd-MM-yyyy');
                }
                obj[k] = v;
                if (v !== '' && v !== 0 && v !== null) hasVal = true;
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
