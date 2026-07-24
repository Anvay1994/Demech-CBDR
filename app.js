/* ===================================
   Demech CBDR Report Portal — App Logic
   Live Google Sheets ↔ Report Portal
   =================================== */

// ============ CONFIG ============
// INSTRUCTIONS:
// 1. Deploy the Google Apps Script (see google_apps_script.js)
// 2. Paste the Web App URL below
// 3. The sheet data stays PRIVATE — only the script can read it
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz7lmAiyM0GjJyyzpQHO1p120YxLqlYWQiiEkF3ZSVvoG8gl38EjRdp93dBe9jX7sB4/exec'; // ← PASTE YOUR WEB APP URL HERE
const API_TOKEN = 'demech_secure_2025'; // Must match the token in google_apps_script.js

const SHEETS = {
    report: 'Input Level Data',
    pipeMaster: 'Pipe Master',
    main: 'Summary Sheet',
    shiftLevel: 'Shift Level Data',
    dayLevel: 'Day Level Data'
};

let PIPE_MASTER_ORDER = [
    "P _598*400*25", "P _585*400*25", "P _489*400*20", "P _489*500*20", "P _480*400*24",
    "P _456*500*20", "P _450*500*25", "P _436*500*20", "P _432*500*20", "P _420*500*20",
    "P _406*600*20", "P _400*500*30", "P _386*500*20", "P _370*500*20", "P _356*500*20",
    "P _356*600*20", "P _345*500*20", "P _342*500*24.5", "P _341*500*20", "P _336*500*20",
    "P _320*500*25", "P _315*500*20", "P _305*500*30.5", "P _303*500*20", "P _297*500*23",
    "P _293*500*24.5", "P _287*500*20", "P _273*500*27", "P _260*500*20", "P _253*500*20",
    "P _248*500*20", "P _243*500*24", "P _232*500*20", "P _228*500*20", "P _218*500*20",
    "P _216*500*20", "P _203*500*30", "P _203*500*20", "P _193*500*25", "P _186*500*28.5",
    "P _185*500*20", "P _178*500*20", "P _173*500*26", "P _153*500*20", "P _143.7*500*24.5",
    "P _140*500*27", "P _128*500*20", "P _110*500*29", "P _103*500*20", "P _94*500*24.5",
    "P _78*400*20", "P _67*350*20", "P _53*350*20", "T _550*350*50", "T _250*350*50", "R _**"
];

function formatPipeSize(raw) {
    if (!raw) return '—';
    if (raw.includes('_') && raw.includes('*')) return raw;
    const formattedDims = raw.replace(/x/ig, '*');
    const match = PIPE_MASTER_ORDER.find(p => p.includes(formattedDims));
    if (match) return match;
    // Missing items have NO prefix so they stand out as mistakes
    return formattedDims;
}

function getPipeTypeScore(pipeSizeStr) {
    if (!pipeSizeStr) return 4;
    if (pipeSizeStr.startsWith('P _') || pipeSizeStr.startsWith('P_')) return 1; // Pipe
    if (pipeSizeStr.startsWith('T _') || pipeSizeStr.startsWith('T_')) return 2; // Trench
    if (pipeSizeStr.startsWith('R _') || pipeSizeStr.startsWith('R_')) return 3; // Reducer
    return 4; // Mistakes / No Prefix
}

function sortPipes(a, b) {
    const typeA = getPipeTypeScore(a);
    const typeB = getPipeTypeScore(b);
    if (typeA !== typeB) return typeA - typeB;
    
    // Extract numbers: e.g. "P_489*500*20" -> [489, 500, 20]
    const numsA = [...a.matchAll(/\d+(\.\d+)?/g)].map(m => parseFloat(m[0]));
    const numsB = [...b.matchAll(/\d+(\.\d+)?/g)].map(m => parseFloat(m[0]));
    
    // 1. Diameter: Largest first (Descending)
    const d1A = numsA[0] || 0, d1B = numsB[0] || 0;
    if (d1A !== d1B) return d1B - d1A; 
    
    // 2. Length: Smallest first (Ascending)
    const d2A = numsA[1] || 0, d2B = numsB[1] || 0;
    if (d2A !== d2B) return d2A - d2B; 
    
    // 3. Thickness: Largest first (Descending)
    const d3A = numsA[2] || 0, d3B = numsB[2] || 0;
    if (d3A !== d3B) return d3B - d3A; 
    
    return a.localeCompare(b);
}

function updatePipeMasterOrder(pmData) {
    if (!pmData || pmData.length === 0) return;
    
    const newOrder = [];
    
    // Add dynamically found unique pipe sizes
    pmData.forEach(row => {
        let uniqueSize = row['Unique Pipe Size'] || row['Unique Pipe Size '];
        if (uniqueSize) {
            uniqueSize = uniqueSize.trim();
            if (!newOrder.includes(uniqueSize)) {
                newOrder.push(uniqueSize);
            }
            // Add a "P _" spaced version just for backward compatibility with old hardcoded array if needed
            const spaced = uniqueSize.replace(/^([PTR])_/, '$1 _');
            if (spaced !== uniqueSize && !newOrder.includes(spaced)) {
                newOrder.push(spaced);
            }
        }
    });
    
    // Merge existing hardcoded order items that weren't dynamically found
    PIPE_MASTER_ORDER.forEach(item => {
        if (!newOrder.includes(item)) {
            newOrder.push(item);
        }
    });
    
    PIPE_MASTER_ORDER = newOrder;
}

// ============ STATE ============
let allData = [];
let pipeMasterData = [];
let shiftLevelData = [];
let dayLevelData = [];
let filteredData = [];
let currentTab = 'dashboard';
let dailySubTab = 'production';
let summaryPeriod = 'monthly';
let summaryView = 'production';
let summaryLevel = 'pipe';
let selectedFurnace = 'F2'; // Default to F2 (currently operational)

// Returns allData filtered by the current furnace selection
function getDataForFurnace() {
    if (selectedFurnace === 'all') return allData;
    return allData.filter(r => r.furnaceNum === selectedFurnace);
}

// Returns shiftLevelData filtered by the current furnace selection
function getShiftDataForFurnace() {
    if (selectedFurnace === 'all') return shiftLevelData;
    return shiftLevelData.filter(r => {
        const f = String(r['Furnace Num'] || '').trim().toUpperCase();
        return f === selectedFurnace;
    });
}

// Returns aggregated/filtered dayLevelData for the given date based on current furnace selection
function getDayLevelDataForDate(dateStr) {
    const formattedDate = String(dateStr || '').trim();
    if (!formattedDate) return null;

    const dateMatches = dayLevelData.filter(r => String(r['Date'] || '').trim() === formattedDate);
    if (dateMatches.length === 0) return null;

    if (selectedFurnace !== 'all') {
        // Find row specifically for selected furnace
        // Handle empty/missing furnace values as unknown
        return dateMatches.find(r => {
            const f = String(r['Furnace Num'] || '').trim().toUpperCase();
            return f === selectedFurnace;
        }) || null;
    } else {
        // Combine all matching rows for the same date (e.g. F1 and F2 records)
        const aggregated = {
            'Date': dateStr,
            'Electricity Consumption': null,
            'PNG Consumption': null,
            'Wire Mesh': null,
            'Tyre Oil': null,
            'Ignite Oil': null,
            'Labour Qty': null,
            'Furnace Num': 'Both'
        };
        let hasData = false;
        dateMatches.forEach(r => {
            hasData = true;
            const elecVal = r['Electricity Consumption'];
            if (elecVal !== undefined && elecVal !== null && elecVal !== '' && elecVal !== '—') {
                aggregated['Electricity Consumption'] = (aggregated['Electricity Consumption'] || 0) + parseFloat(elecVal);
            }
            const pngVal = r['PNG Consumption'];
            if (pngVal !== undefined && pngVal !== null && pngVal !== '' && pngVal !== '—') {
                aggregated['PNG Consumption'] = (aggregated['PNG Consumption'] || 0) + parseFloat(pngVal);
            }
            const wmVal = r['Wire Mesh'];
            if (wmVal !== undefined && wmVal !== null && wmVal !== '' && wmVal !== '—') {
                aggregated['Wire Mesh'] = (aggregated['Wire Mesh'] || 0) + parseFloat(wmVal);
            }
            const toVal = r['Tyre Oil'];
            if (toVal !== undefined && toVal !== null && toVal !== '' && toVal !== '—') {
                aggregated['Tyre Oil'] = (aggregated['Tyre Oil'] || 0) + parseFloat(toVal);
            }
            const ioVal = r['Ignite Oil'];
            if (ioVal !== undefined && ioVal !== null && ioVal !== '' && ioVal !== '—') {
                aggregated['Ignite Oil'] = (aggregated['Ignite Oil'] || 0) + parseFloat(ioVal);
            }
            const labVal = r['Labour Qty'];
            if (labVal !== undefined && labVal !== null && labVal !== '' && labVal !== '—') {
                aggregated['Labour Qty'] = (aggregated['Labour Qty'] || 0) + parseFloat(labVal);
            }
        });
        return hasData ? aggregated : null;
    }
}

function setFurnace(furnace) {
    selectedFurnace = furnace;
    document.querySelectorAll('.furnace-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.furnace-tab[data-furnace="${furnace}"]`)?.classList.add('active');
    // Re-populate filters for the selected furnace scope, then re-render
    populateFilterOptions();
    applyFilters();
}

// ============ AUTH CHECK ============
function checkAuth() {
    const isAuth = sessionStorage.getItem('demech_auth') === 'true' || localStorage.getItem('demech_auth') === 'true';
    if (!isAuth) {
        window.location.href = 'index.html';
        return false;
    }
    
    // Display user profile if available
    const name = sessionStorage.getItem('demech_user_name') || localStorage.getItem('demech_user_name');
    const role = sessionStorage.getItem('demech_user_role') || localStorage.getItem('demech_user_role');
    const profileEl = document.getElementById('userProfile');
    if (profileEl && name) {
        document.getElementById('userName').textContent = name;
        document.getElementById('userRole').textContent = role || 'User';
        profileEl.style.display = 'flex';
    }
    
    return true;
}

function logout() {
    sessionStorage.clear();
    localStorage.removeItem('demech_auth');
    localStorage.removeItem('demech_user_email');
    localStorage.removeItem('demech_user_name');
    localStorage.removeItem('demech_user_role');
    window.location.href = 'index.html';
}

// ============ CSV PARSER ============
function parseCSV(csvText) {
    const rows = [];
    let current = '';
    let inQuotes = false;
    const lines = [];

    // Split into lines handling quoted newlines
    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        if (char === '"') {
            inQuotes = !inQuotes;
            current += char;
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (current.trim()) lines.push(current);
            current = '';
            if (char === '\r' && csvText[i + 1] === '\n') i++;
        } else {
            current += char;
        }
    }
    if (current.trim()) lines.push(current);

    if (lines.length === 0) return [];

    // Parse header
    const headers = parseCSVLine(lines[0]);

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        const obj = {};
        let hasData = false;
        headers.forEach((h, idx) => {
            const key = h.trim();
            const val = (values[idx] || '').trim();
            obj[key] = val;
            if (val && val !== '0' && val !== '') hasData = true;
        });
        if (hasData) rows.push(obj);
    }

    return rows;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}

// ============ DATA FETCHER (Secure via Google Apps Script) ============
async function fetchSheetData(sheetName) {
    if (!APPS_SCRIPT_URL) {
        showSetupMode();
        return [];
    }

    const cacheKey = `demech_cache_${sheetName}`;
    const cacheTimeKey = `demech_cache_time_${sheetName}`;
    const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes cache

    const now = Date.now();
    const cachedTime = localStorage.getItem(cacheTimeKey);
    const cachedData = localStorage.getItem(cacheKey);

    // If cache is valid, return it instantly to make the UI blazing fast (0s load)
    if (cachedData && cachedTime && (now - parseInt(cachedTime) < CACHE_DURATION_MS)) {
        try {
            return JSON.parse(cachedData);
        } catch (e) {
            console.warn('Cache corrupted, fetching fresh data...');
        }
    }

    try {
        // Request the 2D compressed format to reduce payload size by 60%
        const url = `${APPS_SCRIPT_URL}?token=${encodeURIComponent(API_TOKEN)}&sheet=${encodeURIComponent(sheetName)}&format=2d`;

        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow'
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const json = await response.json();

        if (json.error) {
            throw new Error(json.error);
        }

        let parsedData = [];

        // Handle 2D Compressed Array Format
        if (json.data && json.data.headers && Array.isArray(json.data.rows)) {
            const headers = json.data.headers;
            parsedData = json.data.rows.map(rowArray => {
                const obj = {};
                for (let i = 0; i < headers.length; i++) {
                    obj[headers[i]] = rowArray[i];
                }
                return obj;
            });
        } else {
            // Fallback for legacy format
            parsedData = json.data || [];
        }

        // Save fresh data to cache for next time
        try {
            localStorage.setItem(cacheKey, JSON.stringify(parsedData));
            localStorage.setItem(cacheTimeKey, now.toString());
        } catch (e) {
            console.warn('Local storage quota exceeded, skipping cache');
        }

        return parsedData;

    } catch (err) {
        console.error(`Error fetching sheet "${sheetName}":`, err);

        // If fetch fails but we have stale cache, use it as fallback
        if (cachedData) {
            try {
                showToast(`Network error. Loading cached data...`, 'warning');
                return JSON.parse(cachedData);
            } catch (e) {}
        }

        if (err instanceof TypeError || err.message === 'Failed to fetch') {
            const corsMsg = `Connection Blocked (CORS). Please ensure your Google Apps Script is deployed as "Web App", with "Execute as: Me" and "Who has access: Anyone".`;
            showToast(corsMsg, 'error');
            throw new Error(corsMsg);
        }

        throw err;
    }
}

function showSetupMode() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.innerHTML = `
            <div style="max-width: 600px; text-align: center;">
                <h3 style="color: var(--accent-amber); margin-bottom: 1rem;">⚙️ Setup Required</h3>
                <p style="margin-bottom: 1.5rem; color: var(--text-secondary);">
                    To keep your data <strong>private and secure</strong>, you need to deploy a Google Apps Script as an API.
                </p>
                <div style="text-align: left; background: rgba(255,255,255,0.03); padding: 1.5rem; border-radius: 12px; border: 1px solid rgba(255,255,255,0.08);">
                    <p style="margin-bottom: 0.75rem; font-weight: 600;">Steps:</p>
                    <ol style="padding-left: 1.25rem; line-height: 2;">
                        <li>Open your Google Sheet → <strong>Extensions → Apps Script</strong></li>
                        <li>Delete existing code, paste from <code>google_apps_script.js</code></li>
                        <li>Click <strong>Deploy → New deployment</strong></li>
                        <li>Type: <strong>Web app</strong></li>
                        <li>Execute as: <strong>Me</strong> &nbsp;|&nbsp; Access: <strong>Anyone</strong></li>
                        <li>Click <strong>Deploy</strong> → Copy the Web App URL</li>
                        <li>Open <code>app.js</code> and paste the URL in <code>APPS_SCRIPT_URL</code></li>
                        <li>Refresh this page</li>
                    </ol>
                </div>
                <p style="margin-top: 1rem; font-size: 0.8rem; color: var(--text-muted);">
                    🔒 Your sheet data stays private — only the script can read it, protected by a security token.
                </p>
            </div>
        `;
        overlay.style.display = 'flex';
    }
}

// ============ DATA TRANSFORMATION ============

// Parse the report data into structured objects
function transformReportData(rawData) {
    console.log('Raw Data received from API:', rawData);
    if (!rawData || !rawData.length) {
        console.warn("Raw data is empty or invalid!");
        return [];
    }

    const transformed = rawData.map((row, idx) => {
        const dateShift = row['Date_Shift'] || row['Date_shift'] || '';

        let shift = '';
        const rawShift = (row['Input Shift'] || '').trim().toLowerCase();
        if (rawShift === 'l') shift = 'I';
        else if (rawShift === 'll') shift = 'II';
        else if (rawShift === 'lll') shift = 'III';

        // fallback to Date_shift extraction if Shift col isn't found
        if (!shift) {
            const shiftMap = { '_lll': 'III', '_ll': 'II', '_l': 'I' };
            for (const [suffix, label] of Object.entries(shiftMap)) {
                if (dateShift.toLowerCase().endsWith(suffix)) {
                    shift = label;
                    break;
                }
            }
        }

        // Robust mapping: try exact match, then any key containing the keyword
        const getField = (row, keywords, exactFavors, excludes = []) => {
            const allKeys = Object.keys(row);
            
            // 1. Case-insensitive match from a preferred list
            for (const favor of exactFavors) {
                const match = allKeys.find(k => k.toLowerCase().trim() === favor.toLowerCase().trim());
                if (match && row[match] !== undefined && row[match] !== null && String(row[match]).trim() !== '') {
                    return String(row[match]).trim();
                }
            }

            // 2. Try any key containing keywords (with exclusions)
            for (const key of allKeys) {
                const lowerKey = key.toLowerCase();
                if (excludes.some(e => lowerKey.includes(e.toLowerCase()))) continue;
                
                if (keywords.some(k => lowerKey.includes(k.toLowerCase()))) {
                    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return String(row[key]).trim();
                }
            }
            return '';
        };

        // --- Quantities & Weights (using getField for flexible matching) ---
        const totalPipes = parseInt(getField(row, ['prod qty', 'total pipe', 'total nos', 'total qty'], ['Prod Qty', 'Total Pipe Number', 'Total (Nos)'])) || 0;
        const accepted = parseInt(getField(row, ['accepted pipes', 'accepted (nos)', 'accept'], ['Accepted Pipes', 'Accepted (Nos)', 'Accept (Nos)'])) || 0;
        const rejected = parseInt(getField(row, ['rejected pipes', 'rejected (nos)', 'reject'], ['Rejected Pipes', 'Rejected (Nos)', 'Reject (Nos)'])) || 0;
        
        const wtPerPipe = parseFloat(getField(row, ['wt', 'wt per pipe'], ['WT', 'WT Per Pipe'])) || 0;
        const totalWt = parseFloat(getField(row, ['prod wt', 'total wt'], ['Prod wt', 'Total WT Pipes (KG)', 'Total Wt'])) || 0;
        const acceptedWt = parseFloat(getField(row, ['accepted wt', 'acc wt'], ['Accepted Wt', 'Acc. Wt (Kg.)', 'Acc Wt'])) || 0;

        // Calculate rejected weight
        const rawRejectedWt = getField(row, ['rejected wt', 'rej wt'], ['Rejected Wt', 'Rej. Wt (Kg.)', 'Rej Wt']);
        const rejectedWt = rawRejectedWt !== "" ? parseFloat(rawRejectedWt) : (totalWt - acceptedWt);

        let qcShift = '';
        const rawQcShift = (row['Shift'] || '').trim().toLowerCase();
        if (rawQcShift === 'l' || rawQcShift === 'i' || rawQcShift === '1') qcShift = 'I';
        else if (rawQcShift === 'll' || rawQcShift === 'ii' || rawQcShift === '2') qcShift = 'II';
        else if (rawQcShift === 'lll' || rawQcShift === 'iii' || rawQcShift === '3') qcShift = 'III';
        else qcShift = (row['Shift'] || '').trim();

        // Use Input Date — handle both DD-MM-YYYY (from Apps Script) and ISO formats
        const parseDateInput = (inputVal) => {
            if (!inputVal) return '';
            const ddmmyyyy = inputVal.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
            if (ddmmyyyy) {
                return `${ddmmyyyy[1].padStart(2, '0')}-${ddmmyyyy[2].padStart(2, '0')}-${ddmmyyyy[3]}`;
            }
            const d = new Date(inputVal);
            if (!isNaN(d.getTime())) {
                const dd = String(d.getDate()).padStart(2, '0');
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const yyyy = d.getFullYear();
                return `${dd}-${mm}-${yyyy}`;
            }
            return '';
        };

        const rawDate = parseDateInput(String(row['Input Date'] || row['Date'] || '').trim());
        let rawQcDate = parseDateInput(String(row['Date for Output'] || '').trim());

        const supervisor = getField(row, ['supervisor'], ['Production Supervisor', 'Production Supervisor Name', 'Supervisor'], ['Time', 'Date', 'Shift']);
        const qcName = getField(row, ['qc', 'quality supervisor'], ['QC Supervisor', 'QC Supervisor Name', 'QC Name', 'Name'], ['Time', 'Date', 'Shift']);
        const trolleyNo = getField(row, ['trolley'], ['Trolley no', 'Trolley No', 'Trolley No.']);

        const lDateRaw = getField(row, ['loading date', 'input date'], ['Loading Date', 'Input Date', 'Input Date ']);
        const lTimeRaw = getField(row, ['loading time'], ['Loading Time', 'Loading time']);
        const qTimeRaw = getField(row, ['qc time'], ['QC Time', 'QC time', 'QC Time ']);

        return {
            sourceRows: [row['ID'] || row['Related ID'] || (idx + 2)],
            dateShift: dateShift,
            date: rawDate,
            shift: shift,
            qcDate: rawQcDate,
            qcShift: qcShift,
            supervisor: supervisor,
            qcName: qcName,
            loadingDate: formatDate(lDateRaw),
            loadingTime: formatTimeLocal(lTimeRaw),
            qcTime: formatTimeLocal(qTimeRaw),
            hoursCycle: calculateCycleTime(lDateRaw, lTimeRaw, rawQcDate, qTimeRaw),
            pipeSize: formatPipeSize(row['Pipe Size_Calculated']),
            trolleyNo: trolleyNo,
            prodRej: parseFloat(row['Prod Rej'] || row['Prod. Rej.'] || 0) || 0,
            prodRejWt: (parseFloat(row['Prod Rej'] || row['Prod. Rej.'] || 0) || 0) * wtPerPipe,
            totalPipes,
            wtPerPipe,
            totalWt,
            accepted,
            rejected,
            cavity: parseInt(row['Cavity']) || 0,
            cracks: parseInt(row['Cracks']) || 0,
            rCracks: parseInt(row['R cracks']) || parseInt(row['R Cracks']) || 0,
            ovality: parseInt(row['Ovality']) || 0,
            others: parseInt(row['Others']) || 0,
            acceptedWt,
            rejectedWt: Math.abs(rejectedWt),
            status: (row['Status'] || '').trim(),
            furnaceNum: (row['Furnace Num'] || '').trim().toUpperCase() || 'Unknown'
        };
    }).filter(r => (r.date && r.date !== "") || (r.totalPipes > 0) || (r.qcName && r.qcName !== ""));

    // Aggregate by date + shift + qcDate + qcShift + supervisor + pipeSize so each pipe size is unique per group
    const aggMap = {};
    transformed.forEach(r => {
        // Group by Date, Shift, QC Date, QC Shift, Supervisor, Pipe Size AND Trolley No for subtotals
        const key = `${r.date}|${r.shift}|${r.qcDate}|${r.qcShift}|${r.supervisor}|${r.pipeSize}|${r.trolleyNo}|${r.furnaceNum}`;
        if (!aggMap[key]) {
            aggMap[key] = {
                sourceRows: [],
                dateShift: r.dateShift,
                date: r.date,
                shift: r.shift,
                qcDate: r.qcDate,
                qcShift: r.qcShift,
                supervisor: r.supervisor,
                qcNames: new Set(),
                pipeSize: r.pipeSize,
                trolleyNo: r.trolleyNo,
                prodRej: 0,
                prodRejWt: 0,
                totalPipes: 0,
                wtPerPipe: r.wtPerPipe,
                loadingDate: r.loadingDate,
                loadingTime: r.loadingTime,
                qcTime: r.qcTime,
                hoursCycle: r.hoursCycle,
                totalWt: 0,
                accepted: 0,
                rejected: 0,
                cavity: 0,
                cracks: 0,
                rCracks: 0,
                ovality: 0,
                others: 0,
                acceptedWt: 0,
                rejectedWt: 0,
                furnaceNum: r.furnaceNum,
                statuses: new Set()
            };
        }
        const a = aggMap[key];
        a.sourceRows.push(...r.sourceRows);
        if (r.qcName) a.qcNames.add(r.qcName);
        a.prodRej += r.prodRej;
        a.prodRejWt += r.prodRejWt;
        a.totalPipes += r.totalPipes;
        a.totalWt += r.totalWt;
        a.accepted += r.accepted;
        a.rejected += r.rejected;
        a.cavity += r.cavity;
        a.cracks += r.cracks;
        a.rCracks += r.rCracks;
        a.ovality += r.ovality;
        a.others += r.others;
        a.acceptedWt += r.acceptedWt;
        a.rejectedWt += r.rejectedWt;
        if (r.status) a.statuses.add(r.status);
    });

    // Calculate percentages after aggregation
    const aggregated = Object.values(aggMap).map(r => {
        const rejPct = r.totalWt > 0 ? ((r.rejectedWt / r.totalWt) * 100).toFixed(1) + '%' : '0.0%';
        const accPct = r.totalWt > 0 ? ((r.acceptedWt / r.totalWt) * 100).toFixed(1) + '%' : '0.0%';
        return { ...r, qcName: [...r.qcNames].join(', '), status: [...(r.statuses || [])].join(', '), rejectedPct: rejPct, acceptedPct: accPct };
    });

    console.log('Aggregated rows:', aggregated.length, '(from', transformed.length, 'raw rows)');
    return aggregated;
}

// ============ DATE HELPERS ============
function parseDate(dateStr) {
    if (!dateStr) return null;
    const s = String(dateStr);

    // Handle YYYY-MM-DD format directly
    if (s.match(/^\d{4}-\d{2}-\d{2}/)) {
        return new Date(s);
    }

    // Handle DD-MM-YYYY format or DD-MMM-YYYY format
    const parts = s.split('-');
    if (parts.length === 3) {
        const [d, m, y] = parts;
        const mInt = parseInt(m);
        if (!isNaN(mInt)) {
            // It's a number like '07'
            return new Date(parseInt(y), mInt - 1, parseInt(d));
        }
        // It's a string like 'Jul', fallback to new Date()
    }
    return new Date(s);
}

function formatDate(dateStr) {
    const d = parseDate(dateStr);
    if (!d || isNaN(d.getTime())) return dateStr;
    // If it's the 1899 epoch (time-only), don't show it as a date
    if (d.getFullYear() < 1920) return '';
    
    return d.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    }).replace(/ /g, '-');
}

function formatTimeLocal(timeStr) {
    if (!timeStr) return '';
    const d = new Date(timeStr);
    if (isNaN(d.getTime())) return timeStr;
    // If timeStr doesn't look like an ISO date, just return it
    if (!String(timeStr).includes('T')) return timeStr;
    
    // Convert to India time (or browser local)
    return d.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

function formatDuration(val) {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d.getTime()) || !String(val).includes('T')) return val;
    
    // Google Sheets uses 1899-12-30 00:00:00 as the base for DURATIONS
    const base = new Date('1899-12-30T00:00:00.000Z');
    const diffMs = d.getTime() - base.getTime();
    
    const totalSeconds = Math.round(diffMs / 1000);
    const absSeconds = Math.abs(totalSeconds);
    const hours = Math.floor(absSeconds / 3600);
    const minutes = Math.floor((absSeconds % 3600) / 60);
    const seconds = absSeconds % 60;
    
    return `${totalSeconds < 0 ? '-' : ''}${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function calculateCycleTime(loadingDate, loadingTime, qcDate, qcTime) {
    if (!loadingDate || !qcDate) return '—';
    const lDate = parseDate(loadingDate);
    const qDate = parseDate(qcDate);
    if (!lDate || !qDate) return '—';

    const getHMS = (timeStr) => {
        if (!timeStr) return { h: 0, m: 0, s: 0 };
        const s = String(timeStr).trim();
        if (s.includes('T')) {
            const t = new Date(s);
            if (!isNaN(t.getTime())) {
                if (s.includes('Z')) return { h: t.getUTCHours(), m: t.getUTCMinutes(), s: t.getUTCSeconds() };
                return { h: t.getHours(), m: t.getMinutes(), s: t.getSeconds() };
            }
        }
        const parts = s.split(':');
        return {
            h: parseInt(parts[0]) || 0,
            m: parseInt(parts[1]) || 0,
            s: parseInt(parts[2]) || 0
        };
    };

    const lt = getHMS(loadingTime);
    const qt = getHMS(qcTime);
    const start = new Date(lDate); start.setHours(lt.h, lt.m, lt.s, 0);
    const end = new Date(qDate); end.setHours(qt.h, qt.m, qt.s, 0);
    
    const diffMs = end.getTime() - start.getTime();
    if (diffMs < 0) return '0:00:00';

    const totalSec = Math.round(diffMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getRejectionTooltip(r) {
    const parts = [];
    if (r.cavity > 0) parts.push(`Cavity: ${r.cavity}`);
    if (r.cracks > 0) parts.push(`Cracks: ${r.cracks}`);
    if (r.rCracks > 0) parts.push(`R Cracks: ${r.rCracks}`);
    if (r.ovality > 0) parts.push(`Ovality: ${r.ovality}`);
    if (r.others > 0) parts.push(`Others: ${r.others}`);
    return parts.length > 0 ? parts.join('\n') : 'No specific defect details';
}

function getMonthKey(dateStr) {
    const d = parseDate(dateStr);
    if (!d || isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getYearKey(dateStr) {
    const d = parseDate(dateStr);
    if (!d || isNaN(d.getTime())) return '';
    return `${d.getFullYear()}`;
}

function getWeekKey(dateStr) {
    const d = parseDate(dateStr);
    if (!d) return dateStr;
    // Get Monday of the week
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d);
    monday.setDate(diff);
    return monday.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function getDateRangeLabel(data) {
    if (data.length === 0) return '';
    const dates = data.map(r => parseDate(r.date)).filter(d => d);
    if (dates.length === 0) return '';
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const opts = { day: '2-digit', month: 'short', year: 'numeric' };
    if (minDate.toDateString() === maxDate.toDateString()) {
        return minDate.toLocaleDateString('en-IN', opts);
    }
    return `${minDate.toLocaleDateString('en-IN', opts)} – ${maxDate.toLocaleDateString('en-IN', opts)}`;
}

// ============ FILTER LOGIC ============
function applyFilters() {
    const dateFrom = document.getElementById('filterDateFrom')?.value;
    const dateTo = document.getElementById('filterDateTo')?.value;
    const shift = document.getElementById('filterShift')?.value;
    const supervisor = document.getElementById('filterSupervisor')?.value;
    const qcSupervisor = document.getElementById('filterQCName')?.value;
    const pipeSize = document.getElementById('filterPipeSize')?.value;
    const trolley = document.getElementById('filterTrolley')?.value;

    const furnaceScoped = getDataForFurnace();
    filteredData = furnaceScoped.filter(row => {
        const isQualityTab = (currentTab === 'quality');
        const rowDateToCompare = isQualityTab ? row.qcDate : row.date;

        // Date filter
        if (dateFrom) {
            const rowDate = parseDate(rowDateToCompare);
            if (!rowDate) return false;
            const parts = dateFrom.split('-');
            const fromDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            if (rowDate < fromDate) return false;
        }
        if (dateTo) {
            const rowDate = parseDate(rowDateToCompare);
            if (!rowDate) return false;
            const parts = dateTo.split('-');
            const toDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            if (rowDate > toDate) return false;
        }
        // Shift filter
        const rowShiftToCompare = isQualityTab ? (row.qcShift || row.shift) : row.shift;
        if (shift && shift !== 'all' && rowShiftToCompare !== shift) return false;
        // Production Supervisor filter
        if (supervisor && supervisor !== 'all' && row.supervisor !== supervisor) return false;
        // Quality Supervisor filter (check if name is in comma-separated list)
        if (qcSupervisor && qcSupervisor !== 'all') {
            const names = (row.qcName || '').split(',').map(n => n.trim());
            if (!names.includes(qcSupervisor)) return false;
        }
        // Pipe Size filter
        if (pipeSize && pipeSize !== 'all' && row.pipeSize !== pipeSize) return false;
        // Trolley filter
        if (trolley && trolley !== 'all' && row.trolleyNo !== trolley) return false;

        return true;
    });

    renderAll();
}

function resetFilters() {
    if (document.getElementById('filterDateFrom')) document.getElementById('filterDateFrom').value = '';
    if (document.getElementById('filterDateTo')) document.getElementById('filterDateTo').value = '';
    if (document.getElementById('filterShift')) document.getElementById('filterShift').value = 'all';
    if (document.getElementById('filterSupervisor')) document.getElementById('filterSupervisor').value = 'all';
    if (document.getElementById('filterQCName')) document.getElementById('filterQCName').value = 'all';
    if (document.getElementById('filterPipeSize')) document.getElementById('filterPipeSize').value = 'all';
    if (document.getElementById('filterTrolley')) document.getElementById('filterTrolley').value = 'all';
    
    filteredData = [...allData];
    renderAll();
}

function populateFilterOptions() {
    const furnaceScoped = getDataForFurnace();
    const supervisors = [...new Set(furnaceScoped.map(r => r.supervisor))].sort();
    const pipeSizes = [...new Set(furnaceScoped.map(r => r.pipeSize))].filter(Boolean).sort(sortPipes);
    const trolleys = [...new Set(furnaceScoped.map(r => r.trolleyNo))].filter(Boolean).sort();
    
    // Collect all unique QC names (handling comma separation)
    const qcSet = new Set();
    furnaceScoped.forEach(r => {
        (r.qcName || '').split(',').forEach(n => {
            const name = n.trim();
            if (name && name !== '—') qcSet.add(name);
        });
    });
    const qcSupervisors = [...qcSet].sort();

    const supSelect = document.getElementById('filterSupervisor');
    const qcSelect = document.getElementById('filterQCName');
    const psSelect = document.getElementById('filterPipeSize');
    const trolSelect = document.getElementById('filterTrolley');

    if (supSelect) {
        supSelect.innerHTML = '<option value="all">All Supervisors</option>';
        supervisors.forEach(s => {
            supSelect.innerHTML += `<option value="${s}">${s}</option>`;
        });
    }

    if (qcSelect) {
        qcSelect.innerHTML = '<option value="all">All Supervisors</option>';
        qcSupervisors.forEach(q => {
            qcSelect.innerHTML += `<option value="${q}">${q}</option>`;
        });
    }

    if (psSelect) {
        psSelect.innerHTML = '<option value="all">All Sizes</option>';
        pipeSizes.forEach(ps => {
            psSelect.innerHTML += `<option value="${ps}">${ps}</option>`;
        });
    }

    if (trolSelect) {
        trolSelect.innerHTML = '<option value="all">All Trolleys</option>';
        trolleys.forEach(t => {
            trolSelect.innerHTML += `<option value="${t}">${t}</option>`;
        });
    }
}

// ============ KPI RENDERING ============
function renderKPIs() {
    const data = filteredData;
    const totalPipes = data.reduce((s, r) => s + (r.totalPipes || 0), 0);
    const totalWt = data.reduce((s, r) => s + (r.totalWt || 0), 0);
    const totalAccepted = data.reduce((s, r) => s + (r.status === 'QC Checked' ? r.accepted : 0), 0);
    const totalRejected = data.reduce((s, r) => s + (r.status === 'QC Checked' ? r.rejected : 0), 0);
    const totalAcceptedWt = data.reduce((s, r) => s + (r.status === 'QC Checked' ? r.acceptedWt : 0), 0);
    const totalRejectedWt = data.reduce((s, r) => s + (r.status === 'QC Checked' ? r.rejectedWt : 0), 0);
    const totalWtCalc = totalAcceptedWt + totalRejectedWt;
    const acceptPct = totalWtCalc > 0 ? ((totalAcceptedWt / totalWtCalc) * 100).toFixed(1) : '0.0';
    const rejectPct = totalWtCalc > 0 ? ((totalRejectedWt / totalWtCalc) * 100).toFixed(1) : '0.0';

    document.getElementById('kpiTotalWeight').textContent = (totalWt / 1000).toFixed(1) + 'T';
    document.getElementById('kpiAcceptWeight').textContent = (totalAcceptedWt / 1000).toFixed(1) + 'T';
    document.getElementById('kpiRejectWeight').textContent = (totalRejectedWt / 1000).toFixed(1) + 'T';
    document.getElementById('kpiRejectRate').textContent = rejectPct + '%';

    // Show date range context
    const rangeLabel = getDateRangeLabel(data);
    const uniqueDays = new Set(data.map(r => r.date)).size;
    const dateStr = (rangeLabel ? ` · ${uniqueDays} day${uniqueDays !== 1 ? 's' : ''} (${rangeLabel})` : '');
    
    document.getElementById('kpiSubPipes').textContent = `${totalPipes.toLocaleString('en-IN')} pipes` + dateStr;
    document.getElementById('kpiSubAccept').textContent = `${totalAccepted.toLocaleString('en-IN')} pipes accepted`;
    document.getElementById('kpiSubReject').textContent = `${totalRejected.toLocaleString('en-IN')} pipes rejected`;
}

// ============ PRODUCTION REPORT TABLE ============
function renderProductionReport() {
    const data = filteredData;
    const tbody = document.getElementById('prodReportBody');
    tbody.innerHTML = '';

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="13" class="empty-state">No data available</td></tr>';
        return;
    }

    // Group by Date → Shift → Supervisor → Trolley → Pipe Sizes
    const groups = {};
    data.forEach(row => {
        const key = `${row.date}|${row.shift}|${row.supervisor}|${row.trolleyNo}`;
        if (!groups[key]) {
            groups[key] = {
                date: row.date,
                shift: row.shift,
                supervisor: row.supervisor,
                trolleyNo: row.trolleyNo,
                pipes: []
            };
        }
        groups[key].pipes.push(row);
    });

    // Sort groups: New to Old (Descending)
    const sortedGroups = Object.values(groups).sort((a, b) => {
        const dateA = parseDate(a.date);
        const dateB = parseDate(b.date);
        if (dateA && dateB && dateA.getTime() !== dateB.getTime()) return dateB - dateA;
        if (a.shift !== b.shift) return a.shift.localeCompare(b.shift);
        return a.supervisor.localeCompare(b.supervisor);
    });

    // Grand totals
    let gtQty = 0, gtAcc = 0, gtRej = 0, gtTotalWt = 0, gtAccWt = 0, gtRejWt = 0;

    let srNo = 1;
    sortedGroups.forEach(group => {
        // Subtotals for this group
        let stQty = 0, stAcc = 0, stRej = 0, stTotalWt = 0, stAccWt = 0, stRejWt = 0;
        let stProdRej = 0, stProdRejWt = 0;

        group.pipes.forEach((pipe, idx) => {
            const tr = document.createElement('tr');
            if (idx === 0) tr.classList.add('group-start');
            else {
                tr.classList.add('sub-row');
                tr.classList.add('prod-sub-row');
            }

            const totalWt = pipe.totalWt;
            const acceptedWt = pipe.acceptedWt;
            const rejectedWt = pipe.rejectedWt;
            const rejPct = parseFloat(pipe.rejectedPct) || 0;
            const rateClass = rejPct > 30 ? 'danger' : rejPct > 15 ? 'warning' : 'good';

            // Accumulate subtotals
            stQty += pipe.totalPipes;
            stAcc += pipe.accepted;
            stRej += pipe.rejected;
            stTotalWt += totalWt;
            stAccWt += acceptedWt;
            stRejWt += rejectedWt;
            stProdRej += pipe.prodRej;
            stProdRejWt += pipe.prodRejWt;

            tr.innerHTML = `
        <td>${idx === 0 ? srNo : ''}</td>
        <td class="col-bl">${pipe.prodRej}</td>
        <td class="col-bl">${pipe.prodRejWt.toFixed(1)}</td>
        <td>${idx === 0 ? formatDate(group.date) : ''}</td>
        <td>${idx === 0 ? group.shift : ''}</td>
        <td>${idx === 0 ? group.supervisor : ''}</td>
        <td>${pipe.pipeSize}</td>
        <td>${pipe.trolleyNo}</td>
        <td>${pipe.totalPipes}</td>
        <td class="badge-accepted">${pipe.accepted}</td>
        <td class="badge-rejected">${pipe.rejected}</td>
        <td>${totalWt.toFixed(1)}</td>
        <td>${acceptedWt.toFixed(1)}</td>
        <td>${rejectedWt.toFixed(1)}</td>
        <td><span class="badge-rate ${rateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${pipe.rejectedPct}</span></td>
      `;
            tbody.appendChild(tr);
        });

        // Subtotal row
        const stRejPct = stTotalWt > 0 ? ((stRejWt / stTotalWt) * 100).toFixed(1) : '0.0';
        const stRateClass = parseFloat(stRejPct) > 30 ? 'danger' : parseFloat(stRejPct) > 15 ? 'warning' : 'good';
        const stRow = document.createElement('tr');
        stRow.classList.add('subtotal-row');
        stRow.innerHTML = `
        <td></td>
        <td class="col-bl"><strong>${stProdRej}</strong></td>
        <td class="col-bl"><strong>${stProdRejWt.toFixed(1)}</strong></td>
        <td colspan="4"></td>
        <td style="text-align:right;"><strong>Subtotal</strong></td>
        <td><strong>${stQty}</strong></td>
        <td><strong>${stAcc}</strong></td>
        <td><strong>${stRej}</strong></td>
        <td><strong>${stTotalWt.toFixed(1)}</strong></td>
        <td><strong>${stAccWt.toFixed(1)}</strong></td>
        <td><strong>${stRejWt.toFixed(1)}</strong></td>
        <td><strong><span class="badge-rate ${stRateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${stRejPct}%</span></strong></td>
      `;
        tbody.appendChild(stRow);

        // Accumulate grand totals
        gtQty += stQty;
        gtAcc += stAcc;
        gtRej += stRej;
        gtTotalWt += stTotalWt;
        gtAccWt += stAccWt;
        gtRejWt += stRejWt;

        srNo++;
    });

    // Grand Total row
    const gtRejPct = gtTotalWt > 0 ? ((gtRejWt / gtTotalWt) * 100).toFixed(1) : '0.0';
    const gtRateClass = parseFloat(gtRejPct) > 30 ? 'danger' : parseFloat(gtRejPct) > 15 ? 'warning' : 'good';
    const gtRow = document.createElement('tr');
    gtRow.classList.add('grand-total-row');
    
    // Calculate BL Grand Totals
    const gtProdRej = data.reduce((s, r) => s + r.prodRej, 0);
    const gtProdRejWt = data.reduce((s, r) => s + r.prodRejWt, 0);

    gtRow.innerHTML = `
        <td></td>
        <td class="col-bl"><strong>${gtProdRej}</strong></td>
        <td class="col-bl"><strong>${gtProdRejWt.toFixed(1)}</strong></td>
        <td colspan="4"></td>
        <td style="text-align:right;"><strong>Grand Total</strong></td>
        <td><strong>${gtQty}</strong></td>
        <td><strong>${gtAcc}</strong></td>
        <td><strong>${gtRej}</strong></td>
        <td><strong>${gtTotalWt.toFixed(1)}</strong></td>
        <td><strong>${gtAccWt.toFixed(1)}</strong></td>
        <td><strong>${gtRejWt.toFixed(1)}</strong></td>
        <td><strong><span class="badge-rate ${gtRateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${gtRejPct}%</span></strong></td>
      `;
    tbody.appendChild(gtRow);

    // Update count badge
    const badge = document.getElementById('prodReportCount');
    if (badge) badge.textContent = `${Object.keys(groups).length} groups · ${data.length} rows`;
}

// ============ PRODUCTION SUMMARY TABLE ============
function renderProductionSummary() {
    const data = filteredData;
    const tbody = document.getElementById('prodSummaryBody');
    tbody.innerHTML = '';

    // Group by supervisor and shift
    const supGroups = {};
    data.forEach(row => {
        const sup = row.supervisor || '—';
        const shift = row.shift || '—';
        const key = `${sup}_${shift}`;
        
        if (!supGroups[key]) {
            supGroups[key] = {
                supervisor: sup,
                shift: shift,
                totalPipes: 0,
                accepted: 0,
                rejected: 0,
                totalWt: 0,
                acceptedWt: 0,
                rejectedWt: 0
            };
        }
        supGroups[key].totalPipes += row.totalPipes;
        supGroups[key].accepted += row.accepted;
        supGroups[key].rejected += row.rejected;
        supGroups[key].totalWt += row.totalWt;
        supGroups[key].acceptedWt += row.acceptedWt;
        supGroups[key].rejectedWt += row.rejectedWt;
    });

    let srNo = 1;
    Object.values(supGroups).sort((a, b) => {
        const supCmp = a.supervisor.localeCompare(b.supervisor);
        if (supCmp !== 0) return supCmp;
        return a.shift.toString().localeCompare(b.shift.toString());
    }).forEach(group => {
        const rejPct = group.totalWt > 0 ? ((group.rejectedWt / group.totalWt) * 100).toFixed(1) : '0.0';
        const rateClass = parseFloat(rejPct) > 30 ? 'danger' : parseFloat(rejPct) > 15 ? 'warning' : 'good';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${srNo++}</td>
            <td><strong>${group.shift}</strong></td>
            <td><strong>${group.supervisor}</strong></td>
            <td>${group.totalPipes}</td>
            <td>${group.accepted}</td>
            <td>${group.rejected}</td>
            <td>${group.totalWt.toFixed(1)}</td>
            <td>${group.acceptedWt.toFixed(1)}</td>
            <td>${group.rejectedWt.toFixed(1)}</td>
            <td><span class="badge-rate ${rateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${rejPct}%</span></td>
        `;
        tbody.appendChild(tr);
    });

    // Update count badge
    const badge = document.getElementById('prodReportCount');
    if (badge) badge.textContent = `${Object.keys(supGroups).length} supervisors · ${data.length} rows`;
}

// ============ QUALITY REPORT TABLE ============
function renderQualityReport() {
    // Only show QC Checked data in this report
    const data = filteredData.filter(r => r.status === 'QC Checked');
    const tbody = document.getElementById('qualReportBody');
    const showTimeline = document.getElementById('toggleTimeline')?.checked !== false;
    
    // Update headers dynamically
    const thead = document.querySelector('#section-quality .report-table thead');
    if (thead) {
        thead.innerHTML = `
            <tr>
                <th>Sr.No.</th>
                <th>Date</th>
                <th>Shift</th>
                <th>QC Name</th>
                <th>Prod Sup</th>
                <th>Pipe Size</th>
                <th>Trolley No.</th>
                ${showTimeline ? '<th>Loading Date</th><th>Loading Time</th><th>QC Time</th><th>Hours Cycle</th>' : ''}
                <th>Total Qty</th>
                <th>Accept (Nos)</th>
                <th>Reject (Nos)</th>
                <th>Total Wt</th>
                <th>Acc Wt</th>
                <th>Rej Wt</th>
                <th>Rej %</th>
            </tr>`;
    }

    tbody.innerHTML = '';

    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${showTimeline ? 17 : 13}" class="empty-state">No data available</td></tr>`;
        return;
    }

    // Group by QC Date → QC Shift → Quality Supervisor Name
    const groups = {};
    data.forEach(row => {
        const names = (row.qcName || '—').split(',').map(n => n.trim()).filter(n => n);
        if (names.length === 0) names.push('—');

        names.forEach(qc => {
            const dateToUse = row.qcDate;
            const shiftToUse = row.qcShift || row.shift;
            const key = `${dateToUse}|${shiftToUse}|${qc}|${row.trolleyNo}`;
            if (!groups[key]) {
                groups[key] = {
                    date: dateToUse,
                    shift: shiftToUse,
                    qcName: qc,
                    trolleyNo: row.trolleyNo,
                    pipes: []
                };
            }
            groups[key].pipes.push(row);
        });
    });

    // Sort by Date (New to Old), then Shift, then QC Name
    const sortedGroups = Object.values(groups).sort((a, b) => {
        const dateA = parseDate(a.date);
        const dateB = parseDate(b.date);
        if (dateA && dateB && dateA.getTime() !== dateB.getTime()) return dateB - dateA; // Descending
        if (a.shift !== b.shift) return a.shift.localeCompare(b.shift);
        return a.qcName.localeCompare(b.qcName);
    });

    // Grand totals
    const gtQty = data.reduce((s, r) => s + r.totalPipes, 0);
    const gtAcc = data.reduce((s, r) => s + r.accepted, 0);
    const gtRej = data.reduce((s, r) => s + r.rejected, 0);
    const gtTotalWt = data.reduce((s, r) => s + r.totalWt, 0);
    const gtAccWt = data.reduce((s, r) => s + r.acceptedWt, 0);
    const gtRejWt = data.reduce((s, r) => s + r.rejectedWt, 0);

    // Aggregate defects for Grand Total tooltip
    const gtDefects = {
        cavity: data.reduce((s, r) => s + (r.cavity || 0), 0),
        cracks: data.reduce((s, r) => s + (r.cracks || 0), 0),
        rCracks: data.reduce((s, r) => s + (r.rCracks || 0), 0),
        ovality: data.reduce((s, r) => s + (r.ovality || 0), 0),
        others: data.reduce((s, r) => s + (r.others || 0), 0)
    };

    let srNo = 1;
    sortedGroups.forEach(group => {
        let stQty = 0, stAcc = 0, stRej = 0, stTotalWt = 0, stAccWt = 0, stRejWt = 0;
        let stDefects = { cavity: 0, cracks: 0, rCracks: 0, ovality: 0, others: 0 };

        group.pipes.forEach((pipe, idx) => {
            const tr = document.createElement('tr');
            if (idx === 0) tr.classList.add('group-start');
            else {
                tr.classList.add('sub-row');
                tr.classList.add('qual-sub-row');
            }

            const totalWt = pipe.totalWt;
            const acceptedWt = pipe.acceptedWt;
            const rejectedWt = pipe.rejectedWt;
            const rejPct = parseFloat(pipe.rejectedPct) || 0;
            const rateClass = rejPct > 30 ? 'danger' : rejPct > 15 ? 'warning' : 'good';

            stQty += pipe.totalPipes;
            stAcc += pipe.accepted;
            stRej += pipe.rejected;
            stTotalWt += totalWt;
            stAccWt += acceptedWt;
            stRejWt += rejectedWt;

            stDefects.cavity += pipe.cavity;
            stDefects.cracks += pipe.cracks;
            stDefects.rCracks += pipe.rCracks;
            stDefects.ovality += pipe.ovality;
            stDefects.others += pipe.others;

            tr.innerHTML = `
                <td>${idx === 0 ? srNo : ''}</td>
                <td>${idx === 0 ? formatDate(group.date) : ''}</td>
                <td>${idx === 0 ? group.shift : ''}</td>
                <td>${idx === 0 ? `<strong>${group.qcName}</strong>` : ''}</td>
                <td>${pipe.supervisor}</td>
                <td>${pipe.pipeSize}</td>
                <td>${pipe.trolleyNo}</td>
                ${showTimeline ? '<td></td><td></td><td></td><td></td>' : ''}
                <td>${pipe.totalPipes}</td>
                <td class="badge-accepted">${pipe.accepted}</td>
                <td class="badge-rejected" data-tooltip="${getRejectionTooltip(pipe)}">${pipe.rejected}</td>
                <td>${totalWt.toFixed(1)}</td>
                <td>${acceptedWt.toFixed(1)}</td>
                <td>${rejectedWt.toFixed(1)}</td>
                <td><span class="badge-rate ${rateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${pipe.rejectedPct}</span></td>
            `;
            tbody.appendChild(tr);
        });

        const stRejPct = stTotalWt > 0 ? ((stRejWt / stTotalWt) * 100).toFixed(1) : '0.0';
        const stRateClass = parseFloat(stRejPct) > 30 ? 'danger' : parseFloat(stRejPct) > 15 ? 'warning' : 'good';
        const stRow = document.createElement('tr');
        stRow.classList.add('subtotal-row');
        stRow.innerHTML = `
            <td colspan="6"></td>
            <td><strong>Subtotal</strong></td>
            ${showTimeline ? `
                <td><strong>${group.pipes[0].loadingDate}</strong></td>
                <td><strong>${group.pipes[0].loadingTime}</strong></td>
                <td><strong>${group.pipes[0].qcTime}</strong></td>
                <td><strong>${group.pipes[0].hoursCycle}</strong></td>
            ` : ''}
            <td><strong>${stQty}</strong></td>
            <td><strong>${stAcc}</strong></td>
            <td><strong class="badge-rejected" data-tooltip="${getRejectionTooltip(stDefects)}">${stRej}</strong></td>
            <td><strong>${stTotalWt.toFixed(1)}</strong></td>
            <td><strong>${stAccWt.toFixed(1)}</strong></td>
            <td><strong>${stRejWt.toFixed(1)}</strong></td>
            <td><strong><span class="badge-rate ${stRateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${stRejPct}%</span></strong></td>
        `;
        tbody.appendChild(stRow);
        srNo++;
    });

    const gtRejPct = gtTotalWt > 0 ? ((gtRejWt / gtTotalWt) * 100).toFixed(1) : '0.0';
    const gtRateClass = parseFloat(gtRejPct) > 30 ? 'danger' : parseFloat(gtRejPct) > 15 ? 'warning' : 'good';
    const gtRow = document.createElement('tr');
    gtRow.classList.add('grand-total-row');
    gtRow.innerHTML = `
        <td colspan="6"></td>
        <td><strong>Grand Total</strong></td>
        ${showTimeline ? '<td colspan="4"></td>' : ''}
        <td><strong>${gtQty}</strong></td>
        <td><strong>${gtAcc}</strong></td>
        <td><strong class="badge-rejected" data-tooltip="${getRejectionTooltip(gtDefects)}">${gtRej}</strong></td>
        <td><strong>${gtTotalWt.toFixed(1)}</strong></td>
        <td><strong>${gtAccWt.toFixed(1)}</strong></td>
        <td><strong>${gtRejWt.toFixed(1)}</strong></td>
        <td><strong><span class="badge-rate ${gtRateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${gtRejPct}%</span></strong></td>
    `;
    tbody.appendChild(gtRow);

    // Update count badge
    const badge = document.getElementById('qualReportCount');
    if (badge) badge.textContent = `${Object.keys(groups).length} groups · ${data.length} rows`;
}

// ============ QUALITY SUMMARY TABLE ============
function renderQualitySummary() {
    // Only show QC Checked data in this summary
    const data = filteredData.filter(r => r.status === 'QC Checked');
    const tbody = document.getElementById('qualSummaryBody');
    tbody.innerHTML = '';

    // Group by Name and Shift for aggregate summary (split comma-separated names)
    const groups = {};
    data.forEach(row => {
        const names = (row.qcName || '—').split(',').map(n => n.trim()).filter(n => n);
        if (names.length === 0) names.push('—');

        const shift = row.qcShift || '—';

        names.forEach(qc => {
            const key = `${qc}|${shift}`;
            if (!groups[key]) {
                groups[key] = {
                    qcName: qc,
                    shift: shift,
                    totalPipes: 0,
                    accepted: 0,
                    rejected: 0,
                    totalWt: 0,
                    acceptedWt: 0,
                    rejectedWt: 0,
                    cavity: 0, cracks: 0, rCracks: 0, ovality: 0, others: 0
                };
            }
            groups[key].totalPipes += row.totalPipes;
            groups[key].accepted += row.accepted;
            groups[key].rejected += row.rejected;
            groups[key].totalWt += row.totalWt;
            groups[key].acceptedWt += row.acceptedWt;
            groups[key].rejectedWt += row.rejectedWt;
            groups[key].cavity += row.cavity;
            groups[key].cracks += row.cracks;
            groups[key].rCracks += row.rCracks;
            groups[key].ovality += row.ovality;
            groups[key].others += row.others;
        });
    });

    const shiftMap = { 'I': 1, 'II': 2, 'III': 3 };
    const sortedGroups = Object.values(groups).sort((a, b) => {
        const sA = shiftMap[a.shift] || 99;
        const sB = shiftMap[b.shift] || 99;
        if (sA !== sB) return sA - sB;
        return a.qcName.localeCompare(b.qcName);
    });

    // Calculate Grand Totals from raw data to avoid double-counting unrolled names
    const gtQty = data.reduce((s, r) => s + r.totalPipes, 0);
    const gtAcc = data.reduce((s, r) => s + r.accepted, 0);
    const gtRej = data.reduce((s, r) => s + r.rejected, 0);
    const gtTotalWt = data.reduce((s, r) => s + r.totalWt, 0);
    const gtAccWt = data.reduce((s, r) => s + r.acceptedWt, 0);
    const gtRejWt = data.reduce((s, r) => s + r.rejectedWt, 0);

    // Aggregate defects for Grand Total tooltip in Summary
    const gtDefects = {
        cavity: data.reduce((s, r) => s + (r.cavity || 0), 0),
        cracks: data.reduce((s, r) => s + (r.cracks || 0), 0),
        rCracks: data.reduce((s, r) => s + (r.rCracks || 0), 0),
        ovality: data.reduce((s, r) => s + (r.ovality || 0), 0),
        others: data.reduce((s, r) => s + (r.others || 0), 0)
    };

    let srNo = 1;
    sortedGroups.forEach(group => {
        const rejPct = group.totalWt > 0 ? ((group.rejectedWt / group.totalWt) * 100).toFixed(2) : '0.00';
        const rateClass = parseFloat(rejPct) > 30 ? 'danger' : parseFloat(rejPct) > 15 ? 'warning' : 'good';

        const tr = document.createElement('tr');
        tr.innerHTML = `
      <td>${srNo}</td>
      <td style="text-align:center;"><span class="badge-shift sh-${group.shift}">${group.shift}</span></td>
      <td><strong>${group.qcName}</strong></td>
      <td>${group.totalPipes}</td>
      <td>${group.accepted}</td>
      <td><span class="badge-rejected" data-tooltip="${getRejectionTooltip(group)}">${group.rejected}</span></td>
      <td>${group.totalWt.toFixed(1)}</td>
      <td>${group.acceptedWt.toFixed(1)}</td>
      <td>${group.rejectedWt.toFixed(1)}</td>
      <td><span class="badge-rate ${rateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${rejPct}%</span></td>
    `;
        tbody.appendChild(tr);
        srNo++;
    });

    // Grand Total Row
    const totalGmWtQC = gtAccWt + gtRejWt;
    const gtRejPct = totalGmWtQC > 0 ? ((gtRejWt / totalGmWtQC) * 100).toFixed(2) : '0.00';
    const gtRateClass = parseFloat(gtRejPct) > 30 ? 'danger' : parseFloat(gtRejPct) > 15 ? 'warning' : 'good';

    const gtRow = document.createElement('tr');
    gtRow.classList.add('grand-total-row');
    gtRow.innerHTML = `
        <td colspan="3"><strong>Grand Total</strong></td>
        <td><strong>${gtQty}</strong></td>
        <td><strong>${gtAcc}</strong></td>
        <td><strong class="badge-rejected" data-tooltip="${getRejectionTooltip(gtDefects)}">${gtRej}</strong></td>
        <td><strong>${gtTotalWt.toFixed(1)}</strong></td>
        <td><strong>${gtAccWt.toFixed(1)}</strong></td>
        <td><strong>${gtRejWt.toFixed(1)}</strong></td>
        <td><strong><span class="badge-rate ${gtRateClass}" data-tooltip="Calculated on Weight (Kg.)">${gtRejPct}%</span></strong></td>
    `;
    tbody.appendChild(gtRow);
}

// ============ CHARTS ============
let chartAccRej = null;
let chartDefects = null;
let chartSupervisor = null;

function renderCharts() {
    renderAcceptRejectChart();
    renderDefectsChart();
    renderSupervisorChart();
    renderDashboardMonthTimeline();
}

function renderDashboardMonthTimeline() {
    const tbody = document.getElementById('dashboardMonthTimelineBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const allFurnaceData = getDataForFurnace();
    if (allFurnaceData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No data available</td></tr>';
        return;
    }

    // Find the latest date to determine "Current FY" and "ongoing month"
    const dates = allFurnaceData.map(r => parseDate(r.date)).filter(d => d);
    if (dates.length === 0) return;
    
    const maxDate = new Date(Math.max(...dates));
    const maxYear = maxDate.getFullYear();
    const maxMonth = maxDate.getMonth() + 1;

    let startYear, endYear;
    if (maxMonth >= 4) {
        startYear = maxYear;
        endYear = maxYear + 1;
    } else {
        startYear = maxYear - 1;
        endYear = maxYear;
    }

    // Filter for Current FY
    const data = allFurnaceData.filter(row => {
        const rowDate = parseDate(row.date);
        if (!rowDate) return false;
        
        const yr = rowDate.getFullYear();
        const mo = rowDate.getMonth() + 1;
        
        if (yr === startYear && mo >= 4) return true;
        if (yr === endYear && mo <= 3) return true;
        return false;
    });

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No data available for Current FY</td></tr>';
        return;
    }

    const monthMap = {};
    data.forEach(row => {
        const monthKey = getMonthKey(row.date);
        if (!monthMap[monthKey]) {
            monthMap[monthKey] = {
                display: getMonthDisplay(row.date),
                totalWt: 0,
                accWt: 0,
                rejWt: 0
            };
        }
        monthMap[monthKey].totalWt += row.totalWt || 0;
        if (row.status === 'QC Checked') {
            monthMap[monthKey].accWt += row.acceptedWt || 0;
            monthMap[monthKey].rejWt += row.rejectedWt || 0;
        }
    });

    const sortedMonths = Object.keys(monthMap).sort().map(k => monthMap[k]);
    let gtTotalWt = 0, gtAccWt = 0, gtRejWt = 0;

    sortedMonths.forEach(m => {
        gtTotalWt += m.totalWt;
        gtAccWt += m.accWt;
        gtRejWt += m.rejWt;

        const totalQCWt = m.accWt + m.rejWt;
        const rejPct = totalQCWt > 0 ? (m.rejWt / totalQCWt * 100).toFixed(1) : '0.0';
        const rateClass = parseFloat(rejPct) > 30 ? 'danger' : parseFloat(rejPct) > 15 ? 'warning' : 'good';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${m.display}</strong></td>
            <td>${m.totalWt.toFixed(1)}</td>
            <td>${m.accWt.toFixed(1)}</td>
            <td>${m.rejWt.toFixed(1)}</td>
            <td><span class="badge-rate ${rateClass}" data-tooltip="Calculated as: (Rej Wt / Total QC Wt) * 100">${rejPct}%</span></td>
        `;
        tbody.appendChild(tr);
    });

    // Grand total
    const gtTotalQCWt = gtAccWt + gtRejWt;
    const gtRejPct = gtTotalQCWt > 0 ? (gtRejWt / gtTotalQCWt * 100).toFixed(1) : '0.0';
    const gtRateClass = parseFloat(gtRejPct) > 30 ? 'danger' : parseFloat(gtRejPct) > 15 ? 'warning' : 'good';

    const gtRow = document.createElement('tr');
    gtRow.classList.add('grand-total-row');
    gtRow.innerHTML = `
        <td style="text-align:right;"><strong>GRAND TOTAL</strong></td>
        <td><strong>${gtTotalWt.toFixed(1)}</strong></td>
        <td><strong>${gtAccWt.toFixed(1)}</strong></td>
        <td><strong>${gtRejWt.toFixed(1)}</strong></td>
        <td><strong><span class="badge-rate ${gtRateClass}" data-tooltip="Calculated as: (Rej Wt / Total QC Wt) * 100">${gtRejPct}%</span></strong></td>
    `;
    tbody.appendChild(gtRow);
}

// ========= CHART UTILITIES =========
// Build a vertical linear gradient for a canvas context
function makeGradient(ctx, chartArea, colorTop, colorBottom) {
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, colorTop);
    gradient.addColorStop(1, colorBottom);
    return gradient;
}

// Shared beautiful tooltip config (glassmorphism dark)
const CHART_TOOLTIP = {
    enabled: true,
    backgroundColor: 'rgba(10, 10, 30, 0.92)',
    titleColor: '#e8e8f0',
    bodyColor: '#a0a0c8',
    borderColor: 'rgba(67, 97, 238, 0.4)',
    borderWidth: 1,
    padding: 12,
    cornerRadius: 10,
    titleFont: { family: 'Outfit', size: 12, weight: '700' },
    bodyFont: { family: 'Inter', size: 11 },
    boxPadding: 6,
    usePointStyle: true,
    caretSize: 6,
    callbacks: {}
};

function renderAcceptRejectChart() {
    const data = filteredData;

    const allDates = data.map(r => parseDate(r.date)).filter(d => d);
    let spanDays = 0;
    if (allDates.length > 1) {
        const minD = Math.min(...allDates);
        const maxD = Math.max(...allDates);
        spanDays = Math.round((maxD - minD) / (1000 * 60 * 60 * 24));
    }

    let aggMode = 'Daily';
    let keyFn = (row) => row.date;
    let labelFn = (key) => formatDate(key);
    if (spanDays > 90) {
        aggMode = 'Monthly';
        keyFn = (row) => getMonthKey(row.date);
        labelFn = (key) => key;
    } else if (spanDays > 14) {
        aggMode = 'Weekly';
        keyFn = (row) => getWeekKey(row.date);
        labelFn = (key) => 'Wk ' + key;
    }

    const titleEl = document.getElementById('chartAccRejTitle');
    if (titleEl) titleEl.textContent = `📊 Accepted vs Rejected (${aggMode})`;

    const groups = {};
    const groupOrder = [];
    data.forEach(row => {
        const key = keyFn(row);
        if (!groups[key]) {
            groups[key] = { accepted: 0, rejected: 0, acceptedWt: 0, rejectedWt: 0, sortDate: parseDate(row.date) };
            groupOrder.push(key);
        }
        groups[key].accepted += row.accepted;
        groups[key].rejected += row.rejected;
        groups[key].acceptedWt += (row.acceptedWt || 0);
        groups[key].rejectedWt += (row.rejectedWt || 0);
        const rd = parseDate(row.date);
        if (rd && (!groups[key].sortDate || rd < groups[key].sortDate)) {
            groups[key].sortDate = rd;
        }
    });
    groupOrder.sort((a, b) => (groups[a].sortDate || 0) - (groups[b].sortDate || 0));

    const labels = groupOrder.map(k => labelFn(k));
    const acceptedVals = groupOrder.map(k => groups[k].accepted);
    const rejectedVals = groupOrder.map(k => groups[k].rejected);
    const rejPctVals = groupOrder.map(k => {
        const total = groups[k].acceptedWt + groups[k].rejectedWt;
        return total > 0 ? parseFloat(((groups[k].rejectedWt / total) * 100).toFixed(1)) : 0;
    });

    const ctx = document.getElementById('chartAccRej');
    if (!ctx) return;
    if (chartAccRej) chartAccRej.destroy();

    // Gradient fill function (runs after each render)
    const getAcceptedGradient = (context) => {
        const chart = context.chart;
        const { ctx: c, chartArea } = chart;
        if (!chartArea) return 'rgba(46,196,182,0.75)';
        return makeGradient(c, chartArea, 'rgba(46,196,182,0.92)', 'rgba(32,180,150,0.45)');
    };
    const getRejectedGradient = (context) => {
        const chart = context.chart;
        const { ctx: c, chartArea } = chart;
        if (!chartArea) return 'rgba(230,57,70,0.8)';
        return makeGradient(c, chartArea, 'rgba(255,80,95,0.95)', 'rgba(200,30,50,0.50)');
    };

    chartAccRej = new Chart(ctx, {
        data: {
            labels,
            datasets: [
                {
                    type: 'bar',
                    label: 'Accepted',
                    data: acceptedVals,
                    backgroundColor: getAcceptedGradient,
                    borderColor: 'rgba(46,196,182,0.9)',
                    borderWidth: { top: 2, left: 0, right: 0, bottom: 0 },
                    borderRadius: { topLeft: 0, topRight: 0, bottomLeft: 5, bottomRight: 5 },
                    borderSkipped: false,
                    stack: 'stack',
                    order: 2,
                    maxBarThickness: 56,
                },
                {
                    type: 'bar',
                    label: 'Rejected',
                    data: rejectedVals,
                    backgroundColor: getRejectedGradient,
                    borderColor: 'rgba(255,80,95,0.9)',
                    borderWidth: { top: 2, left: 0, right: 0, bottom: 0 },
                    borderRadius: { topLeft: 5, topRight: 5, bottomLeft: 0, bottomRight: 0 },
                    borderSkipped: false,
                    stack: 'stack',
                    order: 2,
                    maxBarThickness: 56,
                },
                {
                    type: 'line',
                    label: 'Rejection %',
                    data: rejPctVals,
                    yAxisID: 'yPct',
                    borderColor: 'rgba(244,162,97,1)',
                    backgroundColor: 'rgba(244,162,97,0.12)',
                    borderWidth: 2.5,
                    pointBackgroundColor: 'rgba(244,162,97,1)',
                    pointBorderColor: '#0a0a1a',
                    pointBorderWidth: 2,
                    pointRadius: 5,
                    pointHoverRadius: 8,
                    tension: 0.38,
                    fill: true,
                    order: 1,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 900,
                easing: 'easeOutQuart'
            },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    ...CHART_TOOLTIP,
                    callbacks: {
                        label: (item) => {
                            if (item.dataset.label === 'Rejection %') {
                                return `  ${item.dataset.label}: ${item.formattedValue}%`;
                            }
                            return `  ${item.dataset.label}: ${item.formattedValue}`;
                        },
                        footer: (items) => {
                            let total = 0;
                            items.forEach(item => {
                                if (item.dataset.label === 'Accepted' || item.dataset.label === 'Rejected') {
                                    total += item.raw;
                                }
                            });
                            return `Total Produced: ${total}`;
                        }
                    }
                },
                legend: {
                    labels: {
                        color: '#9090b8',
                        font: { family: 'Inter', size: 11 },
                        usePointStyle: true,
                        pointStyle: 'rectRounded',
                        padding: 16
                    }
                },
                datalabels: {
                    color: '#ffffff',
                    font: { size: 10, weight: 'bold', family: 'Inter' },
                    anchor: 'center',
                    align: 'center',
                    display: function (ctx) {
                        if (ctx.datasetIndex === 2) return false; // hide on line
                        return ctx.dataset.data[ctx.dataIndex] > 0;
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    ticks: { color: '#6868a0', font: { size: 10, family: 'Inter' } },
                    grid: { color: 'rgba(255,255,255,0.03)', drawTicks: false },
                    border: { color: 'rgba(255,255,255,0.05)' }
                },
                y: {
                    stacked: true,
                    ticks: { color: '#6868a0', font: { size: 10 } },
                    grid: { color: 'rgba(255,255,255,0.05)', borderDash: [4, 4] },
                    border: { dash: [4, 4], color: 'rgba(255,255,255,0.05)' }
                },
                yPct: {
                    type: 'linear',
                    position: 'right',
                    min: 0,
                    max: 100,
                    ticks: { color: 'rgba(244,162,97,0.8)', font: { size: 10 }, callback: v => v + '%' },
                    grid: { drawOnChartArea: false },
                    border: { color: 'rgba(244,162,97,0.2)' }
                }
            }
        },
        plugins: [ChartDataLabels]
    });
}

function renderDefectsChart() {
    const data = filteredData;

    const totals = {
        Cavity: data.reduce((s, r) => s + r.cavity, 0),
        Cracks: data.reduce((s, r) => s + r.cracks, 0),
        'R Cracks': data.reduce((s, r) => s + r.rCracks, 0),
        Ovality: data.reduce((s, r) => s + r.ovality, 0),
        Others: data.reduce((s, r) => s + r.others, 0),
    };

    const totalDefects = Object.values(totals).reduce((a, b) => a + b, 0);

    const ctx = document.getElementById('chartDefects');
    if (!ctx) return;
    if (chartDefects) chartDefects.destroy();

    // Rich gradient-influenced palette for doughnut segments
    const DEFECT_COLORS = [
        { bg: 'rgba(67,97,238,0.88)', border: '#4361ee', glow: 'rgba(67,97,238,0.5)' },
        { bg: 'rgba(255,80,95,0.88)', border: '#ff505f', glow: 'rgba(255,80,95,0.5)' },
        { bg: 'rgba(244,162,97,0.88)', border: '#f4a261', glow: 'rgba(244,162,97,0.5)' },
        { bg: 'rgba(123,97,255,0.88)', border: '#7b61ff', glow: 'rgba(123,97,255,0.5)' },
        { bg: 'rgba(46,196,182,0.88)', border: '#2ec4b6', glow: 'rgba(46,196,182,0.5)' },
    ];

    // Custom plugin: outer labels with leader lines for small segments
    const doughnutOuterLabels = {
        id: 'doughnutOuterLabels',
        afterDatasetsDraw(chart) {
            const { ctx: c } = chart;
            const dataset = chart.data.datasets[0];
            const meta = chart.getDatasetMeta(0);
            const total = dataset.data.reduce((a, b) => a + b, 0);
            if (total === 0) return;

            const smallLabels = [];
            meta.data.forEach((arc, i) => {
                const value = dataset.data[i];
                const pct = (value / total) * 100;
                if (pct >= 8 || value === 0) return;

                const props = arc.getProps(['x', 'y', 'startAngle', 'endAngle', 'outerRadius']);
                const midAngle = (props.startAngle + props.endAngle) / 2;
                const isRight = Math.cos(midAngle) >= 0;
                const edgeX = props.x + Math.cos(midAngle) * props.outerRadius;
                const edgeY = props.y + Math.sin(midAngle) * props.outerRadius;
                const elbowX = props.x + Math.cos(midAngle) * (props.outerRadius + 14);
                const elbowY = props.y + Math.sin(midAngle) * (props.outerRadius + 14);
                const endX = isRight ? elbowX + 30 : elbowX - 30;

                smallLabels.push({
                    text: `${value} (${pct.toFixed(1)}%)`,
                    color: DEFECT_COLORS[i]?.border || '#e0e0f0',
                    edgeX, edgeY, elbowX, elbowY, endX,
                    naturalY: elbowY, y: elbowY, isRight
                });
            });

            smallLabels.sort((a, b) => a.naturalY - b.naturalY);
            const minGap = 18;
            for (let i = 1; i < smallLabels.length; i++) {
                if (smallLabels[i].y - smallLabels[i - 1].y < minGap) {
                    smallLabels[i].y = smallLabels[i - 1].y + minGap;
                }
            }

            c.save();
            smallLabels.forEach(label => {
                c.beginPath();
                c.moveTo(label.edgeX, label.edgeY);
                c.lineTo(label.elbowX, label.elbowY);
                c.lineTo(label.endX, label.y);
                c.strokeStyle = label.color + '99';
                c.lineWidth = 1.5;
                c.stroke();

                c.fillStyle = label.color;
                c.font = 'bold 10px Inter, sans-serif';
                c.textAlign = label.isRight ? 'left' : 'right';
                c.textBaseline = 'middle';
                c.fillText(label.text, label.endX + (label.isRight ? 4 : -4), label.y);
            });
            c.restore();
        }
    };

    // Centre text plugin showing total defects
    const centreText = {
        id: 'centreText',
        beforeDatasetsDraw(chart) {
            const { ctx: c, data: d } = chart;
            const meta = chart.getDatasetMeta(0);
            if (!meta || !meta.data[0]) return;
            const cx = meta.data[0].x;
            const cy = meta.data[0].y;
            c.save();
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillStyle = '#7070a0';
            c.font = '11px Inter';
            c.fillText('Total Defects', cx, cy - 12);
            c.fillStyle = '#e8e8f0';
            c.font = 'bold 22px Outfit';
            c.fillText(totalDefects.toLocaleString('en-IN'), cx, cy + 10);
            c.restore();
        }
    };

    chartDefects = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(totals),
            datasets: [{
                data: Object.values(totals),
                backgroundColor: DEFECT_COLORS.map(c => c.bg),
                borderColor: DEFECT_COLORS.map(c => c.border),
                hoverBorderColor: DEFECT_COLORS.map(c => c.border),
                borderWidth: 2,
                hoverOffset: 14,
                hoverBorderWidth: 3,
                spacing: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '62%',
            animation: { animateRotate: true, animateScale: true, duration: 1000, easing: 'easeOutBack' },
            layout: { padding: { top: 44, bottom: 44, left: 55, right: 55 } },
            plugins: {
                tooltip: {
                    ...CHART_TOOLTIP,
                    callbacks: {
                        label: (item) => {
                            const v = item.raw;
                            const pct = totalDefects > 0 ? ((v / totalDefects) * 100).toFixed(1) : '0.0';
                            return `  ${item.label}: ${v.toLocaleString('en-IN')} (${pct}%)`;
                        }
                    }
                },
                legend: {
                    position: 'right',
                    labels: {
                        color: '#9090b8',
                        font: { family: 'Inter', size: 11 },
                        usePointStyle: true,
                        pointStyle: 'circle',
                        padding: 14
                    }
                },
                datalabels: {
                    color: '#ffffff',
                    font: { size: 11, weight: 'bold', family: 'Inter' },
                    anchor: 'center',
                    align: 'center',
                    textShadowColor: 'rgba(0,0,0,0.6)',
                    textShadowBlur: 4,
                    formatter: function (value) {
                        if (value === 0) return '';
                        const pct = totalDefects > 0 ? ((value / totalDefects) * 100) : 0;
                        if (pct < 8) return '';
                        return value + '\n(' + pct.toFixed(1) + '%)';
                    },
                    display: function (ctx) {
                        const value = ctx.dataset.data[ctx.dataIndex];
                        const pct = totalDefects > 0 ? (value / totalDefects) * 100 : 0;
                        return value > 0 && pct >= 8;
                    }
                }
            }
        },
        plugins: [ChartDataLabels, doughnutOuterLabels, centreText]
    });
}

function renderSupervisorChart() {
    const data = filteredData;

    const supGroups = {};
    data.forEach(row => {
        if (!supGroups[row.supervisor]) {
            supGroups[row.supervisor] = { accepted: 0, rejected: 0, acceptedWt: 0, rejectedWt: 0 };
        }
        supGroups[row.supervisor].accepted += row.accepted;
        supGroups[row.supervisor].rejected += row.rejected;
        supGroups[row.supervisor].acceptedWt += (row.acceptedWt || 0);
        supGroups[row.supervisor].rejectedWt += (row.rejectedWt || 0);
    });

    const labels = Object.keys(supGroups);
    const acceptedVals = labels.map(s => supGroups[s].accepted);
    const rejectedVals = labels.map(s => supGroups[s].rejected);
    const rejPctVals = labels.map(s => {
        const total = supGroups[s].acceptedWt + supGroups[s].rejectedWt;
        return total > 0 ? parseFloat(((supGroups[s].rejectedWt / total) * 100).toFixed(1)) : 0;
    });

    const ctx = document.getElementById('chartSupervisor');
    if (!ctx) return;
    if (chartSupervisor) chartSupervisor.destroy();

    const getAccGradient = (context) => {
        const chart = context.chart;
        const { ctx: c, chartArea } = chart;
        if (!chartArea) return 'rgba(46,196,182,0.75)';
        return makeGradient(c, chartArea, 'rgba(46,196,182,0.92)', 'rgba(32,180,150,0.40)');
    };
    const getRejGradient = (context) => {
        const chart = context.chart;
        const { ctx: c, chartArea } = chart;
        if (!chartArea) return 'rgba(230,57,70,0.8)';
        return makeGradient(c, chartArea, 'rgba(255,80,95,0.95)', 'rgba(200,30,50,0.45)');
    };

    chartSupervisor = new Chart(ctx, {
        data: {
            labels,
            datasets: [
                {
                    type: 'bar',
                    label: 'Accepted',
                    data: acceptedVals,
                    backgroundColor: getAccGradient,
                    borderColor: 'rgba(46,196,182,0.9)',
                    borderWidth: { top: 2, left: 0, right: 0, bottom: 0 },
                    borderRadius: { topLeft: 0, topRight: 0, bottomLeft: 6, bottomRight: 6 },
                    borderSkipped: false,
                    stack: 'stack',
                    order: 2,
                    maxBarThickness: 64,
                },
                {
                    type: 'bar',
                    label: 'Rejected',
                    data: rejectedVals,
                    backgroundColor: getRejGradient,
                    borderColor: 'rgba(255,80,95,0.9)',
                    borderWidth: { top: 2, left: 0, right: 0, bottom: 0 },
                    borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
                    borderSkipped: false,
                    stack: 'stack',
                    order: 2,
                    maxBarThickness: 64,
                },
                {
                    type: 'line',
                    label: 'Rejection %',
                    data: rejPctVals,
                    yAxisID: 'yPct',
                    borderColor: 'rgba(244,162,97,1)',
                    backgroundColor: 'rgba(244,162,97,0.1)',
                    borderWidth: 2.5,
                    pointBackgroundColor: 'rgba(244,162,97,1)',
                    pointBorderColor: '#0a0a1a',
                    pointBorderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 9,
                    tension: 0.3,
                    fill: true,
                    order: 1,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 900, easing: 'easeOutQuart' },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    ...CHART_TOOLTIP,
                    callbacks: {
                        label: (item) => {
                            if (item.dataset.label === 'Rejection %') {
                                return `  ${item.dataset.label}: ${item.formattedValue}%`;
                            }
                            return `  ${item.dataset.label}: ${item.formattedValue}`;
                        },
                        footer: (items) => {
                            let total = 0;
                            items.forEach(item => {
                                if (item.dataset.label === 'Accepted' || item.dataset.label === 'Rejected') {
                                    total += item.raw;
                                }
                            });
                            return `Total Produced: ${total}`;
                        }
                    }
                },
                legend: {
                    labels: {
                        color: '#9090b8',
                        font: { family: 'Inter', size: 11 },
                        usePointStyle: true,
                        pointStyle: 'rectRounded',
                        padding: 16
                    }
                },
                datalabels: {
                    color: '#ffffff',
                    font: { size: 10, weight: 'bold', family: 'Inter' },
                    anchor: 'center',
                    align: 'center',
                    display: function (ctx) {
                        if (ctx.datasetIndex === 2) return false;
                        return ctx.dataset.data[ctx.dataIndex] > 0;
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    ticks: { color: '#6868a0', font: { size: 11, family: 'Inter' } },
                    grid: { color: 'rgba(255,255,255,0.03)', drawTicks: false },
                    border: { color: 'rgba(255,255,255,0.05)' }
                },
                y: {
                    stacked: true,
                    ticks: { color: '#6868a0', font: { size: 10 } },
                    grid: { color: 'rgba(255,255,255,0.05)', borderDash: [4, 4] },
                    border: { dash: [4, 4], color: 'rgba(255,255,255,0.05)' }
                },
                yPct: {
                    type: 'linear',
                    position: 'right',
                    min: 0,
                    max: 100,
                    ticks: { color: 'rgba(244,162,97,0.8)', font: { size: 10 }, callback: v => v + '%' },
                    grid: { drawOnChartArea: false },
                    border: { color: 'rgba(244,162,97,0.2)' }
                }
            }
        },
        plugins: [ChartDataLabels]
    });
}

// ============ RENDER ALL ============
function renderAll() {
    renderKPIs();

    if (currentTab === 'dashboard') {
        renderCharts();
    } else if (currentTab === 'daily') {
        renderDailyReport();
    } else if (currentTab === 'summary') {
        renderSummaryReport();
    } else if (currentTab === 'production') {
        renderProductionReport();
        renderProductionSummary();
    } else if (currentTab === 'quality') {
        renderQualityReport();
        renderQualitySummary();
    }
}

// ============ DAILY REPORT ============
function switchDailySub(sub) {
    dailySubTab = sub;
    document.querySelectorAll('.daily-sub-tab').forEach(b => b.classList.remove('active'));
    document.getElementById(sub === 'production' ? 'dailySubProd' : 'dailySubQual')?.classList.add('active');
    
    // Hide/Show QC toggle for production logbook
    const qcToggleArea = document.getElementById('dailyProdQcToggleArea');
    if (qcToggleArea) qcToggleArea.style.display = sub === 'production' ? 'flex' : 'none';

    const titleEl = document.getElementById('dailyReportTitle');
    if (titleEl) {
        titleEl.textContent = sub === 'production' ? '\ud83c\udfed Shiftwise Production Logbook' : '\ud83d\udd0d Shiftwise Quality Inspection Report';
    }
    renderDailyReport();
}

function getDailyDate() {
    const picker = document.getElementById('dailyDatePicker');
    if (!picker) return null;
    if (!picker.value) {
        // Default to today
        const now = new Date();
        picker.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    }
    // Convert YYYY-MM-DD to DD-MM-YYYY for matching
    const parts = picker.value.split('-');
    return { iso: picker.value, display: `${parts[2]}-${parts[1]}-${parts[0]}` };
}

function renderDailyReport() {
    const dateInfo = getDailyDate();
    if (!dateInfo) return;
    const contentEl = document.getElementById('dailyContent');
    const summaryEl = document.getElementById('daily24HrSummary');
    if (!contentEl || !summaryEl) return;

    if (dailySubTab === 'production') {
        renderDailyProduction(dateInfo, contentEl);
    } else {
        renderDailyQuality(dateInfo, contentEl);
    }
    
    const showQC = document.getElementById('toggleDailyProdQc')?.checked || false;
    renderDaily24HrSummary(dateInfo, summaryEl, dailySubTab, showQC);
}

function getShiftLabel(raw) {
    const s = String(raw).toLowerCase().trim();
    if (s === 'l' || s === 'i' || s === '1') return 'I';
    if (s === 'll' || s === 'ii' || s === '2') return 'II';
    if (s === 'lll' || s === 'iii' || s === '3') return 'III';
    return s.toUpperCase();
}

function renderDailyProduction(dateInfo, container) {
    // Filter production data for this date
    const dayData = getDataForFurnace().filter(r => r.date === dateInfo.display);
    // Filter shift level data for this date (and furnace)
    const dayShiftData = getShiftDataForFurnace().filter(r => {
        const d = String(r['Date'] || '').trim();
        return d === dateInfo.display;
    });

    if (dayData.length === 0 && dayShiftData.length === 0) {
        container.innerHTML = `<div class="daily-empty"><span class="empty-icon">📭</span>No production data for ${formatDate(dateInfo.display)}</div>`;
        return;
    }

    // Group production data by shift
    const shifts = { 'I': [], 'II': [], 'III': [] };
    dayData.forEach(r => {
        const s = r.shift || 'I';
        if (shifts[s]) shifts[s].push(r);
    });

    let html = '';
    ['I', 'II', 'III'].forEach(shiftName => {
        const rows = shifts[shiftName];
        // Find shift level composition for this shift
        const shiftComp = dayShiftData.find(s => getShiftLabel(s['Shift']) === shiftName);
        const supervisor = rows.length > 0 ? rows[0].supervisor : (shiftComp ? shiftComp['Supervisor'] : '—');

        if (rows.length === 0 && !shiftComp) return; // Skip empty shifts

        const badgeClass = shiftName === 'I' ? 'shift-i' : shiftName === 'II' ? 'shift-ii' : 'shift-iii';

        // Aggregate by pipe size
        const showQC = document.getElementById('toggleDailyProdQc')?.checked;
        const pipeSizeMap = {};
        
        rows.forEach(r => {
            const ps = r.pipeSize || '—';
            if (!pipeSizeMap[ps]) {
                pipeSizeMap[ps] = { 
                    pipeSize: ps, 
                    wtPerPipe: r.wtPerPipe, 
                    qty: 0, 
                    totalWt: 0,
                    acc: 0,
                    rej: 0,
                    accWt: 0,
                    rejWt: 0,
                    cavity: 0,
                    cracks: 0,
                    rCracks: 0,
                    ovality: 0,
                    others: 0,
                    hasPending: false 
                };
            }
            const p = pipeSizeMap[ps];
            p.qty += r.totalPipes;
            p.totalWt += r.totalWt;
            
            // Collect QC metrics (from QC Checked entries)
            if (r.status === 'QC Checked') {
                p.acc += r.accepted;
                p.rej += r.rejected;
                p.accWt += r.acceptedWt;
                p.rejWt += r.rejectedWt;
                p.cavity += (r.cavity || 0);
                p.cracks += (r.cracks || 0);
                p.rCracks += (r.rCracks || 0);
                p.ovality += (r.ovality || 0);
                p.others += (r.others || 0);
            } else if (r.status === 'Inside Tunnel') {
                p.hasPending = true;
            }
        });
        
        const pipeRows = Object.values(pipeSizeMap).sort((a, b) => sortPipes(a.pipeSize, b.pipeSize));
        const totalQty = pipeRows.reduce((sum, p) => sum + p.qty, 0);
        const totalWt = pipeRows.reduce((sum, p) => sum + p.totalWt, 0);

        // Status breakdown
        const qcChecked = rows.filter(r => r.status === 'QC Checked').reduce((s, r) => s + r.totalPipes, 0);
        const insideTunnel = rows.filter(r => r.status === 'Inside Tunnel').reduce((s, r) => s + r.totalPipes, 0);
        const otherStatus = totalQty - qcChecked - insideTunnel;

        html += `<div class="shift-card">
            <div class="shift-card-header">
                <div class="shift-card-title">
                    <div class="shift-badge ${badgeClass}">${shiftName}</div>
                    <div>
                        <h4>Shift ${shiftName}</h4>
                        <span>${formatDate(dateInfo.display)} · ${supervisor || '—'}</span>
                    </div>
                </div>
                <div class="shift-card-meta">
                    <div>Pipes: <strong>${totalQty}</strong></div>
                    <div>Weight: <strong>${totalWt.toFixed(1)} Kg</strong></div>
                    ${qcChecked > 0 ? `<div style="color:var(--accent-green);">✓ QC: <strong>${qcChecked}</strong></div>` : ''}
                    ${insideTunnel > 0 ? `<div style="color:var(--accent-amber);">⏳ Tunnel: <strong>${insideTunnel}</strong></div>` : ''}
                </div>
            </div>
            <div class="shift-card-body">`;

        if (pipeRows.length > 0) {
            html += `<div class="report-table-wrapper" style="overflow-x: auto;">
                <table class="report-table" style="margin-bottom:0; min-width: ${showQC ? '1400px' : '100%'}">
                <thead><tr>
                    <th>Sr.</th><th>Pipe Size (ID×L)</th><th>Unit Wt (Kg)</th><th>Qty (Nos)</th><th>Prod Wt (Kg)</th>
                    ${showQC ? '<th>QC Status</th><th>Acc Nos</th><th>Rej Nos</th><th>Acc Wt</th><th>Rej Wt</th><th>Cavity</th><th>Cracks</th><th>R Cracks</th><th>Ovality</th><th>Others</th><th>Rej %</th>' : ''}
                </tr></thead><tbody>`;
            
            pipeRows.forEach((p, idx) => {
                const totalWtValue = p.accWt + p.rejWt;
                const rejPct = totalWtValue > 0 ? (p.rejWt / totalWtValue * 100).toFixed(1) : '0';
                const showRemark = p.hasPending && (p.acc + p.rej === 0);
                
                html += `<tr>
                    <td>${idx+1}</td>
                    <td>${p.pipeSize}</td>
                    <td>${p.wtPerPipe}</td>
                    <td>${p.qty}</td>
                    <td>${p.totalWt.toFixed(1)}</td>
                    ${showQC ? `
                        <td style="font-size: 0.75rem;">${showRemark ? '<span class="status-badge progress">Yet to be checked</span>' : (p.hasPending ? '<span class="status-badge progress">Partial</span>' : '<span class="status-badge done">✓ Checked</span>')}</td>
                        <td>${showRemark ? '—' : p.acc}</td>
                        <td class="badge-rejected">${showRemark ? '—' : p.rej}</td>
                        <td>${showRemark ? '—' : p.accWt.toFixed(1)}</td>
                        <td>${showRemark ? '—' : p.rejWt.toFixed(1)}</td>
                        <td>${showRemark ? '—' : (p.cavity || '')}</td>
                        <td>${showRemark ? '—' : (p.cracks || '')}</td>
                        <td>${showRemark ? '—' : (p.rCracks || '')}</td>
                        <td>${showRemark ? '—' : (p.ovality || '')}</td>
                        <td>${showRemark ? '—' : (p.others || '')}</td>
                        <td><span class="badge-rate ${parseFloat(rejPct) > 30 ? 'danger' : parseFloat(rejPct) > 15 ? 'warning' : 'good'}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${showRemark ? '—' : rejPct + '%'}</span></td>
                    ` : ''}
                </tr>`;
            });
            
            const totalAcc = pipeRows.reduce((s, p) => s + p.acc, 0);
            const totalRej = pipeRows.reduce((s, p) => s + p.rej, 0);
            const totalAccWt = pipeRows.reduce((s, p) => s + p.accWt, 0);
            const totalRejWt = pipeRows.reduce((s, p) => s + p.rejWt, 0);
            const totalWtSum = totalAccWt + totalRejWt;
            const totalRejPct = totalWtSum > 0 ? (totalRejWt / totalWtSum * 100).toFixed(1) : '0';

            html += `<tr class="subtotal-row">
                <td colspan="3" style="text-align:right;"><strong>Shift Total</strong></td>
                <td><strong>${totalQty}</strong></td>
                <td><strong>${totalWt.toFixed(1)}</strong></td>
                ${showQC ? `
                    <td></td>
                    <td><strong>${totalAcc}</strong></td>
                    <td><strong>${totalRej}</strong></td>
                    <td><strong>${totalAccWt.toFixed(1)}</strong></td>
                    <td><strong>${totalRejWt.toFixed(1)}</strong></td>
                    <td colspan="5"></td>
                    <td><strong><span data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${totalRejPct}%</span></strong></td>
                ` : ''}
            </tr></tbody></table></div>`;
        } else {
            html += `<div style="color:var(--text-muted);padding:0.5rem 0;">No pipe data for this shift</div>`;
        }

        // Composition from Shift Level Data
        if (shiftComp) {
            const batches = shiftComp['Number of batch'] || '—';
            const l1 = shiftComp['L1_Composition'] || '—';
            const l2 = shiftComp['L2_Composition'] || '—';
            const rr = shiftComp['RR_Composition'] || '—';
            const inputKgBS = shiftComp['Input KG_BS'] || '';
            const inputKgL1 = shiftComp['Input KG_L1'] || '';
            const inputKgL2 = shiftComp['Input KG_L2'] || '';
            const inputKgRR = shiftComp['Input KG_RR'] || '';
            const inputFurnace = (parseFloat(inputKgBS || 0) + parseFloat(inputKgL1 || 0) + parseFloat(inputKgL2 || 0) + parseFloat(inputKgRR || 0)).toFixed(1);
            const remark = shiftComp['Remark'] || '';

            html += `<div class="composition-grid">
                <div class="comp-item"><div class="comp-label">Batches (Stone)</div><div class="comp-value">${batches}</div><div class="comp-unit">${inputKgBS ? inputKgBS + ' Kg' : ''}</div></div>
                <div class="comp-item"><div class="comp-label">L1 Composition</div><div class="comp-value">${l1}</div><div class="comp-unit">${inputKgL1 ? inputKgL1 + ' Kg' : ''}</div></div>
                <div class="comp-item"><div class="comp-label">L2 Composition</div><div class="comp-value">${l2}</div><div class="comp-unit">${inputKgL2 ? inputKgL2 + ' Kg' : ''}</div></div>
                <div class="comp-item"><div class="comp-label">RR (RJM+RTL)</div><div class="comp-value">${rr}</div><div class="comp-unit">${inputKgRR ? inputKgRR + ' Kg' : ''}</div></div>
                <div class="comp-item" style="border-color: var(--accent-amber);"><div class="comp-label" style="color: var(--accent-amber);">Input Furnace</div><div class="comp-value" style="color: var(--accent-amber);">${inputFurnace}</div><div class="comp-unit">Total Kg</div></div>
            </div>`;
            if (remark) {
                html += `<div style="margin-top:0.75rem;padding:0.6rem 0.8rem;background:var(--bg-secondary);border-radius:8px;border-left:3px solid var(--accent-amber);font-size:0.82rem;color:var(--text-secondary);">
                    <strong style="color:var(--accent-amber);">Remark:</strong> ${remark}
                </div>`;
            }
        }

        html += `</div></div>`; // close shift-card-body and shift-card
    });

    container.innerHTML = html;
}

function renderDailyQuality(dateInfo, container) {
    // Filter QC data for this date — only show QC Checked entries based on Date for Output
    const dayData = getDataForFurnace().filter(r => r.qcDate === dateInfo.display && r.status === 'QC Checked');
    // Tunnel count based on production date (for pipes produced today but still awaiting check)
    const tunnelCount = getDataForFurnace().filter(r => r.date === dateInfo.display && r.status === 'Inside Tunnel').reduce((s, r) => s + r.totalPipes, 0);

    if (dayData.length === 0 && tunnelCount === 0) {
        container.innerHTML = `<div class="daily-empty"><span class="empty-icon">📭</span>No quality data for ${formatDate(dateInfo.display)}</div>`;
        return;
    }

    let html = '';
    if (tunnelCount > 0) {
        html += `<div style="padding:0.7rem 1rem;background:rgba(244,162,97,0.1);border:1px solid rgba(244,162,97,0.3);border-radius:10px;margin-bottom:1rem;font-size:0.85rem;color:var(--accent-amber);">
            ⏳ <strong>${tunnelCount}</strong> pipes still Inside Tunnel — awaiting QC inspection
        </div>`;
    }

    if (dayData.length === 0) {
        html += `<div class="daily-empty"><span class="empty-icon">🔍</span>No QC Checked entries yet for ${formatDate(dateInfo.display)}</div>`;
        container.innerHTML = html;
        return;
    }

    // Group by QC shift
    const shifts = { 'I': [], 'II': [], 'III': [] };
    dayData.forEach(r => {
        const s = r.qcShift || r.shift || 'I';
        if (shifts[s]) shifts[s].push(r);
    });

    ['I', 'II', 'III'].forEach(shiftName => {
        const rows = shifts[shiftName];
        if (rows.length === 0) return;

        const badgeClass = shiftName === 'I' ? 'shift-i' : shiftName === 'II' ? 'shift-ii' : 'shift-iii';
        const qcNames = [...new Set(rows.map(r => r.qcName).filter(Boolean))].join(', ') || '—';
        const totalQty = rows.reduce((s, r) => s + r.totalPipes, 0);
        const totalAcc = rows.reduce((s, r) => s + r.accepted, 0);
        const totalRej = rows.reduce((s, r) => s + r.rejected, 0);
        const totalCavity = rows.reduce((s, r) => s + r.cavity, 0);
        const totalCracks = rows.reduce((s, r) => s + r.cracks, 0);
        const totalRCracks = rows.reduce((s, r) => s + r.rCracks, 0);
        const totalOvality = rows.reduce((s, r) => s + r.ovality, 0);
        const totalOthers = rows.reduce((s, r) => s + r.others, 0);
        const stAccWt = rows.reduce((s, r) => s + r.acceptedWt, 0);
        const stRejWt = rows.reduce((s, r) => s + r.rejectedWt, 0);
        const stTotalWt = stAccWt + stRejWt;
        const rejPct = stTotalWt > 0 ? ((stRejWt / stTotalWt) * 100).toFixed(1) : '0.0';

        html += `<div class="shift-card">
            <div class="shift-card-header">
                <div class="shift-card-title">
                    <div class="shift-badge ${badgeClass}">${shiftName}</div>
                    <div>
                        <h4>Shift ${shiftName} — Quality</h4>
                        <span>QC: ${qcNames}</span>
                    </div>
                </div>
                <div class="shift-card-meta">
                    <div>Checked: <strong>${totalQty}</strong></div>
                    <div data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">Rejected: <strong style="color:var(--accent-red);">${totalRej} (${rejPct}%)</strong></div>
                </div>
            </div>
            <div class="shift-card-body">
                <div class="report-table-wrapper" style="overflow-x: auto;">
                    <table class="report-table" style="margin-bottom:0; min-width: 1200px;">
                        <thead><tr>
                            <th>Sr.</th><th>Pipe Size</th><th>Load Date</th><th>Total</th><th>Accept</th><th>Reject</th>
                            <th>Total Wt</th><th>Acc Wt</th><th>Rej Wt</th>
                            <th>Cavity</th><th>Cracks</th><th>R Cracks</th><th>Ovality</th><th>Others</th><th>Rej %</th>
                        </tr></thead><tbody>`;

        // Aggregate by pipe size (no trolley detail)
        const pipeSizeMap = {};
        rows.forEach(r => {
            const ps = r.pipeSize || '—';
            if (!pipeSizeMap[ps]) pipeSizeMap[ps] = { pipeSize: ps, loadDates: new Set(), total: 0, acc: 0, rej: 0, totalWt: 0, accWt: 0, rejWt: 0, cavity: 0, cracks: 0, rCracks: 0, ovality: 0, others: 0 };
            if (r.date) pipeSizeMap[ps].loadDates.add(r.date);
            pipeSizeMap[ps].total += r.totalPipes;
            pipeSizeMap[ps].acc += r.accepted;
            pipeSizeMap[ps].rej += r.rejected;
            pipeSizeMap[ps].totalWt += r.totalWt;
            pipeSizeMap[ps].accWt += r.acceptedWt;
            pipeSizeMap[ps].rejWt += r.rejectedWt;
            pipeSizeMap[ps].cavity += r.cavity;
            pipeSizeMap[ps].cracks += r.cracks;
            pipeSizeMap[ps].rCracks += r.rCracks;
            pipeSizeMap[ps].ovality += r.ovality;
            pipeSizeMap[ps].others += r.others;
        });
        const pipeRows = Object.values(pipeSizeMap).sort((a, b) => sortPipes(a.pipeSize, b.pipeSize));

        pipeRows.forEach((p, idx) => {
            const pTotalWt = p.accWt + p.rejWt;
            const rp = pTotalWt > 0 ? ((p.rejWt / pTotalWt) * 100).toFixed(1) : '0.0';
            const rc = parseFloat(rp) > 30 ? 'danger' : parseFloat(rp) > 15 ? 'warning' : 'good';
            const ldStr = [...p.loadDates].join(', ');
            html += `<tr>
                <td>${idx+1}</td><td>${p.pipeSize}</td><td>${ldStr}</td><td>${p.total}</td>
                <td class="badge-accepted">${p.acc}</td><td class="badge-rejected">${p.rej}</td>
                <td>${p.totalWt.toFixed(1)}</td><td>${p.accWt.toFixed(1)}</td><td>${p.rejWt.toFixed(1)}</td>
                <td>${p.cavity || ''}</td><td>${p.cracks || ''}</td><td>${p.rCracks || ''}</td>
                <td>${p.ovality || ''}</td><td>${p.others || ''}</td>
                <td><span class="badge-rate ${rc}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${rp}%</span></td>
            </tr>`;
        });

        const sTotalWt = rows.reduce((s, r) => s + r.totalWt, 0);
        const sAccWt = rows.reduce((s, r) => s + r.acceptedWt, 0);
        const sRejWt = rows.reduce((s, r) => s + r.rejectedWt, 0);
        html += `<tr class="subtotal-row">
            <td colspan="3" style="text-align:right;"><strong>Shift Total</strong></td>
            <td><strong>${totalQty}</strong></td><td><strong>${totalAcc}</strong></td><td><strong>${totalRej}</strong></td>
            <td><strong>${sTotalWt.toFixed(1)}</strong></td><td><strong>${sAccWt.toFixed(1)}</strong></td><td><strong>${sRejWt.toFixed(1)}</strong></td>
            <td><strong>${totalCavity || ''}</strong></td><td><strong>${totalCracks || ''}</strong></td>
            <td><strong>${totalRCracks || ''}</strong></td><td><strong>${totalOvality || ''}</strong></td>
            <td><strong>${totalOthers || ''}</strong></td>
            <td><strong><span class="badge-rate ${parseFloat(rejPct) > 30 ? 'danger' : parseFloat(rejPct) > 15 ? 'warning' : 'good'}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${rejPct}%</span></strong></td>
        </tr></tbody></table></div></div></div>`;
    });

    container.innerHTML = html;
}

function renderDailyPipeSummary(dayData, container, mode = 'production', showQC = false) {
    if (!dayData || dayData.length === 0) return;

    const isQual = mode === 'quality';
    const showQCColumns = isQual || showQC;
    const pipeSizeMap = {};

    dayData.forEach(r => {
        const ps = r.pipeSize || '—';
        if (!pipeSizeMap[ps]) {
            pipeSizeMap[ps] = {
                pipeSize: ps,
                unitWt: r.wtPerPipe,
                totalQty: 0,
                totalWt: 0,
                acc: 0,
                rej: 0,
                accWt: 0,
                rejWt: 0,
                cavity: 0, cracks: 0, rCracks: 0, ovality: 0, others: 0
            };
        }
        const p = pipeSizeMap[ps];
        p.totalQty += r.totalPipes;
        p.totalWt += r.totalWt;
        if (r.status === 'QC Checked') {
            p.acc += r.accepted;
            p.rej += r.rejected;
            p.accWt += r.acceptedWt;
            p.rejWt += r.rejectedWt;
            p.cavity += (r.cavity || 0);
            p.cracks += (r.cracks || 0);
            p.rCracks += (r.rCracks || 0);
            p.ovality += (r.ovality || 0);
            p.others += (r.others || 0);
        }
    });

    const pipeRows = Object.values(pipeSizeMap).sort((a, b) => sortPipes(a.pipeSize, b.pipeSize));

    let html = `
        <div class="daily-summary-pipe-section" style="margin-bottom: 2rem;">
            <div class="table-title" style="margin-bottom: 0.75rem; color: var(--text-primary); font-family: Outfit; font-weight: 600; font-size: 1.1rem; display: flex; align-items: center; gap: 0.5rem;">
                ${isQual ? '🔍' : '🏭'} 24-Hour Daily ${isQual ? 'Quality' : 'Production'} Summary (Pipe-wise)
            </div>
            <div class="report-table-wrapper" style="background: rgba(255,255,255,0.02); border-radius: 12px; border: 1px solid var(--border-glass);">
                <table class="report-table">
                    <thead>
                        <tr>
                            <th>Sr.</th>
                            <th>Pipe Size</th>
                            <th>Unit Wt (Kg)</th>
                            <th>Qty (Nos)</th>
                            <th>Prod Wt (Kg)</th>
                            ${showQCColumns ? '<th>Acc Nos</th><th>Rej Nos</th><th>Acc Wt</th><th>Rej Wt</th><th>Cavity</th><th>Cracks</th><th>R Cracks</th><th>Ovality</th><th>Others</th><th>Rej %</th>' : ''}
                        </tr>
                    </thead>
                    <tbody>
    `;

    pipeRows.forEach((p, idx) => {
        const totalWtValue = p.accWt + p.rejWt;
        const rejPct = totalWtValue > 0 ? (p.rejWt / totalWtValue * 100).toFixed(1) : '0.0';
        const rateClass = parseFloat(rejPct) > 30 ? 'danger' : parseFloat(rejPct) > 15 ? 'warning' : 'good';

        html += `
            <tr>
                <td>${idx + 1}</td>
                <td style="color: var(--text-primary); font-weight: 500;">${p.pipeSize}</td>
                <td>${p.unitWt}</td>
                <td>${p.totalQty}</td>
                <td>${p.totalWt.toFixed(1)}</td>
                ${showQCColumns ? `
                    <td class="badge-accepted">${p.acc}</td>
                    <td class="badge-rejected">${p.rej}</td>
                    <td>${p.accWt.toFixed(1)}</td>
                    <td>${p.rejWt.toFixed(1)}</td>
                    <td>${p.cavity || '—'}</td>
                    <td>${p.cracks || '—'}</td>
                    <td>${p.rCracks || '—'}</td>
                    <td>${p.ovality || '—'}</td>
                    <td>${p.others || '—'}</td>
                    <td><span class="badge-rate ${rateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${rejPct}%</span></td>
                ` : ''}
            </tr>
        `;
    });

    // Grand totals for this table
    const grandQty = pipeRows.reduce((s, p) => s + p.totalQty, 0);
    const grandWt = pipeRows.reduce((s, p) => s + p.totalWt, 0);
    const grandAcc = pipeRows.reduce((s, p) => s + p.acc, 0);
    const grandRej = pipeRows.reduce((s, p) => s + p.rej, 0);
    const grandAccWt = pipeRows.reduce((s, p) => s + p.accWt, 0);
    const grandRejWt = pipeRows.reduce((s, p) => s + p.rejWt, 0);
    const grandCavity = pipeRows.reduce((s, p) => s + p.cavity, 0);
    const grandCracks = pipeRows.reduce((s, p) => s + p.cracks, 0);
    const grandRCracks = pipeRows.reduce((s, p) => s + p.rCracks, 0);
    const grandOvality = pipeRows.reduce((s, p) => s + p.ovality, 0);
    const grandOthers = pipeRows.reduce((s, p) => s + p.others, 0);
    const grandTotalWtQC = grandAccWt + grandRejWt;
    const grandRejPct = grandTotalWtQC > 0 ? ((grandRejWt / grandTotalWtQC) * 100).toFixed(1) : '0.0';
    const grandRateClass = parseFloat(grandRejPct) > 30 ? 'danger' : parseFloat(grandRejPct) > 15 ? 'warning' : 'good';

    html += `
                        <tr class="subtotal-row">
                            <td colspan="3" style="text-align:right;"><strong>Daily Total</strong></td>
                            <td><strong>${grandQty}</strong></td>
                            <td><strong>${grandWt.toFixed(1)}</strong></td>
                            ${showQCColumns ? `
                                <td><strong>${grandAcc}</strong></td>
                                <td><strong>${grandRej}</strong></td>
                                <td><strong>${grandAccWt.toFixed(1)}</strong></td>
                                <td><strong>${grandRejWt.toFixed(1)}</strong></td>
                                <td><strong>${grandCavity || ''}</strong></td>
                                <td><strong>${grandCracks || ''}</strong></td>
                                <td><strong>${grandRCracks || ''}</strong></td>
                                <td><strong>${grandOvality || ''}</strong></td>
                                <td><strong>${grandOthers || ''}</strong></td>
                                <td><strong><span class="badge-rate ${grandRateClass}" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100">${grandRejPct}%</span></strong></td>
                            ` : ''}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>`;

    container.innerHTML += html;
}

function renderDaily24HrSummary(dateInfo, container, mode = 'production', showQC = false) {
    const isQual = mode === 'quality';
    const dayData = getDataForFurnace().filter(r => (isQual ? r.qcDate : r.date) === dateInfo.display);
    if (dayData.length === 0) { container.innerHTML = ''; return; }

    container.innerHTML = ''; // Start clean
    
    // 1. Render Pipe-wise Table First
    renderDailyPipeSummary(dayData, container, mode, showQC);

    // 2. Base Metrics for KPI Cards
    const totalPipesInDay = dayData.reduce((s, r) => s + (r.totalPipes || 0), 0);
    const totalWt = dayData.reduce((s, r) => s + r.totalWt, 0);
    const totalAcc = dayData.reduce((s, r) => s + r.accepted, 0);
    const totalRej = dayData.reduce((s, r) => s + r.rejected, 0);
    const totalAccWt = dayData.reduce((s, r) => s + r.acceptedWt, 0);
    const totalRejWt = dayData.reduce((s, r) => s + r.rejectedWt, 0);
    const totalWtCalc = totalAccWt + totalRejWt;
    const rejPct = totalWtCalc > 0 ? ((totalRejWt / totalWtCalc) * 100).toFixed(1) : '0.0';

    if (isQual) {
        // Quality Specific Calculations
        const totalChecked = totalAcc + totalRej;
        const totalCheckedWt = totalAccWt + totalRejWt;
        const totalDefects = dayData.reduce((s, r) => s + (r.status === 'QC Checked' ? (r.cavity || 0) + (r.cracks || 0) + (r.rCracks || 0) + (r.ovality || 0) + (r.others || 0) : 0), 0);
        const activeQCs = new Set(dayData.flatMap(r => (r.qcName || '').split(',').map(n => n.trim())).filter(n => n && n !== '—')).size;

        container.innerHTML += `<div class="daily-summary-card quality-theme">
            <h4>📋 24-Hour Quality Summary — ${formatDate(dateInfo.display)}</h4>
            <div class="daily-summary-grid">
                <div class="daily-summary-item"><div class="ds-label">QC Specialists</div><div class="ds-value">${activeQCs}</div><div class="ds-unit">active</div></div>
                <div class="daily-summary-item"><div class="ds-label">Total Checked</div><div class="ds-value">${totalChecked.toLocaleString('en-IN')}</div><div class="ds-unit">nos</div></div>
                <div class="daily-summary-item"><div class="ds-label">Weight Checked</div><div class="ds-value">${totalCheckedWt.toLocaleString('en-IN', {maximumFractionDigits:1})}</div><div class="ds-unit">Kg</div></div>
                <div class="daily-summary-item" style="border-left: 1px solid var(--border-color);"><div class="ds-label">Accepted</div><div class="ds-value" style="color:var(--accent-green);">${totalAcc}</div><div class="ds-unit">${totalAccWt.toFixed(1)} Kg</div></div>
                <div class="daily-summary-item" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100"><div class="ds-label">Rejected</div><div class="ds-value" style="color:var(--accent-red);">${totalRej} (${rejPct}%)</div><div class="ds-unit">${totalRejWt.toFixed(1)} Kg</div></div>
                <div class="daily-summary-item" style="border-left: 2px dashed var(--accent-red);"><div class="ds-label">Total Defects</div><div class="ds-value" style="color:var(--accent-red);">${totalDefects}</div><div class="ds-unit">detected</div></div>
            </div>
        </div>`;
    } else {
        // Production Specific Calculations
        const shiftsActive = new Set(dayData.map(r => r.shift)).size;
        const dayShiftData = getShiftDataForFurnace().filter(r => String(r['Date'] || '').trim() === dateInfo.display);
        const totalBatches = dayShiftData.reduce((s, r) => s + (parseInt(r['Number of batch']) || 0), 0);
        const totalInputKg = dayShiftData.reduce((s, r) => {
            const bs = parseFloat(r['Input KG_BS'] || 0);
            const l1 = parseFloat(r['Input KG_L1'] || 0);
            const l2 = parseFloat(r['Input KG_L2'] || 0);
            const rr = parseFloat(r['Input KG_RR'] || 0);
            return s + bs + l1 + l2 + rr;
        }, 0);

        // --- Consumption Data from Day Level Data ---
        const dayLevel = getDayLevelDataForDate(dateInfo.display);
        const electricity = dayLevel ? (dayLevel['Electricity Consumption'] || '—') : '—';
        const png = dayLevel ? (dayLevel['PNG Consumption'] || '—') : '—';
        const wireMesh = dayLevel ? (dayLevel['Wire Mesh'] || '—') : '—';
        const tyreOil = dayLevel ? (dayLevel['Tyre Oil'] || '—') : '—';
        const igniteOil = dayLevel ? (dayLevel['Ignite Oil'] || '—') : '—';
        const labourQty = dayLevel ? (dayLevel['Labour Qty'] || '—') : '—';

        // Show plant-wide note only if selected furnace is specific but the data found has no furnace number (meaning it's old plant-wide data)
        const showPlantWideNote = selectedFurnace !== 'all' && dayLevel && !String(dayLevel['Furnace Num'] || '').trim();

        container.innerHTML += `<div class="daily-summary-card">
            <h4>📊 24-Hour Production Summary — ${formatDate(dateInfo.display)}</h4>
            <div class="daily-summary-grid">
                <div class="daily-summary-item"><div class="ds-label">Shifts Active</div><div class="ds-value">${shiftsActive}</div><div class="ds-unit">of 3</div></div>
                <div class="daily-summary-item"><div class="ds-label">Total Pipes</div><div class="ds-value">${totalPipesInDay.toLocaleString('en-IN')}</div><div class="ds-unit">nos</div></div>
                <div class="daily-summary-item"><div class="ds-label">Total Weight</div><div class="ds-value">${totalWt.toLocaleString('en-IN', {maximumFractionDigits:1})}</div><div class="ds-unit">Kg</div></div>
                <div class="daily-summary-item"><div class="ds-label">Accepted</div><div class="ds-value" style="color:var(--accent-green);">${totalAcc}</div><div class="ds-unit">${totalAccWt.toFixed(1)} Kg</div></div>
                <div class="daily-summary-item" data-tooltip="Calculated as: (Rej Wt / Total Wt) * 100"><div class="ds-label">Rejected</div><div class="ds-value" style="color:var(--accent-red);">${totalRej} (${rejPct}%)</div><div class="ds-unit">${totalRejWt.toFixed(1)} Kg</div></div>
                <div class="daily-summary-item" style="border-left: 2px dashed var(--accent-amber);"><div class="ds-label">Input Furnace</div><div class="ds-value" style="color:var(--accent-amber);">${totalInputKg.toLocaleString('en-IN', {maximumFractionDigits:1})}</div><div class="ds-unit">${totalBatches ? totalBatches + ' batches' : 'Total Kg'}</div></div>
            </div>

            <!-- Consumption & Labour Summary -->
            ${showPlantWideNote ? '<div style="font-size:0.75rem;color:var(--text-muted);margin-top:1.25rem;font-style:italic;display:flex;align-items:center;gap:0.4rem;">ℹ️ Plant-wide consumption — common for F1 & F2</div>' : ''}
            <div class="daily-summary-grid consumption-grid-detailed" style="margin-top: ${showPlantWideNote ? '0.5rem' : '1.5rem'}; padding-top: 1.5rem; border-top: 1px solid var(--border-glass);">
                <div class="daily-summary-item"><div class="ds-label">Electricity</div><div class="ds-value" style="color: var(--accent-blue);">${electricity}</div><div class="ds-unit">Consumption</div></div>
                <div class="daily-summary-item"><div class="ds-label">PNG</div><div class="ds-value" style="color: var(--accent-blue);">${png}</div><div class="ds-unit">Consumption</div></div>
                <div class="daily-summary-item"><div class="ds-label">Wire Mesh</div><div class="ds-value" style="color: var(--accent-purple);">${wireMesh}</div></div>
                <div class="daily-summary-item"><div class="ds-label">Tyre Oil</div><div class="ds-value" style="color: var(--accent-purple);">${tyreOil}</div><div class="ds-unit">Ltrs</div></div>
                <div class="daily-summary-item"><div class="ds-label">Ignite Oil</div><div class="ds-value" style="color: var(--accent-purple);">${igniteOil}</div><div class="ds-unit">Ltrs</div></div>
                <div class="daily-summary-item"><div class="ds-label">Labour Qty</div><div class="ds-value" style="color: var(--accent-green);">${labourQty}</div><div class="ds-unit">Workers</div></div>
            </div>
        </div>`;
    }
}

function exportMonthlyCSV() {
    const dateInfo = getDailyDate();
    if (!dateInfo) return;
    const parts = dateInfo.iso.split('-');
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthLabel = `${monthNames[month-1]}-${year}`;

    let csv = 'sep=,\r\n';
    const headers = ['Date','Shift I Pipes','Shift I Wt (Kg)','Shift II Pipes','Shift II Wt (Kg)','Shift III Pipes','Shift III Wt (Kg)','Day Total Pipes','Day Total Wt (Kg)','Accepted','Rejected','Rej %'];
    csv += headers.map(csvSafe).join(',') + '\r\n';

    let gmPipes = 0, gmWt = 0, gmAcc = 0, gmRej = 0;
    let gmAccWtTotal = 0, gmRejWtTotal = 0;

    for (let day = 1; day <= daysInMonth; day++) {
        const dd = String(day).padStart(2, '0');
        const mm = String(month).padStart(2, '0');
        const dateStr = `${dd}-${mm}-${year}`;
        const dayRows = getDataForFurnace().filter(r => r.date === dateStr);

        const byShift = { 'I': { pipes: 0, wt: 0 }, 'II': { pipes: 0, wt: 0 }, 'III': { pipes: 0, wt: 0 } };
        let dayPipes = 0, dayWt = 0, dayAcc = 0, dayRej = 0, dayAccWt = 0, dayRejWt = 0;

        dayRows.forEach(r => {
            const s = r.shift || 'I';
            if (byShift[s]) {
                byShift[s].pipes += r.totalPipes;
                byShift[s].wt += r.totalWt;
            }
            dayPipes += r.totalPipes;
            dayWt += r.totalWt;
            if (r.status === 'QC Checked') {
                dayAcc += r.accepted;
                dayRej += r.rejected;
                dayAccWt += r.acceptedWt;
                dayRejWt += r.rejectedWt;
            }
        });

        gmPipes += dayPipes;
        gmWt += dayWt;
        gmAcc += dayAcc;
        gmRej += dayRej;
        gmAccWtTotal += dayAccWt;
        gmRejWtTotal += dayRejWt;

        const totalWtQC = dayAccWt + dayRejWt;
        const rejPct = totalWtQC > 0 ? ((dayRejWt / totalWtQC) * 100).toFixed(1) + '%' : '';

        csv += [dateStr, byShift['I'].pipes || '', (byShift['I'].wt || 0).toFixed(1),
            byShift['II'].pipes || '', (byShift['II'].wt || 0).toFixed(1),
            byShift['III'].pipes || '', (byShift['III'].wt || 0).toFixed(1),
            dayPipes || '', dayWt ? dayWt.toFixed(1) : '', dayAcc || '', dayRej || '', rejPct
        ].map(csvSafe).join(',') + '\r\n';
    }

    const totalGmWtQC = gmAccWtTotal + gmRejWtTotal;
    const gmRejPct = totalGmWtQC > 0 ? ((gmRejWtTotal / totalGmWtQC) * 100).toFixed(1) + '%' : '';
    csv += ['TOTAL','','','','','','',gmPipes,gmWt.toFixed(1),gmAcc,gmRej,gmRejPct].map(csvSafe).join(',') + '\r\n';

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Demech_Monthly_Summary_${monthLabel}.csv`;
    link.click();
    showToast(`Monthly summary for ${monthLabel} downloaded!`, 'success');
}

// ============ SUMMARY REPORTS (MONTHLY/YEARLY) ============
function setSummaryPeriod(period) {
    summaryPeriod = period;
    document.querySelectorAll('#section-summary .daily-sub-tabs:first-child .daily-sub-tab').forEach(b => b.classList.remove('active'));
    
    let activeBtnId = 'btnSummaryMonthly';
    if (period === 'yearly') activeBtnId = 'btnSummaryYearly';
    if (period === 'range') activeBtnId = 'btnSummaryRange';
    
    document.getElementById(activeBtnId)?.classList.add('active');
    
    document.getElementById('summaryMonthPicker').style.display = period === 'monthly' ? 'block' : 'none';
    document.getElementById('summaryYearPicker').style.display = period === 'yearly' ? 'block' : 'none';
    document.getElementById('summaryRangePicker').style.display = period === 'range' ? 'flex' : 'none';
    
    renderSummaryReport();
}

function switchSummaryView(view) {
    summaryView = view;
    document.querySelectorAll('#section-summary .daily-controls .daily-sub-tab').forEach(b => b.classList.remove('active'));
    document.getElementById(view === 'production' ? 'btnSummaryProd' : 'btnSummaryQual')?.classList.add('active');
    
    // Show/Hide QC toggle area based on view
    const toggleArea = document.getElementById('summaryProdQcToggleArea');
    if (toggleArea) toggleArea.style.display = view === 'production' ? 'flex' : 'none';
    
    renderSummaryReport();
}

function setSummaryLevel(level) {
    summaryLevel = level;
    // Set active button (level selector buttons are in their own sub-tabs container)
    document.getElementById('btnSummaryLvlPipe').classList.toggle('active', level === 'pipe');
    document.getElementById('btnSummaryLvlDay').classList.toggle('active', level === 'day');
    document.getElementById('btnSummaryLvlMonth')?.classList.toggle('active', level === 'month');
    
    // Toggle container visibility
    const pipeSection = document.getElementById('sectionSummaryPipe');
    const daySection = document.getElementById('sectionSummaryDay');
    const monthSection = document.getElementById('sectionSummaryMonth');
    if (pipeSection) pipeSection.style.display = level === 'pipe' ? 'block' : 'none';
    if (daySection) daySection.style.display = level === 'day' ? 'block' : 'none';
    if (monthSection) monthSection.style.display = level === 'month' ? 'block' : 'none';
}

/**
 * Main rendering for Monthly/Yearly summary
 */
function renderSummaryReport() {
    const container = document.getElementById('summaryContent');
    const kpiEl = document.getElementById('summaryKPI');
    if (!container || !kpiEl) return;

    let periodData = [];
    let periodLabel = '';
    const isQual = summaryView === 'quality';
    const dateField = isQual ? 'qcDate' : 'date';

    if (summaryPeriod === 'monthly') {
        const val = document.getElementById('summaryMonth').value;
        if (!val) { 
            kpiEl.innerHTML = '';
            document.getElementById('summaryPipeLevel').innerHTML = '<div class="empty-state">Select a month</div>';
            document.getElementById('summaryDayLevel').innerHTML = '<div class="empty-state">Select a month</div>';
            return; 
        }
        const [year, month] = val.split('-');
        periodData = getDataForFurnace().filter(r => {
            if (isQual && r.status !== 'QC Checked') return false;
            const d = r[dateField];
            if (!d) return false;
            const parts = d.split('-');
            return parts[1] === month && parts[2] === year;
        });
        const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        periodLabel = `${monthNames[parseInt(month)-1]} ${year}`;
    } else if (summaryPeriod === 'range') {
        const startVal = document.getElementById('summaryStartDate').value;
        const endVal = document.getElementById('summaryEndDate').value;
        if (!startVal || !endVal) { 
            kpiEl.innerHTML = '';
            document.getElementById('summaryPipeLevel').innerHTML = '<div class="empty-state">Select a valid range</div>';
            document.getElementById('summaryDayLevel').innerHTML = '<div class="empty-state">Select a valid range</div>';
            return; 
        }
        
        const startDate = new Date(startVal); startDate.setHours(0,0,0,0);
        const endDate = new Date(endVal); endDate.setHours(23,59,59,999);
        
        periodData = getDataForFurnace().filter(r => {
            if (isQual && r.status !== 'QC Checked') return false;
            const dStr = r[dateField];
            if (!dStr) return false;
            const rDate = parseDate(dStr);
            return rDate >= startDate && rDate <= endDate;
        });
        
        periodLabel = `Range: ${formatDate(startVal)} to ${formatDate(endVal)}`;
    } else {
        const val = document.getElementById('summaryYear').value; // e.g. "24-25", "25-26", "26-27"
        periodData = getDataForFurnace().filter(r => {
            if (isQual && r.status !== 'QC Checked') return false;
            const d = r[dateField];
            if (!d) return false;
            const parts = d.split('-');
            if (parts.length < 3) return false;
            
            const yearFull = parseInt(parts[2]);
            const monthInt = parseInt(parts[1]);
            
            // FY logic: Apr (04) to Mar (03) next year
            const [startYY, endYY] = val.split('-').map(y => parseInt(y));
            const startYear = 2000 + startYY;
            const endYear = 2000 + endYY;
            
            if (yearFull === startYear && monthInt >= 4) return true;
            if (yearFull === endYear && monthInt <= 3) return true;
            
            return false;
        });
        periodLabel = `FY 20${val}`;
    }

    if (periodData.length === 0) {
        kpiEl.innerHTML = '';
        document.getElementById('summaryPipeLevel').innerHTML = `<div class="empty-state">No data found for ${periodLabel}</div>`;
        document.getElementById('summaryDayLevel').innerHTML = `<div class="empty-state">No data found for ${periodLabel}</div>`;
        return;
    }

    // Aggregate by Pipe Size
    const pipeMap = {};
    // Aggregate by Day Level
    const dayMap = {};
    // Aggregate by Month Level
    const monthMap = {};

    periodData.forEach(r => {
        // 1. Pipe-wise Aggregation
        const ps = r.pipeSize || '—';
        if (!pipeMap[ps]) {
            pipeMap[ps] = { 
                pipeSize: ps, qty: 0, wt: 0, unitWt: r.wtPerPipe,
                acc: 0, rej: 0, accWt: 0, rejWt: 0,
                cavity: 0, cracks: 0, rCracks: 0, ovality: 0, others: 0
            };
        }
        const p = pipeMap[ps];
        p.qty += r.totalPipes;
        p.wt += r.totalWt;
        
        // 2. Day-level Aggregation
        const d = r[dateField];
        if (!dayMap[d]) {
            dayMap[d] = {
                date: d, qty: 0, wt: 0,
                acc: 0, rej: 0, accWt: 0, rejWt: 0,
                cavity: 0, cracks: 0, rCracks: 0, ovality: 0, others: 0,
                specialists: new Set()
            };
        }
        const day = dayMap[d];
        day.qty += r.totalPipes;
        day.wt += r.totalWt;

        if (r.status === 'QC Checked') {
            // Apply to Pipe Map
            p.acc += r.accepted;
            p.rej += r.rejected;
            p.accWt += r.acceptedWt;
            p.rejWt += r.rejectedWt;
            p.cavity += (r.cavity || 0);
            p.cracks += (r.cracks || 0);
            p.rCracks += (r.rCracks || 0);
            p.ovality += (r.ovality || 0);
            p.others += (r.others || 0);

            // Apply to Day Map
            day.acc += r.accepted;
            day.rej += r.rejected;
            day.accWt += r.acceptedWt;
            day.rejWt += r.rejectedWt;
            day.cavity += (r.cavity || 0);
            day.cracks += (r.cracks || 0);
            day.rCracks += (r.rCracks || 0);
            day.ovality += (r.ovality || 0);
            day.others += (r.others || 0);
            if (r.qcName) {
                r.qcName.split(',').forEach(n => {
                    const cleanName = n.trim();
                    if (cleanName && cleanName !== '—') day.specialists.add(cleanName);
                });
            }
        }
        
        // 3. Month-level Aggregation
        if (d && d.includes('-')) {
            const parts = d.split('-');
            const monthKey = parts[1] + '-' + parts[2]; // MM-YYYY
            
            if (!monthMap[monthKey]) {
                const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                const mName = monthNames[parseInt(parts[1])-1] + ' ' + parts[2];
                monthMap[monthKey] = {
                    monthStr: monthKey,
                    monthName: mName,
                    sortKey: parseInt(parts[2] + parts[1]), // YYYYMM
                    qty: 0, wt: 0,
                    acc: 0, rej: 0, accWt: 0, rejWt: 0,
                    cavity: 0, cracks: 0, rCracks: 0, ovality: 0, others: 0,
                    dates: new Set()
                };
            }
            const m = monthMap[monthKey];
            m.dates.add(d);
            m.qty += r.totalPipes;
            m.wt += r.totalWt;
            
            if (r.status === 'QC Checked') {
                m.acc += r.accepted;
                m.rej += r.rejected;
                m.accWt += r.acceptedWt;
                m.rejWt += r.rejectedWt;
                m.cavity += (r.cavity || 0);
                m.cracks += (r.cracks || 0);
                m.rCracks += (r.rCracks || 0);
                m.ovality += (r.ovality || 0);
                m.others += (r.others || 0);
            }
        }
    });

    // Render KPIs
    const totalQty = periodData.reduce((s,r) => s + r.totalPipes, 0);
    const totalWt = periodData.reduce((s,r) => s + r.totalWt, 0);
    const totalRej = periodData.reduce((s,r) => s + (r.status === 'QC Checked' ? r.rejected : 0), 0);
    const totalAcc = periodData.reduce((s,r) => s + (r.status === 'QC Checked' ? r.accepted : 0), 0);
    const totalAccWtChecked = periodData.reduce((s,r) => s + (r.status === 'QC Checked' ? r.acceptedWt : 0), 0);
    const totalRejWtChecked = periodData.reduce((s,r) => s + (r.status === 'QC Checked' ? r.rejectedWt : 0), 0);
    const totalWeightSum = totalAccWtChecked + totalRejWtChecked;
    const rejPct = totalWeightSum > 0 ? ((totalRejWtChecked / totalWeightSum) * 100).toFixed(1) : '0.0';

    kpiEl.innerHTML = `
        <div class="kpi-card blue">
            <div class="kpi-label">Total Weight</div>
            <div class="kpi-value">${(totalWt/1000).toFixed(1)}T</div>
            <div class="kpi-sub">${totalQty.toLocaleString('en-IN')} pipes</div>
        </div>
        <div class="kpi-card green">
            <div class="kpi-label">Accepted Weight</div>
            <div class="kpi-value">${(totalAccWtChecked/1000).toFixed(1)}T</div>
            <div class="kpi-sub">${totalAcc.toLocaleString('en-IN')} pipes accepted</div>
        </div>
        <div class="kpi-card red">
            <div class="kpi-label">Rejected Weight</div>
            <div class="kpi-value">${(totalRejWtChecked/1000).toFixed(1)}T</div>
            <div class="kpi-sub">${totalRej.toLocaleString('en-IN')} pipes rejected</div>
        </div>
        <div class="kpi-card amber">
            <div class="kpi-label">Rejection Rate</div>
            <div class="kpi-value">${rejPct}%</div>
            <div class="kpi-sub">by total weight</div>
        </div>
    `;

    // Render Both Tables
    const showQC = document.getElementById('toggleSummaryQc')?.checked;
    
    // 1. Table A: Pipe-wise
    renderPipeWiseSummaryTable(pipeMap, document.getElementById('summaryPipeLevel'), summaryView, showQC);
    
    // 2. Table B: Day Level
    renderDayLevelSummaryTable(dayMap, document.getElementById('summaryDayLevel'), summaryView);
    
    // 3. Table C: Month Level
    renderMonthLevelSummaryTable(monthMap, document.getElementById('summaryMonthLevel'), summaryView);
}

function renderMonthLevelSummaryTable(monthMap, container, view) {
    if (!container) return;
    const isQual = view === 'quality';
    const sortedMonths = Object.values(monthMap).sort((a,b) => a.sortKey - b.sortKey);

    let html = `<div class="report-table-wrapper" style="overflow-x: auto; background: rgba(255,255,255,0.02); border-radius: 12px; border: 1px solid var(--border-glass);">`;

    if (isQual) {
        html += `<table class="report-table" style="min-width: 1400px;">
            <thead><tr>
                <th>Month</th><th>Qty (Nos)</th><th>Prod Wt (Kg)</th>
                <th>Acc Nos</th><th>Rej Nos</th><th>Acc Wt</th><th>Rej Wt</th><th>Cavity</th><th>Cracks</th><th>R Cracks</th><th>Ovality</th><th>Others</th><th>Rej %</th>
            </tr></thead><tbody>`;

        sortedMonths.forEach((m) => {
            const pTotalWt = m.accWt + m.rejWt;
            const rp = pTotalWt > 0 ? ((m.rejWt / pTotalWt) * 100).toFixed(1) : '0.0';
            const rc = parseFloat(rp) > 30 ? 'danger' : parseFloat(rp) > 15 ? 'warning' : 'good';
            
            html += `<tr>
                <td><strong>${m.monthName}</strong></td>
                <td>${m.qty}</td>
                <td>${m.wt.toFixed(1)}</td>
                <td style="color:var(--accent-green);">${m.acc}</td>
                <td style="color:var(--accent-red);">${m.rej}</td>
                <td style="color:var(--accent-green);">${m.accWt.toFixed(1)}</td>
                <td style="color:var(--accent-red);">${m.rejWt.toFixed(1)}</td>
                <td>${m.cavity || '—'}</td>
                <td>${m.cracks || '—'}</td>
                <td>${m.rCracks || '—'}</td>
                <td>${m.ovality || '—'}</td>
                <td>${m.others || '—'}</td>
                <td><span class="badge-rate ${rc}">${rp}%</span></td>
            </tr>`;
        });
        
        // Grand Totals for Quality
        const gt = {
            qty: sortedMonths.reduce((s,m) => s + m.qty, 0),
            wt: sortedMonths.reduce((s,m) => s + m.wt, 0),
            acc: sortedMonths.reduce((s,m) => s + m.acc, 0),
            rej: sortedMonths.reduce((s,m) => s + m.rej, 0),
            accWt: sortedMonths.reduce((s,m) => s + m.accWt, 0),
            rejWt: sortedMonths.reduce((s,m) => s + m.rejWt, 0),
            cavity: sortedMonths.reduce((s,m) => s + (m.cavity||0), 0),
            cracks: sortedMonths.reduce((s,m) => s + (m.cracks||0), 0),
            rCracks: sortedMonths.reduce((s,m) => s + (m.rCracks||0), 0),
            ovality: sortedMonths.reduce((s,m) => s + (m.ovality||0), 0),
            others: sortedMonths.reduce((s,m) => s + (m.others||0), 0)
        };
        const rejPct = (gt.accWt + gt.rejWt) > 0 ? (((gt.rejWt) / (gt.accWt + gt.rejWt)) * 100).toFixed(1) : '0.0';

        html += `<tr class="grand-total-row">
            <td><strong>GRAND TOTAL</strong></td>
            <td><strong>${gt.qty.toLocaleString('en-IN')}</strong></td>
            <td><strong>${gt.wt.toFixed(1)}</strong></td>
            <td><strong>${gt.acc.toLocaleString('en-IN')}</strong></td>
            <td><strong>${gt.rej.toLocaleString('en-IN')}</strong></td>
            <td><strong>${gt.accWt.toFixed(1)}</strong></td>
            <td><strong>${gt.rejWt.toFixed(1)}</strong></td>
            <td><strong>${gt.cavity || ''}</strong></td>
            <td><strong>${gt.cracks || ''}</strong></td>
            <td><strong>${gt.rCracks || ''}</strong></td>
            <td><strong>${gt.ovality || ''}</strong></td>
            <td><strong>${gt.others || ''}</strong></td>
            <td><strong><span class="badge-rate ${parseFloat(rejPct) > 30 ? 'danger' : 'good'}">${rejPct}%</span></strong></td>
        </tr>`;

    } else {
        html += `<table class="report-table" style="min-width: 1600px;">
            <thead><tr>
                <th>Month</th><th>Shifts</th><th>Pipes (Nos)</th><th>Weight (Kg)</th>
                <th>Acc Nos</th><th>Acc Wt</th><th>Rej Nos</th><th>Rej Wt</th><th>Rej %</th>
                <th class="col-bl">Input (Kg)</th><th class="col-bl">Electricity</th><th class="col-bl">PNG</th>
                <th class="col-bl">Wire Mesh</th><th class="col-bl">Tyre Oil</th><th class="col-bl">Ignite Oil</th><th class="col-bl">Labour</th>
            </tr></thead><tbody>`;

        sortedMonths.forEach((m) => {
            const pTotalWt = m.accWt + m.rejWt;
            const rp = pTotalWt > 0 ? ((m.rejWt / pTotalWt) * 100).toFixed(1) : '0.0';
            const rc = parseFloat(rp) > 30 ? 'danger' : parseFloat(rp) > 15 ? 'warning' : 'good';
            
            let shiftsActive = 0, totalBatches = 0, inputWeight = 0;
            let cElec = 0, cPng = 0, cWMesh = 0, cTOil = 0, cIOil = 0, cLabour = 0;
            
            m.dates.forEach(dateStr => {
                const dayShiftData = getShiftDataForFurnace().filter(r => String(r['Date'] || '').trim() === dateStr);
                shiftsActive += new Set(dayShiftData.map(r => r['Shift'])).size || 0;
                totalBatches += dayShiftData.reduce((s, r) => s + (parseInt(r['Number of batch'] || r['No of Batch']) || 0), 0);
                inputWeight += dayShiftData.reduce((s, r) => {
                    const bs = parseFloat(r['Input KG_BS'] || 0), l1 = parseFloat(r['Input KG_L1'] || 0), l2 = parseFloat(r['Input KG_L2'] || 0), rr = parseFloat(r['Input KG_RR'] || 0);
                    return s + bs + l1 + l2 + rr;
                }, 0);
                
                const c = getDayLevelDataForDate(dateStr) || {};
                cElec += parseFloat(c['Electricity Consumption'] || 0);
                cPng += parseFloat(c['PNG Consumption'] || 0);
                cWMesh += parseFloat(c['Wire Mesh'] || 0);
                cTOil += parseFloat(c['Tyre Oil'] || 0);
                cIOil += parseFloat(c['Ignite Oil'] || 0);
                cLabour += parseFloat(c['Labour Qty'] || 0);
            });

            html += `<tr>
                <td><strong>${m.monthName}</strong></td>
                <td>${shiftsActive}</td>
                <td>${m.qty}</td>
                <td>${m.wt.toFixed(1)}</td>
                <td class="badge-accepted">${m.acc}</td>
                <td>${m.accWt.toFixed(1)}</td>
                <td class="badge-rejected">${m.rej}</td>
                <td>${m.rejWt.toFixed(1)}</td>
                <td><span class="badge-rate ${rc}">${rp}%</span></td>
                <td class="col-bl">${inputWeight.toFixed(0)} <small>(${totalBatches} bat)</small></td>
                <td class="col-bl">${cElec > 0 ? cElec.toFixed(0) : '—'}</td>
                <td class="col-bl">${cPng > 0 ? cPng.toFixed(0) : '—'}</td>
                <td class="col-bl">${cWMesh > 0 ? cWMesh.toFixed(0) : '—'}</td>
                <td class="col-bl">${cTOil > 0 ? cTOil.toFixed(0) : '—'}</td>
                <td class="col-bl">${cIOil > 0 ? cIOil.toFixed(0) : '—'}</td>
                <td class="col-bl">${cLabour > 0 ? cLabour.toFixed(0) : '—'}</td>
            </tr>`;
        });
        
        // Grand Totals for Production
        const gt = {
            qty: 0, wt: 0, acc: 0, rej: 0, accWt: 0, rejWt: 0,
            input: 0, batches: 0, elec: 0, png: 0, wMesh: 0, tOil: 0, iOil: 0, labour: 0
        };
        
        sortedMonths.forEach(m => {
            gt.qty += m.qty;
            gt.wt += m.wt;
            gt.acc += m.acc;
            gt.rej += m.rej;
            gt.accWt += m.accWt;
            gt.rejWt += m.rejWt;
            
            m.dates.forEach(dateStr => {
                const dayShiftData = getShiftDataForFurnace().filter(r => String(r['Date'] || '').trim() === dateStr);
                gt.batches += dayShiftData.reduce((s, r) => s + (parseInt(r['Number of batch'] || r['No of Batch']) || 0), 0);
                gt.input += dayShiftData.reduce((s, r) => {
                    const bs = parseFloat(r['Input KG_BS'] || 0), l1 = parseFloat(r['Input KG_L1'] || 0), l2 = parseFloat(r['Input KG_L2'] || 0), rr = parseFloat(r['Input KG_RR'] || 0);
                    return s + bs + l1 + l2 + rr;
                }, 0);
                const c = getDayLevelDataForDate(dateStr) || {};
                gt.elec += parseFloat(c['Electricity Consumption'] || 0);
                gt.png += parseFloat(c['PNG Consumption'] || 0);
                gt.wMesh += parseFloat(c['Wire Mesh'] || 0);
                gt.tOil += parseFloat(c['Tyre Oil'] || 0);
                gt.iOil += parseFloat(c['Ignite Oil'] || 0);
                gt.labour += parseFloat(c['Labour Qty'] || 0);
            });
        });

        const rejPct = (gt.accWt + gt.rejWt) > 0 ? (((gt.rejWt) / (gt.accWt + gt.rejWt)) * 100).toFixed(1) : '0.0';

        html += `<tr class="grand-total-row">
            <td colspan="2" style="text-align:right;"><strong>GRAND TOTAL</strong></td>
            <td><strong>${gt.qty.toLocaleString('en-IN')}</strong></td>
            <td><strong>${gt.wt.toFixed(0)}</strong></td>
            <td><strong>${gt.acc}</strong></td>
            <td><strong>${gt.accWt.toFixed(0)}</strong></td>
            <td><strong>${gt.rej}</strong></td>
            <td><strong>${gt.rejWt.toFixed(0)}</strong></td>
            <td><strong><span class="badge-rate ${parseFloat(rejPct) > 30 ? 'danger' : 'good'}">${rejPct}%</span></strong></td>
            <td class="col-bl"><strong>${gt.input.toFixed(0)} <small>(${gt.batches})</small></strong></td>
            <td class="col-bl"><strong>${gt.elec.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.png.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.wMesh.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.tOil.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.iOil.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.labour.toFixed(0)}</strong></td>
        </tr>`;
    }

    html += `</tbody></table></div>`;
    container.innerHTML = html;
}

function renderPipeWiseSummaryTable(pipeMap, container, view, showQC) {
    if (!container) return;
    const isQualView = view === 'quality';
    const displayQC = isQualView || (view === 'production' && showQC);
    const sortedPipes = Object.values(pipeMap).sort((a,b) => sortPipes(a.pipeSize, b.pipeSize));

    let html = `<div class="report-table-wrapper" style="overflow-x: auto; background: rgba(255,255,255,0.02); border-radius: 12px; border: 1px solid var(--border-glass);">
        <table class="report-table" style="min-width: ${displayQC ? '1400px' : '100%'};">
            <thead><tr>
                <th>Sr.</th><th>Pipe Size</th><th>Unit Wt</th><th>Qty (Nos)</th><th>Prod Wt (Kg)</th>
                ${displayQC ? '<th>Acc Nos</th><th>Rej Nos</th><th>Acc Wt</th><th>Rej Wt</th><th>Cavity</th><th>Cracks</th><th>R Cracks</th><th>Ovality</th><th>Others</th><th>Rej %</th>' : ''}
            </tr></thead><tbody>`;

    sortedPipes.forEach((p, idx) => {
        const pTotalWt = p.accWt + p.rejWt;
        const rp = pTotalWt > 0 ? ((p.rejWt / pTotalWt) * 100).toFixed(1) : '0.0';
        const rc = parseFloat(rp) > 30 ? 'danger' : parseFloat(rp) > 15 ? 'warning' : 'good';
        
        html += `<tr>
            <td>${idx + 1}</td>
            <td><strong>${p.pipeSize}</strong></td>
            <td>${p.unitWt}</td>
            <td>${p.qty}</td>
            <td>${p.wt.toFixed(1)}</td>
            ${displayQC ? `
                <td class="badge-accepted">${p.acc}</td>
                <td class="badge-rejected" data-tooltip="${getRejectionTooltip(p)}">${p.rej}</td>
                <td>${p.accWt.toFixed(1)}</td>
                <td>${p.rejWt.toFixed(1)}</td>
                <td>${p.cavity || '—'}</td>
                <td>${p.cracks || '—'}</td>
                <td>${p.rCracks || '—'}</td>
                <td>${p.ovality || '—'}</td>
                <td>${p.others || '—'}</td>
                <td><span class="badge-rate ${rc}">${rp}%</span></td>
            ` : ''}
        </tr>`;
    });

    // Grand Totals Row
    const totalQty = sortedPipes.reduce((s,p) => s + p.qty, 0);
    const totalWt = sortedPipes.reduce((s,p) => s + p.wt, 0);
    const totalAcc = sortedPipes.reduce((s,p) => s + p.acc, 0);
    const totalRej = sortedPipes.reduce((s,p) => s + p.rej, 0);
    const totalAccWt = sortedPipes.reduce((s,p) => s + p.accWt, 0);
    const totalRejWt = sortedPipes.reduce((s,p) => s + p.rejWt, 0);
    const gtDefects = {
        cavity: sortedPipes.reduce((s,p) => s + (p.cavity || 0), 0),
        cracks: sortedPipes.reduce((s,p) => s + (p.cracks || 0), 0),
        rCracks: sortedPipes.reduce((s,p) => s + (p.rCracks || 0), 0),
        ovality: sortedPipes.reduce((s,p) => s + (p.ovality || 0), 0),
        others: sortedPipes.reduce((s,p) => s + (p.others || 0), 0)
    };
    const totalWeightSum = totalAccWt + totalRejWt;
    const rejPct = totalWeightSum > 0 ? ((totalRejWt / totalWeightSum) * 100).toFixed(1) : '0.0';

    html += `<tr class="grand-total-row">
        <td colspan="3" style="text-align:right;"><strong>GRAND TOTAL</strong></td>
        <td><strong>${totalQty.toLocaleString('en-IN')}</strong></td>
        <td><strong>${totalWt.toFixed(1)}</strong></td>
        ${displayQC ? `
            <td><strong>${totalAcc.toLocaleString('en-IN')}</strong></td>
            <td><strong>${totalRej.toLocaleString('en-IN')}</strong></td>
            <td><strong>${totalAccWt.toFixed(1)}</strong></td>
            <td><strong>${totalRejWt.toFixed(1)}</strong></td>
            <td><strong>${gtDefects.cavity || ''}</strong></td>
            <td><strong>${gtDefects.cracks || ''}</strong></td>
            <td><strong>${gtDefects.rCracks || ''}</strong></td>
            <td><strong>${gtDefects.ovality || ''}</strong></td>
            <td><strong>${gtDefects.others || ''}</strong></td>
            <td><strong><span class="badge-rate ${parseFloat(rejPct) > 30 ? 'danger' : 'good'}">${rejPct}%</span></strong></td>
        ` : ''}
    </tr></tbody></table></div>`;
    container.innerHTML = html;
}

function renderDayLevelSummaryTable(dayMap, container, view) {
    if (!container) return;
    const isQual = view === 'quality';
    const sortedDays = Object.values(dayMap).sort((a,b) => parseDate(a.date) - parseDate(b.date));

    let html = `<div class="report-table-wrapper" style="overflow-x: auto; background: rgba(255,255,255,0.02); border-radius: 12px; border: 1px solid var(--border-glass);">`;
    
    if (isQual) {
        // QUALITY DAY LEVEL (Image 1 reference)
        html += `<table class="report-table" style="min-width: 1200px;">
            <thead><tr>
                <th>Date</th><th>QC Specialists</th><th>Checked (Nos)</th><th>Checked Wt (Kg)</th>
                <th>Acc Nos</th><th>Acc Wt</th><th>Rej Nos</th><th>Rej Wt</th><th>Rej %</th><th>Total Defects</th>
            </tr></thead><tbody>`;

        sortedDays.forEach(day => {
            const dayTotalWt = day.accWt + day.rejWt;
            const rp = dayTotalWt > 0 ? ((day.rejWt / dayTotalWt) * 100).toFixed(1) : '0.0';
            const rc = parseFloat(rp) > 30 ? 'danger' : parseFloat(rp) > 15 ? 'warning' : 'good';
            const totalDefects = (day.cavity || 0) + (day.cracks || 0) + (day.rCracks || 0) + (day.ovality || 0) + (day.others || 0);

            html += `<tr>
                <td><strong>${formatDate(day.date)}</strong></td>
                <td>${day.specialists.size} active</td>
                <td>${day.qty}</td>
                <td>${day.wt.toFixed(1)}</td>
                <td class="badge-accepted">${day.acc}</td>
                <td>${day.accWt.toFixed(1)}</td>
                <td class="badge-rejected">${day.rej}</td>
                <td>${day.rejWt.toFixed(1)}</td>
                <td><span class="badge-rate ${rc}">${rp}%</span></td>
                <td style="color:var(--accent-red);">${totalDefects || '—'}</td>
            </tr>`;
        });

        // Grand Totals for Quality
        const gt = {
            qty: sortedDays.reduce((s,d) => s + d.qty, 0),
            wt: sortedDays.reduce((s,d) => s + d.wt, 0),
            acc: sortedDays.reduce((s,d) => s + d.acc, 0),
            rej: sortedDays.reduce((s,d) => s + d.rej, 0),
            accWt: sortedDays.reduce((s,d) => s + d.accWt, 0),
            rejWt: sortedDays.reduce((s,d) => s + d.rejWt, 0),
            defects: sortedDays.reduce((s,d) => s + (d.cavity||0)+(d.cracks||0)+(d.rCracks||0)+(d.ovality||0)+(d.others||0), 0)
        };
        const rejPct = (gt.accWt + gt.rejWt) > 0 ? (((gt.rejWt) / (gt.accWt + gt.rejWt)) * 100).toFixed(1) : '0.0';

        html += `<tr class="grand-total-row">
            <td colspan="2" style="text-align:right;"><strong>GRAND TOTAL</strong></td>
            <td><strong>${gt.qty.toLocaleString('en-IN')}</strong></td>
            <td><strong>${gt.wt.toFixed(1)}</strong></td>
            <td><strong>${gt.acc.toLocaleString('en-IN')}</strong></td>
            <td><strong>${gt.accWt.toFixed(1)}</strong></td>
            <td><strong>${gt.rej.toLocaleString('en-IN')}</strong></td>
            <td><strong>${gt.rejWt.toFixed(1)}</strong></td>
            <td><strong><span class="badge-rate ${parseFloat(rejPct) > 30 ? 'danger' : 'good'}">${rejPct}%</span></strong></td>
            <td><strong>${gt.defects || ''}</strong></td>
        </tr>`;
    } else {
        // PRODUCTION DAY LEVEL (Image 2 reference)
        html += `<table class="report-table" style="min-width: 1600px;">
            <thead><tr>
                <th>Date</th><th>Shifts</th><th>Pipes (Nos)</th><th>Weight (Kg)</th>
                <th>Acc Nos</th><th>Acc Wt</th><th>Rej Nos</th><th>Rej Wt</th><th>Rej %</th>
                <th class="col-bl">Input (Kg)</th><th class="col-bl">Electricity</th><th class="col-bl">PNG</th>
                <th class="col-bl">Wire Mesh</th><th class="col-bl">Tyre Oil</th><th class="col-bl">Ignite Oil</th><th class="col-bl">Labour</th>
            </tr></thead><tbody>`;

        sortedDays.forEach(day => {
            const dayTotalWt = day.accWt + day.rejWt;
            const rp = dayTotalWt > 0 ? ((day.rejWt / dayTotalWt) * 100).toFixed(1) : '0.0';
            const rc = parseFloat(rp) > 30 ? 'danger' : parseFloat(rp) > 15 ? 'warning' : 'good';

            // Lookup Shift Data (for Input Weight/Batches)
            const dayShiftData = getShiftDataForFurnace().filter(r => String(r['Date'] || '').trim() === day.date);
            const shiftsActive = new Set(dayShiftData.map(r => r['Shift'])).size || '—';
            const totalBatches = dayShiftData.reduce((s, r) => s + (parseInt(r['Number of batch'] || r['No of Batch']) || 0), 0);
            const inputWeight = dayShiftData.reduce((s, r) => {
                const bs = parseFloat(r['Input KG_BS'] || 0), l1 = parseFloat(r['Input KG_L1'] || 0), l2 = parseFloat(r['Input KG_L2'] || 0), rr = parseFloat(r['Input KG_RR'] || 0);
                return s + bs + l1 + l2 + rr;
            }, 0);

            // Lookup Consumptions
            const c = getDayLevelDataForDate(day.date) || {};

            html += `<tr>
                <td><strong>${formatDate(day.date)}</strong></td>
                <td>${shiftsActive}</td>
                <td>${day.qty}</td>
                <td>${day.wt.toFixed(1)}</td>
                <td class="badge-accepted">${day.acc}</td>
                <td>${day.accWt.toFixed(1)}</td>
                <td class="badge-rejected">${day.rej}</td>
                <td>${day.rejWt.toFixed(1)}</td>
                <td><span class="badge-rate ${rc}">${rp}%</span></td>
                <td class="col-bl">${inputWeight.toFixed(0)} <small>(${totalBatches} bat)</small></td>
                <td class="col-bl">${c['Electricity Consumption'] || '—'}</td>
                <td class="col-bl">${c['PNG Consumption'] || '—'}</td>
                <td class="col-bl">${c['Wire Mesh'] || '—'}</td>
                <td class="col-bl">${c['Tyre Oil'] || '—'}</td>
                <td class="col-bl">${c['Ignite Oil'] || '—'}</td>
                <td class="col-bl">${c['Labour Qty'] || '—'}</td>
            </tr>`;
        });

        // Grand Totals for Production
        const gt = {
            qty: sortedDays.reduce((s,d) => s + d.qty, 0),
            wt: sortedDays.reduce((s,d) => s + d.wt, 0),
            acc: sortedDays.reduce((s,d) => s + d.acc, 0),
            rej: sortedDays.reduce((s,d) => s + d.rej, 0),
            accWt: sortedDays.reduce((s,d) => s + d.accWt, 0),
            rejWt: sortedDays.reduce((s,d) => s + d.rejWt, 0),
            input: 0, batches: 0,
            elec: 0, png: 0, wMesh: 0, tOil: 0, iOil: 0, labour: 0
        };
        
        sortedDays.forEach(day => {
            const dayShiftData = getShiftDataForFurnace().filter(r => String(r['Date'] || '').trim() === day.date);
            gt.batches += dayShiftData.reduce((s, r) => s + (parseInt(r['Number of batch'] || r['No of Batch']) || 0), 0);
            gt.input += dayShiftData.reduce((s, r) => {
                const bs = parseFloat(r['Input KG_BS'] || 0), l1 = parseFloat(r['Input KG_L1'] || 0), l2 = parseFloat(r['Input KG_L2'] || 0), rr = parseFloat(r['Input KG_RR'] || 0);
                return s + bs + l1 + l2 + rr;
            }, 0);
            const c = getDayLevelDataForDate(day.date) || {};
            gt.elec += parseFloat(c['Electricity Consumption'] || 0);
            gt.png += parseFloat(c['PNG Consumption'] || 0);
            gt.wMesh += parseFloat(c['Wire Mesh'] || 0);
            gt.tOil += parseFloat(c['Tyre Oil'] || 0);
            gt.iOil += parseFloat(c['Ignite Oil'] || 0);
            gt.labour += parseFloat(c['Labour Qty'] || 0);
        });

        const rejPct = (gt.accWt + gt.rejWt) > 0 ? (((gt.rejWt) / (gt.accWt + gt.rejWt)) * 100).toFixed(1) : '0.0';

        html += `<tr class="grand-total-row">
            <td colspan="2" style="text-align:right;"><strong>GRAND TOTAL</strong></td>
            <td><strong>${gt.qty.toLocaleString('en-IN')}</strong></td>
            <td><strong>${gt.wt.toFixed(0)}</strong></td>
            <td><strong>${gt.acc}</strong></td>
            <td><strong>${gt.accWt.toFixed(0)}</strong></td>
            <td><strong>${gt.rej}</strong></td>
            <td><strong>${gt.rejWt.toFixed(0)}</strong></td>
            <td><strong><span class="badge-rate ${parseFloat(rejPct) > 30 ? 'danger' : 'good'}">${rejPct}%</span></strong></td>
            <td class="col-bl"><strong>${gt.input.toFixed(0)} <small>(${gt.batches})</small></strong></td>
            <td class="col-bl"><strong>${gt.elec.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.png.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.wMesh.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.tOil.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.iOil.toFixed(0)}</strong></td>
            <td class="col-bl"><strong>${gt.labour.toFixed(0)}</strong></td>
        </tr>`;
    }
    html += `</tbody></table></div>`;
    container.innerHTML = html;
}

async function exportSummaryCSV() {
    const val = summaryPeriod === 'monthly' ? document.getElementById('summaryMonth').value : document.getElementById('summaryYear').value;
    if (!val) return;
    
    // Select the table based on the CURRENT level
    const targetId = summaryLevel === 'pipe' ? 'summaryPipeLevel' : 'summaryDayLevel';
    const table = document.querySelector(`#${targetId} table`);
    if (!table) return;

    let csv = 'sep=,\r\n';
    const headers = [];
    table.querySelectorAll('thead th').forEach(th => headers.push(th.textContent));
    csv += headers.map(csvSafe).join(',') + '\r\n';

    table.querySelectorAll('tbody tr').forEach(tr => {
        const row = [];
        tr.querySelectorAll('td').forEach(td => {
            let text = td.textContent.trim();
            if (td.querySelector('.badge-rate')) text = text.replace('%', '');
            row.push(text);
        });
        csv += row.map(csvSafe).join(',') + '\r\n';
    });

    const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Demech_${summaryPeriod}_${summaryLevel}_Summary_${val}_${summaryView}.csv`;
    link.click();
    showToast(`${summaryLevel === 'pipe' ? 'Pipe' : 'Day'} summary exported!`, 'success');
}

// ============ TAB NAVIGATION ============
function switchTab(tabName) {
    currentTab = tabName;

    // Update tab styles
    document.querySelectorAll('.page-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');

    // Show/hide sections
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`section-${tabName}`)?.classList.add('active');

    // Hide filters bar on Daily & Summary tabs (they have their own date pickers)
    const filtersBar = document.querySelector('.filters-bar');
    if (filtersBar) {
        const isExcludedTab = (tabName === 'daily' || tabName === 'summary');
        filtersBar.style.display = isExcludedTab ? 'none' : 'flex';

        // Dynamic Filter Groups (only if bar is visible)
        if (!isExcludedTab) {
            const groupQC = document.getElementById('filterGroupQCName');
            if (groupQC) groupQC.style.display = (tabName === 'production') ? 'none' : 'flex';
            
            // Note: Quality tab keeps all filters as requested by client
        }
    }

    // Re-render the active tab content
    renderAll();
}

// ============ EXPORT CSV ============
function csvSafe(val) {
    if (val === undefined || val === null) return '""';
    let str = String(val);
    // Escape quotes and wrap in quotes
    return `"${str.replace(/"/g, '""')}"`;
}

function exportCSV(reportType) {
    if (reportType === 'summary') {
        exportSummaryCSV();
        return;
    }
    const data = (reportType === 'dataquality') ? filteredData : (reportType === 'quality' ? filteredData.filter(r => r.status === 'QC Checked') : filteredData);
    // Start with 'sep=,' to force Excel to use comma regardless of regional settings
    let csvContent = 'sep=,\r\n';

    if (reportType === 'production') {
        const headers = ['Sr.No.', 'Date', 'Shift', 'Production Supervisor', 'CB Pipe Size', 'Total Qty', 'Accepted Qty', 'Rejected Qty', 'Total Weight (Kg)', 'Accepted Weight (Kg)', 'Rejected Weight (Kg)', 'Rejected %'];
        csvContent += headers.map(csvSafe).join(',') + '\r\n';

        const groups = {};
        data.forEach(row => {
            const key = `${row.date}|${row.shift}|${row.supervisor}`;
            if (!groups[key]) groups[key] = { date: row.date, shift: row.shift, supervisor: row.supervisor, pipes: [] };
            groups[key].pipes.push(row);
        });

        let srNo = 1;
        Object.values(groups).forEach(group => {
            group.pipes.forEach((pipe, idx) => {
                const rowArr = [
                    idx === 0 ? srNo : '',
                    idx === 0 ? group.date : '',
                    idx === 0 ? group.shift : '',
                    idx === 0 ? group.supervisor : '',
                    pipe.pipeSize,
                    pipe.totalPipes,
                    pipe.accepted,
                    pipe.rejected,
                    pipe.totalWt.toFixed(1),
                    pipe.acceptedWt.toFixed(1),
                    pipe.rejectedWt.toFixed(1),
                    pipe.rejectedPct
                ];
                csvContent += rowArr.map(csvSafe).join(',') + '\r\n';
            });
            srNo++;
        });
    } else {
        const headers = ['Sr.No.', 'Quality Supervisor Name', 'Date', 'Shift', 'Production Supervisor Name', 'CB Pipe Size', 'Total Qty', 'Accepted Qty', 'Rejected Qty', 'Total Weight (Kg)', 'Accepted Weight (Kg)', 'Rejected Weight (Kg)', 'Rejected %'];
        csvContent += headers.map(csvSafe).join(',') + '\r\n';

        let srNo = 1;
        // Only export QC Checked data for Quality report
        const qData = data.filter(r => r.status === 'QC Checked');
        qData.forEach(row => {
            const rowArr = [
                srNo,
                row.qcName || '—',
                row.qcDate, // Strictly Date for Output
                row.qcShift || row.shift,
                row.supervisor,
                row.pipeSize,
                row.totalPipes,
                row.accepted,
                row.rejected,
                row.totalWt.toFixed(1),
                row.acceptedWt.toFixed(1),
                row.rejectedWt.toFixed(1),
                row.rejectedPct
            ];
            csvContent += rowArr.map(csvSafe).join(',') + '\r\n';
            srNo++;
        });
    }

    // Use Blob with BOM and correct encoding
    const blob = new Blob(['\ufeff', csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `demech_${reportType}_report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exported successfully!', 'success');
}

// ============ TOAST ============
function showToast(message, type = 'success') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3500);
}

// ============ DATA QUALITY / ERROR FLAGGING ============
let dataQualityFlags = [];

// Levenshtein distance for fuzzy name matching
function levenshtein(a, b) {
    const la = a.length, lb = b.length;
    const dp = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));
    for (let i = 0; i <= la; i++) dp[i][0] = i;
    for (let j = 0; j <= lb; j++) dp[0][j] = j;
    for (let i = 1; i <= la; i++) {
        for (let j = 1; j <= lb; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[la][lb];
}


// ============ INIT ============
async function initApp() {
    if (!checkAuth()) return;

    showLoading(true);

    // Update last refresh time
    const refreshEl = document.getElementById('refreshTime');
    if (refreshEl) {
        refreshEl.textContent = `Last refresh: ${new Date().toLocaleTimeString('en-IN')}`;
    }

    try {
        // Fetch data from Google Sheets (sequential to avoid Apps Script concurrency locks causing 5 min hangs)
        const rawData = await fetchSheetData(SHEETS.report);
        const rawPipeMaster = await fetchSheetData(SHEETS.pipeMaster).catch(() => []);
        const rawShiftLevel = await fetchSheetData(SHEETS.shiftLevel).catch(() => []);
        const rawDayLevel = await fetchSheetData(SHEETS.dayLevel).catch(() => []);

        pipeMasterData = rawPipeMaster || [];
        updatePipeMasterOrder(pipeMasterData);
        allData = transformReportData(rawData);
        shiftLevelData = rawShiftLevel || [];
        dayLevelData = rawDayLevel || [];

        // Set default date filter: last 7 days for dashboard
        setDefaultDateRange();

        // Populate filter dropdowns
        populateFilterOptions();

        // Apply filters (will use default date range)
        applyFilters();

        // Set default month for summary
        const summaryMonthInput = document.getElementById('summaryMonth');
        if (summaryMonthInput && !summaryMonthInput.value) {
            const now = new Date();
            summaryMonthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        }

        // Set default dates for custom range (Current Month)
        const summaryStartInput = document.getElementById('summaryStartDate');
        const summaryEndInput = document.getElementById('summaryEndDate');
        if (summaryStartInput && summaryEndInput && !summaryStartInput.value) {
            const now = new Date();
            const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
            const fmt = (d) => {
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                return `${yyyy}-${mm}-${dd}`;
            };
            summaryStartInput.value = fmt(firstDay);
            summaryEndInput.value = fmt(now);
        }

        showToast(`Loaded ${allData.length} records from Google Sheets`, 'success');

    } catch (err) {
        console.error('Init error:', err);
        showToast(`Error: ${err.message}`, 'error');
    }

    showLoading(false);
}

// Set default date range to last 7 days (capped at today)
function setDefaultDateRange() {
    const dateFromEl = document.getElementById('filterDateFrom');
    const dateToEl = document.getElementById('filterDateTo');
    if (!dateFromEl || !dateToEl) return;

    // Only set defaults if user hasn't manually set filters
    if (dateFromEl.value || dateToEl.value) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find the latest date in data, but don't exceed today
    let maxDate = today;
    const allDates = getDataForFurnace().map(r => parseDate(r.date)).filter(d => d && !isNaN(d.getTime()));
    
    if (allDates.length > 0) {
        const latestDataDate = new Date(Math.max(...allDates));
        // If we have data today or in the past, use the latest data date
        // But if the latest data is far in the future, cap it at today
        if (latestDataDate <= today) {
            maxDate = latestDataDate;
        } else {
            maxDate = today;
        }
    }

    const fromDate = new Date(maxDate);
    fromDate.setDate(fromDate.getDate() - 6); // 7 days including maxDate

    // Format as yyyy-mm-dd for HTML date input (using local timezone)
    const fmt = (d) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    };
    dateFromEl.value = fmt(fromDate);
    dateToEl.value = fmt(maxDate);
}

function showLoading(show) {
    const loader = document.getElementById('loadingOverlay');
    if (loader) {
        loader.style.display = show ? 'flex' : 'none';
    }
    document.querySelectorAll('.page-section').forEach(s => {
        if (!show && s.id === `section-${currentTab}`) {
            s.classList.add('active');
        }
    });
}

// Auto-refresh every 5 minutes
setInterval(() => {
    initApp();
}, 5 * 60 * 1000);
