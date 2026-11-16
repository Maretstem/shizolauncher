// Интерфейс. Все внешние строки (Modrinth, MOTD, логи) попадают в DOM только как текст — innerHTML не используется.
/* global api — мост из preload.cjs */
const $ = (s) => document.querySelector(s);
const view = $('#view');
const dlg = $('#dlg');

let S; // состояние из главного процесса
let tab = 'home'; // home | mods | packs | accounts | settings
let sub = 'overview'; // overview | mods | resourcepacks | shaderpacks | console | options
let pack = null; // статус сборки сервера
let srv = null; // ответ пинга
const progress = {}; // id задачи -> прогресс
const logs = {}; // id экземпляра -> строки
const stopping = new Set(); // игры, которые остановил сам игрок
const browse = { type: 'mod', query: '', sort: 'relevance', category: '' };
const consoleView = { filter: '', level: 'all', follow: true };
let menuOpen = false; // выпадающее меню аккаунтов
let update = null; // доступное обновление лаунчера

const THEMES = { sunset: 'Закат', night: 'Ночь', forest: 'Лес', ember: 'Огонь', mono: 'Графит' };
const SORTS = { relevance: 'По релевантности', downloads: 'По загрузкам', follows: 'По подписчикам', newest: 'Сначала новые', updated: 'Недавно обновлённые' };
const CATEGORIES = { '': 'Все категории', optimization: 'Оптимизация', adventure: 'Приключения', decoration: 'Декор', equipment: 'Снаряжение', food: 'Еда', magic: 'Магия', mobs: 'Мобы', storage: 'Хранение', technology: 'Технологии', transportation: 'Транспорт', utility: 'Утилиты', worldgen: 'Генерация мира', library: 'Библиотеки' };

const ICONS = {
  play: 'M7 4.5v15l13-7.5z',
  stop: 'M7 7h10v10H7z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  plus: 'M12 5v14M5 12h14',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  chevron: 'M6 9l6 6 6-6',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  chat: 'M4 5h16v11H9l-5 4z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  check: 'M5 12l5 5 9-10',
  wand: 'M5 19L16 8M14 4v3M19 9h-3M18 5l-1.5 1.5M9 4l.7 1.8L11.5 6.5 9.7 7.2 9 9l-.7-1.8L6.5 6.5l1.8-.7z',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
};
const KIND = { mods: 'Моды', resourcepacks: 'Ресурспаки', shaderpacks: 'Шейдеры' };
const option = (map, value) => Object.entries(map).map(([v, label]) => h('option', { value: v, selected: v === value }, label));
const TYPE_KIND = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const ACCOUNT = { microsoft: 'Microsoft', ely: 'Ely.by', offline: 'Офлайн' };
const accountLabel = (a) => (a.type === 'custom' ? a.serverName || 'Свой сервер' : ACCOUNT[a.type]);
const LOADER = { fabric: 'Fabric', quilt: 'Quilt', neoforge: 'NeoForge', forge: 'Forge' };

// ---------- помощники ----------
function h(spec, attrs, ...kids) {
  const [tag, ...cls] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));
  return el;
}

const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false && x !== ''));

function icon(name, size = 18) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ic');
  if (name === 'play' || name === 'stop') svg.classList.add('fill');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

async function call(name, ...args) {
  try {
    return await api.call(name, ...args);
  } catch (e) {
    throw new Error(e.message.replace(/^Error invoking remote method '\w+': (\w*Error: )?/, ''));
  }
}

// Действие по кнопке: ошибка показывается уведомлением, а не теряется
async function act(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.message !== 'Отменено') toast(e.message, true);
  }
}

function toast(text, bad) {
  const el = h(`div.toast${bad ? '.bad' : ''}`, {}, text);
  $('#toast').append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 3500);
}

const compact = new Intl.NumberFormat('ru', { notation: 'compact' });
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} МБ`;
const loaderLabel = (i) => (i.loader ? `${LOADER[i.loader.type] ?? i.loader.type} ${i.loader.version ?? ''}`.trim() : 'Vanilla');

function entries() {
  const own = S.instances.find((i) => i.id === S.packId) ?? { id: S.packId, name: S.config.serverName, virtual: true };
  return [{ ...own, isPack: true }, ...S.instances.filter((i) => i.id !== S.packId)];
}
const cur = () => entries().find((i) => i.id === S.config.current) ?? entries()[0];
const account = () => S.accounts.find((a) => a.id === S.config.selected);

// Тема — набор переменных в styles.css; акцент и фон игрок задаёт сам
function applyStyle() {
  const c = S.config;
  const root = document.documentElement;
  root.dataset.theme = THEMES[c.theme] ? c.theme : 'sunset';
  for (const v of ['--pink', '--violet', '--grad']) root.style.removeProperty(v);
  if (/^#[0-9a-f]{6}$/i.test(c.accent)) {
    root.style.setProperty('--pink', c.accent);
    root.style.setProperty('--violet', c.accent);
    root.style.setProperty('--grad', `linear-gradient(180deg, ${c.accent}, color-mix(in srgb, ${c.accent} 62%, #000))`);
  }
  const bg = $('#bgimg');
  bg.style.backgroundImage = c.bgImage ? `url("shizo://bg/${c.bgImage}")` : '';
  bg.style.filter = `blur(${Number(c.bgBlur) || 0}px)`;
  root.style.setProperty('--bg-dim', String((Number(c.bgDim) || 0) / 100));
  $('#sky').classList.toggle('custom', !!c.bgImage);
}

async function refresh() {
  S = await call('state');
  applyStyle();
  render();
}

async function loadRemote() {
  pack = await call('packStatus').catch((e) => ({ error: e.message, configured: true }));
  srv = S.config.serverAddress ? await call('ping').catch(() => null) : null;
  if (tab === 'home') render();
  else renderSide();
  // Вышла новая версия сборки, а игра не запущена — докачиваем тихо, чтобы «Играть» запускал сразу
  const installed = S.instances.find((x) => x.id === S.packId)?.pack;
  if (pack?.updateAvailable && installed && S.config.bgUpdate !== false && !S.busy.includes(S.packId) && !S.running.includes(S.packId)) {
    call('prefetchPack')
      .then((v) => v && (toast(`Сборка обновлена до ${v} в фоне — миры и настройки сохранены в резервную копию`), refresh().then(loadRemote)))
      .catch(() => {}); // не вышло — обновится при нажатии «Играть»
  }
}

function avatar(acc) {
  const el = h('div.avatar', {}, acc ? acc.name[0].toUpperCase() : '?');
  if (acc?.type === 'ely') {
    const face = h('div.face');
    face.style.backgroundImage = `url("https://skinsystem.ely.by/skins/${encodeURIComponent(acc.name)}.png")`;
    el.append(face);
  } else if (acc?.type === 'microsoft') {
    el.append(h('img', { src: `https://mc-heads.net/avatar/${acc.uuid}/72`, alt: '', onerror: (e) => e.target.remove() }));
  }
  return el;
}

function tile(i) {
  return h('div.tile', {}, i.isPack ? h('img', { src: 'assets/sz.webp', alt: '' }) : i.name[0].toUpperCase());
}

function dialog(title, body, buttons) {
  dlg.replaceChildren(h('div.stack', {}, h('h3', {}, title), body, h('div.actions', {}, buttons)));
  dlg.showModal();
}
const closeBtn = (label = 'Отмена') => h('button.btn', { type: 'button', onclick: () => dlg.close() }, label);

function confirmDialog(title, text, label, fn) {
  dialog(title, h('p.muted', {}, text), [
    closeBtn(),
    h('button.btn.danger', { onclick: () => (dlg.close(), act(fn)) }, label),
  ]);
}

// ---------- каркас ----------
function render() {
  renderSide();
  renderTop();
  ({ home: viewHome, mods: viewBrowse, packs: viewPacks, accounts: viewAccounts, settings: viewSettings })[tab]();
}

function instStatus(i) {
  if (S.running.includes(i.id)) return ['ok', 'Запущено'];
  if (S.busy.includes(i.id)) return ['warn', 'Установка…'];
  if (!i.isPack) return ['', `${i.mc} · ${loaderLabel(i)}`];
  if (i.virtual) return ['', pack?.configured === false ? 'Не настроена' : 'Не установлена'];
  if (pack?.updateAvailable) return ['warn', `Обновление ${pack.latest}`];
  return ['ok', `Сборка ${i.pack?.version ?? ''}`];
}

function renderSide() {
  const active = cur().id;
  $('#inst-list').replaceChildren(
    ...entries().map((i) => {
      const [dot, text] = instStatus(i);
      return h(`button.inst${i.id === active && tab === 'home' ? '.on' : ''}`, { onclick: () => select(i.id) }, tile(i), h('span', {}, h('b', {}, i.name), h('small', {}, h(`i.dot${dot ? '.' + dot : ''}`), text)));
    }),
  );
  const { discord, telegram, site } = S.config.links ?? {};
  fill($('#side-foot'),
    discord && h('button.side-link.discord', { onclick: () => act(() => call('openExternal', discord)) }, icon('chat'), 'Вступить в Discord'),
    telegram && h('button.side-link', { onclick: () => act(() => call('openExternal', telegram)) }, icon('chat'), 'Telegram'),
    site && h('button.side-link', { onclick: () => act(() => call('openExternal', site)) }, icon('globe'), 'Сайт'),
    h('button.side-link', { onclick: () => act(() => call('openFolder')) }, icon('folder'), 'Папка лаунчера'),
    h('button.ver', { title: 'Проверить обновления', onclick: manualUpdateCheck }, `Лаунчер ${S.version}`),
  );
}

function renderTop() {
  const tabs = [['home', 'Главная'], ['mods', 'Моды'], ['packs', 'Модпаки']];
  $('#tabs').replaceChildren(...tabs.map(([id, label]) => h(`button.pill${tab === id ? '.on' : ''}`, { onclick: () => go(id) }, label)));
  const acc = account();
  const pick = (id) => act(async () => (await call('setSettings', { selected: id }), (menuOpen = false), await refresh()));
  const item = (attrs, ...kids) => h('button.menu-item', { role: 'menuitem', ...attrs }, kids);
  fill($('#top-right'),
    update && h('button.btn.primary', { onclick: updateDialog, title: 'Вышла новая версия лаунчера' }, icon('refresh', 16), `Обновление ${update.version}`),
    h('div.acct-wrap', { onclick: (e) => e.stopPropagation() },
      h('button.acct.glass', { 'aria-haspopup': 'menu', 'aria-expanded': String(menuOpen), title: 'Аккаунты', onclick: () => ((menuOpen = !menuOpen), renderTop()) },
        avatar(acc), h('span', {}, h('b', {}, acc?.name ?? 'Нет аккаунта'), h('small', {}, acc ? accountLabel(acc) : 'Войти')), icon('chevron', 16)),
      menuOpen && h('div.menu.glass', { role: 'menu' },
        S.accounts.map((a) => item({ onclick: () => pick(a.id) }, avatar(a), h('span', {}, h('b', {}, a.name), h('small', {}, accountLabel(a))), a.id === S.config.selected && icon('check', 16))),
        S.accounts.length > 0 && h('hr'),
        item({ onclick: () => ((menuOpen = false), renderTop(), addAccount()) }, icon('plus'), 'Добавить аккаунт'),
        item({ onclick: () => go('accounts') }, icon('sliders'), 'Управление аккаунтами'),
      ),
    ),
    h('button.icon-btn.glass', { onclick: () => go('settings'), title: 'Настройки', 'aria-label': 'Настройки' }, icon('sliders', 20)),
  );
}

// Один диалог на все способы входа
function addAccount() {
  const way = (title, text, fn) => h('button.way.glass', { onclick: fn }, h('b', {}, title), h('span', {}, text));
  dialog('Добавить аккаунт',
    h('div.stack', {},
      S.config.azureClientId
        ? way('Microsoft', 'Лицензионный аккаунт Minecraft', loginMicrosoft)
        : h('div.way.glass.off', { 'aria-disabled': 'true' }, h('b', {}, 'Microsoft'), h('span', {}, 'Скоро: ждём, пока Microsoft одобрит лаунчер. Пока используй Ely.by или офлайн.')),
      way('Ely.by', 'Бесплатный аккаунт со скинами', () => loginEly()),
      way('Свой сервер', 'Сервер авторизации со скинами: LittleSkin, Blessing Skin и другие', loginCustom),
      way('Офлайн', 'Только ник, без пароля', loginOffline),
    ),
    [closeBtn()]);
}

async function manualUpdateCheck() {
  toast('Проверяю обновления…');
  try {
    const u = await checkLauncherUpdate();
    if (u) updateDialog();
    else toast(`У тебя последняя версия — ${S.version}`);
  } catch (e) {
    toast(`Не удалось проверить: ${e.message}. Проверь интернет или VPN.`, true);
  }
}

function updateDialog() {
  dialog(`Обновление лаунчера ${update.version}`,
    h('div.stack', {}, h('pre.changelog', {}, update.notes || 'Новая версия лаунчера.'), h('p.muted', { id: 'upd-status' }, `Размер ${mb(update.size)}. Лаунчер скачает обновление, установит его и перезапустится сам.`)),
    [closeBtn('Позже'), h('button.btn.primary', { onclick: (e) => ((e.target.disabled = true), act(() => call('installUpdate'))) }, 'Обновить сейчас')]);
}

function go(next) {
  tab = next;
  menuOpen = false;
  render();
  view.scrollTop = 0;
}

async function select(id) {
  tab = 'home';
  sub = 'overview';
  S.config.current = id;
  render();
  await act(() => call('setSettings', { current: id }));
}

// ---------- главная: герой выбранной сборки ----------
function playButton(i) {
  if (S.running.includes(i.id)) return h('button.play.alt', { onclick: () => (stopping.add(i.id), call('stop', i.id)) }, icon('stop', 22), 'Остановить');
  if (S.busy.includes(i.id)) return h('button.play.alt', { onclick: () => call('cancel', i.id) }, icon('stop', 22), 'Отмена');
  let label = 'Играть';
  if (i.isPack && i.virtual) label = 'Установить';
  else if (i.isPack && pack?.updateAvailable) label = 'Обновить и играть';
  const blocked = i.isPack && i.virtual && !S.config.packUrl;
  return h('button.play', { disabled: blocked, onclick: () => play(i.id) }, icon('play', 22), label);
}

async function play(id, force) {
  if (!account()) {
    toast('Сначала добавь аккаунт');
    return go('accounts');
  }
  S.busy.push(id);
  render();
  const r = await act(() => call('play', id, force));
  await refresh();
  loadRemote();
  if (r?.problems) modProblems(id, r.problems, true);
}

// Что нашла проверка модов. canPlay — показать кнопку «Всё равно играть».
function modProblems(id, problems, canPlay) {
  dlg.classList.add('wide');
  dialog(problems.length ? `Проверка модов: найдено проблем — ${problems.length}` : 'Проверка модов: всё в порядке',
    h('div.stack', {},
      h('p.muted', {}, 'Это то, из-за чего игра обычно вылетает при запуске. Лучше исправить сейчас, чем ждать вылета.'),
      h('div.rows.scroll', {}, problems.map((p, n) => h('div.row', {}, h('span.n', {}, String(n + 1).padStart(2, '0')), h('div.body', {}, h('b.wrap', {}, p.text), h('span.wrap', {}, p.fix))))),
    ),
    [
      canPlay && h('button.btn', { onclick: () => (dlg.close(), play(id, true)) }, 'Всё равно играть'),
      h('button.btn.primary', { onclick: () => (dlg.close(), select(id).then(() => ((sub = 'mods'), render()))) }, 'Открыть моды'),
    ]);
}

function paintProgress() {
  const box = $('#prog');
  if (!box) return;
  const p = progress[box.dataset.id];
  const bar = box.querySelector('.bar');
  if (!p) {
    bar.classList.add('wait');
    box.querySelector('span').textContent = 'Подготовка…';
    return;
  }
  const ratio = p.totalBytes ? p.bytes / p.totalBytes : p.totalFiles ? p.files / p.totalFiles : 0;
  bar.classList.remove('wait');
  bar.firstChild.style.width = `${(ratio * 100).toFixed(1)}%`;
  const size = p.totalBytes ? ` · ${mb(p.bytes)} из ${mb(p.totalBytes)}` : '';
  box.querySelector('span').textContent = `${p.label ?? 'Загрузка'} · файлов ${p.files} из ${p.totalFiles}${size}`;
}

function subtitle(i) {
  if (S.running.includes(i.id)) return 'Игра запущена. Приятной игры!';
  if (!i.isPack) return i.lastPlayed ? `Последний запуск: ${new Date(i.lastPlayed).toLocaleString('ru')}` : 'Ещё ни разу не запускался';
  if (srv) return `${srv.online} из ${srv.max} сейчас на сервере · пинг ${srv.latency} мс`;
  if (S.config.serverAddress) return 'Сервер сейчас не отвечает';
  return 'Официальная сборка сервера: ставится и обновляется одной кнопкой';
}

function viewHome() {
  const i = cur();
  const busy = S.busy.includes(i.id);
  const mc = i.mc ?? pack?.minecraft;
  const subs = [['overview', 'Обзор'], ...(i.virtual ? [] : [...Object.entries(KIND), ['shots', 'Скриншоты']]), ['console', 'Консоль'], ...(i.virtual ? [] : [['options', 'Параметры']])];
  if (!subs.some(([id]) => id === sub)) sub = 'overview';

  fill(view,
    h('div.chips', {},
      h('span.chip.hot', {}, i.isPack ? 'Сервер' : 'Экземпляр'),
      mc && h('span.chip', {}, `Minecraft ${mc}`),
      (i.loader ?? pack?.loader) && h('span.chip', {}, loaderLabel({ loader: i.loader ?? pack.loader })),
    ),
    i.isPack ? h('img.hero-logo', { src: 'assets/logo.webp', alt: S.config.serverName }) : h('h1', {}, tile(i), i.name),
    h('p.sub', {}, subtitle(i)),
    i.isPack && srv?.players?.length > 0 && h('div.online', {}, h('span.muted', {}, 'Сейчас играют:'), srv.players.map((n) => h('span.chip', {}, h('img', { src: `https://mc-heads.net/avatar/${encodeURIComponent(n)}/32`, alt: '', onerror: (e) => e.target.remove() }), n)), srv.online > srv.players.length && h('span.muted', {}, `и ещё ${srv.online - srv.players.length}`)),
    h('div.actions', {},
      playButton(i),
      h('div.box.glass', {}, h('small', {}, i.isPack ? 'Сборка' : 'Версия'), h('b', {}, i.isPack ? (i.pack?.version ?? pack?.latest ?? '—') : `${i.mc} · ${loaderLabel(i)}`)),
      i.isPack && S.config.serverAddress && h('label.box.glass.joinbox', { title: 'После запуска игра сама подключится к серверу' },
        h('small', {}, 'Сразу на сервер'),
        h('button.switch', { role: 'switch', 'aria-checked': String(!!S.config.autoJoin), 'aria-label': 'Сразу заходить на сервер', onclick: () => act(async () => (await call('setSettings', { autoJoin: !S.config.autoJoin }), refresh())) })),
      !i.virtual && h('button.sq.glass', { title: 'Открыть папку игры', 'aria-label': 'Открыть папку игры', onclick: () => act(() => call('openFolder', i.id)) }, icon('folder', 22)),
    ),
    busy && h('div.progress', { id: 'prog' }, h('div.bar.wait', {}, h('div')), h('span.muted', {}, 'Подготовка…')),
    h('nav.pills.glass.tabs2', {}, subs.map(([id, label]) => h(`button.pill${sub === id ? '.on' : ''}`, { onclick: () => ((sub = id), render()) }, id === 'console' && icon('terminal', 16), label))),
  );
  if (busy) {
    $('#prog').dataset.id = i.id;
    paintProgress();
  }
  if (sub === 'overview') panelOverview(i);
  else if (sub === 'console') panelConsole(i);
  else if (sub === 'shots') panelShots(i);
  else if (sub === 'options') panelOptions(i);
  else panelContent(i, sub);
}

const lineLevel = (l) => (/\/(ERROR|FATAL)\]|Exception|^\s+at |\[лаунчер\] Не/.test(l) ? 'err' : /\/WARN\]/.test(l) ? 'warn' : '');
const lineShown = (l) => (consoleView.level === 'all' || lineLevel(l) === 'err' || (consoleView.level === 'warn' && lineLevel(l) === 'warn')) && (!consoleView.filter || l.toLowerCase().includes(consoleView.filter));
const logLine = (l) => h(`div${lineLevel(l) ? '.' + lineLevel(l) : ''}`, {}, l);

// full=false — короткий хвост на «Обзоре» (без фильтров); full=true — вся консоль
function logBox(id, lines, full) {
  const all = logs[id] ?? [];
  const shown = (full ? all.filter(lineShown) : all).slice(-lines);
  const pre = h(`div.log${full ? '.tall' : ''}`, { id: 'console', role: 'log', tabIndex: 0 }, shown.length ? shown.map(logLine) : h('div.muted', {}, all.length ? 'Под фильтр ничего не подходит.' : 'Журнал появится после запуска игры.'));
  pre.dataset.id = id;
  pre.dataset.lines = lines;
  if (full) pre.dataset.full = '1';
  // Игрок прокрутил вверх, чтобы прочитать или выделить, — не дёргаем его вниз
  pre.addEventListener('scroll', () => (consoleView.follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40));
  queueMicrotask(() => (pre.scrollTop = pre.scrollHeight));
  return pre;
}

function panelConsole(i) {
  const redraw = () => $('#console').replaceWith(logBox(i.id, 1500, true));
  const copy = (text, what) => (navigator.clipboard.writeText(text), toast(`${what} в буфере обмена`));
  view.append(
    h('section.panel.glass', {},
      h('div.panel-head', {}, h('h3', {}, 'Журнал игры'), h('span.muted', { id: 'log-count' }, `${(logs[i.id] ?? []).length} строк`)),
      h('div.searchbar', {},
        h('input', { type: 'search', placeholder: 'Фильтр по тексту…', value: consoleView.filter, 'aria-label': 'Фильтр журнала', oninput: (e) => ((consoleView.filter = e.target.value.toLowerCase()), redraw()) }),
        h('nav.pills.glass', {}, [['all', 'Всё'], ['warn', 'Предупреждения'], ['err', 'Ошибки']].map(([lv, label]) => h(`button.pill${consoleView.level === lv ? '.on' : ''}`, { onclick: () => ((consoleView.level = lv), render()) }, label))),
      ),
      logBox(i.id, 1500, true),
      h('div.actions', {},
        h('button.btn.primary', { onclick: () => copy((logs[i.id] ?? []).filter(lineShown).join('\n'), 'Журнал') }, 'Скопировать всё'),
        h('button.btn', { onclick: () => copy((logs[i.id] ?? []).filter((l) => lineLevel(l) === 'err').join('\n') || 'Ошибок нет', 'Ошибки') }, 'Скопировать ошибки'),
        !i.virtual && h('button.btn', { onclick: () => act(() => call('openLogs', i.id)) }, icon('folder', 16), 'Файлы журналов'),
        h('button.btn', { onclick: () => ((logs[i.id] = []), render()) }, 'Очистить'),
        h('span.muted', {}, 'Текст можно выделять мышью и копировать Ctrl+C.'),
      ),
    ),
  );
}

// ---------- галерея скриншотов ----------
async function panelShots(i) {
  const section = h('section.panel.glass', {}, h('div.panel-head', {}, h('h3', {}, 'Скриншоты'), h('span.muted', {}, 'F2 в игре — сделать снимок')));
  view.append(section);
  const shots = (await act(() => call('listScreenshots', i.id))) ?? [];
  if (!section.isConnected) return;
  const src = (s) => `shizo://shot/${i.id}/${encodeURIComponent(s.file)}`;
  const again = () => (dlg.close(), section.remove(), panelShots(i));
  const open = (s) => dialog(new Date(s.time).toLocaleString('ru'), h('img.shot-big', { src: src(s), alt: s.file }), [
    h('button.btn.danger', { onclick: () => act(() => call('removeScreenshot', i.id, s.file)).then(again) }, 'В корзину'),
    h('button.btn', { onclick: () => act(() => call('showScreenshot', i.id, s.file)) }, 'Показать в папке'),
    h('button.btn', { onclick: () => act(async () => (await call('copyScreenshot', i.id, s.file), toast('Скриншот в буфере обмена'))) }, 'Скопировать'),
    closeBtn('Закрыть'),
  ]);
  section.append(
    shots.length
      ? h('div.gallery', {}, shots.map((s) => h('button.shot', { title: s.file, 'aria-label': `Скриншот ${s.file}`, onclick: () => (dlg.classList.add('wide'), open(s)) }, h('img', { src: src(s), alt: '', loading: 'lazy' }))))
      : h('div.empty', {}, 'Скриншотов пока нет. Нажми F2 в игре.'),
  );
}

function row(n, title, text, button) {
  return h('div.row', {}, h('span.n', {}, String(n).padStart(2, '0')), h('div.body', {}, h('b', {}, title), h('span', {}, text)), button);
}
const linkBtn = (label, fn) => h('button.link', { onclick: fn }, label);

function panelOverview(i) {
  const cfg = S.config;
  const acc = account();
  const rows = [];
  if (i.isPack) {
    let text = `Версия ${i.pack?.version} — актуальная`;
    let button = linkBtn('Проверить файлы', () => repair(i.id));
    if (!cfg.packUrl) [text, button] = ['Адрес сборки не задан: укажи ссылку на pack.json в настройках', linkBtn('Настройки', () => go('settings'))];
    else if (!pack) [text, button] = ['Проверяю версию…', null];
    else if (pack.error) [text, button] = [`Не удалось проверить: ${pack.error}`, linkBtn('Повторить', loadRemote)];
    else if (i.virtual) [text, button] = [`Доступна версия ${pack.latest} — нажми «Установить»`, null];
    else if (pack.updateAvailable) [text, button] = [`Установлена ${i.pack?.version}, доступна ${pack.latest}`, linkBtn('Обновить', () => play(i.id))];
    rows.push(['Сборка', text, button]);
  } else {
    rows.push(['Версия', `Minecraft ${i.mc} · ${loaderLabel(i)}`, linkBtn('Проверить файлы', () => repair(i.id))]);
  }
  rows.push(['Аккаунт', acc ? `${acc.name} · ${accountLabel(acc)}` : 'Не выбран — без аккаунта игра не запустится', linkBtn('Аккаунты', () => go('accounts'))]);
  if (i.isPack && cfg.serverAddress) {
    rows.push(['Сервер', srv ? `${cfg.serverAddress} · ${srv.motd || srv.version}` : `${cfg.serverAddress} · не отвечает`, linkBtn('Скопировать IP', () => (navigator.clipboard.writeText(cfg.serverAddress), toast('IP скопирован')))]);
  }
  rows.push(['Запуск', `${i.memory || cfg.memory} МБ памяти · Java ${i.javaPath || cfg.javaPath ? 'своя' : 'подбирается автоматически'}`, i.virtual ? linkBtn('Настройки', () => go('settings')) : linkBtn('Параметры', () => ((sub = 'options'), render()))]);

  const main = h('section.panel.glass', {},
    h('h3', {}, 'Состояние'),
    h('div.rows', {}, rows.map(([t, text, b], n) => row(n + 1, t, text, b))),
    h('div.panel-head', {}, h('h3', {}, 'Журнал игры'), linkBtn('Вся консоль', () => ((sub = 'console'), render()))),
    logBox(i.id, 8),
  );
  const past = (i.isPack && pack?.history) || [];
  const news = (i.isPack && pack?.news) || [];
  const notes = i.isPack && (pack?.changelog || past.length || news.length);
  view.append(notes
    ? h('div.cols', {}, main, h('div.side-stack', {},
      news.length > 0 && h('section.panel.glass', {}, h('h3', {}, 'Новости сервера'), h('div.history', {}, news.map((n) => h('div', {}, n.date && h('span.muted', {}, new Date(n.date).toLocaleDateString('ru')), h('pre.changelog', {}, n.text))))),
      h('section.panel.glass', {},
        h('h3', {}, `Что нового в ${pack.latest}`),
        h('pre.changelog', {}, pack.changelog || 'Без описания.'),
        past.length > 1 && h('h3', {}, 'Прошлые версии'),
        past.length > 1 && h('div.history', {}, past.filter((p) => p.version !== pack.latest).map((p) => h('div', {}, h('b', {}, p.version), h('span.muted', {}, p.date ? ` · ${new Date(p.date).toLocaleDateString('ru')}` : ''), h('pre.changelog', {}, p.changelog || 'Без описания.')))),
      )))
    : main);
}

async function repair(id) {
  S.busy.push(id);
  render();
  const r = await act(() => call('repair', id));
  if (r) toast(r.restored ? `Не хватало файлов: ${r.restored} — все восстановлены` : 'Проверены игра, библиотеки, ресурсы, Java, загрузчик и моды сборки — всё на месте');
  await refresh();
}

async function panelContent(i, kind) {
  const section = h('section.panel.glass', {}, h('div.panel-head', {}, h('h3', {}, KIND[kind]), h('div.inline', {}, kind === 'mods' && i.loader && h('button.btn', { onclick: () => act(async () => { const r = await call('checkMods', i.id); r.problems.length ? modProblems(i.id, r.problems, false) : toast(`Проверено модов: ${r.checked} — проблем не найдено`); }) }, icon('check', 16), 'Проверить моды'), h('button.btn', { onclick: () => ((browse.type = Object.keys(TYPE_KIND).find((t) => TYPE_KIND[t] === kind)), go('mods')) }, icon('plus', 16), 'Найти на Modrinth'))));
  view.append(section);
  // Для своих экземпляров моды опознаются на Modrinth — так видно, что можно обновить. Сборку сервера обновляют админы.
  const smart = kind === 'mods' && !i.isPack;
  const loading = smart && h('div.empty', {}, 'Сверяю моды с Modrinth…');
  if (loading) section.append(loading);
  const files = (smart ? await call('contentInfo', i.id).catch(() => null) : null) ?? (await act(() => call('listContent', i.id, kind))) ?? [];
  if (!section.isConnected) return;
  loading?.remove?.();
  const again = () => (section.remove(), panelContent(i, kind));
  const upgrade = (only, btn) => act(async () => {
    btn.disabled = true;
    const n = await call('updateContent', i.id, only);
    toast(n ? `Обновлено модов: ${n}` : 'Обновлять нечего');
  }).then(again);
  const stale = files.filter((f) => f.update);
  if (stale.length) section.querySelector('.panel-head').append(h('button.btn.primary', { onclick: (e) => upgrade(null, e.currentTarget) }, icon('refresh', 16), `Обновить все (${stale.length})`));
  if (i.isPack && kind === 'mods') section.append(h('p.muted', {}, 'Ненужный мод можно выключить переключателем — при обновлениях сборки он останется выключенным. Не выключай моды, без которых сервер не пустит: обычно это библиотеки и моды с новыми блоками и предметами.'))
  section.append(
    files.length
      ? h('div.rows', {}, files.map((f, n) =>
          h('div.row', {},
            h('span.n', {}, String(n + 1).padStart(2, '0')),
            h('div.body', {}, h('b', {}, f.file.replace(/\.disabled$/, '')), h('span', {}, [mb(f.size), f.version && `версия ${f.version}`, f.update && `доступна ${f.update.version}`].filter(Boolean).join(' · '))),
            f.update && h('button.btn', { onclick: (e) => upgrade([f.file], e.currentTarget) }, 'Обновить'),
            h('button.switch', { role: 'switch', 'aria-checked': String(f.enabled), 'aria-label': `Включить ${f.file}`, onclick: () => act(() => call('toggleContent', i.id, kind, f.file)).then(again) }),
            h('button.ghost-btn', { title: 'Удалить', 'aria-label': `Удалить ${f.file}`, onclick: () => act(() => call('removeContent', i.id, kind, f.file)).then(again) }, icon('trash')),
          )))
      : h('div.empty', {}, 'Пока пусто. Добавь что-нибудь с Modrinth или положи файлы в папку игры.'),
  );
}

function panelOptions(i) {
  const name = h('input', { type: 'text', value: i.name, maxLength: 40, disabled: i.isPack });
  const memory = h('input', { type: 'number', min: 1024, max: S.totalMem, step: 256, value: i.memory ?? '', placeholder: `Общая настройка: ${S.config.memory}` });
  const jvm = h('input', { type: 'text', value: i.jvmArgs ?? '', placeholder: 'Например: -XX:+UseZGC' });
  const java = h('input', { type: 'text', value: i.javaPath ?? '', placeholder: 'Пусто — лаунчер сам скачает нужную Java' });
  const save = () =>
    act(async () => {
      await call('updateInstance', i.id, { name: name.value.trim() || i.name, memory: Number(memory.value) || undefined, jvmArgs: jvm.value.trim(), javaPath: java.value.trim() });
      toast('Сохранено');
      await refresh();
    });
  view.append(
    h('section.panel.glass', {},
      h('h3', {}, 'Параметры экземпляра'),
      h('div.form', {},
        h('label.field', {}, 'Название', name),
        h('label.field', {}, 'Память, МБ', memory),
        h('label.field.wide', {}, 'Аргументы JVM', jvm),
        h('label.field.wide', {}, 'Путь к Java', java),
      ),
      h('div.toolbar', {},
        h('button.tool.go', { onclick: save }, icon('save', 20), h('span', {}, h('b', {}, 'Сохранить'), h('small', {}, 'применится при следующем запуске'))),
        h('button.tool', { onclick: () => act(async () => {
          const t = await call('tune', i.id);
          memory.value = t.memory;
          jvm.value = t.jvmArgs;
          java.value = '';
          toast(`Подобрано под ${t.total} МБ ОЗУ и ${t.mods} модов: ${t.memory} МБ, Java — автоматически. Нажми «Сохранить».`);
        }) }, icon('wand', 20), h('span', {}, h('b', {}, 'Подобрать автоматически'), h('small', {}, 'память, флаги и Java'))),
        h('button.tool', { onclick: () => repair(i.id) }, icon('check', 20), h('span', {}, h('b', {}, 'Проверить файлы'), h('small', {}, 'найти и восстановить повреждённые'))),
        h('button.tool.danger', {
          onclick: () =>
            confirmDialog(`Удалить «${i.name}»?`, 'Папка экземпляра удалится целиком: миры, скриншоты, моды и настройки. Вернуть будет нельзя.', 'Удалить навсегда', async () => {
              await call('removeInstance', i.id);
              await select(S.packId);
              await refresh();
              loadRemote();
            }),
        }, icon('trash', 20), h('span', {}, h('b', {}, i.isPack ? 'Удалить сборку' : 'Удалить экземпляр'), h('small', {}, 'вместе с мирами и настройками'))),
      ),
    ),
  );
  panelExtras(i);
}

// Режим слабого ПК, перенос из других лаунчеров и резервные копии
async function panelExtras(i) {
  const low = !!i.lowEnd;
  const toggleLow = (btn) => act(async () => {
    btn.disabled = true;
    toast(low ? 'Возвращаю прежние настройки…' : 'Ставлю моды оптимизации и облегчаю графику…');
    const r = await call('lowEnd', i.id, !low);
    toast(low ? 'Режим слабого ПК выключен — всё как было' : `Режим слабого ПК включён${r?.added?.length ? `: добавлено модов — ${r.added.length}` : ''}${r?.skipped?.length ? `, недоступны для этой версии: ${r.skipped.join(', ')}` : ''}`);
    await refresh();
  });
  const backups = h('div.rows');
  const section = h('section.panel.glass', {},
    h('div.row', {},
      h('div.body', {}, h('b', {}, 'Режим слабого ПК'), h('span.wrap', {}, i.loader ? 'Добавит моды оптимизации (Sodium, Lithium, FerriteCore и др.) и облегчит графику: дальность 6 чанков, быстрая графика, без теней и облаков. Выключение вернёт всё как было.' : 'Облегчит графику: дальность 6 чанков, быстрая графика, без теней и облаков. Моды оптимизации нужен загрузчик модов.')),
      h('button.switch', { role: 'switch', 'aria-checked': String(low), 'aria-label': 'Режим слабого ПК', onclick: (e) => toggleLow(e.currentTarget) }),
    ),
    h('div.row', {},
      h('div.body', {}, h('b', {}, 'Перенос из другого лаунчера'), h('span.wrap', {}, 'Миры, скриншоты, ресурспаки и настройки из TLauncher, Prism, CurseForge, Modrinth и других. Ничего не перезаписывается.')),
      h('button.btn', { onclick: () => importDialog(i) }, 'Перенести…'),
    ),
    h('div.panel-head', {}, h('h3', {}, 'Резервные копии миров и настроек'), h('button.btn', { onclick: () => act(async () => { toast((await call('makeBackup', i.id)) ? 'Копия сохранена' : 'Пока нечего сохранять — миров и настроек ещё нет'); drawBackups(); }) }, 'Сделать копию')),
    h('p.muted', {}, i.isPack ? 'Копия делается сама перед каждым обновлением сборки. Хранятся последние 5.' : 'Хранятся последние 5 копий.'),
    backups,
  );
  view.append(section);
  const drawBackups = async () => {
    const list = (await act(() => call('listBackups', i.id))) ?? [];
    backups.replaceChildren(...(list.length ? list.map((b) => h('div.row', {},
      h('div.body', {}, h('b', {}, new Date(b.at).toLocaleString('ru')), h('span', {}, `${b.label} · ${b.items.join(', ')}`)),
      h('button.btn', { onclick: () => confirmDialog('Восстановить копию?', `Миры и настройки вернутся к состоянию на ${new Date(b.at).toLocaleString('ru')}. Текущие перед этим тоже сохранятся в копию — откат можно отменить.`, 'Восстановить', async () => { await call('restoreBackup', i.id, b.name); toast('Восстановлено'); drawBackups(); }) }, 'Восстановить'),
    )) : [h('div.empty', {}, 'Копий пока нет.')]));
  };
  drawBackups();
}

async function importDialog(i) {
  dialog('Перенос из другого лаунчера', h('p.muted', {}, 'Ищу другие лаунчеры на компьютере…'), [closeBtn()]);
  const sources = (await act(() => call('importSources'))) ?? [];
  if (!dlg.open) return;
  if (!sources.length) return dialog('Перенос из другого лаунчера', h('p.muted', {}, 'Не нашёл других лаунчеров с мирами или скриншотами. Поддерживаются TLauncher, официальный лаунчер, Prism, MultiMC, CurseForge, Modrinth App, ATLauncher, FreesmLauncher.'), [closeBtn('Понятно')]);
  const pick = h('select', { 'aria-label': 'Откуда переносить' }, sources.map((s) => h('option', { value: s.index }, `${s.launcher} · ${s.name} — миров: ${s.worlds}, скриншотов: ${s.shots}`)));
  const opts = h('input', { type: 'checkbox' });
  dialog(`Перенос в «${i.name}»`,
    h('div.stack', {}, h('label.field', {}, 'Откуда', pick), h('label.check', {}, opts, 'Перенести и настройки игры (управление, графика, звук) — заменят текущие'), h('p.muted', {}, 'Миры с одинаковыми названиями не перезапишутся — к новым добавится «(перенос)».')),
    [closeBtn(), h('button.btn.primary', { onclick: (e) => {
      e.currentTarget.disabled = true;
      act(async () => {
        const r = await call('importFrom', Number(pick.value), i.id, opts.checked);
        dlg.close();
        toast(`Перенесено: миров — ${r.worlds}, скриншотов — ${r.shots}, ресурспаков — ${r.packs}${r.options ? ', настройки' : ''}`);
      });
    } }, 'Перенести')]);
}

// ---------- Modrinth: моды для выбранного экземпляра ----------
function resultRow(hit, n, button) {
  return h('div.row', {},
    h('span.n', {}, String(n + 1).padStart(2, '0')),
    hit.icon ? h('img.pic', { src: hit.icon, alt: '', loading: 'lazy' }) : h('div.tile', {}, hit.title[0]),
    h('div.body', {}, h('b', {}, hit.title), h('span.clamp', {}, hit.description), h('span', {}, `${hit.author} · ${compact.format(hit.downloads)} загрузок`)),
    button,
  );
}

function searchPanel(title, hint, controls, runSearch, makeButton) {
  const list = h('div.rows');
  const input = h('input', { type: 'search', placeholder: 'Поиск на Modrinth…', value: browse.query, 'aria-label': 'Поиск' });
  let timer;
  let shown = 0;
  const more = h('button.btn', { onclick: () => run(true) }, 'Показать ещё');
  const run = async (append) => {
    browse.query = input.value;
    if (!append) (shown = 0), list.replaceChildren(h('div.empty', {}, 'Ищу…'));
    more.disabled = true;
    const hits = await act(() => runSearch(input.value, shown));
    more.disabled = false;
    if (!list.isConnected) return;
    if (!append) list.replaceChildren();
    if (!hits?.length && !shown) list.append(h('div.empty', {}, hits ? 'Ничего не нашлось.' : 'Не удалось загрузить список.'));
    list.append(...(hits ?? []).map((hit, n) => resultRow(hit, shown + n, makeButton(hit))));
    shown += hits?.length ?? 0;
    more.hidden = (hits?.length ?? 0) < 30; // пришла неполная страница — дальше пусто
  };
  input.addEventListener('input', () => (clearTimeout(timer), (timer = setTimeout(() => run(), 350))));
  const filters = h('div.searchbar', {},
    h('select', { 'aria-label': 'Сортировка', onchange: (e) => ((browse.sort = e.target.value), run()) }, option(SORTS, browse.sort)),
    h('select', { 'aria-label': 'Категория', onchange: (e) => ((browse.category = e.target.value), run()) }, option(CATEGORIES, browse.category)),
  );
  view.replaceChildren(h('h2', {}, title), h('p.sub', {}, hint), h('div.searchbar', {}, input, controls), filters, h('section.panel.glass', {}, list, more));
  run();
}

function viewBrowse() {
  const i = cur();
  if (i.virtual) {
    view.replaceChildren(h('h2', {}, 'Моды'), h('p.sub', {}, 'Сначала установи сборку сервера или выбери экземпляр слева — моды ставятся в выбранную сборку.'));
    return;
  }
  const types = h('nav.pills.glass', {}, [['mod', 'Моды'], ['resourcepack', 'Ресурспаки'], ['shader', 'Шейдеры']].map(([t, label]) => h(`button.pill${browse.type === t ? '.on' : ''}`, { onclick: () => ((browse.type = t), render()) }, label)));
  const hint = browse.type === 'mod' && !i.loader ? `«${i.name}» без загрузчика модов — моды в нём не заработают. Создай экземпляр с Fabric, NeoForge или Forge.` : `Ставятся в «${i.name}» · Minecraft ${i.mc} · ${loaderLabel(i)}. Нужные библиотеки подтянутся сами.`;
  // Что уже стоит в экземпляре: узнаём один раз до первого поиска, кнопки строятся уже с этим знанием
  let have = new Map();
  const known = browse.type === 'mod' ? call('contentInfo', i.id).then((list) => (have = new Map(list.filter((m) => m.projectId).map((m) => [m.projectId, m]))), () => {}) : Promise.resolve();
  searchPanel('Моды', hint, types,
    async (query, offset) => (await known, call('search', { query, offset, sort: browse.sort, category: browse.category, type: browse.type, mc: i.mc, loader: i.loader?.type })),
    (hit) => {
      const mine = have.get(hit.id);
      if (mine && !mine.update) return h('button.btn', { disabled: true, title: `Уже установлен: ${mine.file}` }, icon('check', 16), 'Установлен');
      const label = mine ? `Обновить до ${mine.update.version}` : 'Установить';
      const btn = h(`button.btn${mine ? '.primary' : ''}`, {
        title: mine ? `Сейчас стоит ${mine.version}` : '',
        onclick: async () => {
          btn.disabled = true;
          btn.textContent = mine ? 'Обновляю…' : 'Ставлю…';
          const done = await act(() => (mine ? (i.isPack ? Promise.reject(new Error('Моды сборки сервера обновляют админы')) : call('updateContent', i.id, [mine.file])) : call('installProject', i.id, hit.id, browse.type)));
          btn.replaceChildren(...(done ? [icon('check', 16), 'Установлен'] : [label]));
          btn.disabled = !!done;
        },
      }, label);
      return btn;
    });
}

// ---------- модпаки и новые экземпляры ----------
async function installed(promise) {
  toast('Устанавливаю модпак…');
  const inst = await act(() => promise);
  if (!inst) return;
  toast(`«${inst.name}» готов`);
  await refresh();
  select(inst.id);
}

function viewPacks() {
  const controls = [
    h('button.btn', { onclick: () => installed(call('importMrpack')) }, 'Импорт .mrpack'),
    h('button.btn.primary', { onclick: newInstance }, icon('plus', 16), 'Пустой экземпляр'),
  ];
  searchPanel('Модпаки', 'Готовые сборки с Modrinth ставятся отдельным экземпляром. Поддерживаются Fabric, Quilt, NeoForge и Forge.', controls,
    (query, offset) => call('search', { query, offset, sort: browse.sort, category: browse.category, type: 'modpack' }),
    (hit) => {
      const btn = h('button.btn', { onclick: () => ((btn.disabled = true), installed(call('installModpack', hit.id)).finally(() => (btn.disabled = false))) }, 'Установить');
      return btn;
    });
}

async function newInstance() {
  const versions = await act(() => call('versions'));
  if (!versions) return;
  const name = h('input', { type: 'text', required: true, maxLength: 40, placeholder: 'Моя сборка' });
  const version = h('select');
  const snapshots = h('input', { type: 'checkbox' });
  const fill = () => version.replaceChildren(...versions.filter((v) => snapshots.checked || v.type === 'release').map((v) => h('option', { value: v.id }, v.id)));
  snapshots.addEventListener('change', fill);
  fill();
  const loader = h('select', {}, h('option', { value: 'fabric' }, 'Fabric — лёгкий, большинство новых модов'), h('option', { value: 'neoforge' }, 'NeoForge — большие моды для новых версий'), h('option', { value: 'forge' }, 'Forge — классика, много старых модов'), h('option', { value: 'quilt' }, 'Quilt — совместим с модами Fabric'), h('option', { value: 'vanilla' }, 'Vanilla — без модов'));
  const submit = h('button.btn.primary', { type: 'submit' }, 'Создать');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      const inst = await act(() => call('createInstance', { name: name.value, mc: version.value, type: loader.value }));
      submit.disabled = false;
      if (!inst) return;
      dlg.close();
      await refresh();
      select(inst.id);
    },
  },
    h('h3', {}, 'Новый экземпляр'),
    h('label.field', {}, 'Название', name),
    h('label.field', {}, 'Версия Minecraft', version),
    h('label.check', {}, snapshots, 'Показывать снапшоты и старые версии'),
    h('label.field', {}, 'Загрузчик модов', loader),
    h('p.muted', {}, 'Моды для разных загрузчиков несовместимы между собой. Forge и NeoForge при первом запуске собираются пару минут.'),
    h('div.actions', {}, closeBtn(), submit),
  );
  dlg.replaceChildren(form);
  dlg.showModal();
}

// ---------- аккаунты ----------
function viewAccounts() {
  const sel = S.config.selected;
  view.replaceChildren(
    h('div.panel-head', {}, h('h2', {}, 'Аккаунты'), h('button.btn.primary', { onclick: addAccount }, icon('plus', 16), 'Добавить аккаунт')),
    h('p.sub', {}, 'Можно добавить несколько и переключаться. Токены хранятся зашифрованными на этом компьютере.'),
    h('div.cards', {},
      h('section.card.glass', {}, h('h3', {}, 'Microsoft'), h('p', {}, 'Лицензионный аккаунт Minecraft. Работает на любых серверах.'), h('button.btn.primary', { onclick: loginMicrosoft }, 'Войти')),
      h('section.card.glass', {}, h('h3', {}, 'Ely.by'), h('p', {}, 'Бесплатный аккаунт со скинами. Нужен для входа на наш сервер без лицензии.'), h('button.btn.primary', { onclick: () => loginEly() }, 'Войти')),
      h('section.card.glass', {}, h('h3', {}, 'Офлайн'), h('p', {}, 'Только ник. Для одиночной игры и серверов без проверки аккаунта.'), h('button.btn.primary', { onclick: loginOffline }, 'Добавить')),
    ),
    h('section.panel.glass', {},
      S.accounts.length
        ? h('div.rows', {}, S.accounts.map((a) =>
            h('div.row', {},
              avatar(a),
              h('div.body', {}, h('b', {}, a.name), h('span', {}, accountLabel(a))),
              a.id === sel ? h('span.chip.hot', {}, h('i.dot.ok'), 'Активен') : h('button.btn', { onclick: () => act(() => call('setSettings', { selected: a.id })).then(refresh) }, 'Выбрать'),
              h('button.ghost-btn', { title: 'Выйти из аккаунта', 'aria-label': `Удалить аккаунт ${a.name}`, onclick: () => act(() => call('removeAccount', a.id)).then(refresh) }, icon('trash')),
            )))
        : h('div.empty', {}, 'Аккаунтов пока нет — выбери способ входа выше.'),
    ),
  );
}

function loginOffline() {
  const name = h('input', { type: 'text', required: true, minLength: 3, maxLength: 16, pattern: '[A-Za-z0-9_]+', placeholder: 'Ник латиницей' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (await act(() => call('addOffline', name.value))) (dlg.close(), refresh());
    },
  }, h('h3', {}, 'Офлайн-аккаунт'), h('label.field', {}, 'Ник (3–16 символов: латиница, цифры, _)', name), h('div.actions', {}, closeBtn(), h('button.btn.primary', { type: 'submit' }, 'Добавить')));
  dlg.replaceChildren(form);
  dlg.showModal();
}

function loginCustom() {
  const server = h('input', { type: 'text', required: true, placeholder: 'например, littleskin.cn' });
  const login = h('input', { type: 'text', required: true, placeholder: 'Логин или e-mail', autocomplete: 'username' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Войти');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      if (await act(() => call('addCustom', server.value, login.value.trim(), password.value))) (dlg.close(), refresh());
      submit.disabled = false;
    },
  },
    h('h3', {}, 'Свой сервер авторизации'),
    h('label.field', {}, 'Адрес сервера', server),
    h('label.field', {}, 'Логин', login),
    h('label.field', {}, 'Пароль', password),
    h('p.muted', {}, 'Подходит любой сервер, который поддерживает authlib-injector. Пароль уйдёт только на указанный адрес — вводи его лишь для серверов, которым доверяешь.'),
    h('div.actions', {}, closeBtn(), submit),
  );
  dlg.replaceChildren(form);
  dlg.showModal();
}

function loginEly(needTotp) {
  const login = h('input', { type: 'text', required: true, placeholder: 'Ник или e-mail', autocomplete: 'username' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const totp = h('input', { type: 'text', inputMode: 'numeric', maxLength: 6, placeholder: '6 цифр из приложения' });
  const totpField = h('label.field', { hidden: !needTotp }, 'Код двухфакторной защиты', totp);
  const submit = h('button.btn.primary', { type: 'submit' }, 'Войти');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await call('addEly', login.value.trim(), password.value, totp.value.trim() || undefined);
        dlg.close();
        refresh();
      } catch (err) {
        toast(err.message, true);
        if (err.message.includes('двухфакторной')) (totpField.hidden = false), totp.focus();
      }
      submit.disabled = false;
    },
  },
    h('h3', {}, 'Вход через Ely.by'),
    h('label.field', {}, 'Логин', login),
    h('label.field', {}, 'Пароль', password),
    totpField,
    h('p.muted', {}, 'Пароль уходит только на ely.by и нигде не сохраняется — лаунчер хранит лишь выданный токен.'),
    h('div.actions', {}, h('button.link', { type: 'button', onclick: () => act(() => call('openExternal', 'https://account.ely.by/register')) }, 'Регистрация'), closeBtn(), submit),
  );
  dlg.replaceChildren(form);
  dlg.showModal();
}

async function loginMicrosoft() {
  dialog('Вход через Microsoft', h('p.muted', {}, 'Войди в открывшемся окне Microsoft. Пароль вводится на сайте Microsoft — лаунчер его не видит.'), [h('button.btn', { onclick: () => (call('cancel', 'ms'), dlg.close()) }, 'Отмена')]);
  const acc = await act(() => call('msLogin'));
  dlg.close();
  if (acc) (toast(`Привет, ${acc.name}!`), refresh());
}

// ---------- настройки ----------
function viewSettings() {
  const cfg = S.config;
  const set = (patch) => act(async () => (await call('setSettings', patch), (S = await call('state')), renderSide()));
  const memLabel = h('b', {}, `${cfg.memory} МБ`);
  const memory = h('input', { type: 'range', min: 1024, max: Math.max(2048, S.totalMem - 1024), step: 256, value: cfg.memory, 'aria-label': 'Память для игры', oninput: (e) => (memLabel.textContent = `${e.target.value} МБ`), onchange: (e) => set({ memory: Number(e.target.value) }) });
  const text = (key, placeholder) => h('input', { type: 'text', value: cfg[key] ?? '', placeholder, onchange: (e) => set({ [key]: e.target.value.trim() }).then(loadRemote) });
  const restyle = (patch) => act(async () => (await call('setSettings', patch), await refresh()));
  // Пока тянешь ползунок — меняется только картинка, настройка сохранится, когда отпустишь
  const preview = (patch, input) => (Object.assign(S.config, patch), applyStyle(), (input.parentElement.firstChild.textContent = 'bgBlur' in patch ? `Размытие фона: ${patch.bgBlur} px` : `Затемнение фона: ${patch.bgDim}%`));
  const runCheckup = async () => {
    const box = $('#checkup');
    box.replaceChildren(h('div.empty', {}, 'Проверяю…'));
    const items = (await act(() => call('checkup'))) ?? [];
    if (!box.isConnected) return;
    const bad = items.filter((x) => !x.ok).length;
    box.replaceChildren(
      h('div.row', {}, h(`i.dot.${bad ? 'bad' : 'ok'}`), h('div.body', {}, h('b', {}, bad ? `Найдено проблем: ${bad}` : 'Всё в порядке'))),
      ...items.sort((a, b) => a.ok - b.ok).map((x) => h('div.row', {}, h(`i.dot.${x.ok ? 'ok' : 'bad'}`), h('div.body', {}, h('b', {}, x.name), h('span', {}, x.text)))),
    );
  };
  const java = text('javaPath', 'Пусто — лаунчер сам скачает нужную Java');
  view.replaceChildren(
    h('h2', {}, 'Настройки'),
    h('section.panel.glass', {},
      h('h3', {}, 'Игра'),
      h('label.field', {}, h('span', {}, 'Память для игры: ', memLabel, ` из ${S.totalMem} МБ на компьютере`), memory),
      h('label.field', {}, 'Аргументы JVM', text('jvmArgs', 'Например: -XX:+UseZGC')),
      h('label.field', {}, 'Путь к Java', h('div.inline', {}, java, h('button.btn', { type: 'button', onclick: async () => { const p = await act(() => call('pickJava')); if (p) (java.value = p), set({ javaPath: p }); } }, 'Выбрать…'))),
      h('label.check', {}, h('input', { type: 'checkbox', checked: cfg.autoJoin, onchange: (e) => set({ autoJoin: e.target.checked }) }), 'Сразу заходить на сервер при запуске сборки'),
      h('div.actions', {},
        h('button.btn.primary', { onclick: () => act(async () => { const t = await call('tune'); toast(`Подобрано: ${t.memory} МБ из ${t.total} МБ, флаги G1 для ${t.cpus} ядер`); await refresh(); }) }, 'Подобрать под мой компьютер'),
        h('span.muted', {}, 'Выставит память и флаги сборщика мусора по объёму ОЗУ и числу модов.'),
      ),
    ),
    h('section.panel.glass', {},
      h('h3', {}, 'Оформление'),
      h('div.themes', {}, Object.entries(THEMES).map(([id, label]) => h(`button.theme.t-${id}${cfg.theme === id ? '.on' : ''}`, { 'aria-pressed': String(cfg.theme === id), onclick: () => restyle({ theme: id }) }, h('i'), label))),
      h('div.form', {},
        h('label.field', {}, 'Свой цвет кнопок', h('div.inline', {}, h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cfg.accent) ? cfg.accent : '#f03fd0', onchange: (e) => restyle({ accent: e.target.value }) }), h('button.btn', { type: 'button', onclick: () => restyle({ accent: '' }) }, 'Как в теме'))),
        h('label.field', {}, 'Своя картинка на фон', h('div.inline', {}, h('button.btn', { type: 'button', onclick: () => act(async () => (await call('pickBackground')) && refresh()) }, 'Выбрать картинку…'), cfg.bgImage && h('button.btn', { type: 'button', onclick: () => restyle({ bgImage: '' }) }, 'Убрать'))),
        h('label.field', {}, `Размытие фона: ${cfg.bgBlur} px`, h('input', { type: 'range', min: 0, max: 40, value: cfg.bgBlur, disabled: !cfg.bgImage, oninput: (e) => preview({ bgBlur: Number(e.target.value) }, e.target), onchange: (e) => restyle({ bgBlur: Number(e.target.value) }) })),
        h('label.field', {}, `Затемнение фона: ${cfg.bgDim}%`, h('input', { type: 'range', min: 0, max: 90, value: cfg.bgDim, disabled: !cfg.bgImage, oninput: (e) => preview({ bgDim: Number(e.target.value) }, e.target), onchange: (e) => restyle({ bgDim: Number(e.target.value) }) })),
      ),
    ),
    h('section.panel.glass', {},
      h('h3', {}, 'Диагностика и кэш'),
      h('div.row', {}, h('div.body', {}, h('b', {}, `Лаунчер ${S.version}`), h('span', {}, update ? `Доступна версия ${update.version}` : 'Обновления проверяются при запуске и каждые 30 минут')), h('button.btn', { onclick: manualUpdateCheck }, icon('refresh', 16), 'Проверить обновления')),
      h('div.actions', {},
        h('button.btn.primary', { onclick: runCheckup }, 'Проверить всё'),
        h('button.btn', { onclick: () => act(async () => { const r = await call('cleanCache'); toast(r.files ? `Удалено файлов: ${r.files}, освобождено ${mb(r.bytes)}` : 'Чистить нечего — кэш в порядке'); }) }, 'Очистить кэш'),
        h('label.check', {}, h('input', { type: 'checkbox', checked: cfg.autoClean, onchange: (e) => set({ autoClean: e.target.checked }) }), 'Чистить кэш при каждом запуске'),
        h('label.check', {}, h('input', { type: 'checkbox', checked: cfg.bgUpdate !== false, onchange: (e) => set({ bgUpdate: e.target.checked }) }), 'Обновлять сборку в фоне, пока лаунчер открыт'),
        h('label.check', {}, h('input', { type: 'checkbox', checked: cfg.modCheck !== false, onchange: (e) => set({ modCheck: e.target.checked }) }), 'Проверять моды перед запуском'),
        h('label.check', {}, h('input', { type: 'checkbox', checked: cfg.discordPresence !== false, onchange: (e) => set({ discordPresence: e.target.checked }) }), 'Показывать в Discord, что я играю'),
      ),
      h('p.muted', {}, 'Чистка убирает недокачанные файлы, журналы игры старше недели и отчёты о вылетах старше месяца. Миры, моды, скриншоты и настройки не трогает.'),
      h('div.rows', { id: 'checkup' }),
    ),
    h('section.panel.glass', {},
      h('h3', {}, 'Сервер'),
      h('p.muted', {}, 'Обычно эти поля уже заполнены администратором сервера.'),
      h('label.field', {}, 'Ссылка на pack.json сборки', text('packUrl', 'https://example.com/pack/pack.json')),
      h('label.field', {}, 'Адрес сервера', text('serverAddress', 'play.example.com')),
      h('label.field', {}, 'Azure Client ID (для входа через Microsoft)', text('azureClientId', '00000000-0000-0000-0000-000000000000')),
    ),
    h('section.panel.glass', {},
      h('h3', {}, 'Данные'),
      h('p.muted', { style: 'user-select:text' }, S.dataDir),
      h('div.actions', {}, h('button.btn', { onclick: () => act(() => call('openFolder')) }, icon('folder', 16), 'Открыть папку лаунчера')),
    ),
  );
}

// ---------- события из главного процесса ----------
api.on('progress', (p) => {
  const upd = p.id === 'update' && $('#upd-status');
  if (upd && !p.done && p.totalBytes) upd.textContent = `Скачиваю: ${mb(p.bytes)} из ${mb(p.totalBytes)}`;
  if (p.done) {
    delete progress[p.id];
    S.busy = S.busy.filter((id) => id !== p.id);
    if (tab === 'home') render();
    else renderSide();
  } else {
    progress[p.id] = p;
    if (!S.busy.includes(p.id)) S.busy.push(p.id);
    paintProgress();
  }
});

api.on('game', (g) => {
  S.running = S.running.filter((id) => id !== g.id);
  if (g.running) S.running.push(g.id);
  else if (!stopping.delete(g.id) && g.code) crashReport(g);
  if (tab === 'home') render();
  else renderSide();
});

// Автодиагностика: что нашлось в журнале упавшей игры и что с этим делать
function crashReport(g) {
  if (!g.problems?.length) return toast(`Игра завершилась с ошибкой (код ${g.code}). Подробности — во вкладке «Консоль».`, true);
  dlg.classList.add('wide');
  dialog('Игра вылетела — вот что случилось',
    h('div.rows', {}, g.problems.map((p, n) => h('div.row', {}, h('span.n', {}, String(n + 1).padStart(2, '0')), h('div.body', {}, h('b', {}, p.title), h('span.wrap', {}, p.fix), p.lines.map((l) => h('span.wrap.mono', {}, l)))))),
    [
      h('button.btn', { onclick: () => (navigator.clipboard.writeText((logs[g.id] ?? []).join('\n')), toast('Журнал в буфере обмена — можно отправить админу')) }, 'Скопировать журнал'),
      h('button.btn', { onclick: () => (dlg.close(), select(g.id).then(() => ((sub = 'console'), render()))) }, 'Открыть консоль'),
      closeBtn('Понятно'),
    ]);
}

api.on('log', ({ id, text }) => {
  const lines = (logs[id] ??= []);
  const fresh = text.split(/\r?\n/).filter(Boolean);
  lines.push(...fresh);
  if (lines.length > 5000) lines.splice(0, lines.length - 5000);
  const pre = $('#console');
  if (pre?.dataset.id !== id) return;
  // Дописываем новые строки, а не перерисовываем всё: так не сбрасывается выделение текста
  const add = pre.dataset.full ? fresh.filter(lineShown) : fresh;
  if (add.length && !pre.querySelector(':scope > div:not(.muted)')) pre.replaceChildren();
  pre.append(...add.map(logLine));
  while (pre.childElementCount > Number(pre.dataset.lines)) pre.firstElementChild.remove();
  if (!pre.dataset.full || consoleView.follow) pre.scrollTop = pre.scrollHeight;
  const count = $('#log-count');
  if (count) count.textContent = `${lines.length} строк`;
});

// ---------- старт ----------
for (let n = 0; n < 70; n++) {
  const star = h('i.star');
  star.style.left = `${Math.random() * 100}%`;
  star.style.top = `${Math.random() * 70}%`;
  star.style.opacity = (0.15 + Math.random() * 0.6).toFixed(2);
  $('#sky').append(star);
}
$('#add').append(icon('plus'));
$('#add').addEventListener('click', newInstance);
dlg.addEventListener('click', (e) => e.target === dlg && dlg.close()); // клик по затемнению закрывает
dlg.addEventListener('close', () => dlg.classList.remove('wide'));

document.addEventListener('click', () => menuOpen && ((menuOpen = false), renderTop()));
document.addEventListener('keydown', (e) => e.key === 'Escape' && menuOpen && ((menuOpen = false), renderTop()));

refresh().then(loadRemote);
// Обновление лаунчера: тихо проверяем при старте, кнопка появится наверху
// Обновление лаунчера: при старте и каждые 30 минут — лаунчер часто держат открытым сутками
const checkLauncherUpdate = () => call('checkUpdate').then((u) => ((update = u ?? null), renderTop(), u));
checkLauncherUpdate().catch(() => {});
setInterval(() => checkLauncherUpdate().catch(() => {}), 30 * 60_000);
setInterval(loadRemote, 60_000);
