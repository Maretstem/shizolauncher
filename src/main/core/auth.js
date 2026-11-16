// Аккаунты: оффлайн, Ely.by (Yggdrasil + authlib-injector), Microsoft (device code flow).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { downloadAll, fetchJson, postJson, rawFetch } from './net.js';

const ELY = 'https://authserver.ely.by/auth';
const MS = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';

// ---- Оффлайн ----
// UUID как у ванильного сервера в offline-mode: UUID v3 от "OfflinePlayer:<ник>"
export function offlineUuid(name) {
  const b = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b.toString('hex');
}

export function offlineAccount(name) {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Ник: 3–16 символов, латиница, цифры и _');
  return { id: `offline:${name.toLowerCase()}`, type: 'offline', name, uuid: offlineUuid(name), accessToken: '0' };
}

// ---- Ely.by ----
function elyError(e) {
  const msg = e.body?.errorMessage;
  if (msg === 'Account protected with two factor auth.') return Object.assign(new Error('Нужен код двухфакторной защиты'), { code: 'TOTP' });
  if (e.body?.error === 'ForbiddenOperationException') return new Error('Ely.by: неверный логин или пароль');
  return new Error(msg ? `Ely.by: ${msg}` : e.message);
}

export async function elyLogin(login, password, totp) {
  const clientToken = randomUUID();
  const body = { username: login, password: totp ? `${password}:${totp}` : password, clientToken, requestUser: true };
  const r = await postJson(`${ELY}/authenticate`, body).catch((e) => {
    throw elyError(e);
  });
  const p = r.selectedProfile;
  return { id: `ely:${p.id}`, type: 'ely', name: p.name, uuid: p.id, accessToken: r.accessToken, clientToken };
}

async function elyFresh(acc) {
  const ok = await postJson(`${ELY}/validate`, { accessToken: acc.accessToken }).then(() => true, () => false);
  if (ok) return acc;
  const r = await postJson(`${ELY}/refresh`, { accessToken: acc.accessToken, clientToken: acc.clientToken }).catch(() => {
    throw new Error('Сессия Ely.by истекла — войди в аккаунт заново');
  });
  return { ...acc, accessToken: r.accessToken, name: r.selectedProfile?.name ?? acc.name };
}

// authlib-injector подменяет серверы авторизации в игре на Ely.by (скины и вход на серверы)
export async function ensureAuthlibInjector(root) {
  const dest = path.join(root, 'authlib-injector.jar');
  const meta = await fetchJson('https://authlib-injector.yushi.moe/artifact/latest.json').catch(() => null);
  if (meta) await downloadAll([{ dest, url: meta.download_url, keep: true }]); // без сети возьмём уже скачанный
  return dest;
}

// ---- Свой сервер авторизации (стандарт authlib-injector: LittleSkin, Blessing Skin, Drasl и т. п.) ----
// Игрок вводит адрес сайта; настоящий адрес API сервер сообщает заголовком X-Authlib-Injector-API-Location.
export async function resolveAuthServer(input) {
  const typed = String(input ?? '').trim();
  if (!typed) throw new Error('Укажи адрес сервера авторизации');
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    throw new Error('Это не похоже на адрес сайта');
  }
  // Пароль уходит на этот адрес — без шифрования его отправлять нельзя (кроме сервера на этом же компьютере)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Адрес должен начинаться с https://');
  const res = await rawFetch(url.href).catch(() => {
    throw new Error(`Сервер ${url.host} не отвечает`);
  });
  const hint = res.headers.get('x-authlib-injector-api-location');
  const api = (hint ? new URL(hint, res.url).href : res.url).replace(/\/+$/, '');
  const meta = await fetchJson(api).catch(() => null);
  if (!meta || typeof meta !== 'object' || (!meta.meta && !meta.skinDomains && !meta.signaturePublickey)) throw new Error('По этому адресу нет сервера авторизации authlib-injector');
  return { api, name: String(meta.meta?.serverName ?? new URL(api).host).slice(0, 40) };
}

const customError = (e) => new Error(e.body?.error === 'ForbiddenOperationException' ? 'Неверный логин или пароль' : e.body?.errorMessage ? `Сервер ответил: ${e.body.errorMessage}` : e.message);

export async function customLogin(server, login, password) {
  const { api, name } = await resolveAuthServer(server);
  const clientToken = randomUUID();
  const r = await postJson(`${api}/authserver/authenticate`, { username: login, password, clientToken, requestUser: true, agent: { name: 'Minecraft', version: 1 } }).catch((e) => {
    throw customError(e);
  });
  const p = r.selectedProfile ?? r.availableProfiles?.[0];
  if (!p) throw new Error('У аккаунта нет игрового профиля — создай персонажа на сайте сервера');
  return { id: `custom:${new URL(api).host}:${p.id}`, type: 'custom', name: p.name, uuid: p.id, accessToken: r.accessToken, clientToken, server: api, serverName: name };
}

async function customFresh(acc) {
  const ok = await postJson(`${acc.server}/authserver/validate`, { accessToken: acc.accessToken, clientToken: acc.clientToken }).then(() => true, () => false);
  if (ok) return acc;
  const r = await postJson(`${acc.server}/authserver/refresh`, { accessToken: acc.accessToken, clientToken: acc.clientToken }).catch(() => {
    throw new Error(`Сессия на «${acc.serverName}» истекла — войди в аккаунт заново`);
  });
  return { ...acc, accessToken: r.accessToken, name: r.selectedProfile?.name ?? acc.name };
}

// Что передать игре, чтобы она работала с Ely.by или своим сервером: сам authlib-injector, адрес API
// и заранее скачанные сведения о сервере. Без них модуль качает их сам при старте Java — напрямую, мимо
// системного прокси, — и если не дозвонится, игра закрывается, даже не начав загружаться.
export async function authAgent(root, account) {
  if (account.type !== 'ely' && account.type !== 'custom') return null;
  const jar = await ensureAuthlibInjector(root);
  try {
    const api = account.server ?? (await resolveAuthServer('ely.by')).api;
    const meta = await (await rawFetch(api)).text();
    JSON.parse(meta); // убедиться, что пришёл JSON, а не страница ошибки
    return { jar, target: api, prefetched: Buffer.from(meta).toString('base64') };
  } catch {
    return { jar, target: account.server ?? 'ely.by' }; // без сети: пусть попробует сам
  }
}

// ---- Microsoft ----
const form = (url, params) =>
  fetchJson(url, { method: 'POST', body: new URLSearchParams(params), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

// Ошибки Microsoft по коду AADSTS -> что сделать владельцу лаунчера
const AAD = {
  AADSTS700016: 'Приложение с таким Azure Client ID не найдено — проверь, что ID скопирован целиком',
  AADSTS700038: 'Это не Azure Client ID — скопируй «Application (client) ID» со страницы приложения в Azure',
  AADSTS7000218: 'В приложении Azure не включены публичные клиенты: Authentication → «Allow public client flows» → Yes',
  AADSTS50020: 'Приложение Azure создано не для личных аккаунтов: нужен тип «Personal Microsoft accounts only»',
  AADSTS9002331: 'Приложение Azure создано не для личных аккаунтов: нужен тип «Personal Microsoft accounts only»',
  AADSTS70000: 'Вход отменён или не разрешён — попробуй ещё раз',
};
export function msError(e) {
  const text = e.body?.error_description ?? e.message;
  const code = Object.keys(AAD).find((c) => text.includes(c));
  return new Error(code ? AAD[code] : `Microsoft: ${text.split(' Trace ID')[0]}`);
}

// Вход в окне Microsoft: обычная страница входа, после неё Microsoft перенаправляет на REDIRECT с одноразовым кодом.
// PKCE (verifier/challenge) и state защищают код от перехвата и подмены.
export const MS_REDIRECT = 'https://login.microsoftonline.com/common/oauth2/nativeclient';

export function msAuthRequest(clientId) {
  if (!clientId) throw Object.assign(new Error('Вход через Microsoft ещё не подключён в этом лаунчере. Пока войди через Ely.by или офлайн.'), { code: 'NO_CLIENT_ID' });
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: MS_REDIRECT,
    scope: 'XboxLive.signin offline_access',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });
  return { url: `${MS}/authorize?${params}`, verifier, state };
}

// Адрес, куда ушло окно входа -> код (вход завершён), null (ещё идёт) или ошибка
export function msRedirectCode(url, state) {
  if (!url.startsWith(MS_REDIRECT)) return null;
  const q = new URL(url).searchParams;
  if (q.get('error')) throw q.get('error') === 'access_denied' ? new Error('Отменено') : msError({ body: { error_description: q.get('error_description') ?? q.get('error') } });
  if (q.get('state') !== state) throw new Error('Ответ Microsoft не прошёл проверку — попробуй войти ещё раз');
  return q.get('code');
}

export async function msFinishLogin(clientId, code, verifier) {
  const token = await form(`${MS}/token`, { client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: MS_REDIRECT, code_verifier: verifier }).catch((e) => {
    throw msError(e);
  });
  return msToMinecraft(token);
}

const XERR = {
  2148916233: 'У этого аккаунта Microsoft нет профиля Xbox — создай его на xbox.com',
  2148916235: 'Xbox Live недоступен в твоей стране',
  2148916238: 'Детский аккаунт: его нужно добавить в семейную группу Microsoft',
};

async function msToMinecraft(token) {
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${token.access_token}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  }).catch((e) => {
    throw new Error(XERR[e.body?.XErr] ?? `Xbox Live: ${e.message}`);
  });
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${xbl.DisplayClaims.xui[0].uhs};${xsts.Token}`,
  }).catch((e) => {
    // 403 здесь = приложение Azure ещё не одобрено Mojang
    throw new Error(e.status === 403 ? 'Minecraft API отклонил приложение: Azure Client ID должен быть одобрен Mojang (aka.ms/mce-reviewappid)' : e.message);
  });
  const profile = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` },
  }).catch((e) => {
    throw new Error(e.status === 404 ? 'На этом аккаунте Microsoft не куплен Minecraft: Java Edition' : e.message);
  });
  return {
    id: `microsoft:${profile.id}`,
    type: 'microsoft',
    name: profile.name,
    uuid: profile.id,
    accessToken: mc.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + mc.expires_in * 1000,
  };
}

async function msFresh(acc, clientId) {
  if (acc.expiresAt - Date.now() > 300_000) return acc;
  const token = await form(`${MS}/token`, { grant_type: 'refresh_token', client_id: clientId, refresh_token: acc.refreshToken }).catch(() => {
    throw new Error('Сессия Microsoft истекла — войди в аккаунт заново');
  });
  return msToMinecraft(token);
}

// Перед запуском: проверить/обновить токен. Оффлайн-аккаунту ничего не нужно.
export function freshAccount(acc, { azureClientId } = {}) {
  if (acc.type === 'ely') return elyFresh(acc);
  if (acc.type === 'microsoft') return msFresh(acc, azureClientId);
  if (acc.type === 'custom') return customFresh(acc);
  return acc;
}
