// Главный процесс: окно, хранение настроек/аккаунтов, IPC-мост к ядру.
import { spawn } from 'node:child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, safeStorage, shell } from 'electron';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanCache, diagnose, recommendFlags, recommendMemory } from './core/care.js';
import { authAgent, customLogin, elyLogin, freshAccount, msAuthRequest, msFinishLogin, msRedirectCode, offlineAccount } from './core/auth.js';
import * as instances from './core/instances.js';
import { ensureLoader, install, launch, loaderVersions, versionList } from './core/minecraft.js';
import * as modrinth from './core/modrinth.js';
import { readJson, useFetch, writeJson } from './core/net.js';
import { PACK_ID, packStatus, syncPack } from './core/pack.js';
import { checkUpdate, downloadUpdate } from './core/update.js';
import { parseAddress, ping } from './core/ping.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Своя папка: %APPDATA%\Shizolauncher занята старым лаунчером
const ROOT = process.env.SHIZO_DATA ?? path.join(app.getPath('appData'), 'ShizostanLauncher');
app.setPath('userData', path.join(ROOT, 'electron'));

useFetch((url, init) => net.fetch(url, init));

const brand = JSON.parse(readFileSync(path.join(here, '../../launcher.config.json'), 'utf8'));
const DEFAULTS = { memory: 4096, javaPath: '', jvmArgs: '', autoJoin: true, selected: null, current: PACK_ID, theme: 'sunset', accent: '', bgImage: '', bgBlur: 0, bgDim: 45, autoClean: true };
const HOSTS = { 'Серверы Minecraft': 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', Fabric: 'https://meta.fabricmc.net/v2/versions/loader', Modrinth: 'https://api.modrinth.com/v2/tag/loader', 'Ely.by': 'https://authserver.ely.by/' };
// Картинки с диска (скриншоты, свой фон) окно получает только через эту схему — прямого доступа к файлам у него нет
protocol.registerSchemesAsPrivileged([{ scheme: 'shizo', privileges: { standard: true, secure: true } }]);
const SETTING_KEYS = [...Object.keys(DEFAULTS), 'packUrl', 'serverAddress', 'azureClientId'];
const settingsFile = path.join(ROOT, 'settings.json');
const accountsFile = path.join(ROOT, 'accounts.bin');

let win;
let settings = {};
let accounts = [];
const jobs = new Map(); // id -> AbortController
const games = new Map(); // id экземпляра -> процесс игры

const config = () => ({ ...DEFAULTS, ...brand, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== '' && v != null)) });
const send = (channel, data) => win?.webContents.send(channel, data);
const publicAccount = ({ id, type, name, uuid, serverName }) => ({ id, type, name, uuid, serverName });

async function loadAccounts() {
  try {
    const raw = await fs.readFile(accountsFile);
    return JSON.parse((await safeStorage.isAsyncEncryptionAvailable()) ? (await safeStorage.decryptStringAsync(raw)).result : raw.toString());
  } catch {
    return [];
  }
}
async function saveAccounts() {
  const json = JSON.stringify(accounts);
  // Токены шифруются ключом ОС (DPAPI на Windows); без него (редкий Linux без keyring) — открытым текстом
  await fs.writeFile(accountsFile, (await safeStorage.isAsyncEncryptionAvailable()) ? await safeStorage.encryptStringAsync(json) : json);
}
async function saveSettings(patch) {
  for (const k of Object.keys(patch)) if (!SETTING_KEYS.includes(k)) throw new Error(`Неизвестная настройка: ${k}`);
  settings = { ...settings, ...patch };
  await writeJson(settingsFile, settings);
}
async function addAccount(acc) {
  accounts = [...accounts.filter((a) => a.id !== acc.id), acc];
  await saveAccounts();
  await saveSettings({ selected: acc.id });
  return publicAccount(acc);
}

async function job(id, fn) {
  if (jobs.has(id)) throw new Error('Эта операция уже выполняется');
  const ac = new AbortController();
  jobs.set(id, ac);
  let last = 0;
  const onProgress = (p) => {
    if (p.files !== p.totalFiles && Date.now() - last < 100) return; // не заваливаем окно событиями
    last = Date.now();
    send('progress', { id, ...p });
  };
  try {
    return await fn({ signal: ac.signal, onProgress });
  } finally {
    jobs.delete(id);
    send('progress', { id, done: true });
  }
}

const handlers = {
  async state() {
    return {
      config: config(),
      accounts: accounts.map(publicAccount),
      instances: await instances.listInstances(ROOT),
      running: [...games.keys()],
      busy: [...jobs.keys()],
      version: app.getVersion(),
      totalMem: Math.floor(os.totalmem() / 1048576),
      packId: PACK_ID,
      dataDir: ROOT,
    };
  },
  setSettings: (patch) => saveSettings(patch),

  // --- аккаунты ---
  addOffline: (name) => addAccount(offlineAccount(String(name).trim())),
  addEly: async (login, password, totp) => addAccount(await elyLogin(login, password, totp)),
  addCustom: async (server, login, password) => addAccount(await customLogin(server, login, password)),
  msLogin: () =>
    job('ms', ({ signal }) =>
      new Promise((resolve, reject) => {
        const clientId = config().azureClientId;
        const req = msAuthRequest(clientId);
        // Отдельная сессия в памяти: после входа в лаунчере не остаётся куки Microsoft
        const popup = new BrowserWindow({ parent: win, modal: true, width: 520, height: 720, title: 'Вход через Microsoft', autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { partition: `ms-login-${Date.now()}`, sandbox: true } });
        let done = false;
        const finish = (fn) => {
          if (done) return;
          done = true;
          if (!popup.isDestroyed()) popup.close();
          fn();
        };
        const watch = (e, url) => {
          let code;
          try {
            code = msRedirectCode(url, req.state);
          } catch (err) {
            e.preventDefault();
            return finish(() => reject(err));
          }
          if (!code) return;
          e.preventDefault();
          finish(() => msFinishLogin(clientId, code, req.verifier).then(addAccount).then(resolve, reject));
        };
        popup.webContents.on('will-redirect', watch);
        popup.webContents.on('will-navigate', watch);
        popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        popup.on('closed', () => finish(() => reject(new Error('Отменено'))));
        signal.addEventListener('abort', () => finish(() => reject(new Error('Отменено'))));
        popup.loadURL(req.url).catch(() => {}); // ошибки загрузки страницы видны в самом окне
      }),
    ),
  async removeAccount(id) {
    accounts = accounts.filter((a) => a.id !== id);
    await saveAccounts();
    if (settings.selected === id) await saveSettings({ selected: accounts[0]?.id ?? null });
  },

  // --- версии и экземпляры ---
  versions: async () => (await versionList()).versions.map(({ id, type }) => ({ id, type })),
  loaderVersions,
  async createInstance({ name, mc, type }) {
    // Версию загрузчика фиксируем сразу, чтобы экземпляр не менялся сам от запуска к запуску
    const loader = type && type !== 'vanilla' ? { type, version: (await loaderVersions(type, mc))[0] } : null;
    if (loader && !loader.version) throw new Error(`Для Minecraft ${mc} нет версии ${type} — выбери другую версию игры или другой загрузчик`);
    return instances.createInstance(ROOT, { name, mc, loader });
  },
  updateInstance: (id, { name, memory, jvmArgs, javaPath }) => instances.updateInstance(ROOT, id, { name, memory, jvmArgs, javaPath }),
  async removeInstance(id) {
    if (games.has(id) || jobs.has(id)) throw new Error('Сначала останови игру');
    await instances.removeInstance(ROOT, id);
  },
  async openFolder(id) {
    const dir = id ? instances.gameDir(ROOT, id) : ROOT;
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  },
  listScreenshots: (id) => instances.listScreenshots(ROOT, id),
  removeScreenshot: (id, file) => shell.trashItem(instances.screenshotFile(ROOT, id, file)), // в корзину, а не насовсем
  copyScreenshot: (id, file) => void clipboard.writeImage(nativeImage.createFromPath(instances.screenshotFile(ROOT, id, file))),
  showScreenshot: (id, file) => void shell.showItemInFolder(instances.screenshotFile(ROOT, id, file)),
  async openLogs(id) {
    const dir = path.join(instances.gameDir(ROOT, id), 'logs');
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  },

  // --- оформление ---
  async pickBackground() {
    const r = await dialog.showOpenDialog(win, { title: 'Картинка для фона', filters: [{ name: 'Картинки', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    const name = `background${path.extname(r.filePaths[0]).toLowerCase()}`;
    for (const old of (await fs.readdir(ROOT)).filter((f) => f.startsWith('background.'))) await fs.rm(path.join(ROOT, old));
    await fs.copyFile(r.filePaths[0], path.join(ROOT, name));
    await saveSettings({ bgImage: `${name}?v=${Date.now()}` }); // ?v — чтобы окно не показало старую картинку из кэша
    return config().bgImage;
  },

  // --- оптимизация, диагностика, чистка ---
  // С id — только посчитать для этого экземпляра (сохранит сам игрок), без id — выставить общие настройки
  async tune(id) {
    const total = Math.floor(os.totalmem() / 1048576);
    const mods = (await instances.listContent(ROOT, id ?? config().current, 'mods').catch(() => [])).length;
    const memory = recommendMemory(total, mods);
    const jvmArgs = recommendFlags(memory);
    if (!id) await saveSettings({ memory, jvmArgs });
    return { memory, jvmArgs, total, mods, cpus: os.cpus().length };
  },
  async checkup() {
    const cfg = config();
    const out = [];
    const add = (name, ok, text) => out.push({ name, ok, text });
    const total = Math.floor(os.totalmem() / 1048576);
    const free = Math.floor(os.freemem() / 1048576);
    add('Память', cfg.memory <= total - 1536 && cfg.memory <= free + 1024, `игре выделено ${cfg.memory} МБ, свободно сейчас ${free} из ${total} МБ`);
    const disk = await fs.statfs(ROOT).then((s) => Math.floor((s.bavail * s.bsize) / 1048576), () => null);
    if (disk != null) add('Место на диске', disk > 3072, `свободно ${(disk / 1024).toFixed(1)} ГБ`);
    if (cfg.javaPath) add('Своя Java', await fs.access(cfg.javaPath).then(() => true, () => false), cfg.javaPath);
    else add('Java', true, 'подбирается и скачивается автоматически');
    add('Аккаунт', !!accounts.find((a) => a.id === cfg.selected), accounts.find((a) => a.id === cfg.selected)?.name ?? 'не выбран');
    const urls = { ...HOSTS, ...(cfg.packUrl && { 'Сборка сервера': cfg.packUrl }) };
    await Promise.all(Object.entries(urls).map(async ([name, url]) => {
      const started = Date.now();
      const ok = await net.fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok, () => false);
      add(name, ok, ok ? `доступен, ${Date.now() - started} мс` : 'нет связи — проверь интернет или VPN/прокси');
    }));
    if (cfg.serverAddress) {
      const s = await ping(cfg.serverAddress).catch(() => null);
      add('Игровой сервер', !!s, s ? `${s.online} из ${s.max} игроков, пинг ${s.latency} мс` : 'не отвечает');
    }
    return out;
  },
  async cleanCache(dry) {
    if (jobs.size || games.size) throw new Error('Сначала закрой игру и дождись конца загрузок');
    return cleanCache(ROOT, { dry: !!dry });
  },

  listContent: (id, kind) => instances.listContent(ROOT, id, kind),
  toggleContent: (id, kind, file) => instances.toggleContent(ROOT, id, kind, file),
  removeContent: (id, kind, file) => instances.removeContent(ROOT, id, kind, file),

  // --- сборка сервера ---
  packStatus: () => packStatus(ROOT, config().packUrl),
  // Один повтор: единичный сбой сети не должен рисовать «сервер не отвечает»
  ping: () => ping(config().serverAddress).catch(() => ping(config().serverAddress)),

  // --- игра ---
  play(id) {
    if (games.has(id)) throw new Error('Игра уже запущена');
    return job(id, async (opts) => {
      const cfg = config();
      let account = accounts.find((a) => a.id === cfg.selected);
      if (!account) throw new Error('Сначала добавь аккаунт');
      const tail = []; // хвост журнала для разбора причин вылета
      const log = (text) => {
        tail.push(text);
        if (tail.length > 400) tail.shift();
        send('log', { id, text });
      };

      if (id === PACK_ID && cfg.packUrl) {
        try {
          await syncPack(ROOT, cfg.packUrl, opts);
        } catch (e) {
          // Без сети играем на уже установленной сборке
          if (opts.signal.aborted || !(await instances.getInstance(ROOT, id))?.pack) throw e;
          log(`[лаунчер] Сборку проверить не удалось (${e.message}) — запускаю установленную версию\n`);
        }
      }
      const inst = await instances.getInstance(ROOT, id);
      if (!inst) throw new Error(id === PACK_ID ? 'Сборка сервера ещё не настроена: укажи адрес pack.json в настройках' : 'Экземпляр не найден');

      account = await freshAccount(account, cfg);
      accounts = accounts.map((a) => (a.id === account.id ? account : a));
      await saveAccounts();

      const child = await launch({
        ...opts,
        root: ROOT,
        versionId: await ensureLoader(ROOT, inst.mc, inst.loader, { ...opts, javaPath: inst.javaPath || cfg.javaPath }),
        gameDir: instances.gameDir(ROOT, id),
        account,
        memory: inst.memory || cfg.memory,
        jvmArgs: (inst.jvmArgs || cfg.jvmArgs).split(/\s+/).filter(Boolean),
        javaPath: inst.javaPath || cfg.javaPath,
        server: id === PACK_ID && cfg.autoJoin && cfg.serverAddress ? parseAddress(cfg.serverAddress) : null,
        // authlib-injector направляет игру на нужный сервер авторизации: Ely.by или свой
        agent: await authAgent(ROOT, account),
        onLog: log,
      });
      games.set(id, child);
      const ended = (code) => {
        if (games.delete(id)) send('game', { id, running: false, code, problems: code ? diagnose(tail.join('')) : [] });
      };
      child.on('error', (e) => {
        log(`[лаунчер] Не удалось запустить Java: ${e.message}\n`);
        ended(-1);
      });
      child.on('exit', ended);
      await instances.updateInstance(ROOT, id, { lastPlayed: Date.now() });
      send('game', { id, running: true });
    });
  },
  stop: (id) => void games.get(id)?.kill(),
  cancel: (id) => void jobs.get(id)?.abort(),
  // Перепроверяет по хешам всё, без чего игра не запустится: моды сборки, загрузчик, библиотеки, ресурсы, Java.
  // Возвращает число восстановленных файлов — 0 значит, что всё действительно на месте.
  repair: (id) =>
    job(id, async (opts) => {
      const cfg = config();
      let restored = 0;
      if (id === PACK_ID && cfg.packUrl) restored += (await syncPack(ROOT, cfg.packUrl, opts)).restored;
      const inst = await instances.getInstance(ROOT, id);
      if (!inst) throw new Error('Экземпляр не найден');
      const javaPath = inst.javaPath || cfg.javaPath;
      if (javaPath && !(await fs.access(javaPath).then(() => true, () => false))) throw new Error(`Java не найдена по пути ${javaPath} — очисти поле «Путь к Java»`);
      const versionId = await ensureLoader(ROOT, inst.mc, inst.loader, { ...opts, javaPath, full: true });
      restored += (await install(ROOT, versionId, { ...opts, full: true, javaPath })).restored;
      return { restored };
    }),

  // --- Modrinth ---
  search: (params) => modrinth.search(params),
  contentInfo: (id) => modrinth.contentInfo(ROOT, id),
  updateContent(id, files) {
    if (id === PACK_ID) throw new Error('Моды сборки сервера обновляют админы — иначе на сервер не пустит');
    if (games.has(id)) throw new Error('Сначала закрой игру');
    return job(`update:${id}`, (opts) => modrinth.updateContent(ROOT, id, files, opts));
  },

  // --- обновление самого лаунчера ---
  checkUpdate: () => checkUpdate(config().updateRepo, app.getVersion()),
  installUpdate() {
    if (games.size) throw new Error('Сначала закрой игру');
    return job('update', async (opts) => {
      const info = await checkUpdate(config().updateRepo, app.getVersion());
      if (!info) throw new Error('Обновление уже не нужно');
      const file = await downloadUpdate(info, path.join(ROOT, 'updates'), { ...opts, onProgress: (p) => opts.onProgress({ ...p, label: `Обновление ${info.version}` }) });
      // Тихая установка поверх текущей версии, затем запуск новой. Делает это крошечный скрипт Windows Script Host:
      // флаг установщика --force-run ищет ярлык в «Пуске», которого в этот момент нет, а отдельно запущенный
      // PowerShell без консоли молча завершается. wscript — оконная программа, ей консоль не нужна.
      const helper = path.join(path.dirname(file), 'finish-update.js');
      const js = `var sh = new ActiveXObject('WScript.Shell');\nsh.Run(${JSON.stringify(`"${file}" /S`)}, 0, true);\nsh.Run(${JSON.stringify(`"${process.execPath}"`)}, 1, false);\n`;
      await fs.writeFile(helper, '\ufeff' + js, 'utf16le'); // UTF-16 с BOM: путь может быть на русском
      spawn('wscript.exe', ['//B', '//Nologo', helper], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
      setTimeout(() => app.quit(), 500);
    });
  },
  installProject: (id, projectId, type) => job(`mod:${projectId}`, (opts) => modrinth.installProject(ROOT, id, projectId, type, opts)),
  installModpack: (projectId) => job('modpack', (opts) => modrinth.installModpackProject(ROOT, projectId, opts)),
  async importMrpack() {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Модпак Modrinth', extensions: ['mrpack'] }], properties: ['openFile'] });
    return r.canceled ? null : job('modpack', (opts) => modrinth.installMrpack(ROOT, r.filePaths[0], opts));
  },
  async pickJava() {
    const r = await dialog.showOpenDialog(win, { title: 'Выбери java/javaw', properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  },
  async openExternal(url) {
    if (new URL(url).protocol !== 'https:') throw new Error('Разрешены только https-ссылки');
    await shell.openExternal(url);
  },
};

ipcMain.handle('api', (_event, name, ...args) => {
  if (!Object.hasOwn(handlers, name)) throw new Error(`Неизвестный метод: ${name}`);
  return handlers[name](...args);
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => win?.focus());
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  settings = await readJson(settingsFile, {});
  accounts = await loadAccounts();
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    backgroundColor: '#100a1c',
    icon: path.join(here, '../renderer/assets/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#cbbfe0', height: 40 },
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  protocol.handle('shizo', async (req) => {
    try {
      const url = new URL(req.url);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const file = url.hostname === 'shot' ? instances.screenshotFile(ROOT, parts[0], parts[1]) : url.hostname === 'bg' && /^background\.(png|jpe?g|webp)$/.test(parts[0]) ? path.join(ROOT, parts[0]) : null;
      if (!file) throw new Error('нет такого ресурса');
      return await net.fetch(pathToFileURL(file).href);
    } catch {
      return new Response('', { status: 404 });
    }
  });
  if (config().autoClean) cleanCache(ROOT).catch(() => {}); // тихо, при каждом запуске
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  await win.loadFile(path.join(here, '../renderer/index.html'));
});
