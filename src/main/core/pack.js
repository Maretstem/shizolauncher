// Сборка сервера: pack.json на хостинге -> проверка версии -> докачка изменённых файлов -> удаление убранных.
//
// pack.json: { name, version, minecraft, loader: { type: "fabric", version }, changelog?,
//              files: [{ path, sha1, size, url?, overwrite? }] }
// url по умолчанию — files/<path> рядом с pack.json. overwrite:false — качать только если файла нет (конфиги).
import fs from 'node:fs/promises';
import { createInstance, gameDir, getInstance, updateInstance } from './instances.js';
import { downloadAll, fetchJson, httpsUrl, safeJoin } from './net.js';

export const PACK_ID = 'shizostan';

export async function fetchPack(url) {
  const m = await fetchJson(httpsUrl(url), { cache: 'no-store' });
  if (typeof m?.version !== 'string' || typeof m.minecraft !== 'string' || !Array.isArray(m.files)) {
    throw new Error('pack.json повреждён: нужны поля version, minecraft, files');
  }
  return m;
}

export function packTasks(manifest, manifestUrl, dir) {
  return manifest.files.map((f) => ({
    dest: safeJoin(dir, f.path),
    url: httpsUrl(f.url ?? `files/${f.path.split('/').map(encodeURIComponent).join('/')}`, manifestUrl),
    sha1: f.sha1,
    size: f.size,
    keep: f.overwrite === false,
  }));
}

// Файлы прошлой версии сборки, которых нет в новой. Чужие файлы (моды игрока, миры, настройки) не трогаем.
export function staleFiles(previous = [], manifest) {
  const now = new Set(manifest.files.map((f) => f.path));
  return previous.filter((p) => !now.has(p));
}

export async function packStatus(root, url) {
  const installed = (await getInstance(root, PACK_ID))?.pack?.version ?? null;
  if (!url) return { installed, configured: false };
  try {
    const m = await fetchPack(url);
    return { installed, configured: true, latest: m.version, minecraft: m.minecraft, loader: m.loader ?? null, changelog: m.changelog ?? '', history: Array.isArray(m.history) ? m.history : [], updateAvailable: installed !== m.version };
  } catch (e) {
    return { installed, configured: true, error: e.message };
  }
}

export async function syncPack(root, url, { signal, onProgress } = {}) {
  const m = await fetchPack(url);
  const meta = { name: m.name ?? 'SHIZOSTAN', mc: m.minecraft, loader: m.loader ?? null };
  const inst = (await getInstance(root, PACK_ID)) ?? (await createInstance(root, { id: PACK_ID, ...meta }));
  const dir = gameDir(root, PACK_ID);
  const restored = await downloadAll(packTasks(m, url, dir), { signal, onProgress: (p) => onProgress?.({ ...p, label: `Сборка ${m.version}` }) });
  for (const old of staleFiles(inst.pack?.files, m)) await fs.rm(safeJoin(dir, old), { force: true });
  return { ...(await updateInstance(root, PACK_ID, { ...meta, pack: { version: m.version, files: m.files.map((f) => f.path) } })), restored };
}
