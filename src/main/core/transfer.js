// Перенос сборок целиком: импорт экземпляров других лаунчеров и архивов (.mrpack, CurseForge .zip, Prism .zip),
// экспорт в .mrpack (Modrinth) и .zip для Prism/MultiMC.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInstance, gameDir, getInstance, removeInstance } from './instances.js';
import { postJson, rawFetch, readJson, safeJoin, unzip, zipFiles } from './net.js';

const exists = (p) => fs.access(p).then(() => true, () => false);
const subdirs = async (dir) => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);
// Что переносим из папки игры: моды, настройки, миры, ресурсы. Кэши, логи и сама игра скачаются заново.
const COPY = ['mods', 'config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots', 'schematics', 'options.txt', 'optionsof.txt', 'servers.dat'];
const LOADERS = ['fabric', 'quilt', 'neoforge', 'forge'];

// «fabric-0.16.9-1.21.1», «forge-47.2.0», «forge-1.20.1-47.2.0», «neoforge-21.1.77» -> { type, version }
export function parseLoader(s) {
  const m = String(s ?? '').toLowerCase().match(/^(fabric|quilt|neoforge|forge)[-_]?(.*)$/);
  if (!m) return null;
  const parts = m[2].split('-').filter(Boolean);
  // У Forge версия игры бывает впереди: forge-1.20.1-47.2.0; у Fabric — сзади: fabric-0.16.9-1.21.1
  const version = m[1] === 'forge' && parts.length > 1 ? parts[parts.length - 1] : parts[0];
  return { type: m[1], version: version || null };
}

const PRISM_UID = { 'net.fabricmc.fabric-loader': 'fabric', 'org.quiltmc.quilt-loader': 'quilt', 'net.neoforged': 'neoforge', 'net.minecraftforge': 'forge' };

// Описание одного экземпляра в папке dir по формату лаунчера -> { name, mc, loader, game } | null
async function readPrism(dir) {
  const pack = await readJson(path.join(dir, 'mmc-pack.json'));
  if (!pack?.components) return null;
  const mc = pack.components.find((c) => c.uid === 'net.minecraft')?.version;
  const l = pack.components.find((c) => PRISM_UID[c.uid]);
  const cfg = await fs.readFile(path.join(dir, 'instance.cfg'), 'utf8').catch(() => '');
  const name = cfg.match(/^name=(.*)$/m)?.[1]?.trim() || path.basename(dir);
  const game = (await exists(path.join(dir, '.minecraft'))) ? path.join(dir, '.minecraft') : path.join(dir, 'minecraft');
  return mc ? { name, mc, loader: l ? { type: PRISM_UID[l.uid], version: l.version ?? null } : null, game } : null;
}
async function readCurseForge(dir) {
  const j = await readJson(path.join(dir, 'minecraftinstance.json'));
  return j?.gameVersion ? { name: j.name || path.basename(dir), mc: j.gameVersion, loader: parseLoader(j.baseModLoader?.name), game: dir } : null;
}
async function readAtl(dir) {
  const j = await readJson(path.join(dir, 'instance.json'));
  const mc = j?.id ?? j?.minecraftVersion;
  if (!mc || !j.launcher) return null;
  const lv = j.launcher.loaderVersion;
  return { name: j.launcher.name || path.basename(dir), mc, loader: lv?.type ? { type: lv.type.toLowerCase(), version: lv.version ?? null } : null, game: dir };
}
async function readModrinthApp(dir) {
  const j = await readJson(path.join(dir, 'profile.json'));
  const m = j?.metadata;
  return m?.game_version ? { name: m.name || path.basename(dir), mc: m.game_version, loader: LOADERS.includes(m.loader) ? { type: m.loader, version: m.loader_version?.id ?? null } : null, game: dir } : null;
}
async function readFtb(dir) {
  const j = await readJson(path.join(dir, 'instance.json'));
  return j?.mcVersion ? { name: j.name || path.basename(dir), mc: j.mcVersion, loader: parseLoader(j.modLoader), game: dir } : null;
}
async function readTechnic(dir) {
  // Technic держит профиль загрузчика в bin/version.json (формат официального лаунчера)
  const v = await readJson(path.join(dir, 'bin', 'version.json'));
  if (!v?.id) return null;
  const mc = v.inheritsFrom ?? v.id.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
  const forge = (v.libraries ?? []).map((l) => l.name ?? '').find((n) => /^net\.minecraftforge:(forge|minecraftforge)/.test(n));
  const fabric = (v.libraries ?? []).map((l) => l.name ?? '').find((n) => n.startsWith('net.fabricmc:fabric-loader:'));
  const loader = forge ? { type: 'forge', version: forge.split(':')[2].split('-').pop() } : fabric ? { type: 'fabric', version: fabric.split(':')[2] } : null;
  return mc ? { name: path.basename(dir), mc, loader, game: dir } : null;
}

export function launcherDirs(env = process.env, home = os.homedir()) {
  const appData = env.APPDATA ?? '';
  const local = env.LOCALAPPDATA ?? '';
  return [
    { launcher: 'Prism Launcher', dir: path.join(appData, 'PrismLauncher', 'instances'), read: readPrism },
    { launcher: 'MultiMC', dir: path.join(home, 'MultiMC', 'instances'), read: readPrism },
    { launcher: 'FreesmLauncher', dir: path.join(appData, 'FreesmLauncher', 'instances'), read: readPrism },
    { launcher: 'ATLauncher', dir: path.join(appData, 'ATLauncher', 'instances'), read: readAtl },
    { launcher: 'CurseForge', dir: path.join(home, 'curseforge', 'minecraft', 'Instances'), read: readCurseForge },
    { launcher: 'FTB App', dir: path.join(local, '.ftba', 'instances'), read: readFtb },
    { launcher: 'Modrinth App', dir: path.join(appData, 'ModrinthApp', 'profiles'), read: readModrinthApp },
    { launcher: 'Technic', dir: path.join(appData, '.technic', 'modpacks'), read: readTechnic },
  ];
}

// -> [{ launcher, name, mc, loader, game, mods }] — сборки других лаунчеров, которые можно перенести целиком
export async function findInstances(list = launcherDirs()) {
  const out = [];
  for (const l of list) {
    for (const name of await subdirs(l.dir)) {
      const info = await l.read(path.join(l.dir, name)).catch(() => null);
      if (!info) continue;
      const mods = (await fs.readdir(path.join(info.game, 'mods')).catch(() => [])).filter((f) => f.endsWith('.jar')).length;
      out.push({ launcher: l.launcher, ...info, mods });
    }
  }
  return out;
}

async function copyGame(src, dest, onProgress) {
  await fs.mkdir(dest, { recursive: true });
  for (const [n, item] of COPY.entries()) {
    onProgress?.({ label: `Переношу ${item}`, files: n, totalFiles: COPY.length, bytes: 0, totalBytes: 0 });
    if (await exists(path.join(src, item))) await fs.cp(path.join(src, item), path.join(dest, item), { recursive: true, force: false, errorOnExist: false });
  }
}

// Новый экземпляр из сборки другого лаунчера. Версию загрузчика берём ту же, что была там.
export async function importInstance(root, src, { onProgress } = {}) {
  if (src.loader && !LOADERS.includes(src.loader.type)) throw new Error(`Загрузчик ${src.loader.type} не поддерживается`);
  const inst = await createInstance(root, { name: src.name, mc: src.mc, loader: src.loader, importedFrom: src.launcher });
  try {
    await copyGame(src.game, gameDir(root, inst.id), onProgress);
    return inst;
  } catch (e) {
    await removeInstance(root, inst.id);
    throw e;
  }
}

// CurseForge отдаёт файл по ссылке сайта без ключа API; имя файла узнаём из конечного адреса после переадресации
async function curseDownload(projectID, fileID, dir, signal) {
  const res = await rawFetch(`https://www.curseforge.com/api/v1/mods/${projectID}/files/${fileID}/download`, { signal });
  if (!res.ok) throw new Error(`${res.status}`);
  const name = decodeURIComponent(new URL(res.url).pathname.split('/').pop() || `${projectID}-${fileID}.jar`);
  await fs.writeFile(safeJoin(dir, path.basename(name)), Buffer.from(await res.arrayBuffer()));
}

// Архив сборки: CurseForge (.zip с manifest.json) или Prism/MultiMC (.zip с mmc-pack.json).
// .mrpack ставит modrinth.installMrpack. -> { inst, failed: [] } — failed: моды CurseForge, которые не скачались
export async function importArchive(root, file, { signal, onProgress } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shizo-import-'));
  let inst;
  try {
    await unzip(file, tmp);
    // Prism кладёт экземпляр в папку внутри архива
    const top = (await exists(path.join(tmp, 'mmc-pack.json'))) || (await exists(path.join(tmp, 'manifest.json'))) ? tmp : path.join(tmp, (await subdirs(tmp))[0] ?? '');
    const prism = await readPrism(top).catch(() => null);
    if (prism) {
      inst = await createInstance(root, { name: prism.name, mc: prism.mc, loader: prism.loader, importedFrom: 'Prism/MultiMC' });
      await copyGame(prism.game, gameDir(root, inst.id), onProgress);
      return { inst, failed: [] };
    }
    const m = await readJson(path.join(top, 'manifest.json'));
    if (!m?.minecraft?.version || !Array.isArray(m.files)) throw new Error('Не понял формат архива: нужен модпак CurseForge, экспорт Prism/MultiMC или .mrpack');
    const primary = m.minecraft.modLoaders?.find((l) => l.primary) ?? m.minecraft.modLoaders?.[0];
    inst = await createInstance(root, { name: m.name || 'Модпак CurseForge', mc: m.minecraft.version, loader: parseLoader(primary?.id), importedFrom: 'CurseForge' });
    const dir = gameDir(root, inst.id);
    await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
    const failed = [];
    const files = m.files.filter((f) => f.required !== false);
    for (const [n, f] of files.entries()) {
      onProgress?.({ label: 'Моды CurseForge', files: n, totalFiles: files.length, bytes: 0, totalBytes: 0 });
      await curseDownload(f.projectID, f.fileID, path.join(dir, 'mods'), signal).catch((e) => {
        if (signal?.aborted) throw e;
        failed.push(`${f.projectID}/${f.fileID}`);
      });
    }
    await fs.cp(path.join(top, m.overrides || 'overrides'), dir, { recursive: true }).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    return { inst, failed };
  } catch (e) {
    if (inst) await removeInstance(root, inst.id);
    throw e;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const hashFile = async (file, algo) => createHash(algo).update(await fs.readFile(file)).digest('hex');
const MRPACK_LOADER = { fabric: 'fabric-loader', quilt: 'quilt-loader', neoforge: 'neoforge', forge: 'forge' };

// Экспорт в .mrpack: моды, ресурспаки и шейдеры, которые есть на Modrinth, — ссылками, остальное и настройки — внутри архива.
// withWorlds — положить и миры. -> { file, linked, packed }
export async function exportMrpack(root, id, out, { withWorlds = false, api = 'https://api.modrinth.com/v2' } = {}) {
  const inst = await getInstance(root, id);
  if (!inst) throw new Error('Экземпляр не найден');
  const dir = gameDir(root, id);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shizo-export-'));
  try {
    const content = [];
    for (const kind of ['mods', 'resourcepacks', 'shaderpacks']) {
      for (const f of await fs.readdir(path.join(dir, kind)).catch(() => [])) {
        const full = path.join(dir, kind, f);
        if ((await fs.stat(full)).isFile() && !f.endsWith('.disabled')) content.push({ path: `${kind}/${f}`, full, sha1: await hashFile(full, 'sha1') });
      }
    }
    const known = content.length ? await postJson(`${api}/version_files`, { hashes: content.map((c) => c.sha1), algorithm: 'sha1' }).catch(() => ({})) : {};
    const files = [];
    await fs.mkdir(path.join(tmp, 'overrides'), { recursive: true });
    for (const c of content) {
      const file = known[c.sha1]?.files?.find((x) => x.hashes.sha1 === c.sha1);
      if (file) {
        files.push({ path: c.path, hashes: { sha1: c.sha1, sha512: await hashFile(c.full, 'sha512') }, env: { client: 'required', server: c.path.startsWith('mods/') ? 'optional' : 'unsupported' }, downloads: [file.url], fileSize: file.size });
      } else {
        await fs.mkdir(path.join(tmp, 'overrides', path.dirname(c.path)), { recursive: true });
        await fs.copyFile(c.full, path.join(tmp, 'overrides', c.path));
      }
    }
    for (const item of ['config', 'defaultconfigs', 'kubejs', 'options.txt', 'servers.dat', ...(withWorlds ? ['saves'] : [])]) {
      if (await exists(path.join(dir, item))) await fs.cp(path.join(dir, item), path.join(tmp, 'overrides', item), { recursive: true });
    }
    const dependencies = { minecraft: inst.mc, ...(inst.loader && { [MRPACK_LOADER[inst.loader.type]]: inst.loader.version }) };
    await fs.writeFile(path.join(tmp, 'modrinth.index.json'), JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: inst.name, summary: 'Экспорт из ShizoLauncher', files, dependencies }, null, 2));
    await fs.rm(out, { force: true });
    await zipFiles(out, tmp, ['modrinth.index.json', 'overrides']);
    return { file: out, linked: files.length, packed: content.length - files.length };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// Экспорт для Prism Launcher / MultiMC: экземпляр с папкой игры, Prism сам докачает игру и загрузчик
export async function exportPrism(root, id, out, { withWorlds = false } = {}) {
  const inst = await getInstance(root, id);
  if (!inst) throw new Error('Экземпляр не найден');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shizo-export-'));
  try {
    const uid = Object.entries(PRISM_UID).find(([, t]) => t === inst.loader?.type)?.[0];
    const components = [{ uid: 'net.minecraft', version: inst.mc, important: true }, ...(uid ? [{ uid, version: inst.loader.version }] : [])];
    await fs.writeFile(path.join(tmp, 'mmc-pack.json'), JSON.stringify({ formatVersion: 1, components }, null, 2));
    await fs.writeFile(path.join(tmp, 'instance.cfg'), `InstanceType=OneSix\nname=${inst.name.replace(/[\r\n]/g, ' ')}\n`);
    const src = gameDir(root, id);
    for (const item of COPY.filter((x) => withWorlds || x !== 'saves')) {
      if (await exists(path.join(src, item))) await fs.cp(path.join(src, item), path.join(tmp, '.minecraft', item), { recursive: true });
    }
    await fs.mkdir(path.join(tmp, '.minecraft'), { recursive: true });
    await fs.rm(out, { force: true });
    await zipFiles(out, tmp, ['instance.cfg', 'mmc-pack.json', '.minecraft']);
    return { file: out };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
