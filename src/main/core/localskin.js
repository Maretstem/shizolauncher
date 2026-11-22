// Свой скин для офлайн-аккаунта. Игра берёт скины с сервера авторизации, поэтому лаунчер поднимает
// крошечный локальный сервер в духе Yggdrasil и подключает его к игре через authlib-injector.
// Скин видит сам игрок; другим на сервере он виден, только если сервер сам раздаёт скины (SkinsRestorer и т.п.).
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const skinFile = (root, accId) => path.join(root, 'skins', `${createHash('sha1').update(accId).digest('hex')}.png`);
const metaFile = (root) => path.join(root, 'skins', 'skins.json');

async function readMeta(root) {
  return JSON.parse(await fs.readFile(metaFile(root), 'utf8').catch(() => '{}'));
}

// PNG 64×64 или 64×32 — другие размеры игра не примет
export function checkSkinPng(buf) {
  if (buf.length < 24 || buf.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('Нужна картинка PNG');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== 64 || (h !== 64 && h !== 32)) throw new Error(`Скин должен быть 64×64 или 64×32, а у картинки ${w}×${h}`);
}

export async function setLocalSkin(root, accId, file, slim) {
  const buf = await fs.readFile(file);
  checkSkinPng(buf);
  await fs.mkdir(path.join(root, 'skins'), { recursive: true });
  await fs.writeFile(skinFile(root, accId), buf);
  const meta = await readMeta(root);
  meta[accId] = { slim: !!slim, at: Date.now() };
  await fs.writeFile(metaFile(root), JSON.stringify(meta));
}

export async function removeLocalSkin(root, accId) {
  await fs.rm(skinFile(root, accId), { force: true });
  const meta = await readMeta(root);
  delete meta[accId];
  await fs.writeFile(metaFile(root), JSON.stringify(meta)).catch(() => {});
}

// -> { data: Buffer, slim } | null
export async function getLocalSkin(root, accId) {
  const meta = (await readMeta(root))[accId];
  if (!meta) return null;
  const data = await fs.readFile(skinFile(root, accId)).catch(() => null);
  return data ? { data, slim: meta.slim } : null;
}

// Ключ подписи текстур: игра проверяет подпись, authlib-injector подставляет ей наш открытый ключ
async function keys(root) {
  const file = path.join(root, 'skins', 'signing-key.pem');
  const pem = await fs.readFile(file, 'utf8').catch(() => null);
  if (pem) return { privateKey: pem, publicKey: (await import('node:crypto')).createPublicKey(pem).export({ type: 'spki', format: 'pem' }) };
  const k = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, k.privateKey);
  return k;
}

// Сервер на время игры. profile: { uuid (без дефисов), name }, skin: { data, slim }. -> { url, close() }
export async function startSkinServer(root, profile, skin) {
  const { privateKey, publicKey } = await keys(root);
  const hash = createHash('sha256').update(skin.data).digest('hex');
  let base = '';
  const texturesProp = () => {
    const value = Buffer.from(JSON.stringify({
      timestamp: Date.now(),
      profileId: profile.uuid,
      profileName: profile.name,
      textures: { SKIN: { url: `${base}textures/${hash}`, ...(skin.slim && { metadata: { model: 'slim' } }) } },
    })).toString('base64');
    const signature = createSign('RSA-SHA1').update(value).sign(privateKey, 'base64');
    return { name: 'textures', value, signature };
  };
  const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
    const p = url.pathname;
    if (p === '/') return json(res, 200, { meta: { serverName: 'ShizoLauncher (свой скин)', implementationName: 'shizolauncher', implementationVersion: '1' }, skinDomains: ['127.0.0.1', 'localhost'], signaturePublickey: publicKey });
    if (p === `/textures/${hash}`) return res.writeHead(200, { 'Content-Type': 'image/png' }).end(skin.data);
    const m = p.match(/^\/sessionserver\/session\/minecraft\/profile\/([0-9a-f-]{32,36})$/i);
    if (m) return m[1].replace(/-/g, '') === profile.uuid ? json(res, 200, { id: profile.uuid, name: profile.name, properties: [texturesProp()] }) : json(res, 204);
    if (p === '/sessionserver/session/minecraft/join') return json(res, 204); // на офлайн-сервере проверки входа нет
    if (p === '/api/profiles/minecraft') return json(res, 200, []);
    return json(res, 404, { error: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  return { url: base, close: () => server.close() };
}
