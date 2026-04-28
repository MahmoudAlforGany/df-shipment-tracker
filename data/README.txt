Place the company shipment file here as:

    data/shipment-tracker.xlsx

The web app auto-fetches it on every page load (no upload needed for end users).
Only the FIRST sheet is read. The existing engine (Smart Status, Risk, Vendor
Scorecard, KPIs) runs unchanged on the parsed data.

Admin override: clicking "Update Shipment File" in the header (password-gated)
still works. The override is saved per-browser to IndexedDB and overrides the
system file for that user until they click "Clear Stored Data".
