// Режим слабого ПК: моды оптимизации с Modrinth + облегчённые настройки графики. Выключение возвращает всё как было.
import fs from 'node:fs/promises';
import path from 'node:path';
import { gameDir, getInstance, listContent, updateInstance } from './instances.js';
import { fetchJson } from './net.js';

const API = 'https://api.modrinth.com/v2';
// Только клиентские моды, которые не меняют игру и не мешают заходить на серверы
export const OPT_MODS = ['sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix', 'dynamic-fps'];
// Ключи options.txt версии 1.21: дальность 6 чанков, быстрая графика, минимум частиц, без теней, облаков и сглаживания биомов
export const LOW_OPTIONS = { renderDistance: '6', simulationDistance: '5', graphicsMode: '0', particles: '2', entityShadows: 'false', biomeBlendRadius: '0', mipmapLevels: '0', renderClouds: '"false"', entityDistanceScaling: '0.75' };

export function readOptions(text) {
  return new Map(text.split(/\r?\n/).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]));
}
const writeOptions = (map) => [...map].map(([k, v]) => `${k}:${v}`).join('\n') + '\n';

// install(projectId) -> имена поставленных файлов; installed — id проектов Modrinth, которые уже стоят (опознаны по хешу)
export async function enableLowEnd(root, id, { install, installed = new Set() }, api = API) {
  const inst = await getInstance(root, id);
  if (inst.lowEnd) return inst.lowEnd;
  const file = path.join(gameDir(root, id), 'options.txt');
  const opts = readOptions(await fs.readFile(file, 'utf8').catch(() => ''));
  const prev = Object.fromEntries(Object.keys(LOW_OPTIONS).map((k) => [k, opts.get(k) ?? null]));
  for (const [k, v] of Object.entries(LOW_OPTIONS)) opts.set(k, v);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, writeOptions(opts));

  // Ставим только то, чего ещё нет, и запоминаем, что поставили сами — убирать будем только это
  const before = new Set((await listContent(root, id, 'mods')).map((m) => m.file.replace(/\.disabled$/, '')));
  const projects = inst.loader ? await fetchJson(`${api}/projects?ids=${encodeURIComponent(JSON.stringify(OPT_MODS))}`).catch(() => []) : [];
  const added = [];
  const skipped = [];
  for (const p of projects) {
    if (installed.has(p.id)) continue;
    try {
      for (const f of await install(p.id)) if (!before.has(f) && !added.includes(f)) added.push(f); // общие зависимости (Fabric API) — один раз
    } catch {
      skipped.push(p.title); // нет версии под эту игру/загрузчик — просто пропускаем
    }
  }
  const lowEnd = { prev, added, skipped, at: Date.now() };
  await updateInstance(root, id, { lowEnd });
  return lowEnd;
}

export async function disableLowEnd(root, id) {
  const inst = await getInstance(root, id);
  if (!inst.lowEnd) return;
  const dir = gameDir(root, id);
  const file = path.join(dir, 'options.txt');
  const opts = readOptions(await fs.readFile(file, 'utf8').catch(() => ''));
  for (const [k, v] of Object.entries(inst.lowEnd.prev)) v === null ? opts.delete(k) : opts.set(k, v);
  await fs.writeFile(file, writeOptions(opts));
  for (const f of inst.lowEnd.added) {
    await fs.rm(path.join(dir, 'mods', f), { force: true });
    await fs.rm(path.join(dir, 'mods', `${f}.disabled`), { force: true });
  }
  await updateInstance(root, id, { lowEnd: null });
}
