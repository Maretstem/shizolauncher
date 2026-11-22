// Horizon — Minecraft 26.3, переписанный на Rust (github.com/horizon-rust/horizon).
// Запускать его разрешено только игроку с аккаунтом Microsoft, у которого куплен Minecraft: Java Edition, —
// это правило Launch API Horizon. Пока в ShizoLauncher нет такого входа, мы ставим официальный лаунчер Horizon:
// он сам проверяет аккаунт, готовит игру и управляет её модами.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { downloadAll, fetchJson, rawFetch } from './net.js';

const REPO = 'horizon-rust/horizon';

// Релизы лаунчера Horizon помечены тегами «launcher@x.y.z»; рядом с ними выходят и релизы самой игры
export async function latestHorizonLauncher({ arch = process.arch, api = 'https://api.github.com', site = 'https://github.com' } = {}) {
  const releases = await fetchJson(`${api}/repos/${REPO}/releases?per_page=30`);
  const rel = releases.find((r) => r.tag_name?.startsWith('launcher@') && !r.prerelease && !r.draft);
  if (!rel) throw new Error('Не нашёл релиз лаунчера Horizon на GitHub');
  const file = arch === 'arm64' ? 'horizon-launcher-setup-arm64.exe' : 'horizon-launcher-setup.exe';
  const asset = rel.assets.find((a) => a.name === file);
  if (!asset) throw new Error(`В релизе ${rel.tag_name} нет ${file}`);
  const base = `${site}/${REPO}/releases/download/${encodeURIComponent(rel.tag_name)}`;
  const sums = await (await rawFetch(`${base}/SHA256SUMS`)).text();
  const sha256 = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find(([, name]) => name === file)?.[0];
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new Error('У релиза Horizon нет контрольной суммы установщика — качать не буду');
  return { version: rel.tag_name.replace('launcher@', ''), file, url: `${base}/${file}`, size: asset.size, sha256 };
}

// Скачивает установщик и сверяет SHA-256 из SHA256SUMS релиза. -> путь к файлу
export async function downloadHorizonLauncher(info, dir, opts = {}) {
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, info.file);
  await fs.rm(dest, { force: true });
  await downloadAll([{ dest, url: info.url, size: info.size }], opts);
  const hash = createHash('sha256');
  await pipeline(createReadStream(dest), hash);
  if (hash.digest('hex') !== info.sha256) {
    await fs.rm(dest, { force: true });
    throw new Error('Скачанный установщик Horizon повреждён (контрольная сумма не совпала) — попробуй ещё раз');
  }
  return dest;
}
