// Проверка модов до запуска: читаем описания прямо из jar (fabric.mod.json, quilt.mod.json, mods.toml)
// и находим то, из-за чего игра вылетит: нет нужного мода, два одинаковых, несовместимые, не тот загрузчик.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// ---- крошечный читатель zip: jar — это zip, а нужно из него 1–2 файла ----
export function zipEntries(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Файл повреждён (это не zip)');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let n = 0; n < count && buf.readUInt32LE(at) === 0x02014b50; n++) {
    const nameLen = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    out.set(name, { method: buf.readUInt16LE(at + 10), size: buf.readUInt32LE(at + 20), local: buf.readUInt32LE(at + 42) });
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

export function zipRead(buf, entry) {
  const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
  const data = buf.subarray(start, start + entry.size);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error('Неизвестное сжатие');
}

// В описаниях модов встречаются переводы строк прямо внутри строк — строгий JSON.parse на них падает
const looseJson = (text) => JSON.parse(text.replace(/^﻿/, '').replace(/[\u0000-\u001f]+/g, ' '));
const ids = (deps) => (Array.isArray(deps) ? deps.map((d) => (typeof d === 'string' ? d : d?.id)) : Object.keys(deps ?? {})).filter(Boolean);
// { id: условие версии } — у Fabric объект, у Quilt массив строк или { id, versions }
const ranges = (deps) => Object.fromEntries(Array.isArray(deps) ? deps.map((d) => (typeof d === 'string' ? [d, '*'] : [d?.id, d?.versions ?? '*'])).filter(([k]) => k) : Object.entries(deps ?? {}));

// ---- версии в стиле Fabric: 1.2.3-beta.1+build; условия >=, <=, >, <, =, ~, ^, 1.2.x, *; массив = «или», пробел = «и» ----
function parseVersion(v) {
  const m = String(v).trim().match(/^v?(\d+(?:\.\d+)*)(?:-([^+]*))?/);
  return m && { nums: m[1].split('.').map(Number), pre: m[2] ?? null };
}
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return String(a) === String(b) ? 0 : NaN;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1; // 1.0 новее 1.0-beta
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0 ? 1 : -1;
}
// Подходит ли установленная версия под условие. Не понимаем формат версии — считаем, что подходит (лучше промолчать, чем зря напугать).
export function satisfies(version, pred) {
  if (Array.isArray(pred)) return pred.length === 0 || pred.some((p) => satisfies(version, p));
  const parts = String(pred ?? '*').trim().split(/\s+/).filter(Boolean);
  if (!parseVersion(version)) return true;
  return parts.every((p) => {
    if (p === '*') return true;
    const m = p.match(/^(>=|<=|>|<|=|~|\^)?(.+)$/);
    const [, op = '=', target] = m;
    if (/\.x$|\.\*$/i.test(target)) return String(version).startsWith(target.replace(/[x*]$/i, ''));
    const c = compareVersions(version, target);
    if (Number.isNaN(c)) return true;
    const t = parseVersion(target)?.nums ?? [];
    if (op === '~') return c >= 0 && compareVersions(version, `${t[0]}.${(t[1] ?? 0) + 1}`) < 0;
    if (op === '^') return c >= 0 && compareVersions(version, `${(t[0] ?? 0) + 1}`) < 0;
    return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0 }[op];
  });
}

function fromToml(text) {
  // Хватает простого разбора: [[mods]] modId="..." и [[dependencies.x]] modId="..." mandatory/type
  const blocks = text.split(/^\s*\[\[/m).slice(1);
  const value = (b, key) => b.match(new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\n#]+)`, 'm'))?.[1]?.trim();
  const mods = blocks.filter((b) => b.startsWith('mods]')).map((b) => value(b, 'modId')).filter(Boolean);
  const deps = blocks.filter((b) => b.startsWith('dependencies.'));
  const kind = (b) => (value(b, 'type') ?? (value(b, 'mandatory') === 'false' ? 'optional' : 'required')).toLowerCase();
  return {
    id: mods[0],
    provides: mods.slice(1),
    depends: deps.filter((b) => kind(b) === 'required').map((b) => value(b, 'modId')).filter(Boolean),
    breaks: Object.fromEntries(deps.filter((b) => kind(b) === 'incompatible').map((b) => [value(b, 'modId'), '*']).filter(([k]) => k)),
  };
}

// -> { id, name, loaders: Set, provides: [], depends: [], breaks: [] } или null, если в jar нет описания мода
export function readMod(buf) {
  const entries = zipEntries(buf);
  const text = (name) => (entries.has(name) ? zipRead(buf, entries.get(name)).toString('utf8') : null);
  const info = { loaders: new Set(), provides: [], depends: [], breaks: {}, versions: {} };
  const fabric = text('fabric.mod.json');
  if (fabric) {
    const j = looseJson(fabric);
    Object.assign(info, { id: j.id, name: j.name ?? j.id, version: j.version, provides: j.provides ?? [], depends: ids(j.depends), breaks: ranges(j.breaks) });
    info.loaders.add('fabric').add('quilt'); // Quilt запускает моды Fabric
    // Fabric API и другие «сборники» несут модули внутри себя — их id тоже считаются установленными
    for (const nested of j.jars ?? []) {
      const e = entries.get(nested.file);
      const inner = e && readModSafe(zipRead(buf, e));
      if (inner) {
        info.provides.push(inner.id, ...inner.provides);
        for (const id of [inner.id, ...inner.provides]) info.versions[id] = inner.version;
      }
    }
  }
  const quilt = text('quilt.mod.json');
  if (quilt) {
    const q = looseJson(quilt).quilt_loader ?? {};
    info.loaders.add('quilt');
    if (!info.id) Object.assign(info, { id: q.id, name: q.metadata?.name ?? q.id, version: q.version, depends: ids(q.depends), breaks: ranges(q.breaks), provides: ids(q.provides) });
  }
  for (const [file, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
    const t = text(file);
    if (!t) continue;
    info.loaders.add(loader);
    if (!info.id) Object.assign(info, fromToml(t), { name: undefined });
  }
  if (!info.id) return null;
  info.name ??= info.id;
  for (const id of [info.id, ...info.provides]) info.versions[id] ??= info.version;
  return info;
}

function readModSafe(buf) {
  try {
    return readMod(buf);
  } catch {
    return null;
  }
}

// Это даёт сама игра и загрузчик — такие зависимости всегда есть
const BUILTIN = ['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilted_fabric_loader', 'forge', 'neoforge', 'fml', 'javafml', 'mixinextras'];
const LOADER_NAME = { fabric: 'Fabric', quilt: 'Quilt', neoforge: 'NeoForge', forge: 'Forge' };

// shortcut: версии зависимостей («нужна 0.5 и выше») не сверяются — только наличие мода; добавить разбор диапазонов, если начнут ловиться вылеты из-за версий
export function findProblems(mods, loader) {
  const problems = [];
  const have = new Map(BUILTIN.map((id) => [id, null])); // id -> установленная версия
  const owners = new Map();
  for (const m of mods) {
    for (const id of [m.id, ...m.provides]) if (!have.get(id)) have.set(id, m.versions[id] ?? m.version ?? null);
    owners.set(m.id, [...(owners.get(m.id) ?? []), m.file]);
  }
  for (const [id, files] of owners) {
    if (files.length > 1) problems.push({ level: 'error', text: `Мод «${id}» установлен ${files.length} раза`, fix: `Оставь один из файлов: ${files.join(', ')}` });
  }
  for (const m of mods) {
    if (loader && !m.loaders.has(loader)) {
      problems.push({ level: 'error', text: `«${m.name}» сделан для ${[...m.loaders].map((l) => LOADER_NAME[l]).join('/')}, а сборка на ${LOADER_NAME[loader] ?? loader}`, fix: `Выключи или удали ${m.file}` });
      continue; // зависимости чужого загрузчика сравнивать бессмысленно
    }
    const missing = m.depends.filter((d) => !have.has(d));
    if (missing.length) problems.push({ level: 'error', text: `Моду «${m.name}» не хватает: ${missing.join(', ')}`, fix: 'Найди и поставь эти моды во вкладке «Моды» или выключи этот мод' });
    for (const [b, pred] of Object.entries(m.breaks)) {
      if (b === m.id || !have.has(b) || !satisfies(have.get(b) ?? '', pred)) continue;
      problems.push({ level: 'error', text: `«${m.name}» несовместим с «${b}»${have.get(b) ? ` версии ${have.get(b)}` : ''}`, fix: 'Выключи один из этих модов или обнови его' });
    }
  }
  return problems;
}

// Проверяет включённые моды экземпляра. -> { checked, problems }
export async function checkMods(gameDir, loader) {
  const dir = path.join(gameDir, 'mods');
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jar'));
  const mods = [];
  for (const file of files) {
    const info = readModSafe(await fs.readFile(path.join(dir, file)));
    if (info) mods.push({ ...info, file });
  }
  return { checked: mods.length, problems: findProblems(mods, loader) };
}
