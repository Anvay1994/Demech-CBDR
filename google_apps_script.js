// ============================================
// Demech CBDR — Google Apps Script API Proxy
// ============================================
// This script acts as a SECURE API to serve
// Google Sheets data to the Report Portal.
// The sheet itself stays PRIVATE — only this
// script can read it on your behalf.
//
// SETUP INSTRUCTIONS:
// 1. Open your Google Sheet
// 2. Go to Extensions → Apps Script
// 3. Delete any existing code in the editor
// 4. Paste this entire script
// 5. Click "Deploy" → "New deployment"
// 6. Type: "Web app"
// 7. Execute as: "Me" (your Google account)
// 8. Who has access: "Anyone"
//    (This makes the API endpoint accessible,
//     but NOT your raw sheet data)
// 9. Click "Deploy" → Copy the Web App URL
// 10. Paste the URL into app.js (APPS_SCRIPT_URL)
// ============================================

// Security token — must match the one in app.js
var API_TOKEN = 'demech_secure_2025';

function doGet(e) {
    // Verify the security token
    var token = e.parameter.token;
    if (token !== API_TOKEN) {
        return ContentService.createTextOutput(
            JSON.stringify({ error: 'Unauthorized' })
        ).setMimeType(ContentService.MimeType.JSON);
    }

    var sheetName = e.parameter.sheet || 'Report Format';
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
        return ContentService.createTextOutput(
            JSON.stringify({ error: 'Sheet not found: ' + sheetName })
        ).setMimeType(ContentService.MimeType.JSON);
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var rows = [];

    for (var i = 1; i < data.length; i++) {
        var row = {};
        var hasData = false;
        for (var j = 0; j < headers.length; j++) {
            var key = String(headers[j]).trim();
            var val = data[i][j];

            // Convert dates to string format
            if (val instanceof Date) {
                val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'dd-MM-yyyy');
            }

            row[key] = val;
            if (val !== '' && val !== 0 && val !== null) hasData = true;
        }
        if (hasData) rows.push(row);
    }

    var response = JSON.stringify({ data: rows });

    return ContentService.createTextOutput(response)
        .setMimeType(ContentService.MimeType.JSON);
}
