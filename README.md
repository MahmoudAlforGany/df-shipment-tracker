# Delta Fitness Shipment Tracker - Control Tower (web)

An operational, company-shareable web application that turns the Shipment Tracker Tower Excel file into a **live Shipment Control Tower** in the browser. No backend. No install. Open the HTML file, upload the file once (admin password required), and the data stays loaded across refreshes.

> v3.2 (Pro) - Operational follow-up first. The big hero search is the entry point. Same smart-search UX is used for the advanced global search and vendor search (with autocomplete suggestions). Filters are collapsed by default. The shipment table is full-width with smart column hiding on narrow screens. Performance Overview was re-oriented to operational follow-up (Open by Vendor, Delayed by Vendor, ETA next 12 weeks, Risk snapshot, Delay buckets, Status mix) plus a "pulse strip" of follow-up counts. Vendor Scorecard is now a clean card grid with rank pill, grade-coloured border, score progress bar and a 3x2 stat panel. Admin password gates Update Shipment File and Clear Stored Data.

---

## Quick start (regular users)

1. Open **`DF Shipment Tracker Tool (V2).html`** in any modern browser (Chrome / Edge / Firefox / Safari).
2. The dashboard loads automatically from browser storage.
3. Use the big search box at the top to find any shipment by Item Code, Description, Vendor, PO, SO/PI, or Shipment ID.
4. Click any table row for a full shipment detail.

> No data leaves your machine. SheetJS parses the workbook in the browser. Persistence uses IndexedDB on the same origin.

## Quick start (admin / first-time setup)

1. Open the HTML file in your browser.
2. Click **Update Shipment File** in the header.
3. Enter the admin password (default `Fergany@2930410`).
4. Pick the latest `Shipment Tracker Tower 2026 - V?.xlsx`.
5. The whole company now sees the same data after refresh.

---

## What you get (top to bottom)

| Section | Purpose |
|---|---|
| **NAV-style header** | Delta Fitness logo flush far-left · centred title + tagline · Powered-by photo flush far-right · status-pill strip + live system message · in-header admin toolbar (Update / Demo / Export / Print / Clear / Theme). |
| **Hero search** | Big, prominent search box. As you type: instant table filter, autocomplete suggestions (top 6), "Showing results for: 'X' - N of M lines" pill. Highlights matching rows. |
| **Shipment Tracking Table** | Paginated, sortable, sticky-header. Conditional pills for Smart Status / Risk. Priority bar. Click any row for the full detail modal. **Operational entry point.** |
| **Key Performance Indicators** | 8 essential KPIs only: Total Shipments, Open, Delivered, Delayed (Open), At-Risk Lines, On-Time %, Avg Delay (Open), In-Transit Lines. |
| **Filters (collapsible)** | Vendor / Status / Risk / Purpose / PO / ETA from-to / Delay category / Open-only / Critical-only. Independent of the hero search. |
| **Today's Action Control** | 6 priority bands: Critical · Delayed > 7d · ETA in 7d but Open · High-Value at Risk · Vendors with repeated delays · POs requiring escalation. |
| **Performance Overview (charts)** | Status doughnut · Risk bars · Top-10 vendor delays · Delay distribution · 12-month arrivals timeline. |
| **Vendor Scorecard** | Score 0-100 with grade (Excellent / Good / Watchlist / Critical), on-time %, avg delay, risk exposure. |
| **Detail Modal** | Header info · Smart status & risk · Timeline · Recommended next action · All sibling lines under the same shipment. |

---

## Persistence - how it works

**IndexedDB** (browser-native database) is used because the parsed dataset (5,000+ rows x 22 fields) easily exceeds localStorage's 5 MB cap.

### What gets saved

On every successful upload, the app writes one record to IndexedDB:

```
DB:    DeltaShipmentTrackerDB  (origin-scoped)
Store: datasets
Key:   current
Value: {
  meta: {
    fileName, loadedAt, sheetUsed,
    rowCount, shipmentCount,
    savedAt, source: 'upload' | 'demo'
  },
  lines: [...normalized rows...],
  warnings: [...]
}
```

### What happens on refresh

1. Page loads, app checks IndexedDB for `current`.
2. If found: rehydrates `Date` fields (defensive coercion in case the value came back as a string), re-runs `computeLine` on every row so delays etc. reflect today's date, and shows **"Data restored from browser storage"** in the system message.
3. If not found: the empty state is shown with two buttons (Update Shipment File / Try Demo Data).

### What clears data

Only **Clear Stored Data** in the header (also password-gated). Refresh, browser restart, OS reboot, OneDrive sync - none of these clear it. Browser-level "clear site data" or a different browser profile / different machine would.

> Demo data is **never persisted** (it's ephemeral by design).

---

## Updating the shipment file (admin)

1. Click **Update Shipment File** in the header (or in the empty state).
2. Enter the admin password.
3. Pick the latest `.xlsx`.
4. Old data is replaced; system message says **"Data updated successfully"**.
5. All users see the new data on their next refresh.

## Clearing stored data (admin)

1. Click **Clear Stored Data** in the header.
2. Enter the admin password.
3. Confirm.
4. The dashboard returns to the empty state. The original Excel file is untouched.

---

## Admin password

**Default:** `Fergany@2930410`

> Stored in two places:
> - `app.js` line 32 — `const ADMIN_PASSWORD = 'Fergany@2930410';`
> - `Password.txt` (companion reminder file in the same folder)

To change it, edit the top of `app.js`:

```js
const ADMIN_PASSWORD = 'your-new-password';
```

> This is convenience-level access control, not real security - the password is visible in the page source. For a hosted/internal deployment, put the page behind your corporate SSO or any reverse-proxy auth layer instead.

---

## Hero search

Type anything in the big search box at the top. The app instantly:

- Filters the shipment table to matching lines
- Shows a count pill: **"Showing results for: '`<query>`' - 12 of 5,671 lines"**
- Pops a suggestion list (top 6) - click one to fill the search and jump
- Highlights matching rows in the table with an amber bar on the left

Search covers: Item Code, Item Description, Vendor, PO, SO/PI, Shipment ID, and Smart Status. Press `Esc` to clear.

---

## File structure

```
DF Shipment Tracker Tool (V2)/
|-- DF Shipment Tracker Tool (V2).html   (UI shell)
|-- styles.css                            (NAV blue header + dark glass body + responsive + print)
|-- app.js                                (~1,900 lines - parser, engine, persistence, search, modal)
|-- README.md                             (this file)
`-- assets/
    |-- delta-logo.png                    (REQUIRED - drop your logo here)
    |-- mahmoud-photo.png                 (REQUIRED - drop the personal photo here)
    `-- README.txt                        (instructions for asset placement)
```

> If a file in `assets/` is missing, the app shows a graceful initials badge ("DF" / "MA") instead of a broken image.

---

## Replacing the logo / photo

1. Drop **`delta-logo.png`** (256x256 transparent PNG recommended) into `assets/`.
2. Drop **`mahmoud-photo.png`** (256x256 square portrait) into `assets/`.
3. Refresh the browser. Done.

> Watch out for Windows hiding file extensions: a file saved as `delta-logo.png.jpeg` will look correct in Explorer but won't load. Turn on "View - File name extensions" to be sure.

---

## Architecture (what's in `app.js`)

The script is a single IIFE with **clearly numbered layers**:

```
1.  Constants & state                (incl. ADMIN_PASSWORD)
2.  Utilities                        (date parsing, dom, formatting)
3.  Data Upload Layer                (password-gated trigger -> hidden file input -> SheetJS)
4.  Data Normalization Layer         (intelligent column detection)
5.  Shipment Engine                  (line-level calc + rollup)
6.  Risk & Delay Engine              (smart status, risk, priority)
7.  Filter Layer                     (8 filters + global advanced search)
8.  Dashboard / KPI Layer            (8 KPIs + 5 charts)
9.  Action Control Layer             (6 priority bands)
10. Vendor Scorecard
11. Main Tracking Table              (paginated, sortable, sticky)
12. Row Detail Modal
13. Export Layer                     (CSV of current view)
14. Persistence Layer (IndexedDB)
15. Init / event wiring
16. Password Gate                    (modal flow, single attempt)
17. Hero Search                      (instant filter + autocomplete + highlights)
```

### Smart Status engine (date-driven, overrides raw "Received/blank")

```
status contains "received"/"delivered"   ->  Delivered
ETA missing                              ->  In Production / Awaiting ETA
Arrival exists                           ->  Under Clearance | In Transit
TODAY < Proj Ship Date                   ->  In Production
TODAY < ETA                              ->  In Transit
otherwise                                ->  Delayed / At Port
```

### Risk Level

```
Delivered           ->  Closed
Delay > 30          ->  Critical
Delay > 7           ->  High
Delay > 0           ->  Medium
ETA in next 7 days  ->  Medium
otherwise           ->  Low
```

### Priority Score (0-100)

```
priority = clamp(delayDays, 0, 60)
         + risk weight (Crit=25 / High=15 / Med=8 / Low=2)
         + ETA proximity (<=7d = +10, <=30d = +5)
         + log10(value + 1) * 3
```

---

## Browser support

Tested on Chrome 120+, Edge 120+, Firefox 120+, Safari 17+. Uses CSS Grid, `backdrop-filter`, IndexedDB. No build step. No bundler. No npm.

External libraries (CDN):
- [SheetJS](https://sheetjs.com/) `0.18.5` - Excel parser
- [Chart.js](https://www.chartjs.org/) `4.4.1` - charts

For offline use, replace the two `<script src="https://...">` lines in the HTML with local copies.

---

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Shows mojibake (`ðŸš¢`, `â€"`, `Â·`) instead of clean text | The HTML was saved with the wrong encoding by a tool somewhere. The current file is pure ASCII to avoid this entirely - re-download a fresh copy if it ever happens again. |
| Logo / photo show "DF" / "MA" initials | The image file is missing or has wrong extension (`delta-logo.png.jpeg` etc). Drop a clean `.png` in `assets/` and refresh. |
| Empty state still shows after refresh | Either you've never uploaded, or you cleared storage, or you're in a different browser / private mode. Ask admin to upload. |
| "Could not access browser storage" | Browser is in private/incognito mode (IndexedDB blocked) or the page was opened with a strange protocol. Use a normal window. |
| Numbers look wrong after data update | Refresh once - the engine reruns against today's date on every restore. |

---

## Roadmap

- Save filter presets to localStorage
- ETA Calendar view (FullCalendar.js)
- Diff against last week's snapshot
- PDF export of the executive summary (jsPDF)
- Real auth via SSO when hosted on a corporate server

---

**Built by Mahmoud AlforGany - DF SC Planning.**
Runs 100% client-side · No backend · Drop in any folder, double-click the HTML, share with the team.
