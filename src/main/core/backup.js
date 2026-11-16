// Резервные копии миров и настроек экземпляра: backups/<id>/<время>/ + meta.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { gameDir } from './instances.js';

// Что игроку жалко потерять. Моды и файлы игры сюда не входят — их лаунчер скачает заново.
export const ITEMS = ['saves', 'config', 'options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat', 'resourcepacks', 'shaderpacks'];
const KEEP = 5;

const dirOf = (root, id) => path.join(root, 'backups', path.basename(id));
const exists = (p) => fs.access(p).then(() => true, () => false);

export async function makeBackup(root, id, label, now = Date.now()) {
  const src = gameDir(root, id);
  const items = [];
  for (const item of ITEMS) if (await exists(path.join(src, item))) items.push(item);
  if (!items.length) return null; // нечего сохранять — ещё ни разу не играли
  const name = new Date(now).toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dirOf(root, id), name);
  await fs.mkdir(dest, { recursive: true });
  for (const item of items) await fs.cp(path.join(src, item), path.join(dest, item), { recursive: true });
  await fs.writeFile(path.join(dest, 'meta.json'), JSON.stringify({ label, at: now, items }));
  // Старые копии удаляем, чтобы не съесть диск: оставляем последние KEEP
  const all = await listBackups(root, id);
  for (const old of all.slice(KEEP)) await fs.rm(path.join(dirOf(root, id), old.name), { recursive: true, force: true });
  return name;
}

export async function listBackups(root, id) {
  const dir = dirOf(root, id);
  const out = [];
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const meta = await fs.readFile(path.join(dir, name, 'meta.json'), 'utf8').then(JSON.parse, () => null);
    if (meta) out.push({ name, ...meta });
  }
  return out.sort((a, b) => b.at - a.at);
}

// Возвращает миры и настройки к состоянию копии. Перед этим сохраняет текущее — чтобы откат можно было отменить.
export async function restoreBackup(root, id, name) {
  if (path.basename(name) !== name) throw new Error('Некорректная копия');
  const src = path.join(dirOf(root, id), name);
  const meta = JSON.parse(await fs.readFile(path.join(src, 'meta.json'), 'utf8'));
  await makeBackup(root, id, 'перед восстановлением');
  const dest = gameDir(root, id);
  for (const item of meta.items) {
    await fs.rm(path.join(dest, item), { recursive: true, force: true });
    await fs.cp(path.join(src, item), path.join(dest, item), { recursive: true });
  }
  return meta;
}
