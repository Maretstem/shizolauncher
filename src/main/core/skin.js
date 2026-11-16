// Скин аккаунта для 3D-превью: адрес текстуры берётся там же, где его берёт игра, а картинка отдаётся окну как data:-URL.
import { fetchJson, rawFetch } from './net.js';

const https = (url) => String(url).replace(/^http:/, 'https:');

// Профиль Yggdrasil (Mojang, Ely.by, authlib-injector): свойство textures — base64 с JSON внутри
export function skinFromProfile(profile) {
  const prop = profile?.properties?.find((p) => p.name === 'textures');
  if (!prop) return null;
  const skin = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')).textures?.SKIN;
  return skin?.url ? { url: https(skin.url), slim: skin.metadata?.model === 'slim' } : null;
}

export async function skinSource(acc) {
  const uuid = String(acc.uuid ?? '').replace(/-/g, '');
  if (acc.type === 'microsoft') return skinFromProfile(await fetchJson(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`));
  if (acc.type === 'custom') return skinFromProfile(await fetchJson(`${acc.server.replace(/\/$/, '')}/sessionserver/session/minecraft/profile/${uuid}`));
  // Ely.by и офлайн: скин по нику на Ely.by — так его увидят и на серверах с SkinsRestorer
  const t = await fetchJson(`https://skinsystem.ely.by/textures/${encodeURIComponent(acc.name)}`);
  return t?.SKIN?.url ? { url: https(t.SKIN.url), slim: t.SKIN.metadata?.model === 'slim' } : null;
}

// -> { data: 'data:image/png;base64,…', slim } или null (скина нет — окно нарисует запасной)
export async function loadSkin(acc) {
  const src = await skinSource(acc).catch(() => null);
  if (!src) return null;
  const res = await rawFetch(src.url).catch(() => null);
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 512 * 1024 || buf.subarray(1, 4).toString('latin1') !== 'PNG') return null;
  return { data: `data:image/png;base64,${buf.toString('base64')}`, slim: src.slim };
}
