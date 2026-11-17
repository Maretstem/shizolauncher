// Modrinth: поиск и установка модов/ресурспаков/шейдеров, установка модпаков (.mrpack).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInstance, gameDir, getInstance, listContent, removeInstance } from './instances.js';
import { downloadAll, fetchJson, postJson, readJson, safeJoin, sha1File, unzip } from './net.js';

const API = 'https://api.modrinth.com/v2';
const FOLDER = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
// Спецификация mrpack разрешает загрузки только с этих хостов
const MRPACK_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
const q = (v) => encodeURIComponent(JSON.stringify(v));

const SORTS = ['relevance', 'downloads', 'follows', 'newest', 'updated'];

export async function search({ query = '', type = 'mod', mc, loader, offset = 0, sort = 'relevance', category = '' }) {
  const facets = [[`project_type:${type}`]];
  if (mc) facets.push([`versions:${mc}`]);
  if (loader && type === 'mod') facets.push([`categories:${loader}`]);
  if (/^[a-z0-9-]+$/.test(category)) facets.push([`categories:${category}`]);
  const index = SORTS.includes(sort) ? sort : 'relevance';
  const r = await fetchJson(`${API}/search?limit=30&offset=${Number(offset) || 0}&index=${index}&query=${encodeURIComponent(query)}&facets=${q(facets)}`);
  return r.hits.map((h) => ({ id: h.project_id, title: h.title, description: h.description, icon: h.icon_url, downloads: h.downloads, author: h.author, type: h.project_type }));
}

async function latestVersion(projectId, mc, loader, type) {
  const filters = [mc && `game_versions=${q([mc])}`, type === 'mod' && loader && `loaders=${q([loader])}`].filter(Boolean).join('&');
  const [version] = await fetchJson(`${API}/project/${encodeURIComponent(projectId)}/version?${filters}`);
  return version;
}

// Ставит проект и его обязательные зависимости в экземпляр. Возвращает имена установленных файлов.
export async function installProject(root, instanceId, projectId, type = 'mod', opts = {}, seen = new Set()) {
  if (seen.has(projectId)) return [];
  seen.add(projectId);
  if (!FOLDER[type]) throw new Error('Этот тип проекта нельзя поставить в экземпляр');
  const inst = await getInstance(root, instanceId);
  if (!inst) throw new Error('Экземпляр не найден');
  const version = await latestVersion(projectId, inst.mc, inst.loader?.type, type);
  if (!version) throw new Error(`Нет версии под Minecraft ${inst.mc}${type === 'mod' ? ` (${inst.loader?.type ?? 'без загрузчика'})` : ''}`);
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  const dest = safeJoin(path.join(gameDir(root, instanceId), FOLDER[type]), path.basename(file.filename));
  await downloadAll([{ dest, url: file.url, sha1: file.hashes.sha1, size: file.size }], opts);
  const done = [file.filename];
  for (const dep of version.dependencies ?? []) {
    if (dep.dependency_type === 'required' && dep.project_id) done.push(...(await installProject(root, instanceId, dep.project_id, 'mod', opts, seen)));
  }
  return done;
}

// Шейдеры работают через мод-загрузчик шейдеров: Iris (Fabric, Quilt, NeoForge) или Oculus (Forge).
// Если его нет — ставим вместе с шейдером. -> имя проекта, который пришлось доставить, или null
export async function ensureShaderLoader(root, instanceId, opts = {}) {
  const inst = await getInstance(root, instanceId);
  const type = inst?.loader?.type;
  if (!type) throw new Error('Шейдерам нужен загрузчик модов: создай экземпляр с Fabric, NeoForge или Forge');
  const project = type === 'forge' ? 'oculus' : 'iris';
  const mods = await listContent(root, instanceId, 'mods');
  if (mods.some((m) => new RegExp(`^${project}`, 'i').test(m.file))) return null;
  await installProject(root, instanceId, project, 'mod', opts);
  return project === 'iris' ? 'Iris' : 'Oculus';
}

// Очередь: ставит проекты по одному (зависимости — сами), ошибки одного не мешают остальным.
// items: [{ projectId, type, title }] -> { done: [title], failed: [{ title, error }], extra: [имена доставленных модов] }
export async function installMany(root, instanceId, items, opts = {}) {
  const out = { done: [], failed: [], extra: [] };
  const seen = new Set();
  for (const [n, it] of items.entries()) {
    opts.onProgress?.({ label: `Очередь: ${it.title ?? it.projectId}`, files: n, totalFiles: items.length, bytes: 0, totalBytes: 0 });
    try {
      if (it.type === 'shader') {
        const extra = await ensureShaderLoader(root, instanceId, opts);
        if (extra && !out.extra.includes(extra)) out.extra.push(extra);
      }
      await installProject(root, instanceId, it.projectId, it.type, { signal: opts.signal }, seen);
      out.done.push(it.title ?? it.projectId);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      out.failed.push({ title: it.title ?? it.projectId, error: e.message });
    }
  }
  return out;
}

// id мода из его файла (fabric.mod.json) -> проект на Modrinth. Чаще всего slug совпадает с id;
// иначе ищем по id среди модов под эту версию игры и загрузчик.
export async function findProjectByModId(modId, mc, loader, api = API) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const direct = await fetchJson(`${api}/project/${encodeURIComponent(modId)}`).catch(() => null);
  if (direct?.project_type === 'mod') return direct.id;
  const facets = [['project_type:mod'], ...(mc ? [[`versions:${mc}`]] : []), ...(loader ? [[`categories:${loader}`]] : [])];
  const r = await fetchJson(`${api}/search?limit=10&query=${encodeURIComponent(modId)}&facets=${q(facets)}`).catch(() => null);
  const hit = r?.hits?.find((h) => [h.slug, h.title].some((x) => norm(x) === norm(modId) || norm(x).replace(/lib$|api$/, '') === norm(modId)));
  return hit?.project_id ?? null;
}

// Опознаёт моды экземпляра по хешу файла (не важно, кто их положил) и узнаёт, есть ли версии новее.
// -> [{ file, enabled, size, projectId?, title?, update?: { version, filename, url, sha1, size } }]
export async function contentInfo(root, instanceId, api = API) {
  const inst = await getInstance(root, instanceId);
  if (!inst) throw new Error('Экземпляр не найден');
  const dir = path.join(gameDir(root, instanceId), 'mods');
  const files = await listContent(root, instanceId, 'mods');
  for (const f of files) f.sha1 = await sha1File(path.join(dir, f.file));
  const hashes = files.map((f) => f.sha1);
  if (!hashes.length) return [];
  const known = await postJson(`${api}/version_files`, { hashes, algorithm: 'sha1' });
  const latest = inst.loader?.type
    ? await postJson(`${api}/version_files/update`, { hashes, algorithm: 'sha1', loaders: [inst.loader.type], game_versions: [inst.mc] }).catch(() => ({}))
    : {};
  return files.map((f) => {
    const cur = known[f.sha1];
    const next = latest[f.sha1];
    const file = next?.files.find((x) => x.primary) ?? next?.files[0];
    const newer = cur && next && next.id !== cur.id && file && new Date(next.date_published) > new Date(cur.date_published);
    return { file: f.file, enabled: f.enabled, size: f.size, projectId: cur?.project_id, version: cur?.version_number,
      update: newer ? { version: next.version_number, filename: path.basename(file.filename), url: file.url, sha1: file.hashes.sha1, size: file.size } : undefined };
  });
}

// Обновляет моды (все или только названные файлы): сначала качает новый файл, потом убирает старый. Возвращает число обновлённых.
export async function updateContent(root, instanceId, only, opts = {}, api = API) {
  const dir = path.join(gameDir(root, instanceId), 'mods');
  const todo = (await contentInfo(root, instanceId, api)).filter((m) => m.update && (!only || only.includes(m.file)));
  await downloadAll(todo.map((m) => ({ dest: safeJoin(dir, m.update.filename + (m.enabled ? '' : '.disabled')), url: m.update.url, sha1: m.update.sha1, size: m.update.size })),
    { ...opts, onProgress: (p) => opts.onProgress?.({ ...p, label: 'Обновление модов' }) });
  for (const m of todo) if (m.file.replace(/\.disabled$/, '') !== m.update.filename) await fs.rm(path.join(dir, m.file), { force: true });
  return todo.length;
}

export async function installModpackProject(root, projectId, opts = {}) {
  const [version] = await fetchJson(`${API}/project/${encodeURIComponent(projectId)}/version`);
  const file = version?.files.find((f) => f.primary) ?? version?.files[0];
  if (!file) throw new Error('У модпака нет файлов');
  const tmp = path.join(os.tmpdir(), `shizo-${Date.now()}.mrpack`);
  try {
    await downloadAll([{ dest: tmp, url: file.url, sha1: file.hashes.sha1, size: file.size }], { ...opts, onProgress: (p) => opts.onProgress?.({ ...p, label: 'Модпак' }) });
    return await installMrpack(root, tmp, opts);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export function mrpackLoader(dependencies) {
  if (dependencies['fabric-loader']) return { type: 'fabric', version: dependencies['fabric-loader'] };
  if (dependencies['quilt-loader']) return { type: 'quilt', version: dependencies['quilt-loader'] };
  if (dependencies.neoforge) return { type: 'neoforge', version: dependencies.neoforge };
  if (dependencies.forge) return { type: 'forge', version: dependencies.forge };
  return null;
}

export async function installMrpack(root, mrpackFile, { signal, onProgress } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shizo-mrpack-'));
  let inst;
  try {
    await unzip(mrpackFile, tmp);
    const index = await readJson(path.join(tmp, 'modrinth.index.json'));
    if (!index?.dependencies?.minecraft || !Array.isArray(index.files)) throw new Error('Это не модпак Modrinth (.mrpack)');
    inst = await createInstance(root, { name: index.name ?? 'Модпак', mc: index.dependencies.minecraft, loader: mrpackLoader(index.dependencies) });
    const dir = gameDir(root, inst.id);
    const tasks = index.files
      .filter((f) => f.env?.client !== 'unsupported')
      .map((f) => {
        const url = new URL(f.downloads[0]);
        if (url.protocol !== 'https:' || !MRPACK_HOSTS.includes(url.hostname)) throw new Error(`Модпак качает с недоверенного адреса: ${url.hostname}`);
        return { dest: safeJoin(dir, f.path), url: url.href, sha1: f.hashes.sha1, size: f.fileSize };
      });
    await downloadAll(tasks, { signal, onProgress: (p) => onProgress?.({ ...p, label: 'Файлы модпака' }) });
    for (const overrides of ['overrides', 'client-overrides']) {
      await fs.cp(path.join(tmp, overrides), dir, { recursive: true }).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
    return inst;
  } catch (e) {
    if (inst) await removeInstance(root, inst.id); // не оставляем полуустановленный экземпляр
    throw e;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
