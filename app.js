/* ============================================================
   DELTA FITNESS — SHIPMENT CONTROL TOWER (web)
   ============================================================
   Architecture (single-file IIFE for easy file:// loading):

     1.  Constants & state
     2.  Utilities (date, number, dom helpers)
     3.  Data Upload Layer        - file input / drag&drop / SheetJS
     4.  Data Normalization Layer - intelligent column detection
     5.  Shipment Engine          - line-level calc + rollup
     6.  Risk & Delay Engine      - smart status, risk, priority
     7.  Filter Layer             - global search + 8 filters
     8.  Dashboard / KPI Layer    - 14 KPI cards + 5 charts
     9.  Action Control Layer     - 6 priority bands
    10.  Vendor Scorecard
    11.  Main Tracking Table      - paginated, sortable, sticky
    12.  Row Detail Modal
    13.  Export Layer             - CSV of current view
    14.  Init / event wiring
   ============================================================ */
(function () {
  'use strict';

  /* ============================================================
     1. CONSTANTS & STATE
     ============================================================ */

  // Admin password — gates Update Shipment File and Clear Stored Data.
  // Change this string to set a new password for your team.
  // (Note: this is convenience-level access control, NOT real security —
  //  the password is visible in the source. Real security needs server-side auth.)
  const ADMIN_PASSWORD = 'Fergany@2930410';

  const TODAY = stripTime(new Date());

  // Status priority — higher = worse (used for "worst-status" rollup at shipment level)
  const STATUS_PRIORITY = {
    'Delivered':         0,
    'Closed':            0,
    'Awaiting ETA':      1,
    'Not Shipped':       2,
    'Not Shipped / TBA': 2,
    'In Production':     3,
    'Ready':             4,
    'In Transit':        5,
    'Arrived / At Port': 6,
    'Under Clearance':   7,
    'Delayed':           8,
    'Delayed / At Port': 8,
  };
  const RISK_PRIORITY = { 'Closed': 0, 'Low': 1, 'Medium': 2, 'High': 3, 'Critical': 4 };

  // Smart Status colour class (for pills in table & modal)
  const STATUS_PILL_CLASS = {
    'Delivered': 'delivered',
    'Closed': 'closed',
    'In Transit': 'in-transit',
    'In Production': 'in-production',
    'Under Clearance': 'under-clearance',
    'Ready': 'in-production',
    'Arrived / At Port': 'under-clearance',
    'Delayed': 'delayed',
    'Delayed / At Port': 'delayed',
    'Awaiting ETA': 'awaiting',
    'Not Shipped': 'not-shipped',
    'Not Shipped / TBA': 'not-shipped',
  };

  // Column-name -> canonical-field map (case-insensitive substring/exact match)
  // Order matters: more-specific aliases first
  const COL_ALIASES = {
    itemCode:    ['item code', 'sku', 'product code', 'material code', 'material'],
    description: ['description', 'item description', 'product description', 'product', 'item name'],
    qty:         ['qty', 'quantity', 'units', 'order qty', 'pcs', 'pieces'],
    po:          ['po no.', 'po no', 'po number', 'po#', 'purchase order', 'po'],
    soPi:        ['so/pi no.', 'so/pi', 'so no', 'pi no', 'sales order', 'order number', 'so'],
    orderDate:   ['order date', 'po date'],
    shipDate:    ['projected shipment date', 'shipment date', 'ship date', 'planned shipment', 'proj ship date'],
    purpose:     ['purpose', 'category', 'segment', 'project'],
    eta:         ['eta date', 'eta (raw)', 'eta', 'expected arrival', 'expected eta'],
    arrival:     ['arrival start date', 'estimated date of arrival in warehouse', 'arrival (raw)', 'actual arrival', 'arrival date', 'arrival', 'received date', 'delivered date'],
    vendor:      ['vendor (clean)', 'supplier', 'vendor', 'manufacturer'],
    status:      ['original status', 'status'],
    // pre-computed (V2/V3 model)
    smartStatus: ['smart status'],
    riskLevel:   ['risk level'],
    delayDays:   ['delay days'],
    nextAction:  ['next action'],
    estValue:    ['estimated value', 'value', 'shipment value'],
    shipmentId:  ['shipment id'],
    leadTime:    ['lead time (d)', 'lead time'],
    transitTime: ['transit time (d)', 'transit time'],
    aging:       ['shipment aging (d)', 'shipment aging', 'aging (d)'],
    daysToEta:   ['days to eta'],
  };

  // Application state (single source of truth for the UI)
  const state = {
    rows: [],            // line-level normalized rows
    shipments: [],       // shipment-level rollup (one row per Shipment ID)
    vendors: [],         // vendor scorecard rows
    filters: {           // current filter selections
      search: '', vendor: '', status: '', risk: '', purpose: '', po: '',
      etaFrom: null, etaTo: null, delayCat: '', openOnly: false, criticalOnly: false,
    },
    sort: { table: { key: 'priority', dir: 'desc' }, vendor: { key: 'rank', dir: 'asc' } },
    page: 1, pageSize: 50,
    fileName: '',
    loadedAt: null,
    charts: {},          // Chart.js instances
    sheetUsed: null,
    warnings: [],
  };

  /* ============================================================
     2. UTILITIES
     ============================================================ */

  function stripTime(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
  function isValidDate(d) { return d instanceof Date && !isNaN(d.getTime()); }
  function daysBetween(later, earlier) {
    if (!isValidDate(later) || !isValidDate(earlier)) return null;
    return Math.round((stripTime(later) - stripTime(earlier)) / 86400000);
  }
  function fmtDate(d) {
    if (!isValidDate(d)) return '—';
    const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${String(d.getDate()).padStart(2,'0')}-${m[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
  }
  function fmtDateLong(d) {
    if (!isValidDate(d)) return '—';
    const m = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${m[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
  function fmtNum(n, decimals = 0) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  function fmtPct(n, decimals = 1) {
    if (n == null || isNaN(n)) return '—';
    return (n * 100).toFixed(decimals) + '%';
  }
  function fmtMoney(n) {
    if (n == null || isNaN(n)) return '—';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function escapeHTML(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }
  function getEl(id) { return document.getElementById(id); }
  function clearEl(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

  /**
   * Robust date parser — handles:
   *   - Excel serial numbers (origin 1900, with pre-1900 trimmed)
   *   - JS Date objects
   *   - "DD/Mmm/YY", "DD-Mmm-YY", "DD Mmm YYYY"
   *   - "DD MMM - DD MMM" arrival ranges (returns START date)
   *   - ISO strings, generic Date-parsable strings
   *   - "TBA", "—", null, '' -> null
   */
  function parseDate(v) {
    if (v == null) return null;
    if (v instanceof Date) return isValidDate(v) ? v : null;
    if (typeof v === 'number') {
      if (v < 1) return null;
      // Excel serial -> JS date (1900 origin, ignoring 1900-Feb-29 bug for typical values)
      const ms = (v - 25569) * 86400 * 1000;
      const d = new Date(ms);
      return isValidDate(d) ? stripTime(d) : null;
    }
    let s = String(v).trim();
    if (!s || /^(tba|n\/?a|—|-+)$/i.test(s)) return null;
    // DD/Mmm/YY  or  DD-Mmm-YY  or  DD Mmm YYYY
    let m = s.match(/^(\d{1,2})[\/\-\s]+([A-Za-z]+)[\/\-\s]+(\d{2,4})$/);
    if (m) {
      const mon = monthIdx(m[2]); if (mon === -1) return null;
      let yr = parseInt(m[3], 10); if (yr < 100) yr += 2000;
      return new Date(yr, mon, parseInt(m[1], 10));
    }
    // Arrival range "DD MMM - DD MMM" (or "DD-MMM - DD MMM")
    m = s.match(/^(\d{1,2})\s*[-\s]\s*([A-Za-z]+)\s*[-—]\s*\d/);
    if (m) {
      const mon = monthIdx(m[2]); if (mon === -1) return null;
      const yr = TODAY.getFullYear();
      return new Date(yr, mon, parseInt(m[1], 10));
    }
    // ISO or anything Date can parse
    const d = new Date(s);
    return isValidDate(d) ? stripTime(d) : null;
  }
  function monthIdx(name) {
    const k = name.toLowerCase().slice(0, 3);
    return ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(k);
  }

  /** Match a header to a canonical field name using the alias table. */
  function detectColumns(headerRow) {
    const lower = headerRow.map(h => String(h || '').trim().toLowerCase());
    const result = {};
    for (const [field, aliases] of Object.entries(COL_ALIASES)) {
      let idx = -1;
      // exact match first
      for (const a of aliases) {
        const i = lower.indexOf(a);
        if (i !== -1) { idx = i; break; }
      }
      // substring fallback (less specific)
      if (idx === -1) {
        for (const a of aliases) {
          const i = lower.findIndex(h => h.includes(a));
          if (i !== -1) { idx = i; break; }
        }
      }
      if (idx !== -1) result[field] = idx;
    }
    return result;
  }

  /* ============================================================
     3. DATA UPLOAD LAYER
     ============================================================ */

  /**
   * v3.1 — Upload is now hidden from regular users.
   * Only the admin can update the file or clear stored data, and only
   * after a password prompt. Drag-and-drop is removed because the file
   * input has no visible drop-zone any more.
   */
  function bindUploadEvents() {
    const fileInput = getEl('fileInput');

    // The hidden file input still triggers the parser when a file is chosen.
    fileInput.addEventListener('change', e => {
      if (e.target.files && e.target.files[0]) {
        loadFile(e.target.files[0]);
        // reset so re-uploading the same filename still fires `change`
        e.target.value = '';
      }
    });

    // Update Shipment File buttons (header + empty state) — both password-gated.
    const triggerUpload = () => {
      promptPassword('Enter the admin password to upload a new shipment file.', () => {
        fileInput.click();
      });
    };
    getEl('btnUpdateFile').addEventListener('click', triggerUpload);
    const emptyUpdate = getEl('emptyUpdateBtn'); if (emptyUpdate) emptyUpdate.addEventListener('click', triggerUpload);
  }

  function loadFile(file) {
    state.fileName = file.name;
    state.loadedAt = new Date();
    setSystemMessage(`Reading ${file.name}…`, 'info');
    setPill('engine', 'warn', '— parsing');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array', cellDates: true });
        ingestWorkbook(wb);
      } catch (err) {
        console.error(err);
        setSystemMessage('Failed to parse file: ' + err.message, 'error');
        setPill('engine', 'warn', '— error');
      }
    };
    reader.onerror = () => { setSystemMessage('File read failed.', 'error'); setPill('engine', 'warn', '— error'); };
    reader.readAsArrayBuffer(file);
  }

  /* ============================================================
     4. DATA NORMALIZATION LAYER
     ============================================================ */

  function ingestWorkbook(wb) {
    state.warnings = [];
    // Choose best sheet:
    //   1. exact match on common engine names
    //   2. sheet whose header contains both "po" + ("eta" or "supplier")
    const preferred = ['Shipment Model', 'Shipment_Model', 'Shipment Engine', 'Shipment_Engine', 'LOG Raw Data', 'LOG_Raw_Data', '2026'];
    let chosen = null;
    for (const name of preferred) {
      if (wb.SheetNames.includes(name)) { chosen = name; break; }
    }
    if (!chosen) {
      for (const name of wb.SheetNames) {
        const sh = wb.Sheets[name];
        const headerRow = (XLSX.utils.sheet_to_json(sh, { header: 1, range: 0 })[0] || []).map(h => String(h || '').toLowerCase());
        if (headerRow.includes('po no.') || headerRow.includes('po') || headerRow.includes('po number')) { chosen = name; break; }
      }
    }
    if (!chosen) chosen = wb.SheetNames[0];
    state.sheetUsed = chosen;

    const sheet = wb.Sheets[chosen];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false, dateNF: 'yyyy-mm-dd' });
    if (!rawRows.length) { setSystemMessage('Sheet is empty.', 'error'); setPill('engine', 'warn', '— error'); return; }

    // header is the first row containing recognizable column names
    let headerRow = rawRows[0];
    let cols = detectColumns(headerRow);
    if (Object.keys(cols).length < 4 && rawRows.length > 1) {
      // try second row in case of merged title
      headerRow = rawRows[1];
      cols = detectColumns(headerRow);
    }
    if (Object.keys(cols).length < 4) {
      setSystemMessage('Could not detect shipment columns in sheet "' + chosen + '". Check the file format.', 'error');
      setPill('engine', 'warn', '— error');
      return;
    }

    // Build line-level rows
    const dataStart = (headerRow === rawRows[1]) ? 2 : 1;
    const lines = [];
    for (let r = dataStart; r < rawRows.length; r++) {
      const row = rawRows[r];
      if (!row || row.every(v => v == null || v === '')) continue;
      const get = key => cols[key] != null ? row[cols[key]] : null;

      const itemCode    = clean(get('itemCode'));
      const description = clean(get('description'));
      const po          = clean(get('po'));
      // skip rows with no PO and no item — likely empty
      if (!po && !itemCode) continue;

      const qty = parseFloat(get('qty')) || 0;
      const orderDate   = parseDate(get('orderDate'));
      const shipDate    = parseDate(get('shipDate'));
      const eta         = parseDate(get('eta'));
      const arrival     = parseDate(get('arrival'));
      const vendorRaw   = clean(get('vendor'));
      const status      = clean(get('status'));
      const purpose     = clean(get('purpose'));
      const soPi        = clean(get('soPi'));

      const vendor = cleanVendor(vendorRaw);
      const shipmentId = clean(get('shipmentId')) || (po ? `${po} | ${purpose || '-'}` : '');

      // pre-computed fields if present
      const preSmart    = clean(get('smartStatus'));
      const preRisk     = clean(get('riskLevel'));
      const preDelay    = parseFloat(get('delayDays'));
      const preAction   = clean(get('nextAction'));
      const preValue    = parseFloat(get('estValue'));

      lines.push({
        rowIdx: r,
        itemCode, description, qty, po, soPi, vendor, vendorRaw,
        purpose, orderDate, shipDate, eta, arrival, status,
        shipmentId,
        // engine fields will be added below
        leadTime: null, transitTime: null, aging: null, daysToEta: null,
        delayDays: null, delayCategory: null,
        smartStatus: null, riskLevel: null, priority: 0, nextAction: null,
        estValue: 0,
        // keep precomputed values as fallback hints
        _pre: { smart: preSmart, risk: preRisk, delay: preDelay, action: preAction, value: preValue },
      });
    }

    if (!lines.length) {
      setSystemMessage('No data rows detected.', 'error');
      setPill('engine', 'warn', '— error');
      return;
    }

    // Engine pass
    lines.forEach(computeLine);

    state.rows = lines;
    state.shipments = buildShipments(lines);
    state.vendors = buildVendorScorecards(state.shipments);

    if (Object.keys(cols).length < 8) state.warnings.push(`Only ${Object.keys(cols).length} of the expected columns were detected — some KPIs may be incomplete.`);
    if (!cols.estValue) state.warnings.push('No "Estimated Value" column found — value KPIs use Qty as a proxy.');

    const source = state._source || 'upload';
    state._source = null;   // reset
    onDataReady(source);
  }
  function clean(v) { if (v == null) return ''; const s = String(v).trim(); return s; }
  function cleanVendor(v) {
    if (!v) return 'Unknown';
    return v.split(/\s+/)
      .map(w => w.length > 1 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toUpperCase())
      .join(' ');
  }

  /* ============================================================
     5 + 6. SHIPMENT ENGINE  +  RISK & DELAY ENGINE
     ============================================================ */

  /** Compute calculated fields on a single line row (in place). */
  function computeLine(row) {
    // time intelligence
    row.leadTime    = daysBetween(row.eta, row.orderDate);
    row.transitTime = daysBetween(row.eta, row.shipDate);
    row.aging       = daysBetween(TODAY, row.orderDate);
    row.daysToEta   = daysBetween(row.eta, TODAY);

    // delay engine
    const isReceived = /received|delivered/i.test(row.status || '');
    if (isReceived && isValidDate(row.arrival) && isValidDate(row.eta)) {
      row.delayDays = Math.max(0, daysBetween(row.arrival, row.eta));
    } else if (isValidDate(row.eta)) {
      row.delayDays = Math.max(0, daysBetween(TODAY, row.eta));
    } else {
      row.delayDays = 0;
    }
    // prefer pre-computed delayDays if it's a valid number > 0 and we couldn't compute
    if ((row.delayDays === 0 || row.delayDays == null) && row._pre.delay != null && !isNaN(row._pre.delay)) {
      row.delayDays = row._pre.delay;
    }

    row.delayCategory =
      row.delayDays === 0 ? 'On Time' :
      row.delayDays <= 7  ? 'Slight Delay' :
      row.delayDays <= 30 ? 'Moderate Delay' : 'High Delay';

    // smart status (date-driven; falls back to precomputed)
    row.smartStatus = computeSmartStatus(row);

    // risk
    row.riskLevel = computeRisk(row);

    // priority score (0..100) — composite ranking
    row.priority = computePriority(row);

    // value (qty proxy if no $ data)
    row.estValue = (row._pre.value != null && !isNaN(row._pre.value)) ? row._pre.value : row.qty;

    // next action
    row.nextAction = computeAction(row);
  }

  function computeSmartStatus(row) {
    const isReceived = /received|delivered/i.test(row.status || '');
    if (isReceived) return 'Delivered';
    // explicit pre-computed override (already date-driven from V2/V3 model)
    if (row._pre.smart && /(in transit|in production|under clearance|delayed|delivered|awaiting|not shipped|ready|at port)/i.test(row._pre.smart)) {
      return row._pre.smart;
    }
    if (!isValidDate(row.eta)) {
      if (isValidDate(row.shipDate) && row.shipDate > TODAY) return 'In Production';
      return 'Awaiting ETA';
    }
    if (isValidDate(row.arrival)) {
      if (row.arrival <= TODAY) return 'Under Clearance';
      return 'In Transit';
    }
    if (isValidDate(row.shipDate) && TODAY < row.shipDate) return 'In Production';
    if (TODAY < row.eta) return 'In Transit';
    return 'Delayed / At Port';
  }

  function computeRisk(row) {
    if (row.smartStatus === 'Delivered') return 'Closed';
    if (row.delayDays > 30) return 'Critical';
    if (row.delayDays > 7) return 'High';
    if (row.delayDays > 0) return 'Medium';
    if (isValidDate(row.eta) && row.daysToEta != null && row.daysToEta >= 0 && row.daysToEta <= 7) {
      // ETA imminent and not delivered → Medium
      return 'Medium';
    }
    return 'Low';
  }

  function computePriority(row) {
    // Closed shipments → 0
    if (row.smartStatus === 'Delivered') return 0;
    let s = 0;
    // delay weight (max 60)
    s += clamp(row.delayDays, 0, 60);
    // risk weight (max 25)
    s += { 'Critical': 25, 'High': 15, 'Medium': 8, 'Low': 2, 'Closed': 0 }[row.riskLevel] || 0;
    // ETA proximity (next 7 days = 10, next 30 = 5)
    if (isValidDate(row.eta) && row.daysToEta != null) {
      if (row.daysToEta >= 0 && row.daysToEta <= 7) s += 10;
      else if (row.daysToEta > 7 && row.daysToEta <= 30) s += 5;
    }
    // value boost (per qty)
    s += Math.min(10, Math.log10(row.estValue + 1) * 3);
    return Math.round(s);
  }

  function computeAction(row) {
    const s = row.smartStatus, r = row.riskLevel, v = row.vendor || '(vendor)';
    if (s === 'Delivered') return 'Closed - no action';
    if (r === 'Critical')  return `URGENT: ESCALATE today - contact ${v}; assess stockout risk`;
    if (r === 'High')      return `Follow up with ${v}; request revised ETA / MAWB`;
    if (s === 'Under Clearance') return 'Coordinate with broker; expedite customs clearance';
    if (s === 'Delayed / At Port') return 'Push customs clearance; prepare receiving capacity';
    if (s === 'In Transit' && row.daysToEta != null && row.daysToEta <= 7) return `Confirm arrival window with ${v}; alert receiving`;
    if (s === 'In Transit') return `Monitor; reconfirm arrival with ${v}`;
    if (s === 'In Production') return `Confirm production milestone with ${v}`;
    if (s === 'Not Shipped' || s === 'Not Shipped / TBA') return `Confirm shipment plan with ${v}`;
    if (s === 'Awaiting ETA') return `Request firm ETA from ${v}`;
    return 'Review';
  }

  /** Roll lines up to one record per Shipment ID. */
  function buildShipments(lines) {
    const grouped = new Map();
    for (const r of lines) {
      const key = r.shipmentId || `${r.po}|${r.purpose || '-'}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }
    const result = [];
    for (const [shipmentId, items] of grouped) {
      const first = items[0];
      const sumQty = items.reduce((s, x) => s + (x.qty || 0), 0);
      const sumVal = items.reduce((s, x) => s + (x.estValue || 0), 0);
      const maxDelay = items.reduce((m, x) => Math.max(m, x.delayDays || 0), 0);
      const minOrderDate = pickMinDate(items, 'orderDate');
      const minShipDate  = pickMinDate(items, 'shipDate');
      const minEta       = pickMinDate(items, 'eta');
      const minArrival   = pickMinDate(items, 'arrival');
      const deliveredCount = items.filter(x => x.smartStatus === 'Delivered').length;
      const worstStatus = items.reduce((w, x) => (STATUS_PRIORITY[x.smartStatus] || 0) > (STATUS_PRIORITY[w] || 0) ? x.smartStatus : w, 'Delivered');
      const worstRisk   = items.reduce((w, x) => (RISK_PRIORITY[x.riskLevel] || 0) > (RISK_PRIORITY[w] || 0) ? x.riskLevel : w, 'Closed');
      const inTransitVal = (worstStatus === 'In Transit') ? sumVal : 0;
      const delayedVal   = (worstStatus === 'Delayed / At Port') ? sumVal : 0;
      const atRiskVal    = (worstRisk === 'Critical' || worstRisk === 'High') ? sumVal : 0;
      const pctDelivered = items.length ? deliveredCount / items.length : 0;
      const priority = items.reduce((m, x) => Math.max(m, x.priority), 0);
      result.push({
        shipmentId, po: first.po, purpose: first.purpose, vendor: first.vendor,
        items, lines: items.length, qty: sumQty, value: sumVal, maxDelay,
        orderDate: minOrderDate, shipDate: minShipDate, eta: minEta, arrival: minArrival,
        smartStatus: worstStatus, riskLevel: worstRisk,
        pctDelivered, pctOpen: 1 - pctDelivered,
        inTransitVal, delayedVal, atRiskVal,
        priority,
        daysToEta: isValidDate(minEta) ? daysBetween(minEta, TODAY) : null,
        nextAction: items.length === 1 ? items[0].nextAction : aggregateAction(worstStatus, worstRisk, first.vendor),
      });
    }
    return result;
  }
  function pickMinDate(items, key) {
    let best = null;
    for (const x of items) {
      const d = x[key];
      if (isValidDate(d) && (!best || d < best)) best = d;
    }
    return best;
  }
  function aggregateAction(status, risk, vendor) {
    if (status === 'Delivered') return 'Closed - no action';
    if (risk === 'Critical') return `URGENT: ESCALATE - contact ${vendor}; multi-line shipment at critical risk`;
    if (risk === 'High') return `Follow up with ${vendor} — request revised ETA`;
    if (status === 'Under Clearance') return 'Coordinate with broker; expedite customs clearance';
    if (status === 'Delayed / At Port') return 'Push clearance; prepare receiving capacity';
    if (status === 'In Transit') return `Monitor; confirm arrival window with ${vendor}`;
    if (status === 'In Production') return `Confirm production milestone with ${vendor}`;
    return `Review with ${vendor}`;
  }

  /** Build the vendor scorecard (one row per vendor). */
  function buildVendorScorecards(shipments) {
    const map = new Map();
    for (const s of shipments) {
      const k = s.vendor || 'Unknown';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    }
    const cards = [];
    for (const [name, list] of map) {
      const total = list.length;
      const totalLines = list.reduce((s, x) => s + x.lines, 0);
      const totalQty   = list.reduce((s, x) => s + x.qty, 0);
      const totalValue = list.reduce((s, x) => s + x.value, 0);
      const open       = list.filter(x => x.smartStatus !== 'Delivered').length;
      const openValue  = list.filter(x => x.smartStatus !== 'Delivered').reduce((s, x) => s + x.value, 0);
      const delivered  = list.filter(x => x.smartStatus === 'Delivered').length;
      const onTime     = list.filter(x => x.smartStatus === 'Delivered' && x.maxDelay === 0).length;
      const onTimePct  = delivered ? onTime / delivered : 0;
      const delayed    = list.filter(x => x.maxDelay > 0);
      const avgDelay   = delayed.length ? delayed.reduce((s, x) => s + x.maxDelay, 0) / delayed.length : 0;
      const critHigh   = list.filter(x => x.riskLevel === 'Critical' || x.riskLevel === 'High').length;
      const riskExp    = list.filter(x => x.riskLevel === 'Critical' || x.riskLevel === 'High').reduce((s, x) => s + x.value, 0);
      const avgLeadTime = avgFromShipments(list, 'orderDate', 'eta');
      // composite vendor score: 50 % on-time, 30 % inverse delay, 20 % inverse open ratio
      const score = clamp(
        50 * onTimePct
        + 30 * Math.max(0, 1 - Math.min(avgDelay, 90) / 90)
        + 20 * Math.max(0, 1 - open / Math.max(total, 1)),
        0, 100
      );
      cards.push({
        name, totalShpt: total, totalLines, totalQty, totalValue,
        openShpt: open, openValue, deliveredShpt: delivered, onTimeShpt: onTime,
        onTimePct, avgDelay, avgLeadTime, critHigh, riskExp, score,
        grade: scoreToGrade(score),
      });
    }
    cards.sort((a, b) => b.score - a.score);
    cards.forEach((c, i) => c.rank = i + 1);
    return cards;
  }
  function avgFromShipments(list, fromKey, toKey) {
    const diffs = [];
    for (const s of list) {
      const a = s[fromKey], b = s[toKey];
      if (isValidDate(a) && isValidDate(b)) diffs.push(daysBetween(b, a));
    }
    return diffs.length ? diffs.reduce((s, x) => s + x, 0) / diffs.length : 0;
  }
  function scoreToGrade(s) {
    if (s >= 85) return 'Excellent';
    if (s >= 70) return 'Good';
    if (s >= 50) return 'Watchlist';
    return 'Critical';
  }

  /* ============================================================
     7. FILTER LAYER
     ============================================================ */

  function applyFilters(rows) {
    const f = state.filters;
    return rows.filter(r => {
      if (f.search) {
        const q = f.search.toLowerCase();
        const hay = (r.itemCode + ' ' + r.description + ' ' + r.po + ' ' + r.soPi + ' ' + r.vendor + ' ' + r.shipmentId + ' ' + (r.smartStatus || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (f.vendor && r.vendor !== f.vendor) return false;
      if (f.status && r.smartStatus !== f.status) return false;
      if (f.risk && r.riskLevel !== f.risk) return false;
      if (f.purpose && r.purpose !== f.purpose) return false;
      if (f.po && r.po !== f.po) return false;
      if (f.delayCat && r.delayCategory !== f.delayCat) return false;
      if (f.openOnly && r.smartStatus === 'Delivered') return false;
      if (f.criticalOnly && !(r.riskLevel === 'Critical' || r.riskLevel === 'High')) return false;
      if (f.etaFrom && (!isValidDate(r.eta) || r.eta < f.etaFrom)) return false;
      if (f.etaTo   && (!isValidDate(r.eta) || r.eta > f.etaTo))   return false;
      return true;
    });
  }

  function bindFilterEvents() {
    const f = state.filters;

    // Advanced global search — same behavior as hero search (suggestions + clear)
    const adv = getEl('filterSearch');
    const advClear = getEl('filterSearchClear');
    const advSugg = getEl('filterSearchSuggestions');
    let advTimer = null;
    if (adv) {
      adv.addEventListener('input', () => {
        clearTimeout(advTimer);
        advTimer = setTimeout(() => {
          // Mirror to hero search input + global state
          const hero = getEl('heroSearchInput'); if (hero) hero.value = adv.value;
          applyHeroSearch(adv.value);
          if (advClear) advClear.hidden = !adv.value;
          renderSuggestionsInto(adv.value, advSugg, adv);
        }, 90);
      });
      adv.addEventListener('focus', () => {
        if (adv.value && advSugg && advSugg.children.length) advSugg.hidden = false;
      });
      adv.addEventListener('keydown', e => {
        if (e.key === 'Escape') { adv.value = ''; applyHeroSearch(''); if (advClear) advClear.hidden = true; if (advSugg) advSugg.hidden = true; }
        if (e.key === 'Enter')  { if (advSugg) advSugg.hidden = true; }
      });
      if (advClear) advClear.addEventListener('click', () => {
        adv.value = ''; applyHeroSearch(''); advClear.hidden = true; if (advSugg) advSugg.hidden = true; adv.focus();
      });
    }
    document.addEventListener('click', e => {
      if (advSugg && !advSugg.hidden) {
        const within = e.target === adv || advSugg.contains(e.target);
        if (!within) advSugg.hidden = true;
      }
    });

    getEl('filterVendor').addEventListener('change', e => { f.vendor = e.target.value; refreshAll(); });
    getEl('filterStatus').addEventListener('change', e => { f.status = e.target.value; refreshAll(); });
    getEl('filterRisk').addEventListener('change', e => { f.risk = e.target.value; refreshAll(); });
    getEl('filterPurpose').addEventListener('change', e => { f.purpose = e.target.value; refreshAll(); });
    getEl('filterPO').addEventListener('change', e => { f.po = e.target.value; refreshAll(); });
    getEl('filterDelayCat').addEventListener('change', e => { f.delayCat = e.target.value; refreshAll(); });
    getEl('filterEtaFrom').addEventListener('change', e => { f.etaFrom = e.target.value ? parseDate(e.target.value) : null; refreshAll(); });
    getEl('filterEtaTo').addEventListener('change', e => { f.etaTo = e.target.value ? parseDate(e.target.value) : null; refreshAll(); });
    getEl('filterOpen').addEventListener('change', e => { f.openOnly = e.target.checked; refreshAll(); });
    getEl('filterCritical').addEventListener('change', e => { f.criticalOnly = e.target.checked; refreshAll(); });
    getEl('filterClear').addEventListener('click', () => {
      Object.assign(f, { search: '', vendor: '', status: '', risk: '', purpose: '', po: '', etaFrom: null, etaTo: null, delayCat: '', openOnly: false, criticalOnly: false });
      ['filterSearch','filterVendor','filterStatus','filterRisk','filterPurpose','filterPO','filterDelayCat','filterEtaFrom','filterEtaTo'].forEach(id => { const el = getEl(id); if (el) el.value = ''; });
      getEl('filterOpen').checked = false; getEl('filterCritical').checked = false;
      const hero = getEl('heroSearchInput'); if (hero) hero.value = '';
      applyHeroSearch('');
      if (advClear) advClear.hidden = true;
      if (advSugg) advSugg.hidden = true;
    });
  }

  function rebuildFilterOptions() {
    const fillSelect = (id, values) => {
      const el = getEl(id);
      const cur = el.value;
      clearEl(el);
      const opt = document.createElement('option'); opt.value = ''; opt.textContent = 'All';
      el.appendChild(opt);
      values.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o); });
      if (values.includes(cur)) el.value = cur;
    };
    const distinct = (key) => Array.from(new Set(state.rows.map(r => r[key]).filter(v => v != null && v !== ''))).sort();
    fillSelect('filterVendor',  distinct('vendor'));
    fillSelect('filterStatus',  distinct('smartStatus'));
    fillSelect('filterRisk',    ['Critical','High','Medium','Low','Closed']);
    fillSelect('filterPurpose', distinct('purpose'));
    fillSelect('filterPO',      distinct('po'));
  }

  function renderFilterSummary(filtered) {
    const total = state.rows.length;
    const html = `Showing <strong>${fmtNum(filtered.length)}</strong> of <strong>${fmtNum(total)}</strong> shipment lines`
      + (Object.values(state.filters).some(v => v && (typeof v !== 'boolean' || v === true)) ? ' (filters active)' : '');
    getEl('filterSummary').innerHTML = html;
  }

  /* ============================================================
     8. KPI LAYER
     ============================================================ */

  /**
   * v3.1 — Slimmer KPI deck (8 cards) focused on operational tracking.
   * Heavy/value KPIs moved into the Vendor Scorecard / Action Control sections.
   */
  function renderKPIs(rows, shipments) {
    const open = rows.filter(r => r.smartStatus !== 'Delivered');
    const closed = rows.filter(r => r.smartStatus === 'Delivered');
    const delayed = open.filter(r => r.delayDays > 0);
    const atRisk = rows.filter(r => r.riskLevel === 'Critical' || r.riskLevel === 'High');
    const onTimePct = closed.length ? closed.filter(r => r.delayDays === 0).length / closed.length : 0;
    const avgDelay = delayed.length ? delayed.reduce((s, x) => s + x.delayDays, 0) / delayed.length : 0;
    const inTransitLines = rows.filter(r => r.smartStatus === 'In Transit').length;

    const openShpts      = shipments.filter(s => s.smartStatus !== 'Delivered').length;
    const deliveredShpts = shipments.filter(s => s.smartStatus === 'Delivered').length;

    const cards = [
      { k: 'Total Shipments',  v: fmtNum(shipments.length),           tone: 'brand' },
      { k: 'Open Shipments',   v: fmtNum(openShpts),                  tone: 'info' },
      { k: 'Delivered',        v: fmtNum(deliveredShpts),             tone: 'ok' },
      { k: 'Delayed (Open)',   v: fmtNum(delayed.length),             tone: 'bad' },
      { k: 'At-Risk Lines',    v: fmtNum(atRisk.length),              tone: 'warn', sub: 'Critical + High' },
      { k: 'On-Time %',        v: fmtPct(onTimePct),                  tone: onTimePct >= .9 ? 'ok' : (onTimePct >= .5 ? 'warn' : 'bad') },
      { k: 'Avg Delay (Open)', v: fmtNum(avgDelay, 1) + ' d',         tone: avgDelay >= 30 ? 'bad' : (avgDelay > 0 ? 'warn' : 'ok') },
      { k: 'In-Transit Lines', v: fmtNum(inTransitLines),             tone: 'info' },
    ];
    const grid = getEl('kpiGrid');
    clearEl(grid);
    cards.forEach(c => grid.appendChild(kpiCard(c)));
  }

  function kpiCard({ k, v, tone, sub }) {
    const div = document.createElement('div');
    div.className = `kpi-card tone-${tone || 'brand'}`;
    div.innerHTML = `
      <div class="kpi-bg-accent"></div>
      <div class="kpi-label">${escapeHTML(k)}</div>
      <div class="kpi-value">${escapeHTML(v)}</div>
      ${sub ? `<div class="kpi-sub">${escapeHTML(sub)}</div>` : ''}
    `;
    return div;
  }

  /* ============================================================
     8b. CHARTS
     ============================================================ */

  /**
   * v3.2 (Pro) — Operational charts.
   * Replaces the analytical month-over-month timeline with a 12-week
   * ETA window. Adds Open Shipments by Vendor (most actionable view).
   */
  function renderCharts(rows) {
    const css = getComputedStyle(document.documentElement);
    const txtColor = css.getPropertyValue('--text-soft').trim() || '#a7b0c0';
    const gridColor = css.getPropertyValue('--border').trim() || 'rgba(255,255,255,.08)';
    Chart.defaults.color = txtColor;
    Chart.defaults.borderColor = gridColor;
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";

    destroyCharts();

    // Operational pulse strip (above the chart cards)
    renderPulseGrid(rows);

    // (a) Open Shipments by Vendor (top 10) — most actionable follow-up view
    const openByV = {};
    rows.forEach(r => { if (r.smartStatus !== 'Delivered') openByV[r.vendor] = (openByV[r.vendor] || 0) + 1; });
    const openTop = Object.entries(openByV).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const openByVendorEl = getEl('chartOpenByVendor');
    if (openByVendorEl) state.charts.openByVendor = new Chart(openByVendorEl, {
      type: 'bar',
      data: { labels: openTop.map(x => x[0]), datasets: [{ data: openTop.map(x => x[1]), backgroundColor: '#38bdf8', borderRadius: 6 }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } }, responsive: true, maintainAspectRatio: false },
    });

    // (b) Delayed Shipments by Vendor (top 10)
    const vCounts = {};
    rows.forEach(r => { if (r.delayDays > 0 && r.smartStatus !== 'Delivered') vCounts[r.vendor] = (vCounts[r.vendor] || 0) + 1; });
    const vTop = Object.entries(vCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    state.charts.vendor = new Chart(getEl('chartVendor'), {
      type: 'bar',
      data: { labels: vTop.map(x => x[0]), datasets: [{ data: vTop.map(x => x[1]), backgroundColor: '#ef4444', borderRadius: 6 }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } }, responsive: true, maintainAspectRatio: false },
    });

    // (c) Delay Distribution (operational buckets)
    const buckets = [
      { k: 'On Time / Future', f: r => r.delayDays === 0 && r.smartStatus !== 'Delivered' },
      { k: '1-7 d',  f: r => r.delayDays >= 1   && r.delayDays <= 7  && r.smartStatus !== 'Delivered' },
      { k: '8-14 d', f: r => r.delayDays >= 8   && r.delayDays <= 14 && r.smartStatus !== 'Delivered' },
      { k: '15-30 d',f: r => r.delayDays >= 15  && r.delayDays <= 30 && r.smartStatus !== 'Delivered' },
      { k: '31-60 d',f: r => r.delayDays >= 31  && r.delayDays <= 60 && r.smartStatus !== 'Delivered' },
      { k: '60+ d',  f: r => r.delayDays >  60                       && r.smartStatus !== 'Delivered' },
    ];
    const bData = buckets.map(b => rows.filter(b.f).length);
    state.charts.delay = new Chart(getEl('chartDelay'), {
      type: 'bar',
      data: { labels: buckets.map(b => b.k), datasets: [{ data: bData, backgroundColor: ['#94a3b8','#22c55e','#fbbf24','#f59e0b','#ef4444','#b91c1c'], borderRadius: 6 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } }, responsive: true, maintainAspectRatio: false },
    });

    // (d) Risk Status Snapshot
    const risks = ['Critical','High','Medium','Low','Closed'];
    const riskCounts = risks.map(r => rows.filter(x => x.riskLevel === r).length);
    const riskColors = ['#b91c1c','#ef4444','#f59e0b','#22c55e','#94a3b8'];
    state.charts.risk = new Chart(getEl('chartRisk'), {
      type: 'bar',
      data: { labels: risks, datasets: [{ data: riskCounts, backgroundColor: riskColors, borderRadius: 6 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } }, responsive: true, maintainAspectRatio: false },
    });

    // (e) Smart Status Distribution
    const statuses = ['Delivered','In Transit','In Production','Under Clearance','Delayed / At Port','Awaiting ETA','Not Shipped / TBA','Ready'];
    const statusCounts = statuses.map(s => rows.filter(r => r.smartStatus === s).length);
    const statusColors = ['#22c55e','#38bdf8','#a78bfa','#fbbf24','#ef4444','#94a3b8','#cbd5e1','#a3e635'];
    const filteredStatuses = statuses.map((s, i) => ({ s, c: statusCounts[i], col: statusColors[i] })).filter(x => x.c > 0);
    state.charts.status = new Chart(getEl('chartStatus'), {
      type: 'doughnut',
      data: { labels: filteredStatuses.map(x => x.s), datasets: [{ data: filteredStatuses.map(x => x.c), backgroundColor: filteredStatuses.map(x => x.col), borderWidth: 0 }] },
      options: { plugins: { legend: { position: 'right', labels: { boxWidth: 10 } } }, cutout: '62%', responsive: true, maintainAspectRatio: false },
    });

    // (f) ETA window — next 12 weeks (open vs delivered)
    const weeks = [];
    const startOfWeek = new Date(TODAY);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Sunday-anchored
    for (let w = 0; w < 12; w++) {
      const d = new Date(startOfWeek);
      d.setDate(startOfWeek.getDate() + w * 7);
      weeks.push(d);
    }
    const weekOpen = weeks.map(d => {
      const next = new Date(d); next.setDate(d.getDate() + 7);
      return rows.filter(r => isValidDate(r.eta) && r.eta >= d && r.eta < next && r.smartStatus !== 'Delivered').length;
    });
    const weekDel = weeks.map(d => {
      const next = new Date(d); next.setDate(d.getDate() + 7);
      return rows.filter(r => isValidDate(r.eta) && r.eta >= d && r.eta < next && r.smartStatus === 'Delivered').length;
    });
    state.charts.timeline = new Chart(getEl('chartTimeline'), {
      type: 'bar',
      data: {
        labels: weeks.map(d => 'W ' + isoWeekShort(d)),
        datasets: [
          { label: 'Open ETAs',      data: weekOpen, backgroundColor: '#38bdf8', borderRadius: 5 },
          { label: 'Delivered ETAs', data: weekDel,  backgroundColor: '#22c55e', borderRadius: 5 },
        ]
      },
      options: {
        plugins: { legend: { position: 'bottom' } },
        scales: { x: { stacked: true }, y: { beginAtZero: true, stacked: true } },
        responsive: true, maintainAspectRatio: false
      },
    });
  }
  function isoWeekShort(d) {
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }

  /** v3.2 (Pro) — Operational pulse strip: 4 follow-up counts above the charts. */
  function renderPulseGrid(rows) {
    const wrap = getEl('pulseGrid');
    if (!wrap) return;
    const open = rows.filter(r => r.smartStatus !== 'Delivered');
    const inTransit = open.filter(r => r.smartStatus === 'In Transit').length;
    const etaSoon = open.filter(r => r.daysToEta != null && r.daysToEta >= 0 && r.daysToEta <= 7).length;
    const delayedShort = open.filter(r => r.delayDays >= 1 && r.delayDays <= 7).length;
    const delayedLong  = open.filter(r => r.delayDays > 7).length;
    const stuck30 = open.filter(r => r.delayDays > 30).length;
    const cards = [
      { label: 'In Transit (Lines)', val: inTransit,    tone: 'info' },
      { label: 'ETA in next 7 days', val: etaSoon,      tone: 'warn' },
      { label: 'Delayed 1-7 d',      val: delayedShort, tone: 'warn' },
      { label: 'Delayed > 7 d',      val: delayedLong,  tone: 'bad' },
      { label: 'Stuck > 30 d',       val: stuck30,      tone: 'crit' },
    ];
    clearEl(wrap);
    cards.forEach(c => {
      const div = document.createElement('div');
      div.className = `pulse-card tone-${c.tone}`;
      div.innerHTML = `<span class="pulse-label">${escapeHTML(c.label)}</span><span class="pulse-value">${fmtNum(c.val)}</span>`;
      wrap.appendChild(div);
    });
  }
  function destroyCharts() {
    Object.values(state.charts).forEach(c => { try { c.destroy(); } catch(_) {} });
    state.charts = {};
  }

  /* ============================================================
     9. ACTION CONTROL LAYER
     ============================================================ */

  function renderActionControl(rows, shipments) {
    const open = shipments.filter(s => s.smartStatus !== 'Delivered');

    const bands = [
      {
        title: 'Critical - Escalate Today',
        tagline: 'Risk = Critical OR Delay > 30 days',
        tone: 'crit',
        rows: open.filter(s => s.riskLevel === 'Critical' || s.maxDelay > 30).sort((a, b) => b.priority - a.priority).slice(0, 12),
        impact: 'Stockout / SLA breach exposure',
      },
      {
        title: 'Delayed > 7 days',
        tagline: 'Past ETA, action window closing',
        tone: 'bad',
        rows: open.filter(s => s.maxDelay >= 8 && s.maxDelay <= 30).sort((a, b) => b.maxDelay - a.maxDelay).slice(0, 12),
        impact: 'Inventory delay, demand miss',
      },
      {
        title: 'ETA within 7 days but Open',
        tagline: 'Imminent arrival, not yet delivered',
        tone: 'warn',
        rows: open.filter(s => s.daysToEta != null && s.daysToEta >= 0 && s.daysToEta <= 7).sort((a, b) => a.daysToEta - b.daysToEta).slice(0, 12),
        impact: 'Receiving / clearance prep needed',
      },
      {
        title: 'High-Value at Risk',
        tagline: 'Top 10 by Open Value (Critical + High risk)',
        tone: 'bad',
        rows: open.filter(s => s.riskLevel === 'Critical' || s.riskLevel === 'High').sort((a, b) => b.value - a.value).slice(0, 10),
        impact: 'Cash stuck in transit',
      },
      {
        title: 'Vendors with Repeated Delays',
        tagline: 'Vendors with 3+ open delayed shipments',
        tone: 'warn',
        rows: vendorRepeatDelay(shipments).slice(0, 10),
        impact: 'Sustained supplier reliability issue',
        isVendor: true,
      },
      {
        title: 'POs Requiring Escalation',
        tagline: 'POs with multiple open delayed lines',
        tone: 'info',
        rows: poEscalation(shipments).slice(0, 10),
        impact: 'Aggregate PO-level risk',
        isPO: true,
      },
    ];

    const wrap = getEl('actionBands');
    clearEl(wrap);
    let totalActions = 0;
    bands.forEach(b => {
      totalActions += b.rows.length;
      wrap.appendChild(renderActionBand(b));
    });
    getEl('actionCount').textContent = totalActions ? `${totalActions} actions` : '';
  }

  function vendorRepeatDelay(shipments) {
    const v = {};
    shipments.forEach(s => {
      if (s.smartStatus !== 'Delivered' && s.maxDelay > 0) {
        if (!v[s.vendor]) v[s.vendor] = { vendor: s.vendor, delayedShpts: 0, totalValue: 0, maxDelay: 0 };
        v[s.vendor].delayedShpts += 1;
        v[s.vendor].totalValue += s.value;
        v[s.vendor].maxDelay = Math.max(v[s.vendor].maxDelay, s.maxDelay);
      }
    });
    return Object.values(v).filter(x => x.delayedShpts >= 3).sort((a, b) => b.delayedShpts - a.delayedShpts);
  }

  function poEscalation(shipments) {
    const map = {};
    shipments.forEach(s => {
      if (s.smartStatus !== 'Delivered' && s.maxDelay > 7) {
        if (!map[s.po]) map[s.po] = { po: s.po, vendor: s.vendor, openLines: 0, maxDelay: 0, value: 0 };
        map[s.po].openLines += s.lines;
        map[s.po].maxDelay = Math.max(map[s.po].maxDelay, s.maxDelay);
        map[s.po].value += s.value;
      }
    });
    return Object.values(map).filter(x => x.openLines >= 2).sort((a, b) => b.maxDelay - a.maxDelay);
  }

  function renderActionBand(b) {
    const card = document.createElement('div');
    card.className = `action-band tone-${b.tone}`;
    const header = `
      <div class="action-band-header">
        <div class="action-band-title">${escapeHTML(b.title)}</div>
        <div class="action-band-count">${b.rows.length}</div>
      </div>
      <div class="action-band-tagline">${escapeHTML(b.tagline)} · <em>${escapeHTML(b.impact)}</em></div>`;
    let body = '<div class="action-rows">';
    if (!b.rows.length) {
      body += '<div class="action-row"><div><div class="ar-line-1 muted">All clear</div><div class="ar-line-2">Nothing matches in this band right now.</div></div></div>';
    } else if (b.isVendor) {
      b.rows.forEach(v => {
        body += `<div class="action-row" data-vendor="${escapeHTML(v.vendor)}">
          <div>
            <div class="ar-line-1">${escapeHTML(v.vendor)}</div>
            <div class="ar-line-2">${v.delayedShpts} delayed shipments · max delay ${v.maxDelay}d · value ${fmtMoney(v.totalValue)}</div>
          </div>
          <div class="ar-tag ${b.tone}">${v.delayedShpts}</div>
        </div>`;
      });
    } else if (b.isPO) {
      b.rows.forEach(p => {
        body += `<div class="action-row" data-po="${escapeHTML(p.po)}">
          <div>
            <div class="ar-line-1">${escapeHTML(p.po)} · ${escapeHTML(p.vendor)}</div>
            <div class="ar-line-2">${p.openLines} open lines · max delay ${p.maxDelay}d · value ${fmtMoney(p.value)}</div>
          </div>
          <div class="ar-tag ${b.tone}">${p.maxDelay}d</div>
        </div>`;
      });
    } else {
      b.rows.forEach(s => {
        const pillTag = s.maxDelay > 0 ? `${s.maxDelay}d late` : (s.daysToEta != null ? `${s.daysToEta}d to ETA` : '—');
        body += `<div class="action-row" data-shipment="${escapeHTML(s.shipmentId)}">
          <div>
            <div class="ar-line-1">${escapeHTML(s.shipmentId || (s.po + ' | ' + (s.purpose || '-')))}</div>
            <div class="ar-line-2">${escapeHTML(s.vendor)} · ${escapeHTML(s.smartStatus)} · ${s.lines} lines · ${fmtMoney(s.value)}</div>
          </div>
          <div class="ar-tag ${b.tone}">${escapeHTML(pillTag)}</div>
        </div>`;
      });
    }
    body += '</div>';
    card.innerHTML = header + body;
    // click → open detail
    card.querySelectorAll('.action-row').forEach(r => {
      r.addEventListener('click', () => {
        const sid = r.dataset.shipment, po = r.dataset.po, vendor = r.dataset.vendor;
        if (sid) openShipmentModal(sid);
        else if (po) openPOModal(po);
        else if (vendor) openVendorModal(vendor);
      });
    });
    return card;
  }

  /* ============================================================
     10. VENDOR SCORECARD
     ============================================================ */

  /**
   * v3.2 (Pro) — Vendor Scorecard as a card grid.
   * Each vendor = a clean card with rank pill, grade colour border,
   * score progress bar, and a 3-col stat grid. Click → vendor modal.
   */
  function renderVendorScorecard() {
    const grid = getEl('vendorGrid');
    if (!grid) return;
    clearEl(grid);

    const searchEl = getEl('vendorSearch');
    const search = (searchEl ? searchEl.value : '').toLowerCase();
    const sortSel = getEl('vendorSortKey');
    const sortKey = sortSel ? sortSel.value : 'score';

    let list = state.vendors.slice();
    if (search) list = list.filter(v => v.name.toLowerCase().includes(search));

    // Score / metrics: descending best-first; name: ascending alphabetical
    const dir = (sortKey === 'name') ? 'asc' : 'desc';
    sortRows(list, sortKey, dir);

    // Toggle the clear button on the smart-search wrapper
    const clearBtn = getEl('vendorSearchClear');
    if (clearBtn) clearBtn.hidden = !search;

    const countEl = getEl('vendorCount');
    if (countEl) countEl.textContent = `${list.length} vendor${list.length === 1 ? '' : 's'}`;

    if (!list.length) {
      grid.innerHTML = `<div class="vendor-grid-empty">No vendors match.</div>`;
      return;
    }

    list.forEach(v => {
      const grade = (v.grade || 'good').toLowerCase();
      const onTimeCls = v.onTimePct >= 0.9 ? 'is-ok' : (v.onTimePct >= 0.5 ? 'is-warn' : 'is-bad');
      const delayCls  = v.avgDelay === 0 ? 'is-ok' : (v.avgDelay <= 14 ? 'is-warn' : 'is-bad');
      const critCls   = v.critHigh > 0 ? 'is-bad' : 'is-ok';
      const card = document.createElement('div');
      card.className = `vendor-card grade-${grade}`;
      card.dataset.vendor = v.name;
      card.innerHTML = `
        <div class="vendor-card-head">
          <div class="vendor-card-rank">
            <span class="rank-num">#${v.rank}</span>
            <span class="rank-tag">RANK</span>
          </div>
          <span class="pill vendor-card-grade grade-${grade}">${escapeHTML(v.grade)}</span>
        </div>
        <div class="vendor-card-name">${escapeHTML(v.name)}</div>
        <div class="vendor-card-score">
          <div class="vendor-card-score-bar"><span class="vendor-card-score-bar-fill" style="width:${clamp(v.score, 0, 100)}%"></span></div>
          <div class="vendor-card-score-num">${fmtNum(v.score, 1)}</div>
        </div>
        <div class="vendor-card-stats">
          <div class="vendor-stat"><div class="vs-key">Total Shpts</div><div class="vs-val">${fmtNum(v.totalShpt)}</div></div>
          <div class="vendor-stat"><div class="vs-key">Open</div><div class="vs-val">${fmtNum(v.openShpt)}</div></div>
          <div class="vendor-stat"><div class="vs-key">Lines</div><div class="vs-val">${fmtNum(v.totalLines)}</div></div>
          <div class="vendor-stat"><div class="vs-key">On-Time %</div><div class="vs-val ${onTimeCls}">${fmtPct(v.onTimePct, 1)}</div></div>
          <div class="vendor-stat"><div class="vs-key">Avg Delay</div><div class="vs-val ${delayCls}">${fmtNum(v.avgDelay, 1)} d</div></div>
          <div class="vendor-stat"><div class="vs-key">Crit + High</div><div class="vs-val ${critCls}">${fmtNum(v.critHigh)}</div></div>
        </div>
      `;
      card.addEventListener('click', () => openVendorModal(v.name));
      grid.appendChild(card);
    });
  }

  /* ============================================================
     11. MAIN TRACKING TABLE
     ============================================================ */

  function renderMainTable(filtered) {
    const tbody = getEl('mainTableBody');
    clearEl(tbody);

    sortRows(filtered, state.sort.table.key, state.sort.table.dir);

    const total = filtered.length;
    const pageSize = state.pageSize;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (state.page > pageCount) state.page = pageCount;
    const start = (state.page - 1) * pageSize;
    const slice = filtered.slice(start, start + pageSize);

    getEl('tableCount').textContent = `${fmtNum(total)} rows · ${slice.length} shown`;
    getEl('pgInfo').textContent = `page ${state.page} / ${pageCount}`;

    if (!slice.length) {
      tbody.innerHTML = `<tr><td colspan="17" class="no-data">No rows match the current filters.</td></tr>`;
      return;
    }

    slice.forEach(r => {
      const tr = document.createElement('tr');
      tr.dataset.row = r.rowIdx;
      const delayCls = r.delayDays > 30 ? 'd-high' : (r.delayDays > 0 ? 'd-pos' : 'd-zero');
      tr.innerHTML = `
        <td><span class="ellipsis" title="${escapeHTML(r.shipmentId)}">${escapeHTML(r.shipmentId)}</span></td>
        <td>${escapeHTML(r.po)}</td>
        <td>${escapeHTML(r.soPi)}</td>
        <td>${escapeHTML(r.vendor)}</td>
        <td><strong>${escapeHTML(r.itemCode)}</strong></td>
        <td><span class="ellipsis" title="${escapeHTML(r.description)}">${escapeHTML(r.description)}</span></td>
        <td class="num">${fmtNum(r.qty)}</td>
        <td>${fmtDate(r.orderDate)}</td>
        <td>${fmtDate(r.shipDate)}</td>
        <td>${fmtDate(r.eta)}</td>
        <td>${fmtDate(r.arrival)}</td>
        <td><span class="muted">${escapeHTML(r.status || '—')}</span></td>
        <td><span class="pill ${STATUS_PILL_CLASS[r.smartStatus] || 'closed'}">${escapeHTML(r.smartStatus)}</span></td>
        <td class="num delay-cell ${delayCls}">${fmtNum(r.delayDays)}</td>
        <td><span class="pill ${(r.riskLevel || '').toLowerCase()}">${escapeHTML(r.riskLevel)}</span></td>
        <td class="num"><span class="priority-bar"><span class="priority-bar-fill" style="width:${clamp(r.priority, 0, 100)}%"></span></span>${fmtNum(r.priority)}</td>
        <td><span class="ellipsis" title="${escapeHTML(r.nextAction)}">${escapeHTML(r.nextAction)}</span></td>
      `;
      tr.addEventListener('click', () => openLineModal(r));
      tbody.appendChild(tr);
    });
  }

  function bindTableSorting(tableId, sortStateKey, refreshFn) {
    const table = getEl(tableId);
    table.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        const cur = state.sort[sortStateKey];
        if (cur.key === key) cur.dir = (cur.dir === 'asc' ? 'desc' : 'asc');
        else { cur.key = key; cur.dir = 'asc'; }
        // visual indicator
        table.querySelectorAll('th').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(cur.dir === 'asc' ? 'sort-asc' : 'sort-desc');
        refreshFn();
      });
    });
  }

  function sortRows(arr, key, dir) {
    const mul = dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let av = a[key], bv = b[key];
      if (av instanceof Date) av = av.getTime();
      if (bv instanceof Date) bv = bv.getTime();
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
      return String(av).localeCompare(String(bv)) * mul;
    });
  }

  function bindPager() {
    getEl('pgFirst').addEventListener('click', () => { state.page = 1; refreshTable(); });
    getEl('pgPrev').addEventListener('click',  () => { state.page = Math.max(1, state.page - 1); refreshTable(); });
    getEl('pgNext').addEventListener('click',  () => { state.page = state.page + 1; refreshTable(); });
    getEl('pgLast').addEventListener('click',  () => { state.page = 1e9; refreshTable(); });
    getEl('pgSize').addEventListener('change', e => { state.pageSize = parseInt(e.target.value, 10) || 50; state.page = 1; refreshTable(); });
  }

  /* ============================================================
     12. ROW DETAIL MODAL
     ============================================================ */

  function openLineModal(row) {
    const sid = row.shipmentId;
    const sibling = state.rows.filter(x => x.shipmentId === sid);
    openShipmentModalCore(sid, sibling, row);
  }
  function openShipmentModal(sid) {
    const lines = state.rows.filter(r => r.shipmentId === sid);
    if (!lines.length) return;
    openShipmentModalCore(sid, lines, lines[0]);
  }
  function openPOModal(po) {
    const lines = state.rows.filter(r => r.po === po);
    if (!lines.length) return;
    openShipmentModalCore(`PO ${po}`, lines, lines[0]);
  }
  function openVendorModal(vendor) {
    const vCard = state.vendors.find(v => v.name === vendor);
    const ships = state.shipments.filter(s => s.vendor === vendor);
    const m = getEl('rowModal'); const body = getEl('modalBody');
    getEl('modalTitle').textContent = `Vendor — ${vendor}`;
    body.innerHTML = `
      <div class="modal-section">
        <h4>Vendor scorecard</h4>
        <div class="kv-grid">
          ${kv('Rank', vCard ? '#' + vCard.rank : '—')}
          ${kv('Grade', `<span class="pill grade-${(vCard?.grade || 'good').toLowerCase()}">${vCard?.grade || '—'}</span>`)}
          ${kv('Score', fmtNum(vCard?.score, 1))}
          ${kv('Total Shipments', fmtNum(vCard?.totalShpt))}
          ${kv('Open Shipments', fmtNum(vCard?.openShpt))}
          ${kv('On-Time %', fmtPct(vCard?.onTimePct))}
          ${kv('Avg Delay (d)', fmtNum(vCard?.avgDelay, 1))}
          ${kv('Avg Lead Time (d)', fmtNum(vCard?.avgLeadTime, 0))}
          ${kv('Critical + High', fmtNum(vCard?.critHigh))}
          ${kv('Total Value', fmtMoney(vCard?.totalValue))}
          ${kv('Open Value', fmtMoney(vCard?.openValue))}
          ${kv('Risk Exposure $', fmtMoney(vCard?.riskExp))}
        </div>
      </div>
      <div class="modal-section">
        <h4>Shipments (${ships.length})</h4>
        <div class="table-wrap" style="max-height:420px">
          <table class="data-table"><thead><tr>
            <th>Shipment ID</th><th>Status</th><th>Risk</th><th class="num">Lines</th><th class="num">Qty</th><th class="num">Value</th><th class="num">Max Delay</th><th>ETA</th>
          </tr></thead><tbody>
            ${ships.map(s => `<tr data-shipment="${escapeHTML(s.shipmentId)}">
              <td><strong>${escapeHTML(s.shipmentId)}</strong></td>
              <td><span class="pill ${STATUS_PILL_CLASS[s.smartStatus] || 'closed'}">${escapeHTML(s.smartStatus)}</span></td>
              <td><span class="pill ${(s.riskLevel || '').toLowerCase()}">${escapeHTML(s.riskLevel)}</span></td>
              <td class="num">${fmtNum(s.lines)}</td>
              <td class="num">${fmtNum(s.qty)}</td>
              <td class="num">${fmtMoney(s.value)}</td>
              <td class="num delay-cell ${s.maxDelay > 30 ? 'd-high' : s.maxDelay > 0 ? 'd-pos' : 'd-zero'}">${fmtNum(s.maxDelay)}</td>
              <td>${fmtDate(s.eta)}</td>
            </tr>`).join('')}
          </tbody></table>
        </div>
      </div>
    `;
    body.querySelectorAll('tr[data-shipment]').forEach(tr => tr.addEventListener('click', () => openShipmentModal(tr.dataset.shipment)));
    showModal();
  }

  function openShipmentModalCore(title, lines, primary) {
    const m = getEl('rowModal'); const body = getEl('modalBody');
    getEl('modalTitle').textContent = `Shipment — ${title}`;
    const sumQty = lines.reduce((s, x) => s + x.qty, 0);
    const sumVal = lines.reduce((s, x) => s + x.estValue, 0);
    const maxDelay = lines.reduce((m, x) => Math.max(m, x.delayDays), 0);
    const worstStatus = lines.reduce((w, x) => (STATUS_PRIORITY[x.smartStatus] || 0) > (STATUS_PRIORITY[w] || 0) ? x.smartStatus : w, 'Delivered');
    const worstRisk   = lines.reduce((w, x) => (RISK_PRIORITY[x.riskLevel] || 0) > (RISK_PRIORITY[w] || 0) ? x.riskLevel : w, 'Closed');

    body.innerHTML = `
      <div class="modal-section">
        <h4>Header</h4>
        <div class="kv-grid">
          ${kv('Shipment ID', primary.shipmentId)}
          ${kv('PO No.', primary.po)}
          ${kv('SO/PI', primary.soPi)}
          ${kv('Vendor', primary.vendor)}
          ${kv('Purpose', primary.purpose)}
          ${kv('Order Date', fmtDateLong(primary.orderDate))}
          ${kv('Proj Ship Date', fmtDateLong(primary.shipDate))}
          ${kv('ETA', fmtDateLong(primary.eta))}
          ${kv('Arrival', fmtDateLong(primary.arrival))}
          ${kv('Lines', fmtNum(lines.length))}
          ${kv('Total Qty', fmtNum(sumQty))}
          ${kv('Estimated Value', fmtMoney(sumVal))}
        </div>
      </div>
      <div class="modal-section">
        <h4>Smart status & risk</h4>
        <div class="kv-grid">
          ${kv('Smart Status', `<span class="pill ${STATUS_PILL_CLASS[worstStatus]}">${escapeHTML(worstStatus)}</span>`)}
          ${kv('Risk Level',   `<span class="pill ${(worstRisk || '').toLowerCase()}">${escapeHTML(worstRisk)}</span>`)}
          ${kv('Max Delay',    fmtNum(maxDelay) + ' d')}
          ${kv('Lead Time',    fmtNum(primary.leadTime, 0) + ' d')}
          ${kv('Transit Time', fmtNum(primary.transitTime, 0) + ' d')}
          ${kv('Aging',        fmtNum(primary.aging, 0) + ' d')}
          ${kv('Days to ETA',  primary.daysToEta != null ? fmtNum(primary.daysToEta) + ' d' : '—')}
          ${kv('Priority',     fmtNum(primary.priority))}
        </div>
      </div>
      <div class="modal-section">
        <h4>Timeline</h4>
        <div class="timeline">
          ${tlRow('Order placed',           primary.orderDate, '1')}
          ${tlRow('Projected shipment',     primary.shipDate, '2')}
          ${tlRow('ETA',                    primary.eta,      '3')}
          ${tlRow('Estimated arrival (WH)', primary.arrival,  '4')}
        </div>
      </div>
      <div class="modal-section">
        <h4>Recommended next action</h4>
        <p style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;margin:0;font-size:13px;color:var(--text);"><strong>${escapeHTML(primary.nextAction)}</strong></p>
      </div>
      <div class="modal-section">
        <h4>Lines under this shipment (${lines.length})</h4>
        <div class="table-wrap" style="max-height:300px">
          <table class="data-table"><thead><tr><th>Item</th><th>Description</th><th class="num">Qty</th><th>Status</th><th class="num">Delay</th></tr></thead><tbody>
            ${lines.map(l => `<tr><td><strong>${escapeHTML(l.itemCode)}</strong></td><td><span class="ellipsis" style="max-width:340px" title="${escapeHTML(l.description)}">${escapeHTML(l.description)}</span></td><td class="num">${fmtNum(l.qty)}</td><td><span class="pill ${STATUS_PILL_CLASS[l.smartStatus] || 'closed'}">${escapeHTML(l.smartStatus)}</span></td><td class="num">${fmtNum(l.delayDays)}</td></tr>`).join('')}
          </tbody></table>
        </div>
      </div>
    `;
    showModal();
  }
  function kv(k, v) { return `<div class="kv"><div class="kv-key">${escapeHTML(k)}</div><div class="kv-val">${v == null || v === '' ? '—' : v}</div></div>`; }
  function tlRow(label, date, icon) {
    const past = isValidDate(date) && date <= TODAY;
    return `<div class="tl-row"><div class="tl-key">${escapeHTML(label)}</div><div class="tl-marker">${icon}</div><div class="tl-val">${fmtDateLong(date)}${past ? ' <span class="muted">· passed</span>' : ''}</div></div>`;
  }
  function showModal() {
    const m = getEl('rowModal');
    m.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function bindModalClose() {
    document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  }
  function closeModal() {
    const m = getEl('rowModal');
    if (m && !m.hidden) {
      m.hidden = true;
      document.body.style.overflow = '';
    }
  }

  /* ============================================================
     13. EXPORT LAYER
     ============================================================ */

  function exportCurrentView() {
    const filtered = applyFilters(state.rows);
    const cols = [
      ['Shipment ID', 'shipmentId'], ['PO No.', 'po'], ['SO/PI', 'soPi'],
      ['Vendor', 'vendor'], ['Item Code', 'itemCode'], ['Description', 'description'],
      ['Qty', 'qty'],
      ['Order Date', r => fmtDate(r.orderDate)], ['Ship Date', r => fmtDate(r.shipDate)],
      ['ETA', r => fmtDate(r.eta)], ['Arrival', r => fmtDate(r.arrival)],
      ['Original Status', 'status'], ['Smart Status', 'smartStatus'],
      ['Delay Days', 'delayDays'], ['Delay Category', 'delayCategory'],
      ['Risk Level', 'riskLevel'], ['Priority', 'priority'],
      ['Lead Time (d)', 'leadTime'], ['Transit Time (d)', 'transitTime'],
      ['Estimated Value', 'estValue'], ['Next Action', 'nextAction'],
    ];
    const header = cols.map(c => c[0]).join(',');
    const lines = filtered.map(r => cols.map(c => csvSafe(typeof c[1] === 'function' ? c[1](r) : r[c[1]])).join(','));
    const blob = new Blob(['﻿', header, '\n', lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shipment-tower_view_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function csvSafe(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* ============================================================
     14. PERSISTENCE LAYER (IndexedDB)
     ============================================================
     Every successful upload is mirrored to IndexedDB. On every
     page load we attempt restore — if data exists we hydrate the
     dashboard automatically, no upload required.

     Storage shape:
       store:  'datasets'
       key:    'current'
       value:  {
         meta: { fileName, loadedAt:Date, sheetUsed, rowCount,
                 shipmentCount, savedAt:Date, source:'upload'|'demo' },
         lines: [ ...normalized rows; Date fields preserved by
                  IndexedDB structured clone ],
         warnings: [...]
       }

     Date safety: IndexedDB structured clone preserves Date objects
     natively, but we still defensively re-hydrate any field that
     comes back as a string before re-running the engine. Belt +
     braces — protects against future serialization changes.
     ============================================================ */

  const DB_NAME = 'DeltaShipmentTrackerDB';
  const DB_VERSION = 1;
  const DB_STORE = 'datasets';
  const DB_KEY = 'current';
  const DATE_FIELDS = ['orderDate', 'shipDate', 'eta', 'arrival'];

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB not supported in this browser.'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  function dbPut(value) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }
  function dbGet() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(DB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    }));
  }
  function dbDel() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  /** Estimate stored payload size in MB (rough). */
  function approxSizeMB(payload) {
    try { return (JSON.stringify(payload).length / (1024 * 1024)).toFixed(1); }
    catch (_) { return '?'; }
  }

  /** Persist the current state to IndexedDB. Non-blocking (toast on error). */
  async function persistDataset(source) {
    const payload = {
      meta: {
        fileName: state.fileName,
        loadedAt: state.loadedAt instanceof Date ? state.loadedAt : new Date(state.loadedAt),
        sheetUsed: state.sheetUsed,
        rowCount: state.rows.length,
        shipmentCount: state.shipments.length,
        savedAt: new Date(),
        source: source || 'upload',
      },
      lines: state.rows,
      warnings: state.warnings || [],
    };
    try {
      await dbPut(payload);
      setPill('storage', 'on', '— ' + approxSizeMB(payload) + ' MB saved');
      return true;
    } catch (err) {
      console.warn('persist failed', err);
      setPill('storage', 'warn', '— save failed');
      setSystemMessage('Could not save to browser storage: ' + err.message, 'warn');
      return false;
    }
  }

  /** Coerce stored row date fields back into Date objects. */
  function rehydrateRow(r) {
    for (const k of DATE_FIELDS) {
      const v = r[k];
      if (v == null || v === '') { r[k] = null; continue; }
      if (v instanceof Date) {
        r[k] = isValidDate(v) ? v : null;
      } else {
        const d = new Date(v);
        r[k] = isValidDate(d) ? stripTime(d) : null;
      }
    }
  }

  /** Try to restore a previously-saved dataset. Returns true on success. */
  async function tryRestoreFromStorage() {
    let payload;
    try { payload = await dbGet(); } catch (e) { console.warn('storage read failed', e); return false; }
    if (!payload || !payload.lines || !payload.lines.length) return false;

    setSystemMessage('Restoring saved dataset…', 'restored');
    state.fileName  = payload.meta.fileName  || '(restored)';
    state.loadedAt  = payload.meta.loadedAt instanceof Date ? payload.meta.loadedAt : new Date(payload.meta.loadedAt);
    state.sheetUsed = payload.meta.sheetUsed || '(unknown)';
    state.warnings  = payload.warnings || [];
    state.rows      = payload.lines;
    state.rows.forEach(rehydrateRow);
    // Recompute everything against TODAY so delays etc. are current
    state.rows.forEach(computeLine);
    state.shipments = buildShipments(state.rows);
    state.vendors   = buildVendorScorecards(state.shipments);

    onDataReady('restore', payload.meta.savedAt);
    return true;
  }

  /** Wipe stored dataset (admin-initiated, password-gated). */
  function clearStoredData() {
    promptPassword('Enter the admin password to clear stored shipment data from this browser.', async () => {
      if (!confirm('Clear the stored shipment data from this browser?\n\nThe original Excel file is NOT touched. You will need to re-upload to see data again.')) return;
      try {
        await dbDel();
      } catch (err) {
        setSystemMessage('Failed to clear storage: ' + err.message, 'error');
        return;
      }
      // Reset in-memory state and UI
      state.rows = []; state.shipments = []; state.vendors = []; state.fileName = ''; state.loadedAt = null; state.sheetUsed = null; state.warnings = [];
      destroyCharts();
      ['kpiSection', 'filtersSection', 'chartsSection', 'actionSection', 'vendorSection', 'tableSection', 'warningsSection'].forEach(id => { const el = getEl(id); if (el) el.hidden = true; });
      const empty = getEl('emptyState'); if (empty) empty.hidden = false;
      getEl('fileName').textContent = '- no file loaded -';
      getEl('loadedAt').textContent = '-';
      getEl('rowCount').textContent = '0';
      getEl('shipmentCount').textContent = '0';
      // Hide hero search until data is back
      const hero = getEl('heroSearch'); if (hero) hero.hidden = true;
      setPill('data',    'off', '- awaiting');
      setPill('engine',  'off', '- idle');
      setPill('tower',   'off', '- standby');
      setPill('storage', 'off', '- empty');
      setSystemMessage('Stored data cleared. An admin must upload a new shipment file to begin.', 'success');
    });
  }

  /* ============================================================
     14b. STATUS PILL + SYSTEM MESSAGE  UI
     ============================================================ */
  function setPill(key, state, stateText) {
    const pill = document.querySelector('[data-pill="' + key + '"]');
    if (!pill) return;
    pill.classList.remove('is-on', 'is-warn');
    if (state === 'on')   pill.classList.add('is-on');
    if (state === 'warn') pill.classList.add('is-warn');
    if (stateText) pill.querySelector('.pill-state').textContent = stateText;
  }

  function setSystemMessage(text, kind) {
    const el = getEl('systemMessage');
    if (!el) return;
    el.classList.remove('is-success', 'is-restored', 'is-warn', 'is-error');
    if (kind && kind !== 'info') el.classList.add('is-' + kind);
    el.querySelector('.msg-text').textContent = text;
    const icon = el.querySelector('.msg-icon');
    icon.textContent = kind === 'success' ? 'OK' : kind === 'warn' ? '!' : kind === 'error' ? 'X' : kind === 'restored' ? 'R' : 'i';
  }

  /** Toggle the upload-zone copy depending on whether data is loaded. */
  function setUploadLabel(hasData) {
    const strong = getEl('uploadLabelStrong');
    const small  = getEl('uploadLabelSmall');
    if (!strong || !small) return;
    if (hasData) {
      strong.textContent = 'Update shipment file';
      small.textContent  = 'Drop a new .xlsx to replace the dataset (auto-saves)';
    } else {
      strong.textContent = 'Upload shipment file';
      small.textContent  = 'Drop or click — .xlsx, .xls, .csv';
    }
  }

  function fmtRelTime(d) {
    if (!isValidDate(d)) return '—';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)        return 'just now';
    if (diff < 3600)      return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400)     return Math.floor(diff / 3600) + ' h ago';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' d ago';
    return d.toLocaleDateString();
  }

  /* ============================================================
     15. INIT / EVENT WIRING
     ============================================================ */

  function onDataReady(source, savedAt) {
    // Toolbar meta
    getEl('fileName').textContent = state.fileName;
    getEl('loadedAt').textContent = state.loadedAt.toLocaleString();
    getEl('rowCount').textContent = fmtNum(state.rows.length);
    getEl('shipmentCount').textContent = fmtNum(state.shipments.length);

    // Status pills (no em-dashes)
    setPill('data',   'on', '- loaded - ' + fmtNum(state.rows.length) + ' lines');
    setPill('engine', 'on', '- ready');
    setPill('tower',  'on', '- active');

    // System message (per source)
    if (source === 'restore') {
      const when = isValidDate(savedAt) ? fmtRelTime(savedAt instanceof Date ? savedAt : new Date(savedAt)) : '-';
      setSystemMessage(`Data restored from browser storage - ${state.fileName} - saved ${when}`, 'restored');
    } else if (source === 'demo') {
      setSystemMessage(`Demo data loaded - ${fmtNum(state.rows.length)} synthetic lines`, 'success');
    } else if (source === 'autofile') {
      // [v3.3] Auto-loaded from the company file in the GitHub project
      setSystemMessage(`Company data loaded from system file - ${state.fileName} - ${fmtNum(state.rows.length)} lines`, 'success');
    } else {
      setSystemMessage(`Data updated successfully - ${state.fileName} - ${fmtNum(state.rows.length)} lines`, 'success');
    }

    // Hide empty state, show all data sections (hero search + table + KPI + ...)
    const empty = getEl('emptyState'); if (empty) empty.hidden = true;
    const hero  = getEl('heroSearch'); if (hero)  hero.hidden  = false;
    ['tableSection','kpiSection','filtersSection','actionSection','chartsSection','vendorSection'].forEach(id => { const el = getEl(id); if (el) el.hidden = false; });

    // Warnings (now in its own section)
    const wWrap = getEl('warningsSection');
    const w = getEl('warnings');
    if (state.warnings.length) {
      if (wWrap) wWrap.hidden = false;
      w.innerHTML = '<ul>' + state.warnings.map(x => `<li>! ${escapeHTML(x)}</li>`).join('') + '</ul>';
    } else if (wWrap) { wWrap.hidden = true; }

    rebuildFilterOptions();
    refreshAll();

    // Persist (only real admin uploads — restore is already saved; demo / autofile are ephemeral)
    if (source === 'upload') {
      persistDataset(source).catch(err => console.warn('persist failed', err));
    } else if (source === 'restore') {
      setPill('storage', 'on', '- restored');
    } else if (source === 'demo') {
      setPill('storage', 'warn', '- demo (not saved)');
    } else if (source === 'autofile') {
      // [v3.3] Auto-fetched from data/shipment-tracker.xlsx — NOT cached locally,
      // so users always see the latest committed file on every refresh.
      setPill('storage', 'warn', '- system file (not cached)');
    }
  }

  function refreshAll() {
    const filtered = applyFilters(state.rows);
    renderFilterSummary(filtered);
    renderKPIs(filtered, buildShipments(filtered));
    renderCharts(filtered);
    renderActionControl(filtered, buildShipments(filtered));
    renderVendorScorecard();
    refreshTable();
  }

  function refreshTable() {
    const filtered = applyFilters(state.rows);
    renderMainTable(filtered);
    // Re-apply hero-search highlight (rows were just re-rendered)
    if (state.filters && state.filters.search) {
      try { highlightMatchingRows(state.filters.search); } catch (_) {}
    }
  }

  function bindTopBarEvents() {
    getEl('themeToggle').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      getEl('themeToggle').textContent = next === 'dark' ? 'D' : 'L';
      if (state.rows.length) renderCharts(applyFilters(state.rows));
    });
    getEl('btnExport').addEventListener('click', exportCurrentView);
    getEl('btnPrint').addEventListener('click', () => window.print());
    getEl('btnClearStorage').addEventListener('click', clearStoredData);

    const loadDemo = () => {
      const demo = generateDemoData();
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([Object.keys(demo[0]), ...demo.map(r => Object.values(r))]);
      XLSX.utils.book_append_sheet(wb, ws, 'Shipment Model');
      state.fileName = 'demo-data.xlsx';
      state.loadedAt = new Date();
      state._source  = 'demo';
      ingestWorkbook(wb);
    };
    getEl('btnLoadDemo').addEventListener('click', loadDemo);
    const emptyDemo = getEl('emptyDemoBtn'); if (emptyDemo) emptyDemo.addEventListener('click', loadDemo);

    // Vendor smart-search input + clear button + sort dropdown
    const vsInput = getEl('vendorSearch');
    const vsClear = getEl('vendorSearchClear');
    const vsSort  = getEl('vendorSortKey');
    if (vsInput) vsInput.addEventListener('input', () => {
      if (vsClear) vsClear.hidden = !vsInput.value;
      renderVendorScorecard();
    });
    if (vsClear) vsClear.addEventListener('click', () => {
      vsInput.value = ''; vsClear.hidden = true; renderVendorScorecard(); vsInput.focus();
    });
    if (vsSort) vsSort.addEventListener('change', renderVendorScorecard);

    // Filter section toggle (Show / Hide) — toggles `is-collapsed` on the section
    const ftog = getEl('filtersToggle');
    if (ftog) ftog.addEventListener('click', () => {
      const sec = getEl('filtersSection');
      if (!sec) return;
      const collapsed = sec.classList.toggle('is-collapsed');
      ftog.setAttribute('aria-expanded', String(!collapsed));
      const lbl = ftog.querySelector('.toggle-label');
      if (lbl) lbl.textContent = collapsed ? 'Show Filters' : 'Hide Filters';
    });
  }

  /* ============================================================
     16. PASSWORD GATE  (admin-only actions)
     ============================================================ */

  let pwPending = null;   // callback to run on successful password

  function promptPassword(promptText, onOK) {
    const modal = getEl('pwModal');
    const input = getEl('pwInput');
    const err   = getEl('pwError');
    const prompt = getEl('pwPrompt');
    pwPending = onOK;
    if (prompt) prompt.textContent = promptText || 'Enter the admin password to continue.';
    if (err) err.hidden = true;
    if (input) { input.value = ''; }
    if (modal) {
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
      // Focus the input after the browser paints the modal
      setTimeout(() => { try { input.focus(); } catch(_) {} }, 30);
    }
  }
  function closePasswordModal() {
    const modal = getEl('pwModal');
    if (modal) {
      modal.hidden = true;
      document.body.style.overflow = '';
    }
    pwPending = null;
  }
  function submitPassword() {
    const input = getEl('pwInput');
    const err   = getEl('pwError');
    if (!input) return;
    if (input.value === ADMIN_PASSWORD) {
      const cb = pwPending;
      closePasswordModal();
      if (typeof cb === 'function') cb();
    } else {
      if (err) err.hidden = false;
      input.select();
    }
  }
  function bindPasswordModal() {
    document.querySelectorAll('[data-pw-close]').forEach(el => el.addEventListener('click', closePasswordModal));
    const submit = getEl('pwSubmit');
    if (submit) submit.addEventListener('click', submitPassword);
    const input = getEl('pwInput');
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitPassword(); } });
    document.addEventListener('keydown', e => {
      const modal = getEl('pwModal');
      if (modal && !modal.hidden && e.key === 'Escape') closePasswordModal();
    });
  }

  /* ============================================================
     17. HERO SEARCH  (operational entry point)
     ============================================================
     Mirrors `state.filters.search`, plus:
       - autocomplete suggestions (top 6 matches)
       - "Showing results for: 'X'" label with count
       - row-level highlight (table rows tagged .is-match)
     ============================================================ */

  let heroDebounce = null;

  function bindHeroSearch() {
    const input  = getEl('heroSearchInput');
    const clear  = getEl('heroSearchClear');
    const sugg   = getEl('heroSuggestions');
    if (!input) return;

    input.addEventListener('input', () => {
      clearTimeout(heroDebounce);
      heroDebounce = setTimeout(() => applyHeroSearch(input.value), 90);
      if (clear) clear.hidden = !input.value;
    });
    input.addEventListener('focus', () => { if (input.value && sugg.children.length) sugg.hidden = false; });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { input.value = ''; applyHeroSearch(''); if (clear) clear.hidden = true; }
      if (e.key === 'Enter')  { sugg.hidden = true; }
    });
    if (clear) clear.addEventListener('click', () => {
      input.value = ''; applyHeroSearch(''); clear.hidden = true; input.focus();
    });

    // Hide suggestions when clicking outside
    document.addEventListener('click', e => {
      if (!sugg) return;
      if (sugg.hidden) return;
      const within = e.target === input || sugg.contains(e.target);
      if (!within) sugg.hidden = true;
    });
  }

  function applyHeroSearch(query) {
    const q = (query || '').trim();
    state.filters.search = q;
    state.page = 1;

    // Mirror to the "advanced" search input in filters panel (kept in sync)
    const adv = getEl('filterSearch'); if (adv) adv.value = q;

    refreshAll();
    renderHeroSummary(q);
    renderHeroSuggestions(q);
    // Mirror suggestions to advanced search box too
    const advSugg = getEl('filterSearchSuggestions');
    if (advSugg) renderSuggestionsInto(q, advSugg, getEl('filterSearch'));
    highlightMatchingRows(q);
  }

  /**
   * Generic suggestion renderer — reused by hero + advanced search.
   * @param {string} q          query
   * @param {HTMLElement} wrap  container to fill (gets hidden when empty)
   * @param {HTMLElement} input input to update on suggestion click
   */
  function renderSuggestionsInto(q, wrap, input) {
    if (!wrap) return;
    if (!q || q.length < 2) { wrap.hidden = true; clearEl(wrap); return; }
    const ql = q.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const r of state.rows) {
      if (out.length >= 6) break;
      const fields = [
        ['Item',        r.itemCode],
        ['Description', r.description],
        ['Vendor',      r.vendor],
        ['PO',          r.po],
        ['SO/PI',       r.soPi],
        ['Shipment',    r.shipmentId],
      ];
      for (const [tag, val] of fields) {
        const v = String(val || '');
        if (!v) continue;
        if (v.toLowerCase().includes(ql)) {
          const key = tag + '|' + v;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ tag, value: v, sub: shortRowSub(r) });
          break;
        }
      }
    }
    clearEl(wrap);
    if (!out.length) { wrap.hidden = true; return; }
    out.forEach(s => {
      const div = document.createElement('div');
      div.className = 'hero-suggestion';
      div.innerHTML =
        '<div class="hero-suggestion-main">' +
          '<div class="hero-suggestion-title">' + highlightString(s.value, q) + '</div>' +
          '<div class="hero-suggestion-sub">' + escapeHTML(s.sub) + '</div>' +
        '</div>' +
        '<div class="hero-suggestion-tag">' + escapeHTML(s.tag) + '</div>';
      div.addEventListener('click', () => {
        if (input) input.value = s.value;
        // Sync both inputs and re-apply
        const hero = getEl('heroSearchInput'); if (hero) hero.value = s.value;
        const adv  = getEl('filterSearch');    if (adv)  adv.value  = s.value;
        applyHeroSearch(s.value);
        wrap.hidden = true;
      });
      wrap.appendChild(div);
    });
    wrap.hidden = false;
  }

  function renderHeroSummary(q) {
    const el = getEl('heroSummary');
    if (!el) return;
    const filtered = applyFilters(state.rows);
    const total = state.rows.length;
    if (!q) {
      el.innerHTML = 'Type to filter the shipment table instantly. Search covers Item Code, Description, Vendor, PO, SO/PI, and Shipment ID.';
      return;
    }
    el.innerHTML =
      '<span class="summary-label">Showing results for:</span>' +
      '<span class="summary-q">' + escapeHTML(q) + '</span>' +
      '<span class="summary-count">' + fmtNum(filtered.length) + ' of ' + fmtNum(total) + ' lines</span>';
  }

  function renderHeroSuggestions(q) {
    const wrap = getEl('heroSuggestions');
    if (!wrap) return;
    if (!q || q.length < 2) { wrap.hidden = true; clearEl(wrap); return; }
    const ql = q.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const r of state.rows) {
      if (out.length >= 6) break;
      const fields = [
        ['Item',        r.itemCode],
        ['Description', r.description],
        ['Vendor',      r.vendor],
        ['PO',          r.po],
        ['SO/PI',       r.soPi],
        ['Shipment',    r.shipmentId],
      ];
      for (const [tag, val] of fields) {
        const v = String(val || '');
        if (!v) continue;
        if (v.toLowerCase().includes(ql)) {
          const key = tag + '|' + v;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ tag, value: v, sub: shortRowSub(r) });
          break;   // one suggestion per row
        }
      }
    }
    clearEl(wrap);
    if (!out.length) { wrap.hidden = true; return; }
    out.forEach(s => {
      const div = document.createElement('div');
      div.className = 'hero-suggestion';
      div.innerHTML =
        '<div class="hero-suggestion-main">' +
          '<div class="hero-suggestion-title">' + highlightString(s.value, q) + '</div>' +
          '<div class="hero-suggestion-sub">' + escapeHTML(s.sub) + '</div>' +
        '</div>' +
        '<div class="hero-suggestion-tag">' + escapeHTML(s.tag) + '</div>';
      div.addEventListener('click', () => {
        const input = getEl('heroSearchInput');
        if (input) input.value = s.value;
        applyHeroSearch(s.value);
        wrap.hidden = true;
      });
      wrap.appendChild(div);
    });
    wrap.hidden = false;
  }
  function shortRowSub(r) {
    const bits = [];
    if (r.po)        bits.push('PO ' + r.po);
    if (r.vendor)    bits.push(r.vendor);
    if (r.smartStatus) bits.push(r.smartStatus);
    return bits.join(' - ');
  }
  function highlightString(value, query) {
    const v = String(value || '');
    const q = String(query || '');
    if (!q) return escapeHTML(v);
    const i = v.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return escapeHTML(v);
    return escapeHTML(v.slice(0, i)) +
      '<mark>' + escapeHTML(v.slice(i, i + q.length)) + '</mark>' +
      escapeHTML(v.slice(i + q.length));
  }

  function highlightMatchingRows(q) {
    const tbody = getEl('mainTableBody');
    if (!tbody) return;
    const ql = (q || '').toLowerCase();
    tbody.querySelectorAll('tr').forEach(tr => {
      tr.classList.toggle('is-match', !!ql && tr.textContent.toLowerCase().includes(ql));
    });
  }

  function generateDemoData() {
    const vendors = ['Life Fitness', 'Core H&F', 'Escape Fitness', 'Concept2', 'Pavigym', 'Nantong Doublebest'];
    const purposes = ['Q1 2026 Replenishment', 'Project Alpha', 'Q2 Consumer', 'Walk-in Stock', 'Project Phoenix'];
    const statuses = ['Received', '', '', ''];
    const today = new Date();
    const rows = [];
    for (let i = 1; i <= 120; i++) {
      const v = vendors[i % vendors.length];
      const po = `PO/2026/${String(100 + (i % 30)).padStart(4, '0')}`;
      const orderDate = new Date(today.getFullYear(), today.getMonth() - (3 + i % 6), 1 + (i % 25));
      const shipDate  = new Date(orderDate.getFullYear(), orderDate.getMonth() + 2, 5 + (i % 20));
      const eta       = new Date(shipDate.getFullYear(), shipDate.getMonth() + 1, 10 + (i % 18));
      const arrival   = (i % 4 === 0) ? new Date(eta.getFullYear(), eta.getMonth(), eta.getDate() + (i % 12 - 3)) : null;
      rows.push({
        'Item Code': `SKU-${1000 + i}`,
        'Description': ['Treadmill','Recumbent Bike','Power Rack','Dumbbell Set','Yoga Mat','Cable Cross'][i % 6] + ' v' + (i % 3),
        'Qty': 4 + (i * 7) % 30,
        'PO No.': po,
        'SO/PI No.': `SO-${50000 + i}`,
        'Order Date': orderDate,
        'Projected Shipment Date': shipDate,
        'Purpose': purposes[i % purposes.length],
        'ETA': eta,
        'Estimated Date of Arrival in Warehouse': arrival,
        'Supplier': v,
        'Status': statuses[i % statuses.length],
      });
    }
    return rows;
  }

  /* ============================================================
     v3.3 — AUTO-FETCH from a project-relative Excel file
     ============================================================
     The tool is hosted on GitHub Pages. The company file lives at:
         data/shipment-tracker.xlsx
     On page load we fetch it via SheetJS, parse the FIRST sheet,
     and run the existing engine. Admin upload (password-gated) still
     overrides; that override is saved to IndexedDB and wins on every
     subsequent refresh until the admin clicks "Clear Stored Data".

     Order of precedence on page load:
       1. IndexedDB restore (admin override sticks for this user)
       2. Auto-fetch  data/shipment-tracker.xlsx
       3. Empty state with "No company data found" message
     ============================================================ */

  const SYSTEM_FILE_PATH = 'data/shipment-tracker.xlsx';

  /**
   * Try to fetch the company shipment file from the project's data/ folder.
   * Returns true on success (engine runs through ingestWorkbook).
   */
  async function tryLoadSystemFile() {
    setSystemMessage('Loading company data from system file...', 'info');
    setPill('engine', 'warn', '- fetching');
    let resp;
    try {
      // cache: 'no-store' so users see the latest committed file on every reload
      resp = await fetch(SYSTEM_FILE_PATH, { cache: 'no-store' });
    } catch (err) {
      console.warn('system file fetch failed', err);
      setPill('engine', 'warn', '- offline');
      return false;
    }
    if (!resp.ok) {
      console.warn('system file response not ok', resp.status);
      setPill('engine', 'warn', '- not found');
      return false;
    }
    try {
      const buf = await resp.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
      // Force the parser to use the FIRST sheet only (per spec)
      if (wb.SheetNames && wb.SheetNames.length > 1) {
        wb.SheetNames = [wb.SheetNames[0]];
      }
      // Filename shown in UI = the relative path's basename
      state.fileName = SYSTEM_FILE_PATH.split('/').pop();
      state.loadedAt = new Date();
      state._source  = 'autofile';
      ingestWorkbook(wb);
      return true;
    } catch (err) {
      console.error('system file parse failed', err);
      setSystemMessage('Failed to read company file: ' + err.message, 'error');
      setPill('engine', 'warn', '- error');
      return false;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindUploadEvents();
    bindFilterEvents();
    bindTopBarEvents();
    bindModalClose();
    bindPager();
    bindPasswordModal();
    bindHeroSearch();
    bindTableSorting('mainTable', 'table', refreshTable);
    // Vendor section is now a card grid — sort is driven by the dropdown,
    // not by clickable column headers, so no bindTableSorting call needed.

    // Initial pill state (ASCII only)
    setPill('data',    'off', '- awaiting');
    setPill('engine',  'off', '- idle');
    setPill('tower',   'off', '- standby');
    setPill('storage', 'off', '- empty');

    // Hide hero search until data exists (it's only useful with data)
    const hero = getEl('heroSearch'); if (hero) hero.hidden = true;

    // [v3.3] Boot order:
    //   1. IndexedDB restore (admin override wins for this browser)
    //   2. Auto-fetch the company file from data/shipment-tracker.xlsx
    //   3. Empty state with "No company data found" message
    let booted = false;

    try {
      booted = await tryRestoreFromStorage();
    } catch (err) {
      console.warn('restore failed', err);
    }

    if (!booted) {
      try {
        booted = await tryLoadSystemFile();
      } catch (err) {
        console.warn('system file load failed', err);
      }
    }

    if (!booted) {
      setSystemMessage(
        'No company data found. Admin must upload the Excel file.',
        'warn'
      );
    }
  });
})();
