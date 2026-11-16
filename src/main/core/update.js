// Автообновление лаунчера: последняя версия берётся из релизов GitHub-репозитория (launcher.config.json -> updateRepo).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { downloadAll, fetchJson, rawFetch } from './net.js';

// 1.10.0 новее 1.9.3: сравниваем числа по частям, а не строки
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// latest.yml, который пишет electron-builder: version, path, sha512, size — хватает простого разбора строк
export function parseLatestYml(text) {
  const get = (key) => text.match(new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+)`, 'm'))?.[1]?.trim();
  const version = get('version');
  const file = get('path');
  return version && file ? { version, file, sha512: get('sha512') ?? null, size: Number(get(' *size')) || undefined } : null;
}

// -> null, если обновления нет; иначе { version, notes, url, size, sha256 | sha512 }
// Сначала обычная ссылка на файл релиза: у неё нет лимита 60 запросов в час, как у API GitHub,
// который на общих VPN и с одного адреса быстро кончается — и проверка молча падала.
export async function checkUpdate(repo, current, api = 'https://api.github.com', site = 'https://github.com') {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return null;
  const res = await rawFetch(`${site}/${repo}/releases/latest/download/latest.yml`, { cache: 'no-store' }).catch(() => null);
  const yml = res?.ok ? parseLatestYml(await res.text()) : null;
  if (yml) {
    if (compareVersions(yml.version, current) <= 0) return null;
    // Описание релиза — из API, если он сейчас отвечает; без него обновление всё равно ставится
    const notes = await fetchJson(`${api}/repos/${repo}/releases/tags/v${yml.version}`).then((r) => r.body ?? '', () => '');
    return { version: yml.version, notes, url: `${site}/${repo}/releases/download/v${yml.version}/${encodeURIComponent(yml.file)}`, size: yml.size, sha512: yml.sha512 };
  }
  const rel = await fetchJson(`${api}/repos/${repo}/releases/latest`, { cache: 'no-store' }).catch((e) => {
    if (e.status === 404) return null; // репозитория или релизов ещё нет
    throw e;
  });
  const asset = rel?.assets?.find((a) => /\.exe$/i.test(a.name));
  if (!asset || compareVersions(rel.tag_name, current) <= 0) return null;
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw new Error('Обновление лежит по небезопасному адресу');
  return { version: rel.tag_name.replace(/^v/, ''), notes: rel.body ?? '', url: url.href, size: asset.size, sha256: asset.digest?.replace(/^sha256:/, '') ?? null };
}

// Скачивает установщик и сверяет его с контрольной суммой из релиза. Возвращает путь к файлу.
export async function downloadUpdate(info, dir, opts = {}) {
  const dest = path.join(dir, `ShizoLauncher-Setup-${info.version}.exe`);
  await fs.rm(dest, { force: true });
  await downloadAll([{ dest, url: info.url, size: info.size }], opts);
  if (info.sha256 || info.sha512) {
    const hash = createHash(info.sha512 ? 'sha512' : 'sha256');
    await pipeline(createReadStream(dest), hash);
    if (hash.digest(info.sha512 ? 'base64' : 'hex') !== (info.sha512 ?? info.sha256)) {
      await fs.rm(dest, { force: true });
      throw new Error('Скачанное обновление повреждено (контрольная сумма не совпала) — попробуй ещё раз');
    }
  }
  return dest;
}
