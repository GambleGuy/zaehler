/**
 * Zählerstände – Backend (JSON-Schnittstelle für die PWA)
 * Als gebundenes Skript im Sheet "Zählerwerte" anlegen (Erweiterungen > Apps Script).
 * Als Web-App bereitstellen: Ausführen als "Ich", Zugriff "Jeder".
 * Geschützt wird über den Schlüssel TOKEN: ohne ihn wird nichts gelesen oder geschrieben.
 *
 * Das Tabellenblatt wird nach dem Jahr gewählt (Tab-Name = Jahreszahl).
 * Gibt es das Blatt noch nicht, wird es aus dem letzten vorhandenen Jahr kopiert.
 */

// Eigenen langen Schlüssel eintragen (mind. 24 Zeichen, nur Buchstaben und Zahlen)
const TOKEN = 'HIER_SCHLUESSEL_EINTRAGEN';

const CONFIG = {
  FIRST_COL: 3,       // Spalte C = erster Ablesewert (Dezember des Vorjahres)
  COL_STEP: 2,        // Wert + Einheit = 2 Spalten pro Monat
  MONTH_COUNT: 13     // Dezember (Vorjahr) bis Dezember
};

// row = Zeilennummer im Sheet, nr = Zählernummer steht in Spalte A
const METERS = [
  // Wasser
  { g: 'Wasser', l: 'Wasser gesamt', row: 2, u: 'm³' },
  // Strom
  { g: 'Strom', l: 'Allgemein', row: 29, u: 'kWh', nr: true },
  { g: 'Strom', l: 'EG', row: 30, u: 'kWh', nr: true },
  { g: 'Strom', l: 'EG 2', row: 31, u: 'kWh' },
  { g: 'Strom', l: 'OG', row: 32, u: 'kWh', nr: true },
  { g: 'Strom', l: 'DG', row: 33, u: 'kWh', nr: true },
  { g: 'Strom', l: 'NB', row: 34, u: 'kWh', nr: true },
  { g: 'Strom', l: 'Heizung', row: 35, u: 'kWh' },
  // Kaltwasser
  { g: 'Kaltwasser', l: 'EG', row: 5, u: 'm³' },
  { g: 'Kaltwasser', l: 'EG 2', row: 6, u: 'm³' },
  { g: 'Kaltwasser', l: 'OG', row: 7, u: 'm³' },
  { g: 'Kaltwasser', l: 'DG', row: 8, u: 'm³' },
  { g: 'Kaltwasser', l: 'NB', row: 9, u: 'm³' },
  { g: 'Kaltwasser', l: 'für WW', row: 10, u: 'm³' },
  // Warmwasser
  { g: 'Warmwasser', l: 'EG', row: 13, u: 'm³' },
  { g: 'Warmwasser', l: 'OG', row: 14, u: 'm³' },
  // Heizung
  { g: 'Heizung', l: 'EG', row: 17, u: 'kWh' },
  { g: 'Heizung', l: 'EG 2', row: 18, u: 'kWh' },
  { g: 'Heizung', l: 'OG', row: 19, u: 'kWh' },
  { g: 'Heizung', l: 'DG', row: 20, u: 'kWh' },
  // Heizung gesamt
  { g: 'Heizung gesamt', l: 'gesamt', row: 21, u: 'kWh' },
  { g: 'Heizung gesamt', l: 'gesamt (Volumen)', row: 22, u: 'm³' },
  // Gas
  { g: 'Gas', l: 'gesamt', row: 25, u: 'm³', nr: true },
  { g: 'Gas', l: 'NB', row: 26, u: 'm³', nr: true }
];

const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];

// ---------- Web-App-Einstieg ----------

function doGet() {
  return ContentService.createTextOutput('Zähler-API läuft.');
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, code: 'bad_request', error: 'Ungültige Anfrage.' });
  }
  if (TOKEN === 'HIER_SCHLUESSEL_EINTRAGEN' || String(TOKEN).length < 16) {
    return json_({ ok: false, code: 'config', error: 'Im Script ist noch kein Schlüssel gesetzt.' });
  }
  if (!req || req.token !== TOKEN) {
    return json_({ ok: false, code: 'auth', error: 'Schlüssel falsch.' });
  }
  try {
    if (req.action === 'state') return json_({ ok: true, data: getState(req.year) });
    if (req.action === 'save') {
      return json_({ ok: true, data: saveReadings(req.year, req.monthIdx, req.entries, !!req.overwrite) });
    }
    return json_({ ok: false, code: 'bad_request', error: 'Unbekannte Aktion.' });
  } catch (err) {
    return json_({ ok: false, code: 'server', error: String(err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Hilfsfunktionen ----------

function toNum_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
}

function currentYear_() {
  return parseInt(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy'), 10);
}

function validYear_(year) {
  const cy = currentYear_();
  const y = Number(year);
  if (!y) return cy;
  if (y < cy - 1 || y > cy + 1) throw new Error('Ungültiges Jahr.');
  return y;
}

function decCol_() {
  // Spalte des Dezember-Werts am Jahresende
  return CONFIG.FIRST_COL + CONFIG.COL_STEP * (CONFIG.MONTH_COUNT - 1);
}

function lastMeterRow_() {
  return Math.max.apply(null, METERS.map(function (m) { return m.row; }));
}

/**
 * Liefert das Blatt für das Jahr. Gibt es keins, wird es aus dem letzten
 * früheren Jahr kopiert: Ablesewerte werden geleert, der Dezember-Stand des
 * Vorjahres wandert in Spalte C. Formeln bleiben erhalten.
 */
function getYearSheet_(year) {
  const ss = SpreadsheetApp.getActive();
  const existing = ss.getSheetByName(String(year));
  if (existing) return existing;

  let src = null;
  ss.getSheets().forEach(function (s) {
    const n = s.getName();
    if (/^\d{4}$/.test(n) && Number(n) < year && (!src || Number(n) > Number(src.getName()))) src = s;
  });
  if (!src) throw new Error('Kein Tabellenblatt eines früheren Jahres als Vorlage gefunden.');

  const sh = src.copyTo(ss);
  sh.setName(String(year));
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(src.getIndex()); // vor die Vorlage, wie bei den anderen Jahren

  const lastRow = lastMeterRow_();
  const width = CONFIG.FIRST_COL - 1 + CONFIG.COL_STEP * CONFIG.MONTH_COUNT;
  const srcVals = src.getRange(1, 1, lastRow, width).getValues();
  const shVals = sh.getRange(1, 1, lastRow, width).getValues();
  const shForm = sh.getRange(1, 1, lastRow, width).getFormulas();
  const off = CONFIG.FIRST_COL - 1;

  METERS.forEach(function (m) {
    const out = [];
    for (let k = 0; k < width - off; k++) {
      const j = off + k;
      const isValueCol = k % CONFIG.COL_STEP === 0;
      const month = Math.floor(k / CONFIG.COL_STEP);
      if (isValueCol && month === 0) {
        out.push(srcVals[m.row - 1][off + (CONFIG.MONTH_COUNT - 1) * CONFIG.COL_STEP]); // Dezember aus Vorjahr
      } else if (isValueCol && !shForm[m.row - 1][j]) {
        out.push(''); // Ablesewert leeren
      } else {
        out.push(shForm[m.row - 1][j] || shVals[m.row - 1][j]); // Einheit/Formel behalten
      }
    }
    sh.getRange(m.row, CONFIG.FIRST_COL, 1, out.length).setValues([out]);
  });
  SpreadsheetApp.flush();
  return sh;
}

// Optional von Hand im Editor ausführbar: legt das Blatt für das nächste Jahr schon an
function neuesJahrAnlegen() {
  getYearSheet_(currentYear_() + 1);
}

function monthLabels_(year) {
  const labels = [];
  for (let i = 0; i < CONFIG.MONTH_COUNT; i++) {
    const m = (11 + i) % 12;
    const y = year - 1 + Math.floor((11 + i) / 12);
    labels.push(MONTH_NAMES[m] + ' ' + y);
  }
  return labels;
}

// ---------- Lesen und Schreiben ----------

function getState(yearArg) {
  const year = validYear_(yearArg);
  const sh = getYearSheet_(year);
  const lastRow = lastMeterRow_();
  const width = CONFIG.FIRST_COL - 1 + CONFIG.COL_STEP * CONFIG.MONTH_COUNT;
  const data = sh.getRange(1, 1, lastRow, width).getValues();

  const meters = METERS.map(function (m) {
    const r = data[m.row - 1];
    const values = [];
    for (let i = 0; i < CONFIG.MONTH_COUNT; i++) {
      values.push(toNum_(r[CONFIG.FIRST_COL - 1 + i * CONFIG.COL_STEP]));
    }
    return {
      id: m.row, group: m.g, label: m.l, unit: m.u,
      nr: m.nr ? String(r[0] || '') : '',
      values: values
    };
  });

  // Vorschlag: der Monat, der bei den meisten Zählern als nächstes leer ist
  const counts = {};
  meters.forEach(function (m) {
    let last = -1;
    m.values.forEach(function (v, i) { if (v !== null) last = i; });
    const next = Math.min(last + 1, CONFIG.MONTH_COUNT - 1);
    counts[next] = (counts[next] || 0) + 1;
  });
  let best = 0, bestCount = -1;
  Object.keys(counts).forEach(function (k) {
    if (counts[k] > bestCount) { bestCount = counts[k]; best = Number(k); }
  });

  return { year: year, sheet: sh.getName(), months: monthLabels_(year), meters: meters, defaultMonth: best };
}

function saveReadings(yearArg, monthIdx, entries, overwrite) {
  monthIdx = Number(monthIdx);
  if (!(monthIdx >= 0 && monthIdx < CONFIG.MONTH_COUNT)) throw new Error('Ungültiger Monat.');
  if (!Array.isArray(entries)) throw new Error('Keine Einträge.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const year = validYear_(yearArg);
    const sh = getYearSheet_(year);
    const col = CONFIG.FIRST_COL + monthIdx * CONFIG.COL_STEP;
    const writtenRows = [];

    const results = entries.map(function (e) {
      const m = METERS.filter(function (x) { return x.row === Number(e.id); })[0];
      if (!m) return { id: e.id, status: 'error', msg: 'Unbekannter Zähler' };
      const val = Number(e.value);
      if (!isFinite(val)) return { id: e.id, status: 'error', msg: 'Ungültiger Wert' };

      const cell = sh.getRange(m.row, col);
      if (cell.getFormula()) return { id: e.id, status: 'skipped', msg: 'Zelle enthält eine Formel' };
      const cur = cell.getValue();
      if (cur !== '' && cur !== null && !overwrite) {
        return { id: e.id, status: 'skipped', msg: 'Zelle ist bereits belegt' };
      }
      cell.setValue(val);
      writtenRows.push({ row: m.row, value: val });
      return { id: e.id, status: 'written' };
    });

    // Der Dezember-Stand steht in zwei Blättern: Dezember (Jahr X) = Spalte C (Jahr X+1)
    if (writtenRows.length && (monthIdx === 12 || monthIdx === 0)) {
      const ss = SpreadsheetApp.getActive();
      const other = ss.getSheetByName(String(monthIdx === 12 ? year + 1 : year - 1));
      const otherCol = monthIdx === 12 ? CONFIG.FIRST_COL : decCol_();
      if (other) {
        writtenRows.forEach(function (w) {
          const c = other.getRange(w.row, otherCol);
          if (!c.getFormula()) c.setValue(w.value);
        });
      }
    }

    SpreadsheetApp.flush();
    return { results: results, month: monthLabels_(year)[monthIdx] };
  } finally {
    lock.releaseLock();
  }
}
