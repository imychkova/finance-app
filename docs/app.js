'use strict';

// Налаштування підключення зберігаються лише в цьому браузері (не в коді).
const LS = { url: 'fa.url', code: 'fa.code', who: 'fa.who', source: 'fa.source', pending: 'fa.pending', config: 'fa.config', filter: 'fa.filter' };

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватний режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ігноруємо */ } },
};
const readJson = (k, fallback) => { try { return JSON.parse(store.get(k)) || fallback; } catch (e) { return fallback; } };

const state = { filter: store.get(LS.filter) || '', config: null, items: [], plan: [], form: { category: null, source: null, who: null }, editing: null };

// ---------- API ----------

class ApiError extends Error {}

async function api(action, payload) {
  const url = store.get(LS.url);
  const code = store.get(LS.code);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // без CORS preflight
      body: JSON.stringify(Object.assign({ action, code }, payload)),
    });
  } catch (e) {
    throw new ApiError('network');
  }
  let data;
  try { data = await res.json(); } catch (e) { throw new ApiError('bad_response'); }
  if (!data.ok) throw new ApiError(data.error || 'error');
  return data;
}

const ERRORS = {
  network: 'Немає зв\'язку із сервером.',
  bad_code: 'Невірний код доступу.',
  bad_response: 'Сервер відповів незрозуміло. Перевір адресу API.',
  bad_amount: 'Некоректна сума.',
  not_found: 'Запис не знайдено (можливо, його вже видалили).',
};
const errText = (e) => ERRORS[e.message] || 'Помилка: ' + e.message;

// ---------- Утиліти ----------

const fmtMoney = (n) => new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n) + ' грн';
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const parseAmount = (s) => Number(String(s).replace(/\s/g, '').replace(',', '.'));
const dayLabel = (iso) => {
  if (iso === today()) return 'Сьогодні';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'long' });
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---------- Навігація ----------

function showView(name) {
  ['setup', 'add', 'plan', 'history'].forEach((v) => { $('view-' + v).hidden = v !== name; });
  $('tabs').hidden = name === 'setup';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'history') loadHistory();
  if (name === 'plan') loadPlan();
  window.scrollTo(0, 0);
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === 'add') resetForm();
  showView(b.dataset.tab);
}));

// ---------- Підключення ----------

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('setup-error');
  store.set(LS.url, $('setup-url').value.trim());
  store.set(LS.code, $('setup-code').value);
  try {
    await loadConfig();
    startApp();
  } catch (err) {
    store.del(LS.code);
    showError('setup-error', errText(err));
  }
});

async function loadConfig() {
  const { config } = await api('config');
  state.config = config;
  store.set(LS.config, JSON.stringify(config));
}

// ---------- Форма ----------

function renderChoices(containerId, values, key, storeKey) {
  const box = $(containerId);
  box.textContent = '';
  values.forEach((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = v;
    b.setAttribute('aria-pressed', String(state.form[key] === v));
    b.addEventListener('click', () => {
      state.form[key] = v;
      if (storeKey) store.set(storeKey, v);
      box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    box.appendChild(b);
  });
}

function renderForm() {
  const c = state.config;
  const pick = (cur, list, saved) => (list.includes(cur) ? cur : list.includes(saved) ? saved : null);
  state.form.source = pick(state.form.source, c.sources, store.get(LS.source)) || c.sources[0];
  state.form.who = pick(state.form.who, c.people, store.get(LS.who)) || c.people[0];
  if (!c.categories.includes(state.form.category)) state.form.category = null;
  renderChoices('f-category', c.categories, 'category');
  renderChoices('f-source', c.sources, 'source', LS.source);
  renderChoices('f-who', c.people, 'who', LS.who);
}

function resetForm() {
  state.editing = null;
  state.form.category = null;
  $('f-amount').value = '';
  $('f-note').value = '';
  $('f-date').value = today();
  $('add-title').textContent = 'Нова витрата';
  $('f-submit').textContent = 'Додати';
  $('edit-actions').hidden = true;
  showError('add-error');
  renderForm();
}

function startEdit(item) {
  state.editing = item;
  state.form = { category: item.category, source: item.source, who: item.who };
  $('f-amount').value = String(item.amount).replace('.', ',');
  $('f-note').value = item.note || '';
  $('f-date').value = item.date;
  $('add-title').textContent = 'Редагування';
  $('f-submit').textContent = 'Зберегти';
  $('edit-actions').hidden = false;
  showError('add-error');
  renderForm();
  showView('add');
}

function readForm() {
  const amount = parseAmount($('f-amount').value);
  if (!isFinite(amount) || amount <= 0) throw new Error('Введи суму більше нуля.');
  if (!state.form.category) throw new Error('Обери категорію.');
  return {
    amount: Math.round(amount * 100) / 100,
    category: state.form.category,
    source: state.form.source,
    who: state.form.who,
    date: $('f-date').value,
    note: $('f-note').value.trim(),
  };
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('add-error');
  let item;
  try { item = readForm(); } catch (err) { showError('add-error', err.message); return; }
  const btn = $('f-submit');
  btn.disabled = true;
  try {
    if (state.editing) {
      item.id = state.editing.id;
      await api('update', { item });
      toast('Збережено');
      resetForm();
      showView('history');
    } else {
      item.id = uuid();
      await sendNew(item);
      resetForm();
    }
  } catch (err) {
    showError('add-error', errText(err));
  } finally {
    btn.disabled = false;
  }
});

// Нову витрату при відсутності зв'язку кладемо в чергу й відправимо пізніше.
async function sendNew(item) {
  try {
    await api('add', { item });
    toast('Додано');
  } catch (err) {
    if (err.message !== 'network') throw err;
    const q = readJson(LS.pending, []);
    q.push(item);
    store.set(LS.pending, JSON.stringify(q));
    toast('Збережено в черзі — відправиться, коли буде зв\'язок');
  }
}

async function flushPending() {
  const q = readJson(LS.pending, []);
  if (!q.length) return;
  const left = [];
  for (const item of q) {
    try { await api('add', { item }); } catch (err) { if (err.message === 'network') left.push(item); }
  }
  if (left.length) store.set(LS.pending, JSON.stringify(left)); else store.del(LS.pending);
  if (left.length < q.length) toast('Відправлено з черги: ' + (q.length - left.length));
}

$('f-cancel').addEventListener('click', () => { resetForm(); showView('history'); });
$('f-delete').addEventListener('click', async () => {
  if (!state.editing || !confirm('Видалити цю витрату?')) return;
  try {
    await api('delete', { id: state.editing.id });
    toast('Видалено');
    resetForm();
    showView('history');
  } catch (err) {
    showError('add-error', errText(err));
  }
});

// ---------- Історія ----------

async function loadHistory() {
  const list = $('history-list');
  try {
    await flushPending();
    const { items } = await api('list', { limit: 300 });
    state.items = items;
  } catch (err) {
    toast(errText(err));
  }
  renderHistory(list);
}

function renderHistoryFilter() {
  const box = $('history-filter');
  box.textContent = '';
  const people = state.config ? state.config.people : [];
  if (people.length < 2) return;
  if (state.filter && people.indexOf(state.filter) < 0) state.filter = '';
  ['', ...people].forEach((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name || 'Усі';
    b.setAttribute('aria-pressed', String((state.filter || '') === name));
    b.addEventListener('click', () => {
      state.filter = name;
      store.set(LS.filter, name);
      renderHistory($('history-list'));
    });
    box.appendChild(b);
  });
}

function renderHistory(list) {
  list.textContent = '';
  renderHistoryFilter();
  const queued = readJson(LS.pending, []);
  const byWho = (x) => !state.filter || x.who === state.filter;
  const all = queued.map((x) => Object.assign({ queued: true }, x)).concat(state.items).filter(byWho);
  $('history-empty').hidden = all.length > 0;
  $('pending-note').hidden = !queued.length;
  $('pending-note').textContent = queued.length ? 'У черзі на відправку: ' + queued.length : '';

  const month = today().slice(0, 7);
  const total = state.items.filter(byWho).filter((x) => x.date.startsWith(month)).reduce((s, x) => s + x.amount, 0);
  $('month-total').textContent = 'Цього місяця: ' + fmtMoney(total);

  let lastDay = null;
  all.forEach((it) => {
    if (it.date !== lastDay) {
      const h = document.createElement('div');
      h.className = 'day';
      h.textContent = dayLabel(it.date);
      list.appendChild(h);
      lastDay = it.date;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item' + (it.queued ? ' queued' : '');
    const main = document.createElement('div');
    main.className = 'main';
    const cat = document.createElement('div');
    cat.className = 'cat';
    cat.textContent = it.category;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [it.source, it.who, it.note].filter(Boolean).join(' · ');
    main.append(cat, meta);
    const sum = document.createElement('div');
    sum.className = 'sum';
    sum.textContent = fmtMoney(it.amount);
    b.append(main, sum);
    if (!it.queued) b.addEventListener('click', () => startEdit(it));
    list.appendChild(b);
  });
}

// ---------- План ----------

async function loadPlan() {
  try {
    const { items } = await api('plan_list');
    state.plan = items;
  } catch (err) {
    toast(errText(err));
  }
  renderPlan();
}

// Зміна рядка плану: оновлюємо екран одразу, а при помилці повертаємо як було.
async function planSave(item, action) {
  try {
    await api(action, { item });
  } catch (err) {
    toast(errText(err));
    await loadPlan();
  }
}

function planAdd(category, text) {
  const item = { id: uuid(), category, text, amount: null, done: false, who: state.form.who || '' };
  state.plan.push(item);
  renderPlan(item.id);
  planSave(item, 'plan_add');
}

function planRemove(item) {
  state.plan = state.plan.filter((x) => x.id !== item.id);
  renderPlan();
  api('plan_delete', { id: item.id }).catch((err) => { toast(errText(err)); loadPlan(); });
}

function planRow(item) {
  const row = document.createElement('div');
  row.className = 'plan-row' + (item.done ? ' done' : '');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = item.done;
  check.setAttribute('aria-label', 'Виконано');
  check.addEventListener('change', () => {
    item.done = check.checked;
    renderPlan();
    planSave(item, 'plan_update');
  });

  const text = document.createElement('input');
  text.type = 'text';
  text.className = 'plan-text';
  text.maxLength = 200;
  text.value = item.text;
  text.setAttribute('aria-label', 'Що');
  text.addEventListener('change', () => {
    const v = text.value.trim();
    if (!v) { text.value = item.text; return; }
    item.text = v;
    planSave(item, 'plan_update');
  });

  const sum = document.createElement('input');
  sum.type = 'text';
  sum.inputMode = 'decimal';
  sum.className = 'plan-sum';
  sum.placeholder = 'грн';
  sum.value = item.amount == null ? '' : String(item.amount).replace('.', ',');
  sum.setAttribute('aria-label', 'Орієнтовна сума, грн');
  sum.addEventListener('change', () => {
    const raw = sum.value.trim();
    const n = raw === '' ? null : parseAmount(raw);
    if (n !== null && (!isFinite(n) || n < 0)) { sum.value = item.amount == null ? '' : String(item.amount).replace('.', ','); return; }
    item.amount = n === null ? null : Math.round(n * 100) / 100;
    renderPlan();
    planSave(item, 'plan_update');
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'plan-del';
  del.textContent = '×';
  del.setAttribute('aria-label', 'Видалити');
  del.addEventListener('click', () => planRemove(item));

  row.append(check, text, sum, del);
  return row;
}

function renderPlan(focusId) {
  const box = $('plan-list');
  box.textContent = '';
  const cats = state.config ? state.config.categories.slice() : [];
  state.plan.forEach((x) => { if (!cats.includes(x.category)) cats.push(x.category); });

  const open = state.plan.filter((x) => !x.done);
  const sum = open.reduce((s, x) => s + (x.amount || 0), 0);
  $('plan-total').textContent = open.length ? 'Лишилось: ' + open.length + (sum ? ' · приблизно ' + fmtMoney(sum) : '') : '';
  $('plan-empty').hidden = state.plan.length > 0;

  cats.forEach((cat) => {
    const items = state.plan.filter((x) => x.category === cat);
    const sec = document.createElement('details');
    sec.className = 'plan-cat';
    sec.open = items.length > 0 || state.planOpen === cat;
    const head = document.createElement('summary');
    const left = items.filter((x) => !x.done).length;
    head.textContent = cat + (items.length ? ' · ' + left + '/' + items.length : '');
    sec.appendChild(head);
    sec.addEventListener('toggle', () => { if (sec.open) state.planOpen = cat; });

    items.filter((x) => !x.done).concat(items.filter((x) => x.done)).forEach((it) => sec.appendChild(planRow(it)));

    const form = document.createElement('form');
    form.className = 'plan-add';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 200;
    inp.placeholder = '+ Додати в «' + cat + '»';
    inp.setAttribute('aria-label', 'Новий рядок: ' + cat);
    form.appendChild(inp);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = inp.value.trim();
      if (!v) return;
      state.planOpen = cat;
      planAdd(cat, v);
    });
    sec.appendChild(form);
    box.appendChild(sec);
    if (state.planOpen === cat && focusId) form.querySelector('input').focus();
  });
}

// ---------- Старт ----------

function startApp() {
  resetForm();
  showView('add');
  flushPending();
}

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('online', flushPending);
  if (!store.get(LS.url) || !store.get(LS.code)) { showView('setup'); return; }
  state.config = readJson(LS.config, null);
  try {
    await loadConfig(); // оновлюємо категорії з таблиці
  } catch (err) {
    if (err.message === 'bad_code') { store.del(LS.code); showView('setup'); showError('setup-error', errText(err)); return; }
    if (!state.config) { showView('setup'); showError('setup-error', errText(err)); return; }
  }
  startApp();
}

init();
