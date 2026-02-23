/* ===================================
   Demech CBDR Report Portal — App Logic
   Live Google Sheets ↔ Report Portal
   =================================== */

// ============ CONFIG ============
// INSTRUCTIONS:
// 1. Deploy the Google Apps Script (see google_apps_script.js)
// 2. Paste the Web App URL below
// 3. The sheet data stays PRIVATE — only the script can read it
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzU0kl9m9HXm8Awq2aQjf9MPO4wRjvj1FCbytIe5EXI5nFQ48aaNCKx1hem3mOlrbv2/exec'; // ← PASTE YOUR WEB APP URL HERE
const API_TOKEN = 'demech_secure_2025'; // Must match the token in google_apps_script.js

const SHEETS = {
    report: 'Input Level Data', // Set to the raw Input Level Data sheet
    pipeMaster: 'Pipe Master',
    main: 'Summary Sheet'
};

// ============ STATE ============
let allData = [];
let pipeMasterData = [];
let filteredData = [];
let currentTab = 'dashboard';

// ============ AUTH CHECK ============
function checkAuth() {
    if (sessionStorage.getItem('demech_auth') !== 'true') {
        window.location.href = 'index.html';
        return false;
    }
    return true;
}

function logout() {
    sessionStorage.clear();
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
        // Show setup instructions if URL not configured
        showSetupMode();
        return [];
    }

    try {
        const url = `${APPS_SCRIPT_URL}?token=${encodeURIComponent(API_TOKEN)}&sheet=${encodeURIComponent(sheetName)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();

        if (json.error) {
            throw new Error(json.error);
        }

        // Convert JSON rows to same format as CSV parser output
        return json.data || [];
    } catch (err) {
        console.error(`Error fetching sheet "${sheetName}":`, err);
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

        const totalPipes = parseInt(row['Prod Qty']) || parseInt(row['Total Pipe Number']) || 0;
        const accepted = parseInt(row['Accepted Pipes']) || 0;
        const rejected = parseInt(row['Rejected Pipes']) || 0;
        const wtPerPipe = parseFloat(row['WT']) || parseFloat(row['WT Per Pipe']) || 0;
        const totalWt = parseFloat(row['Prod wt']) || parseFloat(row['Total WT Pipes (KG)']) || 0;
        const acceptedWt = parseFloat(row['Accepted Wt']) || 0;

        // Calculate rejected weight
        const rejectedWt = row['Rejected Wt'] !== undefined ? parseFloat(row['Rejected Wt']) : (totalWt - acceptedWt);

        // Use Input Date — handle both DD-MM-YYYY (from Apps Script) and ISO formats
        let rawDate = '';
        const inputDate = String(row['Input Date'] || row['Date for Output'] || row['Date'] || '').trim();
        if (inputDate) {
            // Check if already in DD-MM-YYYY format (from Google Apps Script)
            const ddmmyyyy = inputDate.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
            if (ddmmyyyy) {
                // Already DD-MM-YYYY from Apps Script, use directly
                const dd = ddmmyyyy[1].padStart(2, '0');
                const mm = ddmmyyyy[2].padStart(2, '0');
                rawDate = `${dd}-${mm}-${ddmmyyyy[3]}`;
            } else {
                // ISO or other format — parse carefully
                const d = new Date(inputDate);
                if (!isNaN(d.getTime())) {
                    const dd = String(d.getDate()).padStart(2, '0');
                    const mm = String(d.getMonth() + 1).padStart(2, '0');
                    const yyyy = d.getFullYear();
                    rawDate = `${dd}-${mm}-${yyyy}`;
                }
            }
        }

        return {
            sourceRows: [idx + 2], // Sheet row number (1-indexed header + 0-indexed data)
            dateShift: dateShift,
            date: rawDate,
            shift: shift,
            supervisor: (row['Supervisor'] || row['Supervisor '] || '').trim(),
            qcName: (row['Name'] || '').trim(),
            pipeSize: row['Pipe Size_Calculated'] || '',
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
            rejectedWt: Math.abs(rejectedWt)
        };
    }).filter(r => r.totalPipes > 0);

    // Aggregate by date + shift + supervisor + pipeSize so each pipe size is unique per group
    const aggMap = {};
    transformed.forEach(r => {
        const key = `${r.date}|${r.shift}|${r.supervisor}|${r.pipeSize}`;
        if (!aggMap[key]) {
            aggMap[key] = {
                sourceRows: [],
                dateShift: r.dateShift,
                date: r.date,
                shift: r.shift,
                supervisor: r.supervisor,
                qcNames: new Set(),
                pipeSize: r.pipeSize,
                totalPipes: 0,
                wtPerPipe: r.wtPerPipe,
                totalWt: 0,
                accepted: 0,
                rejected: 0,
                cavity: 0,
                cracks: 0,
                rCracks: 0,
                ovality: 0,
                others: 0,
                acceptedWt: 0,
                rejectedWt: 0
            };
        }
        const a = aggMap[key];
        a.sourceRows.push(...r.sourceRows);
        if (r.qcName) a.qcNames.add(r.qcName);
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
    });

    // Calculate percentages after aggregation
    const aggregated = Object.values(aggMap).map(r => {
        const rejPct = r.totalPipes > 0 ? ((r.rejected / r.totalPipes) * 100).toFixed(1) + '%' : '0.0%';
        const accPct = r.totalPipes > 0 ? ((r.accepted / r.totalPipes) * 100).toFixed(1) + '%' : '0.0%';
        return { ...r, qcName: [...r.qcNames].join(', '), rejectedPct: rejPct, acceptedPct: accPct };
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

    // Handle DD-MM-YYYY format
    const parts = s.split('-');
    if (parts.length === 3) {
        const [d, m, y] = parts;
        return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    }
    return new Date(s);
}

function formatDate(dateStr) {
    const d = parseDate(dateStr);
    if (!d || isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
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
    const pipeSize = document.getElementById('filterPipeSize')?.value;

    filteredData = allData.filter(row => {
        // Date filter — parse as local dates to avoid UTC shift
        if (dateFrom) {
            const rowDate = parseDate(row.date);
            const parts = dateFrom.split('-'); // yyyy-mm-dd from input
            const fromDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            if (rowDate && rowDate < fromDate) return false;
        }
        if (dateTo) {
            const rowDate = parseDate(row.date);
            const parts = dateTo.split('-'); // yyyy-mm-dd from input
            const toDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            if (rowDate && rowDate > toDate) return false;
        }
        // Shift filter
        if (shift && shift !== 'all' && row.shift !== shift) return false;
        // Supervisor filter
        if (supervisor && supervisor !== 'all' && row.supervisor !== supervisor) return false;
        // Pipe Size filter
        if (pipeSize && pipeSize !== 'all' && row.pipeSize !== pipeSize) return false;

        return true;
    });

    renderAll();
}

function resetFilters() {
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value = '';
    document.getElementById('filterShift').value = 'all';
    document.getElementById('filterSupervisor').value = 'all';
    document.getElementById('filterPipeSize').value = 'all';
    filteredData = [...allData];
    renderAll();
}

function populateFilterOptions() {
    const supervisors = [...new Set(allData.map(r => r.supervisor))].sort();
    const pipeSizes = [...new Set(allData.map(r => r.pipeSize))].sort();

    const supSelect = document.getElementById('filterSupervisor');
    const psSelect = document.getElementById('filterPipeSize');

    supSelect.innerHTML = '<option value="all">All Supervisors</option>';
    supervisors.forEach(s => {
        supSelect.innerHTML += `<option value="${s}">${s}</option>`;
    });

    psSelect.innerHTML = '<option value="all">All Sizes</option>';
    pipeSizes.forEach(ps => {
        psSelect.innerHTML += `<option value="${ps}">${ps}</option>`;
    });
}

// ============ KPI RENDERING ============
function renderKPIs() {
    const data = filteredData;
    const totalPipes = data.reduce((s, r) => s + r.totalPipes, 0);
    const totalAccepted = data.reduce((s, r) => s + r.accepted, 0);
    const totalRejected = data.reduce((s, r) => s + r.rejected, 0);
    const totalWt = data.reduce((s, r) => s + r.totalWt, 0);
    const acceptPct = totalPipes > 0 ? ((totalAccepted / totalPipes) * 100).toFixed(1) : '0.0';
    const rejectPct = totalPipes > 0 ? ((totalRejected / totalPipes) * 100).toFixed(1) : '0.0';

    document.getElementById('kpiTotalPipes').textContent = totalPipes.toLocaleString('en-IN');
    document.getElementById('kpiAcceptRate').textContent = acceptPct + '%';
    document.getElementById('kpiRejectRate').textContent = rejectPct + '%';
    document.getElementById('kpiTotalWeight').textContent = totalWt.toLocaleString('en-IN', { maximumFractionDigits: 1 }) + ' Kg';

    // Show date range context
    const rangeLabel = getDateRangeLabel(data);
    const uniqueDays = new Set(data.map(r => r.date)).size;
    document.getElementById('kpiSubPipes').textContent = `${totalAccepted.toLocaleString('en-IN')} accepted / ${totalRejected.toLocaleString('en-IN')} rejected`
        + (rangeLabel ? ` · ${uniqueDays} day${uniqueDays !== 1 ? 's' : ''} (${rangeLabel})` : '');
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

    // Group by Date → Shift → Supervisor → Pipe Sizes
    const groups = {};
    data.forEach(row => {
        const key = `${row.date}|${row.shift}|${row.supervisor}`;
        if (!groups[key]) {
            groups[key] = {
                date: row.date,
                shift: row.shift,
                supervisor: row.supervisor,
                pipes: []
            };
        }
        groups[key].pipes.push(row);
    });

    // Grand totals
    let gtQty = 0, gtAcc = 0, gtRej = 0, gtTotalWt = 0, gtAccWt = 0, gtRejWt = 0;

    let srNo = 1;
    Object.values(groups).forEach(group => {
        // Subtotals for this group
        let stQty = 0, stAcc = 0, stRej = 0, stTotalWt = 0, stAccWt = 0, stRejWt = 0;

        group.pipes.forEach((pipe, idx) => {
            const tr = document.createElement('tr');
            if (idx === 0) tr.classList.add('group-start');
            else tr.classList.add('sub-row');

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

            tr.innerHTML = `
        <td>${idx === 0 ? srNo : ''}</td>
        <td>${idx === 0 ? formatDate(group.date) : ''}</td>
        <td>${idx === 0 ? group.shift : ''}</td>
        <td>${idx === 0 ? group.supervisor : ''}</td>
        <td>${idx === 0 ? (pipe.qcName || '—') : ''}</td>
        <td>${pipe.pipeSize}</td>
        <td>${pipe.totalPipes}</td>
        <td class="badge-accepted">${pipe.accepted}</td>
        <td class="badge-rejected">${pipe.rejected}</td>
        <td>${totalWt.toFixed(1)}</td>
        <td>${acceptedWt.toFixed(1)}</td>
        <td>${rejectedWt.toFixed(1)}</td>
        <td><span class="badge-rate ${rateClass}">${pipe.rejectedPct}</span></td>
      `;
            tbody.appendChild(tr);
        });

        // Subtotal row
        const stRejPct = stQty > 0 ? ((stRej / stQty) * 100).toFixed(1) : '0.0';
        const stRateClass = parseFloat(stRejPct) > 30 ? 'danger' : parseFloat(stRejPct) > 15 ? 'warning' : 'good';
        const stRow = document.createElement('tr');
        stRow.classList.add('subtotal-row');
        stRow.innerHTML = `
        <td colspan="5"></td>
        <td><strong>Subtotal</strong></td>
        <td><strong>${stQty}</strong></td>
        <td><strong>${stAcc}</strong></td>
        <td><strong>${stRej}</strong></td>
        <td><strong>${stTotalWt.toFixed(1)}</strong></td>
        <td><strong>${stAccWt.toFixed(1)}</strong></td>
        <td><strong>${stRejWt.toFixed(1)}</strong></td>
        <td><strong><span class="badge-rate ${stRateClass}">${stRejPct}%</span></strong></td>
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
    const gtRejPct = gtQty > 0 ? ((gtRej / gtQty) * 100).toFixed(1) : '0.0';
    const gtRateClass = parseFloat(gtRejPct) > 30 ? 'danger' : parseFloat(gtRejPct) > 15 ? 'warning' : 'good';
    const gtRow = document.createElement('tr');
    gtRow.classList.add('grand-total-row');
    gtRow.innerHTML = `
        <td colspan="5"></td>
        <td><strong>Grand Total</strong></td>
        <td><strong>${gtQty}</strong></td>
        <td><strong>${gtAcc}</strong></td>
        <td><strong>${gtRej}</strong></td>
        <td><strong>${gtTotalWt.toFixed(1)}</strong></td>
        <td><strong>${gtAccWt.toFixed(1)}</strong></td>
        <td><strong>${gtRejWt.toFixed(1)}</strong></td>
        <td><strong><span class="badge-rate ${gtRateClass}">${gtRejPct}%</span></strong></td>
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

    // Group by supervisor
    const supGroups = {};
    data.forEach(row => {
        if (!supGroups[row.supervisor]) {
            supGroups[row.supervisor] = { daily: {}, monthly: {}, yearly: {} };
        }
        const dateKey = row.date;
        const monthKey = getMonthKey(row.date);
        const yearKey = getYearKey(row.date);

        // Daily
        if (!supGroups[row.supervisor].daily[dateKey]) {
            supGroups[row.supervisor].daily[dateKey] = { totalWt: 0, acceptedWt: 0, rejectedWt: 0 };
        }
        supGroups[row.supervisor].daily[dateKey].totalWt += row.totalWt;
        supGroups[row.supervisor].daily[dateKey].acceptedWt += row.acceptedWt;
        supGroups[row.supervisor].daily[dateKey].rejectedWt += row.rejectedWt;

        // Monthly
        if (!supGroups[row.supervisor].monthly[monthKey]) {
            supGroups[row.supervisor].monthly[monthKey] = { totalWt: 0, acceptedWt: 0, rejectedWt: 0 };
        }
        supGroups[row.supervisor].monthly[monthKey].totalWt += row.totalWt;
        supGroups[row.supervisor].monthly[monthKey].acceptedWt += row.acceptedWt;
        supGroups[row.supervisor].monthly[monthKey].rejectedWt += row.rejectedWt;

        // Yearly
        if (!supGroups[row.supervisor].yearly[yearKey]) {
            supGroups[row.supervisor].yearly[yearKey] = { totalWt: 0, acceptedWt: 0, rejectedWt: 0 };
        }
        supGroups[row.supervisor].yearly[yearKey].totalWt += row.totalWt;
        supGroups[row.supervisor].yearly[yearKey].acceptedWt += row.acceptedWt;
        supGroups[row.supervisor].yearly[yearKey].rejectedWt += row.rejectedWt;
    });

    let srNo = 1;
    Object.entries(supGroups).forEach(([supervisor, periods]) => {
        const types = [
            { label: 'Daily', data: periods.daily },
            { label: 'Monthly', data: periods.monthly },
            { label: 'Yearly', data: periods.yearly }
        ];

        types.forEach((type, typeIdx) => {
            const totals = Object.values(type.data).reduce((acc, d) => {
                acc.totalWt += d.totalWt;
                acc.acceptedWt += d.acceptedWt;
                acc.rejectedWt += d.rejectedWt;
                return acc;
            }, { totalWt: 0, acceptedWt: 0, rejectedWt: 0 });

            const rejPct = totals.totalWt > 0 ? ((totals.rejectedWt / totals.totalWt) * 100).toFixed(2) : '0.00';
            const rateClass = parseFloat(rejPct) > 30 ? 'danger' : parseFloat(rejPct) > 15 ? 'warning' : 'good';

            const tr = document.createElement('tr');
            if (typeIdx === 0) tr.classList.add('group-start');
            else tr.classList.add('summary-sub');
            tr.classList.add('type-row');

            tr.innerHTML = `
        <td>${typeIdx === 0 ? srNo : ''}</td>
        <td>${typeIdx === 0 ? supervisor : ''}</td>
        <td>${type.label}</td>
        <td>${totals.totalWt.toFixed(1)}</td>
        <td>${totals.acceptedWt.toFixed(1)}</td>
        <td>${totals.rejectedWt.toFixed(1)}</td>
        <td><span class="badge-rate ${rateClass}">${rejPct}%</span></td>
      `;
            tbody.appendChild(tr);
        });
        srNo++;
    });
}

// ============ QUALITY REPORT TABLE ============
function renderQualityReport() {
    const data = filteredData;
    const tbody = document.getElementById('qualReportBody');
    tbody.innerHTML = '';

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="13" class="empty-state">No data available</td></tr>';
        return;
    }

    // Group by Date → Shift → Supervisor
    const groups = {};
    data.forEach(row => {
        const key = `${row.date}|${row.shift}|${row.supervisor}`;
        if (!groups[key]) {
            groups[key] = {
                date: row.date,
                shift: row.shift,
                qcName: row.qcName || '—',
                prodSupervisor: row.supervisor,
                pipes: []
            };
        }
        if (row.qcName && groups[key].qcName === '—') {
            groups[key].qcName = row.qcName;
        }
        groups[key].pipes.push(row);
    });

    // Grand totals
    let gtQty = 0, gtAcc = 0, gtRej = 0, gtTotalWt = 0, gtAccWt = 0, gtRejWt = 0;

    let srNo = 1;
    Object.values(groups).forEach(group => {
        // Subtotals for this group
        let stQty = 0, stAcc = 0, stRej = 0, stTotalWt = 0, stAccWt = 0, stRejWt = 0;

        group.pipes.forEach((pipe, idx) => {
            const tr = document.createElement('tr');
            if (idx === 0) tr.classList.add('group-start');
            else tr.classList.add('sub-row');

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

            tr.innerHTML = `
        <td>${idx === 0 ? srNo : ''}</td>
        <td>${idx === 0 ? formatDate(group.date) : ''}</td>
        <td>${idx === 0 ? group.shift : ''}</td>
        <td>${idx === 0 ? group.qcName : ''}</td>
        <td>${idx === 0 ? group.prodSupervisor : ''}</td>
        <td>${pipe.pipeSize}</td>
        <td>${pipe.totalPipes}</td>
        <td class="badge-accepted">${pipe.accepted}</td>
        <td class="badge-rejected">${pipe.rejected}</td>
        <td>${totalWt.toFixed(1)}</td>
        <td>${acceptedWt.toFixed(1)}</td>
        <td>${rejectedWt.toFixed(1)}</td>
        <td><span class="badge-rate ${rateClass}">${pipe.rejectedPct}</span></td>
      `;
            tbody.appendChild(tr);
        });

        // Subtotal row
        const stRejPct = stQty > 0 ? ((stRej / stQty) * 100).toFixed(1) : '0.0';
        const stRateClass = parseFloat(stRejPct) > 30 ? 'danger' : parseFloat(stRejPct) > 15 ? 'warning' : 'good';
        const stRow = document.createElement('tr');
        stRow.classList.add('subtotal-row');
        stRow.innerHTML = `
        <td colspan="5"></td>
        <td><strong>Subtotal</strong></td>
        <td><strong>${stQty}</strong></td>
        <td><strong>${stAcc}</strong></td>
        <td><strong>${stRej}</strong></td>
        <td><strong>${stTotalWt.toFixed(1)}</strong></td>
        <td><strong>${stAccWt.toFixed(1)}</strong></td>
        <td><strong>${stRejWt.toFixed(1)}</strong></td>
        <td><strong><span class="badge-rate ${stRateClass}">${stRejPct}%</span></strong></td>
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
    const gtRejPct = gtQty > 0 ? ((gtRej / gtQty) * 100).toFixed(1) : '0.0';
    const gtRateClass = parseFloat(gtRejPct) > 30 ? 'danger' : parseFloat(gtRejPct) > 15 ? 'warning' : 'good';
    const gtRow = document.createElement('tr');
    gtRow.classList.add('grand-total-row');
    gtRow.innerHTML = `
        <td colspan="5"></td>
        <td><strong>Grand Total</strong></td>
        <td><strong>${gtQty}</strong></td>
        <td><strong>${gtAcc}</strong></td>
        <td><strong>${gtRej}</strong></td>
        <td><strong>${gtTotalWt.toFixed(1)}</strong></td>
        <td><strong>${gtAccWt.toFixed(1)}</strong></td>
        <td><strong>${gtRejWt.toFixed(1)}</strong></td>
        <td><strong><span class="badge-rate ${gtRateClass}">${gtRejPct}%</span></strong></td>
      `;
    tbody.appendChild(gtRow);

    // Update count badge
    const badge = document.getElementById('qualReportCount');
    if (badge) badge.textContent = `${Object.keys(groups).length} groups · ${data.length} rows`;
}

// ============ QUALITY SUMMARY TABLE ============
function renderQualitySummary() {
    const data = filteredData;
    const tbody = document.getElementById('qualSummaryBody');
    tbody.innerHTML = '';

    // Group by Date → Shift → QC Name for summary
    const groups = {};
    data.forEach(row => {
        const qc = row.qcName || '—';
        const key = `${row.date}|${row.shift}|${qc}`;
        if (!groups[key]) {
            groups[key] = {
                date: row.date,
                shift: row.shift,
                qcName: qc,
                totalWt: 0,
                acceptedWt: 0,
                rejectedWt: 0
            };
        }
        groups[key].totalWt += row.totalWt;
        groups[key].acceptedWt += row.acceptedWt;
        groups[key].rejectedWt += row.rejectedWt;
    });

    let srNo = 1;
    Object.values(groups).forEach(group => {
        const rejPct = group.totalWt > 0 ? ((group.rejectedWt / group.totalWt) * 100).toFixed(2) : '0.00';
        const rateClass = parseFloat(rejPct) > 30 ? 'danger' : parseFloat(rejPct) > 15 ? 'warning' : 'good';

        const tr = document.createElement('tr');
        tr.innerHTML = `
      <td>${srNo}</td>
      <td>${formatDate(group.date)}</td>
      <td>${group.shift}</td>
      <td>${group.qcName}</td>
      <td>${group.totalWt.toFixed(1)}</td>
      <td>${group.acceptedWt.toFixed(1)}</td>
      <td>${group.rejectedWt.toFixed(1)}</td>
      <td><span class="badge-rate ${rateClass}">${rejPct}%</span></td>
    `;
        tbody.appendChild(tr);
        srNo++;
    });
}

// ============ CHARTS ============
let chartAccRej = null;
let chartDefects = null;
let chartSupervisor = null;

function renderCharts() {
    renderAcceptRejectChart();
    renderDefectsChart();
    renderSupervisorChart();
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
            groups[key] = { accepted: 0, rejected: 0, sortDate: parseDate(row.date) };
            groupOrder.push(key);
        }
        groups[key].accepted += row.accepted;
        groups[key].rejected += row.rejected;
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
        const total = groups[k].accepted + groups[k].rejected;
        return total > 0 ? parseFloat(((groups[k].rejected / total) * 100).toFixed(1)) : 0;
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
            supGroups[row.supervisor] = { accepted: 0, rejected: 0 };
        }
        supGroups[row.supervisor].accepted += row.accepted;
        supGroups[row.supervisor].rejected += row.rejected;
    });

    const labels = Object.keys(supGroups);
    const acceptedVals = labels.map(s => supGroups[s].accepted);
    const rejectedVals = labels.map(s => supGroups[s].rejected);
    const rejPctVals = labels.map(s => {
        const total = supGroups[s].accepted + supGroups[s].rejected;
        return total > 0 ? parseFloat(((supGroups[s].rejected / total) * 100).toFixed(1)) : 0;
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
    } else if (currentTab === 'production') {
        renderProductionReport();
        renderProductionSummary();
    } else if (currentTab === 'quality') {
        renderQualityReport();
        renderQualitySummary();
    }
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
    const data = filteredData;
    // Start with 'sep=,' to force Excel to use comma regardless of regional settings
    let csvContent = 'sep=,\r\n';

    if (reportType === 'production') {
        const headers = ['Sr.No.', 'Date', 'Shift', 'Production Supervisor', 'Name (QC)', 'CB Pipe Size', 'Total Qty', 'Accepted Qty', 'Rejected Qty', 'Total Weight (Kg)', 'Accepted Weight (Kg)', 'Rejected Weight (Kg)', 'Rejected %'];
        csvContent += headers.map(csvSafe).join(',') + '\r\n';

        const groups = {};
        data.forEach(row => {
            const key = `${row.date}|${row.shift}|${row.supervisor}`;
            if (!groups[key]) groups[key] = { date: row.date, shift: row.shift, supervisor: row.supervisor, qcName: row.qcName || '—', pipes: [] };
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
                    idx === 0 ? group.qcName : '',
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
        const headers = ['Sr.No.', 'Date', 'Shift', 'Quality Supervisor (Name)', 'Production Supervisor', 'CB Pipe Size', 'Total Qty', 'Accepted Qty', 'Rejected Qty', 'Total Weight (Kg)', 'Accepted Weight (Kg)', 'Rejected Weight (Kg)', 'Rejected %'];
        csvContent += headers.map(csvSafe).join(',') + '\r\n';

        let srNo = 1;
        data.forEach(row => {
            const rowArr = [
                srNo,
                row.date,
                row.shift,
                row.qcName || '—',
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

function runErrorChecks(data, pipeMaster) {
    const flags = [];

    // 1. Similar Supervisor Names
    const supervisors = [...new Set(data.map(r => r.supervisor).filter(s => s))];
    const checkedPairs = new Set();
    for (let i = 0; i < supervisors.length; i++) {
        for (let j = i + 1; j < supervisors.length; j++) {
            const a = supervisors[i], b = supervisors[j];
            const pairKey = [a, b].sort().join('||');
            if (checkedPairs.has(pairKey)) continue;
            checkedPairs.add(pairKey);
            const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
            if (dist > 0 && dist <= 3) {
                // Collect all row IDs for both supervisor names
                const affectedRows = data.filter(r => r.supervisor === a || r.supervisor === b)
                    .flatMap(r => r.sourceRows || []);
                flags.push({
                    severity: 'warning',
                    type: 'Similar Names',
                    details: `"${a}" and "${b}" look similar (edit distance: ${dist}). Possible misspelling?`,
                    date: '—',
                    affected: `${a}, ${b}`,
                    rowIds: affectedRows
                });
            }
        }
    }

    // 2. Invalid Pipe Sizes (cross-reference Pipe Master)
    if (pipeMaster && pipeMaster.length > 0) {
        const validSizes = new Set();
        pipeMaster.forEach(pm => {
            if (pm['Pipe Size'] && pm['Length'] && pm['Thk']) {
                validSizes.add(`${pm['Pipe Size']}x${pm['Length']}x${pm['Thk']}`);
            }
        });
        const dataPipeSizes = [...new Set(data.map(r => r.pipeSize).filter(s => s))];
        dataPipeSizes.forEach(ps => {
            if (!validSizes.has(ps)) {
                const affectedRows = data.filter(r => r.pipeSize === ps)
                    .flatMap(r => r.sourceRows || []);
                flags.push({
                    severity: 'error',
                    type: 'Invalid Pipe Size',
                    details: `Pipe size "${ps}" not found in Pipe Master sheet.`,
                    date: '—',
                    affected: ps,
                    rowIds: affectedRows
                });
            }
        });
    }

    // 3. Math Errors (Accepted + Rejected ≠ Total)
    data.forEach(row => {
        if (row.accepted + row.rejected !== row.totalPipes) {
            flags.push({
                severity: 'error',
                type: 'Qty Mismatch',
                details: `Accepted (${row.accepted}) + Rejected (${row.rejected}) = ${row.accepted + row.rejected}, but Total is ${row.totalPipes}`,
                date: row.date || '—',
                affected: `${row.supervisor} / ${row.pipeSize}`,
                rowIds: row.sourceRows || []
            });
        }
    });

    // 4. High Rejection Rate (> 40%)
    data.forEach(row => {
        if (row.totalPipes > 0) {
            const rejRate = (row.rejected / row.totalPipes) * 100;
            if (rejRate > 40) {
                flags.push({
                    severity: 'warning',
                    type: 'High Rejection',
                    details: `Rejection rate ${rejRate.toFixed(1)}% exceeds 40% threshold.`,
                    date: row.date || '—',
                    affected: `${row.supervisor} / ${row.pipeSize}`,
                    rowIds: row.sourceRows || []
                });
            }
        }
    });

    // 5. Missing / Empty Fields
    data.forEach(row => {
        const missing = [];
        if (!row.supervisor) missing.push('Supervisor');
        if (!row.pipeSize) missing.push('Pipe Size');
        if (!row.date) missing.push('Date');
        if (missing.length > 0) {
            flags.push({
                severity: 'error',
                type: 'Missing Data',
                details: `Missing fields: ${missing.join(', ')}`,
                date: row.date || '—',
                affected: row.supervisor || 'Unknown',
                rowIds: row.sourceRows || []
            });
        }
    });

    // Sort: errors first, then warnings
    flags.sort((a, b) => {
        if (a.severity === 'error' && b.severity !== 'error') return -1;
        if (a.severity !== 'error' && b.severity === 'error') return 1;
        return 0;
    });

    return flags;
}

function renderDataQuality() {
    const tbody = document.getElementById('dqReportBody');
    const badge = document.getElementById('errorBadge');
    const countEl = document.getElementById('dqReportCount');
    const errorsEl = document.getElementById('dqErrors');
    const warningsEl = document.getElementById('dqWarnings');
    const checkedEl = document.getElementById('dqChecked');
    const healthEl = document.getElementById('dqHealth');

    if (!tbody) return;

    const errors = dataQualityFlags.filter(f => f.severity === 'error').length;
    const warnings = dataQualityFlags.filter(f => f.severity === 'warning').length;
    const total = dataQualityFlags.length;

    // Update badge on tab
    if (badge) {
        badge.textContent = total;
        badge.style.display = total > 0 ? 'inline-flex' : 'none';
    }

    // Update KPI cards
    if (errorsEl) errorsEl.textContent = errors;
    if (warningsEl) warningsEl.textContent = warnings;
    if (checkedEl) checkedEl.textContent = allData.length;
    if (countEl) countEl.textContent = `${total} issues found`;

    // Health score: 100 - (errors*5 + warnings*1), min 0
    if (healthEl) {
        const score = Math.max(0, 100 - (errors * 5 + warnings * 1));
        healthEl.textContent = `${score}%`;
        healthEl.style.color = score >= 80 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--danger)';
    }

    if (total === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:2rem; color: var(--success);">✅ No issues found! Data quality looks great.</td></tr>`;
        return;
    }

    let html = '';
    dataQualityFlags.forEach((flag, idx) => {
        const severityClass = flag.severity === 'error' ? 'severity-error' : 'severity-warning';
        const severityLabel = flag.severity === 'error' ? '🔴 Error' : '🟡 Warning';
        const rowIdsStr = (flag.rowIds && flag.rowIds.length > 0) ? flag.rowIds.join(', ') : '—';
        html += `<tr class="${severityClass}">
            <td>${idx + 1}</td>
            <td><span class="severity-pill ${flag.severity}">${severityLabel}</span></td>
            <td>${flag.type}</td>
            <td>${flag.details}</td>
            <td>${flag.date}</td>
            <td>${flag.affected}</td>
            <td><span class="row-ids">${rowIdsStr}</span></td>
        </tr>`;
    });
    tbody.innerHTML = html;
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
        // Fetch data from Google Sheets (parallel)
        const [rawData, rawPipeMaster] = await Promise.all([
            fetchSheetData(SHEETS.report),
            fetchSheetData(SHEETS.pipeMaster).catch(() => [])
        ]);

        allData = transformReportData(rawData);
        pipeMasterData = rawPipeMaster || [];

        // Set default date filter: last 7 days for dashboard
        setDefaultDateRange();

        // Run error checks
        dataQualityFlags = runErrorChecks(allData, pipeMasterData);

        // Populate filter dropdowns
        populateFilterOptions();

        // Apply filters (will use default date range)
        applyFilters();
        renderDataQuality();

        const flagCount = dataQualityFlags.length;
        const msg = flagCount > 0
            ? `Loaded ${allData.length} records · ${flagCount} data quality issue${flagCount > 1 ? 's' : ''} found`
            : `Loaded ${allData.length} records from Google Sheets`;
        showToast(msg, flagCount > 0 ? 'warning' : 'success');

    } catch (err) {
        console.error('Init error:', err);
        showToast(`Error: ${err.message}`, 'error');
    }

    showLoading(false);
}

// Set default date range to last 7 days
function setDefaultDateRange() {
    const dateFromEl = document.getElementById('filterDateFrom');
    const dateToEl = document.getElementById('filterDateTo');
    if (!dateFromEl || !dateToEl) return;

    // Only set defaults if user hasn't manually set filters
    if (dateFromEl.value || dateToEl.value) return;

    // Find the latest date in data
    const allDates = allData.map(r => parseDate(r.date)).filter(d => d && !isNaN(d.getTime()));
    if (allDates.length === 0) return;

    const maxDate = new Date(Math.max(...allDates));
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
