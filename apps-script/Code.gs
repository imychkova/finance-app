/**
 * Фінансовий трекер: API поверх Google Sheets.
 * Скрипт прив'язаний до таблиці (Розширення → Apps Script).
 * Усі запити — POST із JSON у тілі (text/plain, щоб уникнути CORS preflight).
 * Код доступу береться з Script properties → ACCESS_CODE.
 */

const SHEET_TX = 'Transactions';
const SHEET_CFG = 'Налаштування';
const TX_HEADERS = ['id', 'Дата', 'Сума', 'Категорія', 'Джерело', 'Хто', 'Коментар', 'Створено', 'Тиждень', 'Місяць', 'Рік'];
const COL = { ID: 1, DATE: 2, AMOUNT: 3, CATEGORY: 4, SOURCE: 5, WHO: 6, NOTE: 7, CREATED: 8, WEEK: 9, MONTH: 10, YEAR: 11 };

const DEFAULT_CONFIG = {
  categories: ['Їжа', 'Побутова хімія', 'Корм для тварин', 'Кава', 'Пальне', 'Авто', 'Інше'],
  sources: ['Готівка', 'monobank', 'Приват'],
  people: ['Я', 'Yasilda'],
};

const MAX_AMOUNT = 10000000;
const MAX_LIST = 500;

// ---------- Одноразове налаштування ----------

/** Запусти один раз вручну: створює вкладки, налаштування та зведення. */
function setup() {
  if (!PropertiesService.getScriptProperties().getProperty('ACCESS_CODE')) {
    throw new Error('Спершу додай ACCESS_CODE у Project Settings → Script properties.');
  }
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone('Europe/Kyiv');
  setupTransactions_(ss);
  setupConfig_(ss);
  setupSummary_(ss, 'Тижні', 'I', 'Тиждень');
  setupSummary_(ss, 'Місяці', 'J', 'Місяць');
  setupSummary_(ss, 'Роки', 'K', 'Рік');
}

function setupTransactions_(ss) {
  const sh = ss.getSheetByName(SHEET_TX) || ss.insertSheet(SHEET_TX);
  sh.getRange(1, 1, 1, TX_HEADERS.length).setValues([TX_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('B2:B').setNumberFormat('yyyy-mm-dd');
  sh.getRange('C2:C').setNumberFormat('#,##0.00');
  sh.getRange('H2:H').setNumberFormat('yyyy-mm-dd hh:mm');
}

function setupConfig_(ss) {
  let sh = ss.getSheetByName(SHEET_CFG);
  if (sh) return; // не перезаписуємо те, що вже відредаговано
  sh = ss.insertSheet(SHEET_CFG);
  const cols = [['Категорії', DEFAULT_CONFIG.categories], ['Джерела', DEFAULT_CONFIG.sources], ['Хто', DEFAULT_CONFIG.people]];
  cols.forEach(function (c, i) {
    sh.getRange(1, i + 1).setValue(c[0]).setFontWeight('bold');
    sh.getRange(2, i + 1, c[1].length, 1).setValues(c[1].map(function (v) { return [v]; }));
  });
  sh.setColumnWidths(1, 3, 160);
}

function setupSummary_(ss, name, keyCol, label) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  const src = SHEET_TX + '!A2:K';
  const empty = '"Поки немає даних"';
  const totals = 'select ' + keyCol + ', sum(C) where ' + keyCol + " is not null group by " + keyCol +
    " order by " + keyCol + " desc label " + keyCol + " '" + label + "', sum(C) 'Всього, грн'";
  const pivot = 'select ' + keyCol + ', sum(C) where ' + keyCol + " is not null group by " + keyCol +
    " pivot D order by " + keyCol + " desc label " + keyCol + " '" + label + "'";
  sh.getRange('A1').setFormula('=IFERROR(QUERY(' + src + ',"' + totals + '",0),' + empty + ')');
  sh.getRange('D1').setFormula('=IFERROR(QUERY(' + src + ',"' + pivot + '",0),"")');
  sh.getRange('1:1').setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('B2:B').setNumberFormat('#,##0.00');
  sh.getRange('E2:Z').setNumberFormat('#,##0.00');
}

// ---------- Web app ----------

function doGet() {
  return json_({ ok: true, service: 'finance-app' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!checkCode_(req.code)) return json_({ ok: false, error: 'bad_code' });
    switch (req.action) {
      case 'config': return json_({ ok: true, config: readConfig_() });
      case 'list': return json_({ ok: true, items: listTx_(Number(req.limit) || 200) });
      case 'add': return json_(withLock_(function () { return addTx_(req.item); }));
      case 'update': return json_(withLock_(function () { return updateTx_(req.item); }));
      case 'delete': return json_(withLock_(function () { return deleteTx_(req.id); }));
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function checkCode_(code) {
  const expected = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE');
  return !!expected && typeof code === 'string' && code === expected;
}

// ---------- Дані ----------

function txSheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_TX);
  if (!sh) throw new Error('Не знайдено вкладку Transactions. Запусти setup().');
  return sh;
}

function readConfig_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CFG);
  if (!sh) return DEFAULT_CONFIG;
  const last = Math.max(sh.getLastRow(), 2);
  const vals = sh.getRange(2, 1, last - 1, 3).getValues();
  const col = function (i) {
    return vals.map(function (r) { return String(r[i]).trim(); }).filter(function (v) { return v; });
  };
  return { categories: col(0), sources: col(1), people: col(2) };
}

function tz_() { return Session.getScriptTimeZone(); }

function listTx_(limit) {
  const sh = txSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const rows = sh.getRange(2, 1, n, COL.NOTE).getValues();
  const items = rows.map(function (r) {
    return {
      id: r[COL.ID - 1],
      date: r[COL.DATE - 1] instanceof Date ? Utilities.formatDate(r[COL.DATE - 1], tz_(), 'yyyy-MM-dd') : String(r[COL.DATE - 1]),
      amount: Number(r[COL.AMOUNT - 1]),
      category: r[COL.CATEGORY - 1],
      source: r[COL.SOURCE - 1],
      who: r[COL.WHO - 1],
      note: r[COL.NOTE - 1],
    };
  }).filter(function (x) { return x.id; });
  items.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  return items.slice(0, Math.min(limit, MAX_LIST));
}

function findRow_(id) {
  if (!id) return 0;
  const sh = txSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const ids = sh.getRange(2, COL.ID, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return 0;
}

function validate_(item) {
  if (!item || typeof item !== 'object') throw new Error('bad_item');
  const cfg = readConfig_();
  const amount = Number(item.amount);
  if (!isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw new Error('bad_amount');
  if (cfg.categories.indexOf(item.category) < 0) throw new Error('bad_category');
  if (cfg.sources.indexOf(item.source) < 0) throw new Error('bad_source');
  if (cfg.people.indexOf(item.who) < 0) throw new Error('bad_who');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.date))) throw new Error('bad_date');
  const date = Utilities.parseDate(item.date + ' 12:00', tz_(), 'yyyy-MM-dd HH:mm');
  return {
    date: date,
    amount: Math.round(amount * 100) / 100,
    category: item.category,
    source: item.source,
    who: item.who,
    note: safeText_(item.note),
  };
}

/** Захист від формул: текст, що починається зі спецсимволу, не виконується в таблиці. */
function safeText_(s) {
  const t = String(s || '').trim().slice(0, 200);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

function isoWeekKey_(d) {
  const fmt = function (p) { return Number(Utilities.formatDate(d, tz_(), p)); };
  const t = new Date(Date.UTC(fmt('yyyy'), fmt('M') - 1, fmt('d')));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + (week < 10 ? '0' : '') + week;
}

function rowValues_(id, v, created) {
  return [id, v.date, v.amount, v.category, v.source, v.who, v.note, created,
    isoWeekKey_(v.date), Utilities.formatDate(v.date, tz_(), 'yyyy-MM'), Utilities.formatDate(v.date, tz_(), 'yyyy')];
}

function addTx_(item) {
  const id = item && typeof item.id === 'string' && item.id.length >= 8 && item.id.length <= 64 ? item.id : Utilities.getUuid();
  if (findRow_(id)) return { ok: true, id: id, duplicate: true }; // повторна відправка з черги
  const v = validate_(item);
  const sh = txSheet_();
  const row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, TX_HEADERS.length).setValues([rowValues_(id, v, new Date())]);
  return { ok: true, id: id };
}

function updateTx_(item) {
  const row = findRow_(item && item.id);
  if (!row) throw new Error('not_found');
  const v = validate_(item);
  const sh = txSheet_();
  const created = sh.getRange(row, COL.CREATED).getValue();
  sh.getRange(row, 1, 1, TX_HEADERS.length).setValues([rowValues_(item.id, v, created)]);
  return { ok: true, id: item.id };
}

function deleteTx_(id) {
  const row = findRow_(id);
  if (!row) throw new Error('not_found');
  txSheet_().deleteRow(row);
  return { ok: true };
}
