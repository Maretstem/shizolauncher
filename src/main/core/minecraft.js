// Установка и запуск Minecraft: метаданные Mojang, Fabric/Quilt, библиотеки, ресурсы, Java, аргументы.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureForge, forgeVersions, isForge } from './forge.js';
import { downloadAll, fetchJson, readJson, unzip, writeJson } from './net.js';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const JAVA_URL = 'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const RESOURCES_URL = 'https://resources.download.minecraft.net';
const LOADER_META = { fabric: 'https://meta.fabricmc.net/v2', quilt: 'https://meta.quiltmc.org/v3' };
const JAVA_PLATFORM = {
  windows: { x64: 'windows-x64', x86: 'windows-x86', arm64: 'windows-arm64' },
  linux: { x64: 'linux', x86: 'linux-i386' },
  osx: { x64: 'mac-os', arm64: 'mac-os-arm64' },
};

export const OS = {
  name: { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform],
  arch: { x64: 'x64', ia32: 'x86', arm64: 'arm64' }[process.arch] ?? process.arch,
};

// Правила Mojang: последнее подходящее правило решает; без правил — разрешено.
export function allowed(rules, features = {}, os = OS) {
  if (!rules) return true;
  let ok = false;
  for (const r of rules) {
    if (r.os?.name && r.os.name !== os.name) continue;
    if (r.os?.arch && r.os.arch !== os.arch) continue;
    if (r.features && !Object.entries(r.features).every(([k, v]) => !!features[k] === v)) continue;
    ok = r.action === 'allow';
  }
  return ok;
}

// "group:artifact:version[:classifier][@ext]" -> путь в maven-репозитории
export function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
}

let manifestCache;
export async function versionList() {
  if (!manifestCache || Date.now() - manifestCache.at > 600_000) {
    manifestCache = { at: Date.now(), data: await fetchJson(MANIFEST_URL) };
  }
  return manifestCache.data;
}

export async function loaderVersions(type, mc) {
  if (isForge(type)) return forgeVersions(type, mc);
  if (!LOADER_META[type]) throw new Error(`Загрузчик не поддерживается: ${type}`);
  const list = await fetchJson(`${LOADER_META[type]}/versions/loader/${encodeURIComponent(mc)}`);
  return list.map((x) => x.loader.version);
}

const versionFile = (root, id) => path.join(root, 'versions', id, `${id}.json`);

// Возвращает id версии для запуска: ванильный или профиль загрузчика (скачивает профиль при необходимости).
export async function ensureLoader(root, mc, loader, opts = {}) {
  if (!loader?.type || loader.type === 'vanilla') return mc;
  if (!LOADER_META[loader.type] && !isForge(loader.type)) throw new Error(`Загрузчик не поддерживается: ${loader.type}`);
  const version = loader.version || (await loaderVersions(loader.type, mc))[0];
  if (!version) throw new Error(`${loader.type} не поддерживает Minecraft ${mc}`);
  if (isForge(loader.type)) {
    // Процессорам Forge нужна та же Java, что и игре
    const vanilla = await resolveVersion(root, mc);
    const java = opts.javaPath || (await ensureJava(root, vanilla, { signal: opts.signal, onProgress: (p) => opts.onProgress?.({ ...p, label: 'Java' }) }));
    return ensureForge(root, mc, { type: loader.type, version }, { ...opts, java, vanilla });
  }
  const id = `${loader.type}-loader-${version}-${mc}`;
  if (!(await readJson(versionFile(root, id)))) {
    const url = `${LOADER_META[loader.type]}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/profile/json`;
    await writeJson(versionFile(root, id), { ...(await fetchJson(url)), id });
  }
  return id;
}

export function mergeVersion(parent, child) {
  const args = (k) => [...(parent.arguments?.[k] ?? []), ...(child.arguments?.[k] ?? [])];
  return {
    ...parent,
    ...child,
    jar: child.jar ?? parent.jar ?? parent.id,
    libraries: [...(child.libraries ?? []), ...parent.libraries], // потомок первым: его версии библиотек главнее
    arguments: parent.arguments || child.arguments ? { jvm: args('jvm'), game: args('game') } : undefined,
  };
}

export async function resolveVersion(root, id) {
  let v = await readJson(versionFile(root, id));
  if (!v) {
    const entry = (await versionList()).versions.find((x) => x.id === id);
    if (!entry) throw new Error(`Неизвестная версия Minecraft: ${id}`);
    v = await fetchJson(entry.url);
    await writeJson(versionFile(root, id), v);
  }
  return v.inheritsFrom ? mergeVersion(await resolveVersion(root, v.inheritsFrom), v) : v;
}

export function libraryFiles(v, root, os = OS) {
  const seen = new Set();
  const out = [];
  for (const lib of v.libraries) {
    if (!allowed(lib.rules, {}, os)) continue;
    const key = lib.name.split(':').filter((_, i) => i !== 2).join(':'); // без версии
    if (seen.has(key)) continue;
    seen.add(key);
    const art = lib.downloads?.artifact;
    if (art || !lib.downloads) {
      const rel = art?.path ?? mavenPath(lib.name);
      const base = (lib.url ?? 'https://libraries.minecraft.net/').replace(/\/?$/, '/');
      // local: адреса нет — файл собрал установщик Forge, качать нечего, но в classpath он нужен
      out.push({ dest: path.join(root, 'libraries', rel), url: art ? art.url : base + rel, sha1: art?.sha1 ?? lib.sha1, size: art?.size, cp: true, local: !!art && !art.url });
    }
    // Старые версии (до 1.19): нативные библиотеки лежат отдельным архивом
    const nativeKey = lib.natives?.[os.name]?.replace('${arch}', os.arch === 'x86' ? '32' : '64');
    const nat = nativeKey && lib.downloads?.classifiers?.[nativeKey];
    if (nat) out.push({ dest: path.join(root, 'libraries', nat.path), url: nat.url, sha1: nat.sha1, size: nat.size, native: true });
  }
  return out;
}

async function assetTasks(root, v) {
  const file = path.join(root, 'assets', 'indexes', `${v.assetIndex.id}.json`);
  await downloadAll([{ dest: file, url: v.assetIndex.url, sha1: v.assetIndex.sha1 }]);
  const { objects } = await readJson(file);
  // shortcut: версии до 1.7 ждут ресурсы в другой раскладке (virtual/resources) — там не будет звука; добавить копирование, если понадобятся
  return Object.values(objects).map((o) => ({
    dest: path.join(root, 'assets', 'objects', o.hash.slice(0, 2), o.hash),
    url: `${RESOURCES_URL}/${o.hash.slice(0, 2)}/${o.hash}`,
    sha1: o.hash,
    size: o.size,
    quick: true,
  }));
}

// force — перепроверить все файлы Java по хешам («Проверить файлы игры»). count(n) — сколько файлов пришлось скачать.
export async function ensureJava(root, v, opts = {}, { force, count } = {}) {
  const component = v.javaVersion?.component ?? 'jre-legacy';
  const home = path.join(root, 'runtimes', component);
  const bin = path.join(home, OS.name === 'osx' ? 'jre.bundle/Contents/Home/bin/java' : OS.name === 'windows' ? 'bin/javaw.exe' : 'bin/java');
  const marker = path.join(home, '.installed');
  // Метки мало: если сам исполняемый файл пропал, Java нужно доустановить
  if (!force && (await readJson(marker)) && (await fs.access(bin).then(() => true, () => false))) return bin;

  const platform = JAVA_PLATFORM[OS.name]?.[OS.arch];
  const entry = (await fetchJson(JAVA_URL))[platform]?.[component]?.[0];
  if (!entry) throw new Error(`Mojang не раздаёт Java (${component}) для ${platform}. Укажи путь к Java в настройках.`);
  const { files } = await fetchJson(entry.manifest.url);
  const entries = Object.entries(files);
  const tasks = entries
    .filter(([, f]) => f.type === 'file')
    .map(([rel, f]) => ({ dest: path.join(home, rel), url: f.downloads.raw.url, sha1: f.downloads.raw.sha1, size: f.downloads.raw.size }));
  count?.(await downloadAll(tasks, opts));
  if (OS.name !== 'windows') {
    for (const [rel, f] of entries) {
      if (f.type === 'file' && f.executable) await fs.chmod(path.join(home, rel), 0o755);
      if (f.type === 'link') await fs.symlink(f.target, path.join(home, rel)).catch(() => {});
    }
  }
  await writeJson(marker, { version: entry.version.name });
  return bin;
}

// Докачивает всё нужное для версии. full=true — перепроверить хеши всех файлов («починить»).
export async function install(root, versionId, { signal, onProgress, javaPath, full } = {}) {
  const v = await resolveVersion(root, versionId);
  const step = (label) => ({ signal, onProgress: (p) => onProgress?.({ ...p, label }) });
  const jarId = v.jar ?? v.id;
  const jar = { dest: path.join(root, 'versions', jarId, `${jarId}.jar`), ...v.downloads.client };
  const libs = libraryFiles(v, root);
  const relax = (tasks) => (full ? tasks.map((t) => ({ ...t, quick: false })) : tasks.map((t) => ({ ...t, quick: true })));
  let restored = 0; // сколько файлов не хватало или было повреждено
  restored += await downloadAll(relax([...libs.filter((l) => !l.local), jar]), step('Библиотеки'));
  restored += await downloadAll(relax(await assetTasks(root, v)), step('Ресурсы игры'));
  const java = javaPath || (await ensureJava(root, v, step('Java'), { force: full, count: (n) => (restored += n) }));
  return { v, java, restored, classpath: [...libs.filter((l) => l.cp).map((l) => l.dest), jar.dest], natives: libs.filter((l) => l.native).map((l) => l.dest) };
}

export function buildArgs(v, vars, { features = {}, jvmExtra = [], gameExtra = [] } = {}) {
  const sub = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  const flat = (list) => list.flatMap((a) => (typeof a === 'string' ? [a] : allowed(a.rules, features) ? [a.value].flat() : []));
  const jvm = v.arguments?.jvm?.length ? flat(v.arguments.jvm) : ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];
  const game = v.arguments?.game?.length ? flat(v.arguments.game) : v.minecraftArguments.split(' ');
  return [...jvmExtra, ...jvm.map(sub), v.mainClass, ...game.map(sub), ...gameExtra];
}

export async function launch({ root, versionId, gameDir, account, memory = 4096, jvmArgs = [], javaPath, server, width, height, fullscreen, agent, signal, onProgress, onLog }) {
  const { v, java, classpath, natives } = await install(root, versionId, { signal, onProgress, javaPath });
  const nativesDir = path.join(gameDir, '..', 'natives');
  await fs.mkdir(gameDir, { recursive: true });
  await fs.mkdir(nativesDir, { recursive: true });
  for (const jar of natives) await unzip(jar, nativesDir); // только версии до 1.19

  const assetsRoot = path.join(root, 'assets');
  const quickPlay = !!server && JSON.stringify(v.arguments?.game ?? '').includes('quickPlayMultiplayer');
  const vars = {
    auth_player_name: account.name,
    auth_uuid: account.uuid,
    auth_access_token: account.accessToken || '0',
    auth_session: account.accessToken || '0',
    auth_xuid: '',
    clientid: '',
    user_type: account.type === 'microsoft' ? 'msa' : account.type === 'offline' ? 'legacy' : 'mojang',
    user_properties: '{}',
    version_name: v.id,
    version_type: 'ShizoLauncher',
    game_directory: gameDir,
    assets_root: assetsRoot,
    game_assets: assetsRoot,
    assets_index_name: v.assetIndex.id,
    natives_directory: nativesDir,
    library_directory: path.join(root, 'libraries'),
    classpath: classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    launcher_name: 'ShizoLauncher',
    launcher_version: '1.2.0',
    resolution_width: String(width || ''),
    resolution_height: String(height || ''),
    quickPlayMultiplayer: server ? `${server.host}:${server.port}` : '',
  };
  const args = buildArgs(v, vars, {
    features: { has_custom_resolution: !!(width && height), is_quick_play_multiplayer: quickPlay },
    // useSystemProxies: Java сама по себе игнорирует прокси Windows, и у игроков с VPN/прокси не работают вход и скины
    jvmExtra: [`-Xmx${memory}M`, '-Djava.net.useSystemProxies=true', ...(agent ? [`-javaagent:${agent.jar}=${agent.target}`, ...(agent.prefetched ? [`-Dauthlibinjector.yggdrasil.prefetched=${agent.prefetched}`] : [])] : []), ...jvmArgs],
    gameExtra: [...(server && !quickPlay ? ['--server', server.host, '--port', String(server.port)] : []), ...(fullscreen ? ['--fullscreen'] : [])],
  });
  const child = spawn(java, args, { cwd: gameDir });
  child.stdout.on('data', (d) => onLog?.(d.toString()));
  child.stderr.on('data', (d) => onLog?.(d.toString()));
  return child;
}
