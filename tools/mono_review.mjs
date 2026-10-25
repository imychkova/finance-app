#!/usr/bin/env node
// Локальний інтерфейс перегляду витрат monobank перед записом у застосунок.
// Читає data/mono-pending.json (його створює mono_fetch.mjs), показує таблицю, де можна
// обрати «Хто», категорію й коментар, і записує підтверджене через API застосунку.
// Слухає лише 127.0.0.1; токени лишаються на сервері.
//
//   node tools/mono_review.mjs   → http://127.0.0.1:8788
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadEnv, app, readSkipped, classify, findDuplicate, ROOT, PENDING_FILE, SKIPPED_FILE } from './mono_lib.mjs';

const PORT = 8788;
const HOST = `127.0.0.1:${PORT}`;
loadEnv();

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 2e6) reject(new Error('too_big')); });
  req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  req.on('error', reject);
});

async function loadData() {
  if (!fs.existsSync(PENDING_FILE)) throw new Error('Немає data/mono-pending.json. Спершу запусти: node tools/mono_fetch.mjs');
  const pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  const [{ config }, { items: all }] = await Promise.all([app('config'), app('list', { limit: 500 })]);
  const known = new Set(all.map((i) => i.id));
  const skipped = readSkipped();
  const minDate = pending.length ? pending[0].date : '';
  const existing = all.filter((i) => i.date >= minDate && i.amount > 0);
  const used = new Set();
  const items = [];
  const missing = new Set();
  let dupes = 0;
  for (const t of pending) {
    if (known.has(t.id) || skipped.has(t.id)) continue;
    if (findDuplicate(t, existing, used)) { dupes++; continue; }
    const c = classify(t);
    if (!config.categories.includes(c.category)) missing.add(c.category);
    items.push({
      id: t.id, date: t.date, amount: t.amount,
      description: t.description.replace(/\n.*/s, ''), mcc: t.mcc,
      category: config.categories.includes(c.category) ? c.category : 'Інше',
      who: c.who && config.people.includes(c.who) ? c.who : process.env.APP_DEFAULT_WHO || 'Разом',
      note: t.comment || '',
      auto: c.skip, reason: c.reason,
    });
  }
  return { items, dupes, missing: [...missing], categories: config.categories, people: config.people };
}

async function push(body) {
  const results = { added: 0, errors: [] };
  for (const it of body.items || []) {
    try {
      await app('add', {
        item: { id: it.id, date: it.date, amount: it.amount, category: it.category, source: 'monobank', who: it.who, note: it.note },
      });
      results.added++;
    } catch (e) {
      results.errors.push({ id: it.id, error: String(e.message || e) });
    }
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  try {
    // Захист від DNS rebinding та запитів з чужих сайтів.
    if (req.headers.host !== HOST) return send(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && req.url === '/') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'tools', 'mono_review.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && req.url === '/api/data') return send(res, 200, await loadData());
    if (req.method === 'POST' && req.headers['content-type']?.startsWith('application/json')) {
      const body = await readBody(req);
      if (req.url === '/api/push') return send(res, 200, await push(body));
      if (req.url === '/api/skip') {
        const ids = (body.ids || []).filter((i) => /^mono-[\w-]+$/.test(i));
        if (ids.length) fs.appendFileSync(SKIPPED_FILE, ids.join('\n') + '\n');
        return send(res, 200, { skipped: ids.length });
      }
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Відкрий http://${HOST}`));
