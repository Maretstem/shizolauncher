// Собирает pack.json для сборки сервера.
//   node tools/make-pack.mjs <папка> --version 1.2.0 --mc 1.21.11 --loader fabric [--loader-version 0.17.3] [--name SHIZOSTAN] [--changelog "текст"]
// В <папка>/files/ лежит содержимое .minecraft (mods/, config/, ...). Рядом появится <папка>/pack.json.
// Папку целиком выкладываешь на любой статический хостинг; адрес pack.json вписываешь в launcher.config.json.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readJson, writeJson } from '../src/main/core/net.js';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { version: { type: 'string' }, mc: { type: 'string' }, loader: { type: 'string' }, 'loader-version': { type: 'string' }, name: { type: 'string' }, changelog: { type: 'string' } },
});
const dir = positionals[0];
if (!dir) {
  console.error('Использование: node tools/make-pack.mjs <папка> --version X --mc 1.21.11 --loader fabric');
  process.exit(1);
}

const filesDir = path.join(dir, 'files');
const out = path.join(dir, 'pack.json');
const prev = (await readJson(out)) ?? {};

const files = [];
for (const entry of await fs.readdir(filesDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const full = path.join(entry.parentPath, entry.name);
  const rel = path.relative(filesDir, full).split(path.sep).join('/');
  const data = await fs.readFile(full);
  const sha1 = (parts) => parts.reduce((h, p) => h.update(p), createHash('sha1')).digest('hex');
  // git — идентификатор файла в git: по нему веб-панель видит, что файл не менялся, и не перекачивает его
  const file = { path: rel, sha1: sha1([data]), size: data.length, git: sha1([`blob ${data.length}\0`, data]) };
  // Настройки игрок меняет под себя — ставим один раз и больше не перезаписываем
  if (rel.startsWith('config/') || rel === 'options.txt' || rel === 'servers.dat') file.overwrite = false;
  files.push(file);
}

const loaderType = opt.loader ?? prev.loader?.type;
const pack = {
  name: opt.name ?? prev.name ?? 'SHIZOSTAN',
  version: opt.version ?? prev.version,
  minecraft: opt.mc ?? prev.minecraft,
  loader: loaderType && loaderType !== 'vanilla' ? { type: loaderType, version: opt['loader-version'] ?? prev.loader?.version ?? '' } : null,
  changelog: opt.changelog ?? prev.changelog ?? '',
  history: prev.history ?? [],
  files: files.sort((a, b) => a.path.localeCompare(b.path)),
};
if (!pack.version || !pack.minecraft) {
  console.error('Нужны --version и --mc (в первый раз; дальше берутся из старого pack.json)');
  process.exit(1);
}
// История для блока «Что нового» в лаунчере: новая версия добавляется сверху, повторный запуск правит верхнюю запись
const entry = { version: pack.version, date: new Date().toISOString().slice(0, 10), changelog: pack.changelog };
pack.history = [entry, ...pack.history.filter((h) => h.version !== pack.version)].slice(0, 30);
await writeJson(out, pack);
console.log(`${out}: версия ${pack.version}, файлов ${files.length}, ${(files.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(1)} МБ`);
