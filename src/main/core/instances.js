// Экземпляры: instances/<id>/instance.json + instances/<id>/.minecraft
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './net.js';

export const CONTENT_KINDS = ['mods', 'resourcepacks', 'shaderpacks'];

function dirOf(root, id) {
  if (!/^[a-z0-9-]{1,64}$/.test(id ?? '')) throw new Error('Некорректный id экземпляра');
  return path.join(root, 'instances', id);
}
export const gameDir = (root, id) => path.join(dirOf(root, id), '.minecraft');
const metaFile = (root, id) => path.join(dirOf(root, id), 'instance.json');

export const getInstance = (root, id) => readJson(metaFile(root, id));

export async function listInstances(root) {
  const ids = await fs.readdir(path.join(root, 'instances')).catch(() => []);
  const all = await Promise.all(ids.map((id) => getInstance(root, id).catch(() => null)));
  return all.filter(Boolean).sort((a, b) => (b.lastPlayed ?? b.created) - (a.lastPlayed ?? a.created));
}

export async function createInstance(root, { id, name, mc, loader = null, ...rest }) {
  name = String(name ?? '').trim();
  if (!name || !mc) throw new Error('Нужны название и версия Minecraft');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'instance';
  id ??= `${slug}-${randomBytes(2).toString('hex')}`;
  const inst = { ...rest, id, name, mc, loader, created: Date.now() };
  await fs.mkdir(gameDir(root, id), { recursive: true });
  await writeJson(metaFile(root, id), inst);
  return inst;
}

export async function updateInstance(root, id, patch) {
  const inst = await getInstance(root, id);
  if (!inst) throw new Error('Экземпляр не найден');
  const next = { ...inst, ...patch, id };
  await writeJson(metaFile(root, id), next);
  return next;
}

export const removeInstance = (root, id) => fs.rm(dirOf(root, id), { recursive: true, force: true });

function contentDir(root, id, kind) {
  if (!CONTENT_KINDS.includes(kind)) throw new Error('Неизвестный тип содержимого');
  return path.join(gameDir(root, id), kind);
}
function contentFile(root, id, kind, file) {
  if (typeof file !== 'string' || path.basename(file) !== file) throw new Error('Некорректное имя файла');
  return path.join(contentDir(root, id, kind), file);
}

export async function listContent(root, id, kind) {
  const dir = contentDir(root, id, kind);
  const names = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const d of names) {
    if (d.isDirectory() && kind === 'mods') continue;
    const st = await fs.stat(path.join(dir, d.name));
    out.push({ file: d.name, enabled: !d.name.endsWith('.disabled'), size: st.size });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export async function toggleContent(root, id, kind, file) {
  const from = contentFile(root, id, kind, file);
  await fs.rename(from, file.endsWith('.disabled') ? from.slice(0, -'.disabled'.length) : from + '.disabled');
}

export const removeContent = (root, id, kind, file) => fs.rm(contentFile(root, id, kind, file), { force: true });

// Скриншоты: только картинки из папки screenshots экземпляра, имя файла без путей
export function screenshotFile(root, id, file) {
  if (typeof file !== 'string' || path.basename(file) !== file || !/\.(png|jpe?g)$/i.test(file)) throw new Error('Некорректное имя скриншота');
  return path.join(gameDir(root, id), 'screenshots', file);
}

export async function listScreenshots(root, id) {
  const dir = path.join(gameDir(root, id), 'screenshots');
  const out = [];
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!/\.(png|jpe?g)$/i.test(name)) continue;
    const st = await fs.stat(path.join(dir, name));
    out.push({ file: name, size: st.size, time: st.mtimeMs });
  }
  return out.sort((a, b) => b.time - a.time);
}

// Своя иконка экземпляра: копия картинки рядом с instance.json
export async function setIcon(root, id, file) {
  const inst = await getInstance(root, id);
  if (!inst) throw new Error('Экземпляр не найден');
  for (const old of (await fs.readdir(dirOf(root, id))).filter((f) => f.startsWith('icon.'))) await fs.rm(path.join(dirOf(root, id), old));
  if (!file) return updateInstance(root, id, { icon: null });
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) throw new Error('Нужна картинка PNG, JPG, WebP или GIF');
  if ((await fs.stat(file)).size > 5 * 1024 * 1024) throw new Error('Картинка больше 5 МБ');
  await fs.copyFile(file, path.join(dirOf(root, id), `icon${ext}`));
  return updateInstance(root, id, { icon: `icon${ext}?v=${Date.now()}` });
}
export function iconFile(root, id, file) {
  if (!/^icon\.(png|jpe?g|webp|gif)$/.test(file ?? '')) throw new Error('Некорректная иконка');
  return path.join(dirOf(root, id), file);
}

// Сводка для вкладки «Обзор»: что лежит в папке игры
export async function instanceStats(root, id) {
  const dir = gameDir(root, id);
  const count = async (sub, test) => (await fs.readdir(path.join(dir, sub), { withFileTypes: true }).catch(() => [])).filter(test).length;
  const mods = (await listContent(root, id, 'mods')).filter((m) => m.file.endsWith('.jar') || m.file.endsWith('.jar.disabled'));
  async function size(p) {
    const st = await fs.lstat(p).catch(() => null);
    if (!st) return 0;
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of await fs.readdir(p)) total += await size(path.join(p, e));
    return total;
  }
  return {
    mods: mods.length,
    modsOff: mods.filter((m) => !m.enabled).length,
    worlds: await count('saves', (d) => d.isDirectory()),
    shots: await count('screenshots', (d) => /\.(png|jpe?g)$/i.test(d.name)),
    packs: await count('resourcepacks', () => true),
    shaders: await count('shaderpacks', () => true),
    bytes: await size(dir),
  };
}
