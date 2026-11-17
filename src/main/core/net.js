// Сеть и файлы: JSON-запросы, параллельные загрузки с проверкой SHA-1, безопасные пути.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

// Electron подставляет сюда net.fetch: он ходит через системный прокси, обычный fetch из Node — нет
let doFetch = fetch;
export const useFetch = (f) => void (doFetch = f);

const UA = { 'User-Agent': 'ShizoLauncher/1.0 (minecraft launcher)' };

// Обычный запрос тем же транспортом (с системным прокси в Electron) — когда нужен сам ответ, а не JSON
export const rawFetch = (url, init = {}) => doFetch(url, { ...init, headers: { ...UA, ...init.headers } });

export async function fetchJson(url, init = {}) {
  const res = await doFetch(url, { ...init, headers: { ...UA, ...init.headers } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw Object.assign(new Error(`${res.status} ${res.statusText}: ${url}`), { status: res.status, body });
  }
  return res.status === 204 ? null : res.json();
}

export const postJson = (url, body, init = {}) =>
  fetchJson(url, {
    ...init,
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init.headers },
  });

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(data, null, 2));
  await fs.rename(file + '.tmp', file); // атомарно: при сбое не останется полфайла
}

// Путь из внешних данных (манифест сборки, mrpack) не должен выходить за пределы base.
export function safeJoin(base, rel) {
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  if (typeof rel !== 'string' || !full.startsWith(root + path.sep)) throw new Error(`Недопустимый путь: ${rel}`);
  return full;
}

// shortcut: распаковка zip системным bsdtar (есть в Windows 10+ и macOS, сам отбрасывает пути с ".."); на Linux нужен пакет libarchive-tools.
// Полный путь на Windows обязателен: в PATH может стоять GNU tar из Git, который zip не читает.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : process.platform === 'linux' ? 'bsdtar' : 'tar';
// member — достать из архива только один файл
export const unzip = (file, dest, member) => promisify(execFile)(TAR, ['-xf', file, '-C', dest, ...(member ? [member] : [])]);
// Zip-архив из перечисленных файлов и папок внутри cwd (имена без «./» в начале — так их читают другие лаунчеры)
export const zipFiles = (file, cwd, members) => promisify(execFile)(TAR, ['--format', 'zip', '-cf', file, '-C', cwd, ...members], { maxBuffer: 1 << 26 });

export function httpsUrl(url, base) {
  const u = new URL(url, base);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Недопустимый адрес: ${url}`);
  return u.href;
}

export async function sha1File(file) {
  const hash = createHash('sha1');
  try {
    await pipeline(createReadStream(file), hash);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return hash.digest('hex');
}

// task: { url, dest, sha1?, size?, quick?: проверять только размер, keep?: не трогать, если файл уже есть }
async function isValid(t) {
  const st = await fs.stat(t.dest).catch(() => null);
  if (!st) return false;
  if (t.keep) return true;
  if (t.size != null && st.size !== t.size) return false;
  if (t.sha1 && !t.quick) return (await sha1File(t.dest)) === t.sha1;
  return true;
}

async function fetchTo(t, signal, onBytes) {
  await fs.mkdir(path.dirname(t.dest), { recursive: true });
  const part = t.dest + '.part';
  for (let attempt = 1; ; attempt++) {
    let got = 0;
    try {
      const res = await doFetch(t.url, { headers: UA, signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${t.url}`);
      const hash = createHash('sha1');
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          got += chunk.length;
          onBytes(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(part));
      if (t.sha1 && hash.digest('hex') !== t.sha1) throw new Error(`Файл повреждён при загрузке (хеш не совпал): ${t.url}`);
      await fs.rename(part, t.dest);
      return;
    } catch (e) {
      onBytes(-got);
      await fs.rm(part, { force: true });
      if (signal?.aborted) throw new Error('Отменено');
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function pool(items, limit, fn) {
  let i = 0;
  let failed = false;
  const worker = async () => {
    while (i < items.length && !failed) {
      try {
        await fn(items[i++]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Скачивает только то, чего нет или что не прошло проверку. Возвращает число скачанных файлов.
export async function downloadAll(tasks, { signal, onProgress = () => {} } = {}) {
  const unique = [...new Map(tasks.map((t) => [t.dest, t])).values()];
  const need = [];
  await pool(unique, 32, async (t) => {
    if (!(await isValid(t))) need.push(t);
  });
  const totalBytes = need.reduce((sum, t) => sum + (t.size ?? 0), 0);
  let bytes = 0;
  let files = 0;
  const report = () => onProgress({ files, totalFiles: need.length, bytes, totalBytes });
  if (need.length) report();
  await pool(need, 12, async (t) => {
    await fetchTo(t, signal, (n) => {
      bytes += n;
      report();
    });
    files++;
    report();
  });
  return need.length;
}
