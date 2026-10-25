#!/usr/bin/env node
// Записує підтверджені категорії в застосунок. Вхід — JSON-файл із рішеннями:
//   [{ "id": "mono-…", "category": "Їжа", "note": "необов'язково" }, { "id": "mono-…", "skip": true }]
// Суму, дату й опис бере з data/mono-pending.json. Повторний запуск безпечний (id унікальний).
//
//   node tools/mono_push.mjs data/mono-decisions.json
import fs from 'node:fs';
import { loadEnv, app, PENDING_FILE, SKIPPED_FILE } from './mono_lib.mjs';

const file = process.argv[2];
if (!file) throw new Error('Вкажи файл із рішеннями.');
loadEnv();

const pending = new Map(JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')).map((p) => [p.id, p]));
const decisions = JSON.parse(fs.readFileSync(file, 'utf8'));
const who = process.env.APP_WHO || 'Я';

let added = 0;
const skipped = [];
for (const d of decisions) {
  const p = pending.get(d.id);
  if (!p) { console.error(`Пропускаю невідомий id ${d.id}`); continue; }
  if (d.skip) { skipped.push(d.id); continue; }
  await app('add', {
    item: {
      id: p.id,
      date: p.date,
      amount: p.amount,
      category: d.category,
      source: 'monobank',
      who: d.who || who,
      note: d.note ?? p.description,
    },
  });
  added++;
}
if (skipped.length) fs.appendFileSync(SKIPPED_FILE, skipped.join('\n') + '\n');
console.log(`Додано: ${added}, пропущено назавжди: ${skipped.length}`);
