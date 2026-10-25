#!/usr/bin/env node
// Тягне виписку monobank (особисте API) і зберігає нові витрати в data/mono-pending.json.
// Нічого не пише в застосунок. Ліміт API: 1 запит / 60 с, виписка до 31 дня за запит.
// За замовчуванням бере останні 31 день (≈ місяць); інша початкова дата — через --from.
//
//   node tools/mono_fetch.mjs [--from YYYY-MM-DD]
import fs from 'node:fs';
import { loadEnv, app, sleep, readSkipped, suggestCategory, DATA, PENDING_FILE } from './mono_lib.mjs';

const BASE = 'https://api.monobank.ua';
const UAH = 980;

const WINDOW = 31 * 86400;
const fromIdx = process.argv.indexOf('--from');
const fromArg = fromIdx > 0 ? process.argv[fromIdx + 1] : null;
if (fromArg && !/^\d{4}-\d{2}-\d{2}$/.test(fromArg)) throw new Error('--from має бути у форматі YYYY-MM-DD');

loadEnv();

async function mono(pathname) {
  const res = await fetch(BASE + pathname, { headers: { 'X-Token': process.env.MONOBANK_TOKEN } });
  if (res.status === 429) throw new Error('monobank: забагато запитів (429), спробуй за хвилину');
  if (!res.ok) throw new Error(`monobank ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const info = await mono('/personal/client-info');
const accounts = info.accounts.filter((a) => a.currencyCode === UAH && a.type === 'black');
if (!accounts.length) throw new Error('Не знайдено гривневої чорної картки.');

const to = Math.floor(Date.now() / 1000);
const from = fromArg ? Math.floor(new Date(`${fromArg}T00:00:00+03:00`).getTime() / 1000) : to - WINDOW;
if (!(from < to)) throw new Error('Початкова дата має бути в минулому.');
console.error(`Рахунків: ${accounts.length}, з ${new Date(from * 1000).toISOString().slice(0, 10)}`);
const known = new Set((await app('list', { limit: 500 })).items.map((i) => i.id));
const skipped = readSkipped();

const pending = [];
let truncated = false;
for (const acc of accounts) {
  const list = [];
  for (let start = from; start < to; start += WINDOW) {
    console.error(`Чекаю 61 с через ліміт API… (${acc.maskedPan?.[0] || acc.id})`);
    await sleep(61000);
    const part = await mono(`/personal/statement/${acc.id}/${start}/${Math.min(start + WINDOW, to)}`);
    if (part.length >= 500) truncated = true;
    list.push(...part);
  }
  for (const t of list) {
    const id = `mono-${t.id}`;
    if (t.amount >= 0 || known.has(id) || skipped.has(id)) continue;
    pending.push({
      id,
      date: new Date(t.time * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }),
      amount: Math.abs(t.amount) / 100,
      description: t.description,
      comment: t.comment || '',
      mcc: t.mcc,
      account: acc.maskedPan?.[0] || acc.id,
      suggested: suggestCategory(t.mcc, t.description),
    });
  }
}

pending.sort((a, b) => (a.date < b.date ? -1 : 1));
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
console.log(`Нових витрат: ${pending.length} → ${PENDING_FILE}`);
if (truncated) console.log('Увага: рахунок повернув 500 записів — період обрізано, задай пізнішу --from.');
