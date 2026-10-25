// Спільні утиліти для синхронізації з monobank (офіційне особисте API: https://api.monobank.ua/docs/).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const PENDING_FILE = path.join(DATA, 'mono-pending.json');
export const SKIPPED_FILE = path.join(DATA, 'mono-skipped.txt');

/** Читає .env.local (KEY=VALUE) у process.env, не перезаписуючи вже задане. */
export function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const k of ['MONOBANK_TOKEN', 'APP_URL', 'APP_CODE']) {
    if (!process.env[k]) throw new Error(`Не задано ${k}. Додай його в .env.local (див. .env.example).`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Виклик API застосунку (Apps Script). Усі запити — POST із text/plain, як у PWA. */
export async function app(action, payload = {}) {
  const res = await fetch(process.env.APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ code: process.env.APP_CODE, action, ...payload }),
    redirect: 'follow',
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`app ${action}: ${data.error}`);
  return data;
}

export function readSkipped() {
  return new Set(fs.existsSync(SKIPPED_FILE) ? fs.readFileSync(SKIPPED_FILE, 'utf8').split('\n').filter(Boolean) : []);
}

/** Підказка категорії за MCC; null — агент має спитати користувача. */
export function suggestCategory(mcc, description) {
  const d = (description || '').toLowerCase();
  if (/(^|[^а-яіїєґ])кав[аиу]|кав.ярн|coffee|starbucks|lviv croissants/.test(d)) return 'Кава';
  if ([5411, 5499, 5422, 5441, 5451, 5462].includes(mcc)) return 'Їжа';
  if ([5541, 5542].includes(mcc)) return 'Пальне';
  if ([5812, 5813, 5814].includes(mcc)) return 'Ресторани';
  if ([5912].includes(mcc)) return 'Аптека';
  if ([5995].includes(mcc)) return 'Корм для тварин';
  if ([7523, 7538, 5533, 7542, 4111, 4121].includes(mcc)) return 'Авто';
  return null;
}

// Автоматичні правила: [regex за описом, категорія або 'skip', причина, «Хто» (необов'язково)]. Перше співпадіння виграє.
const RULES = [
  [/На машину|Поповнення «|Округлення|Переказ на картку|Мичкова/, 'skip', 'внутрішній переказ'],
  [/Банкомат/, 'skip', 'готівка (вноситься вручну)'],
  [/^UWF$/, 'skip', 'вже враховано записом «фестиваль вина»'],
  [/Base Sternenko|Повернись живим/, 'Донат', '', 'Я'],
  [/Apple|Netflix|Київстар|EasyPay/, 'Підписки й інтернет', ''],
  [/Епіцентр/, 'Дім і сад', ''],
  [/Parkomaydanchik|Львівавтодор|Паркінг/, 'Авто', ''],
  [/Veterinar/, 'Корм для тварин', 'ветеринарка'],
  [/Аврора/, 'Побутова хімія', ''],
  [/Рукавичка|Сільпо|АТБ|PRAVDORUB|Близенько/, 'Їжа', ''],
  [/Muzeo|Hromadska|E-wings|Нова пошта|monomarket|EVA|Waikiki|Інтерспорт|Копач|WAYFORPAY/, 'Інше', 'перевір'],
];

// Правила за MCC (мають пріоритет над RULES): MCC → { category, who }.
const MCC_RULES = {
  4111: { category: 'Інше', who: 'Я', reason: 'громадський транспорт' },
  4814: { category: 'Підписки й інтернет', who: 'Я', reason: 'зв\'язок' },
};

/** Категорія + ознака «пропустити» для транзакції з pending. */
export function classify(t) {
  const m = MCC_RULES[t.mcc];
  if (m) return { skip: false, ...m };
  const desc = (t.description || '').replace(/\n.*/s, '');
  for (const [re, cat, reason, who] of RULES) {
    if (re.test(desc)) return cat === 'skip' ? { skip: true, category: 'Інше', reason } : { skip: false, category: cat, reason, who };
  }
  return { skip: false, category: t.suggested || 'Інше', reason: t.suggested ? '' : 'перевір' };
}

/** Чи є в застосунку запис із тією ж датою і сумою (±1 грн); кожен існуючий запис гасить лише одну транзакцію. */
export function findDuplicate(t, existing, used) {
  const hit = existing.find((a) => !used.has(a.id) && a.date === t.date && Math.abs(a.amount - t.amount) <= 1);
  if (hit) used.add(hit.id);
  return hit;
}
