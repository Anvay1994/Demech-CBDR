/* ===================================
   Demech CBDR — Shared configuration
   ===================================
   Loaded by BOTH index.html (login) and dashboard.html.

   This exists so the login page does not have to download the whole of
   app.js (174 KB) just to read these two values.

   NOTE: these are not secrets. Any token here is served to every browser
   that opens the dashboard, so it is public by necessity. It identifies
   the app to the Apps Script endpoint; it does not protect the data.
   =================================== */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz7lmAiyM0GjJyyzpQHO1p120YxLqlYWQiiEkF3ZSVvoG8gl38EjRdp93dBe9jX7sB4/exec';
const API_TOKEN = 'demech_qea97pror1_2026'; // must match API_TOKEN in google_apps_script.js
