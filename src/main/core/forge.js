// Forge и NeoForge: их установщик — это jar с профилем версии, библиотеками и «процессорами»,
// которые нужно прогнать через Java, чтобы получить пропатченный клиент. Делаем то же, что делает официальный установщик.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { downloadAll, fetchJson, readJson, sha1File, unzip, writeJson } from './net.js';

const exec = promisify(execFile);
const MAVEN = { neoforge: 'https://maven.neoforged.net/releases/net/neoforged/neoforge', forge: 'https://maven.minecraftforge.net/net/minecraftforge/forge' };
export const isForge = (type) => type in MAVEN;

// "g:a:v[:classifier][@ext]" -> путь в maven (копия из minecraft.js, чтобы модули не зависели друг от друга по кругу)
function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
}

// NeoForge нумеруется по версии игры без первой единицы: 1.21.11 -> 21.11.x, 1.21 -> 21.0.x, 26.3 -> 26.3.x
export function neoforgePrefix(mc) {
  const [a, b = '0'] = mc.replace(/^1\./, '').split('.');
  return `${a}.${b}.`;
}

// Версии загрузчика для этой версии игры, новые первыми; бета-версии — в конце списка
export async function forgeVersions(type, mc) {
  let list;
  if (type === 'neoforge') {
    const all = (await fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions;
    list = all.filter((v) => v.startsWith(neoforgePrefix(mc)));
  } else {
    const all = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json');
    list = (all[mc] ?? []).map((v) => v.slice(mc.length + 1));
  }
  list.reverse();
  return [...list.filter((v) => !/beta|alpha/.test(v)), ...list.filter((v) => /beta|alpha/.test(v))];
}

// Главный класс jar-файла записан в его манифесте
async function mainClass(jar, tmp) {
  const dir = await fs.mkdtemp(path.join(tmp, 'mf-'));
  await unzip(jar, dir, 'META-INF/MANIFEST.MF');
  const text = (await fs.readFile(path.join(dir, 'META-INF', 'MANIFEST.MF'), 'utf8')).replace(/\r?\n /g, ''); // длинные строки манифеста переносятся с пробелом
  const m = text.match(/^Main-Class:\s*(.+)$/m);
  if (!m) throw new Error(`В ${path.basename(jar)} нет главного класса`);
  return m[1].trim();
}

// Ставит загрузчик и возвращает id версии для запуска. java — путь к Java для процессоров, vanilla — разобранная версия игры.
export async function ensureForge(root, mc, loader, { java, vanilla, signal, onProgress, full } = {}) {
  const { type, version } = loader;
  const id = `${type}-${mc}-${version}`;
  const dir = path.join(root, 'versions', id);
  const profileFile = path.join(dir, `${id}.json`);
  const marker = path.join(dir, '.processed');
  if (!full && (await readJson(profileFile)) && (await readJson(marker))) return id;

  const lib = (rel) => path.join(root, 'libraries', rel);
  const step = (label) => ({ signal, onProgress: (p) => onProgress?.({ ...p, label }) });
  const coords = type === 'neoforge' ? version : `${mc}-${version}`;
  const installer = path.join(dir, 'installer.jar');
  await downloadAll([{ dest: installer, url: `${MAVEN[type]}/${coords}/${type}-${coords}-installer.jar`, keep: true }], step(`Установщик ${type}`));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shizo-forge-'));
  try {
    await unzip(installer, tmp);
    const profile = await readJson(path.join(tmp, 'install_profile.json'));
    if (!profile?.processors || !profile.data) throw new Error('Forge для версий Minecraft до 1.13 не поддерживается — возьми версию новее или Fabric');
    const versionJson = await readJson(path.join(tmp, profile.json.replace(/^\//, '')));

    // Библиотеки загрузчика и самих процессоров. Без адреса — лежит внутри установщика в папке maven/ либо будет собрана процессорами
    const tasks = [];
    for (const l of [...profile.libraries, ...versionJson.libraries]) {
      const art = l.downloads?.artifact;
      if (!art) continue;
      if (art.url) tasks.push({ dest: lib(art.path), url: art.url, sha1: art.sha1, size: art.size, quick: !full });
      else {
        await fs.mkdir(path.dirname(lib(art.path)), { recursive: true });
        await fs.copyFile(path.join(tmp, 'maven', art.path), lib(art.path)).catch((e) => {
          if (e.code !== 'ENOENT') throw e; // нет в установщике — этот файл соберут процессоры
        });
      }
    }
    const client = path.join(root, 'versions', mc, `${mc}.jar`);
    tasks.push({ dest: client, ...vanilla.downloads.client, quick: !full });
    await downloadAll(tasks, step(`Библиотеки ${type}`));

    // Подстановки для аргументов процессоров: [координаты] — библиотека, 'текст' — как есть, /путь — файл из установщика
    const resolve = (value) => (/^\[.*\]$/.test(value) ? lib(mavenPath(value.slice(1, -1))) : /^'.*'$/.test(value) ? value.slice(1, -1) : path.join(tmp, value));
    const data = { SIDE: 'client', MINECRAFT_JAR: client, MINECRAFT_VERSION: mc, ROOT: root, INSTALLER: installer, LIBRARY_DIR: path.join(root, 'libraries') };
    for (const [key, v] of Object.entries(profile.data)) data[key] = resolve(v.client);
    const sub = (arg) => (/^\[.*\]$/.test(arg) ? resolve(arg) : arg.replace(/\{(\w+)\}/g, (m, k) => data[k] ?? m));

    const todo = profile.processors.filter((p) => !p.sides || p.sides.includes('client'));
    for (const [n, p] of todo.entries()) {
      onProgress?.({ label: `Сборка ${type}: шаг ${n + 1} из ${todo.length}`, files: n, totalFiles: todo.length, bytes: 0, totalBytes: 0 });
      if (signal?.aborted) throw new Error('Отменено');
      // Результат уже готов и цел — шаг можно пропустить
      const outputs = Object.entries(p.outputs ?? {});
      const ready = outputs.length && (await Promise.all(outputs.map(async ([file, hash]) => (await sha1File(sub(file))) === sub(hash).replace(/'/g, '')))).every(Boolean);
      if (ready) continue;
      const args = p.args.map(sub);
      // Шаг «скачать маппинги Mojang» делаем сами: Java качает напрямую и не знает про системный прокси
      if (args.includes('DOWNLOAD_MOJMAPS') && vanilla.downloads.client_mappings) {
        await downloadAll([{ dest: args[args.indexOf('--output') + 1], ...vanilla.downloads.client_mappings }], { signal });
        continue;
      }
      const jar = lib(mavenPath(p.jar));
      const cp = [jar, ...p.classpath.map((c) => lib(mavenPath(c)))].join(path.delimiter);
      await exec(java, ['-Djava.net.useSystemProxies=true', '-cp', cp, await mainClass(jar, tmp), ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch((e) => {
        throw new Error(`Не удалось собрать ${type} (шаг ${n + 1}): ${String(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`);
      });
    }
    // jar: id — клиентский jar кладётся под именем версии загрузчика: Forge по этому имени исключает его из модулей
    await writeJson(profileFile, { ...versionJson, id, jar: id });
    await writeJson(marker, { at: Date.now() });
    return id;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
