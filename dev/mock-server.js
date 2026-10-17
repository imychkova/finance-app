// Локальний імітатор API для перевірки інтерфейсу без Google.
// Запуск: node dev/mock-server.js  → http://localhost:8787 (API: /api, код: test)
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'docs');
const CODE = 'test';
const config = {
  categories: ['Їжа', 'Побутова хімія', 'Корм для тварин', 'Кава', 'Пальне', 'Авто', 'Інше'],
  sources: ['Готівка', 'monobank', 'Приват'],
  people: ['Я', 'Yasilda'],
};
const items = [];
const plan = [];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

function reply(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = JSON.parse(body || '{}');
      if (r.code !== CODE) return reply(res, { ok: false, error: 'bad_code' });
      if (r.action === 'config') return reply(res, { ok: true, config });
      if (r.action === 'list') return reply(res, { ok: true, items: [...items].sort((a, b) => (a.date < b.date ? 1 : -1)) });
      if (r.action === 'add') {
        if (!items.some((x) => x.id === r.item.id)) items.push(r.item);
        return reply(res, { ok: true, id: r.item.id });
      }
      if (r.action === 'update') {
        const i = items.findIndex((x) => x.id === r.item.id);
        if (i < 0) return reply(res, { ok: false, error: 'not_found' });
        items[i] = r.item;
        return reply(res, { ok: true });
      }
      if (r.action === 'delete') {
        const i = items.findIndex((x) => x.id === r.id);
        if (i < 0) return reply(res, { ok: false, error: 'not_found' });
        items.splice(i, 1);
        return reply(res, { ok: true });
      }
      if (r.action === 'plan_list') return reply(res, { ok: true, items: plan });
      if (r.action === 'plan_add') {
        if (!plan.some((x) => x.id === r.item.id)) plan.push(r.item);
        return reply(res, { ok: true, id: r.item.id });
      }
      if (r.action === 'plan_update') {
        const i = plan.findIndex((x) => x.id === r.item.id);
        if (i < 0) return reply(res, { ok: false, error: 'not_found' });
        plan[i] = r.item;
        return reply(res, { ok: true });
      }
      if (r.action === 'plan_delete') {
        const i = plan.findIndex((x) => x.id === r.id);
        if (i < 0) return reply(res, { ok: false, error: 'not_found' });
        plan.splice(i, 1);
        return reply(res, { ok: true });
      }
      reply(res, { ok: false, error: 'unknown_action' });
    });
    return;
  }
  const file = path.join(WEB, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(8787, () => console.log('http://localhost:8787'));
