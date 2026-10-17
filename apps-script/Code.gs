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

const SHEET_PLAN = 'План';
const PLAN_HEADERS = ['id', 'Категорія', 'Що', 'Орієнтовна сума', 'Виконано', 'Хто', 'Створено'];
const PCOL = { ID: 1, CATEGORY: 2, TEXT: 3, AMOUNT: 4, DONE: 5, WHO: 6, CREATED: 7 };

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
  rebuildSummaries();
}

/** Меню «Фінанси» у таблиці: ручне оновлення зведення. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Фінанси').addItem('Оновити зведення', 'rebuildSummaries').addToUi();
}

function setupTransactions_(ss) {
  const sh = ss.getSheetByName(SHEET_TX) || ss.insertSheet(SHEET_TX);
  sh.getRange(1, 1, 1, TX_HEADERS.length).setValues([TX_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange('B2:B').setNumberFormat('yyyy-mm-dd');
  sh.getRange('C2:C').setNumberFormat('#,##0.00');
  sh.getRange('H2:H').setNumberFormat('yyyy-mm-dd hh:mm');
  // Ключі періодів — лише текст, інакше «2026-10» Sheets перетворить на дату.
  sh.getRange('I2:K').setNumberFormat('@');
}

/**
 * Запусти вручну після імпорту CSV: заповнює Тиждень/Місяць/Рік для рядків, де вони порожні.
 */
function recomputeKeys() {
  const sh = txSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return;
  normalizeTypes_(sh, n);
  sh.getRange('I2:K').setNumberFormat('@');
  const dates = sh.getRange(2, COL.DATE, n, 1).getValues();
  const keys = sh.getRange(2, COL.WEEK, n, 3).getValues();
  const out = keys.map(function (k, i) {
    const d = dates[i][0];
    if (!(d instanceof Date) || (k[0] && k[1] && k[2])) return k;
    return [isoWeekKey_(d), Utilities.formatDate(d, tz_(), 'yyyy-MM'), Utilities.formatDate(d, tz_(), 'yyyy')];
  });
  sh.getRange(2, COL.WEEK, n, 3).setValues(out);
  rebuildSummaries();
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

// ---------- Зведення (тижні / місяці / роки) ----------

const SUMMARIES = [
  { sheet: 'Тижні', label: 'Тиждень', key: function (d) { return isoWeekKey_(d); } },
  { sheet: 'Місяці', label: 'Місяць', key: function (d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM'); } },
  { sheet: 'Роки', label: 'Рік', key: function (d) { return Utilities.formatDate(d, tz_(), 'yyyy'); } },
];

/**
 * Чиста функція: з рядків [{date, amount, category}] робить таблицю зведення.
 * Рядки періодів — від новіших до старіших; колонки: Період, Всього, категорії.
 */
function aggregate_(rows, label, keyFn, cfgCategories) {
  const periods = {};
  const seenCats = {};
  rows.forEach(function (r) {
    const k = keyFn(r.date);
    const p = periods[k] || (periods[k] = { total: 0, cats: {} });
    p.total += r.amount;
    p.cats[r.category] = (p.cats[r.category] || 0) + r.amount;
    seenCats[r.category] = true;
  });
  const cats = cfgCategories.concat(Object.keys(seenCats).filter(function (c) { return cfgCategories.indexOf(c) < 0; }).sort());
  const out = [[label, 'Всього, грн'].concat(cats)];
  Object.keys(periods).sort().reverse().forEach(function (k) {
    const p = periods[k];
    out.push([k, round2_(p.total)].concat(cats.map(function (c) { return p.cats[c] ? round2_(p.cats[c]) : ''; })));
  });
  return out;
}

function round2_(x) { return Math.round(x * 100) / 100; }

/** Читає Transactions і спритно переживає текстові дати/суми після імпорту. */
function readRows_() {
  const sh = txSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const vals = sh.getRange(2, 1, n, COL.CATEGORY).getValues();
  const rows = [];
  vals.forEach(function (r) {
    let d = r[COL.DATE - 1];
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d.trim())) {
      d = Utilities.parseDate(d.trim().slice(0, 10) + ' 12:00', tz_(), 'yyyy-MM-dd HH:mm');
    }
    let a = r[COL.AMOUNT - 1];
    if (typeof a === 'string') a = Number(a.replace(/\s/g, '').replace(',', '.'));
    if (!(d instanceof Date) || !isFinite(a) || r[COL.ID - 1] === '') return;
    rows.push({ date: d, amount: a, category: String(r[COL.CATEGORY - 1]) || 'Інше' });
  });
  return rows;
}

/** Перебудовує вкладки Тижні / Місяці / Роки. Викликається після кожної зміни й вручну з меню. */
function rebuildSummaries() {
  const ss = SpreadsheetApp.getActive();
  const rows = readRows_();
  const cfgCats = readConfig_().categories;
  SUMMARIES.forEach(function (s) {
    const sh = ss.getSheetByName(s.sheet) || ss.insertSheet(s.sheet);
    const table = aggregate_(rows, s.label, s.key, cfgCats);
    sh.clear();
    sh.getRange(1, 1, table.length, table[0].length).setValues(table);
    sh.getRange(1, 1, 1, table[0].length).setFontWeight('bold');
    sh.getRange(1, 1, table.length, 1).setNumberFormat('@');
    if (table.length > 1) sh.getRange(2, 2, table.length - 1, table[0].length - 1).setNumberFormat('#,##0.00');
    sh.setFrozenRows(1);
    sh.setFrozenColumns(1);
  });
}

/** Після імпорту дати й суми можуть опинитись текстом (залежить від локалі) — повертаємо їм справжні типи. */
function normalizeTypes_(sh, n) {
  const range = sh.getRange(2, COL.DATE, n, 2); // колонки Дата і Сума
  const out = range.getValues().map(function (r) {
    let d = r[0];
    let a = r[1];
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d.trim())) {
      d = Utilities.parseDate(d.trim().slice(0, 10) + ' 12:00', tz_(), 'yyyy-MM-dd HH:mm');
    }
    if (typeof a === 'string') {
      const x = Number(a.replace(/\s/g, '').replace(',', '.'));
      if (isFinite(x)) a = x;
    }
    return [d, a];
  });
  range.setValues(out);
  sh.getRange(2, COL.DATE, n, 1).setNumberFormat('yyyy-mm-dd');
  sh.getRange(2, COL.AMOUNT, n, 1).setNumberFormat('#,##0.00');
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
      case 'plan_list': return json_({ ok: true, items: listPlan_() });
      case 'plan_add': return json_(withLock_(function () { return addPlan_(req.item); }));
      case 'plan_update': return json_(withLock_(function () { return updatePlan_(req.item); }));
      case 'plan_delete': return json_(withLock_(function () { return deletePlan_(req.id); }));
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
  refreshSummaries_();
  return { ok: true, id: id };
}

function updateTx_(item) {
  const row = findRow_(item && item.id);
  if (!row) throw new Error('not_found');
  const v = validate_(item);
  const sh = txSheet_();
  const created = sh.getRange(row, COL.CREATED).getValue();
  sh.getRange(row, 1, 1, TX_HEADERS.length).setValues([rowValues_(item.id, v, created)]);
  refreshSummaries_();
  return { ok: true, id: item.id };
}

function deleteTx_(id) {
  const row = findRow_(id);
  if (!row) throw new Error('not_found');
  txSheet_().deleteRow(row);
  refreshSummaries_();
  return { ok: true };
}

/** Зведення не повинні ламати збереження витрати: помилку лише логуємо. */
function refreshSummaries_() {
  try { rebuildSummaries(); } catch (err) { console.error('rebuildSummaries: ' + err); }
}

// ---------- План (список покупок і справ) ----------

/** Вкладка «План» створюється сама при першому зверненні. */
function planSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_PLAN);
  if (!sh) {
    sh = ss.insertSheet(SHEET_PLAN);
    sh.getRange(1, 1, 1, PLAN_HEADERS.length).setValues([PLAN_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('D2:D').setNumberFormat('#,##0.00');
    sh.getRange('G2:G').setNumberFormat('yyyy-mm-dd hh:mm');
  }
  return sh;
}

function listPlan_() {
  const sh = planSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, PLAN_HEADERS.length).getValues().map(function (r) {
    return {
      id: r[PCOL.ID - 1],
      category: r[PCOL.CATEGORY - 1],
      text: r[PCOL.TEXT - 1],
      amount: r[PCOL.AMOUNT - 1] === '' ? null : Number(r[PCOL.AMOUNT - 1]),
      done: r[PCOL.DONE - 1] === true || r[PCOL.DONE - 1] === 'TRUE',
      who: r[PCOL.WHO - 1],
    };
  }).filter(function (x) { return x.id; });
}

function findPlanRow_(id) {
  if (!id) return 0;
  const sh = planSheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const ids = sh.getRange(2, PCOL.ID, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return 0;
}

function validatePlan_(item) {
  if (!item || typeof item !== 'object') throw new Error('bad_item');
  const cfg = readConfig_();
  if (cfg.categories.indexOf(item.category) < 0) throw new Error('bad_category');
  const text = safeText_(item.text);
  if (!text) throw new Error('bad_text');
  let amount = '';
  if (item.amount !== null && item.amount !== undefined && item.amount !== '') {
    amount = Number(item.amount);
    if (!isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) throw new Error('bad_amount');
    amount = Math.round(amount * 100) / 100;
  }
  const who = cfg.people.indexOf(item.who) >= 0 ? item.who : '';
  return { category: item.category, text: text, amount: amount, done: item.done === true, who: who };
}

function addPlan_(item) {
  const id = item && typeof item.id === 'string' && item.id.length >= 8 && item.id.length <= 64 ? item.id : Utilities.getUuid();
  if (findPlanRow_(id)) return { ok: true, id: id, duplicate: true };
  const v = validatePlan_(item);
  const sh = planSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, 1, PLAN_HEADERS.length)
    .setValues([[id, v.category, v.text, v.amount, v.done, v.who, new Date()]]);
  return { ok: true, id: id };
}

function updatePlan_(item) {
  const row = findPlanRow_(item && item.id);
  if (!row) throw new Error('not_found');
  const v = validatePlan_(item);
  const sh = planSheet_();
  sh.getRange(row, PCOL.CATEGORY, 1, 4).setValues([[v.category, v.text, v.amount, v.done]]);
  return { ok: true, id: item.id };
}

function deletePlan_(id) {
  const row = findPlanRow_(id);
  if (!row) throw new Error('not_found');
  planSheet_().deleteRow(row);
  return { ok: true };
}
