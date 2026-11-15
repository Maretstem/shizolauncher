// Панель обновления сборки сервера: локальная страничка в браузере.
//   node --use-env-proxy tools/pack-panel.mjs [папка сборки = ../shizostan-pack]
// Добавить/удалить моды, задать версию и описание, «Опубликовать» = git pull + make-pack + commit + push (main и gh-pages).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readJson, sha1File } from '../src/main/core/net.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.resolve(process.argv[2] ?? path.join(here, '../../shizostan-pack'));
const MODS = path.join(PACK, 'files', 'mods');
const LIVE_URL = (await readJson(path.join(here, '../launcher.config.json')))?.packUrl;
const TOKEN = randomBytes(16).toString('hex'); // чужой сайт в браузере не сможет дёргать панель
const MAX_FILE = 100 * 1024 * 1024; // предел GitHub на один файл
const exec = promisify(execFile);

async function git(...args) {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd: PACK, maxBuffer: 16 * 1024 * 1024 });
    return (stdout + stderr).trim();
  } catch (e) {
    throw new Error(`git ${args[0]}: ${(e.stderr || e.stdout || e.message).trim()}`);
  }
}

function modPath(name) {
  if (typeof name !== 'string' || path.basename(name) !== name || !/\.jar$/i.test(name)) throw new Error('Нужен файл .jar с обычным именем');
  return path.join(MODS, name);
}

// «binary-barrier-1.4.1.jar» -> «binary-barrier»: два файла с одним ключом — скорее всего две версии одного мода
export const modKey = (name) => name.toLowerCase().replace(/\.jar$/, '').replace(/[-_+ ]?v?\d.*$/, '') || name.toLowerCase();
export const nextVersion = (v) => (/\d/.test(v ?? '') ? v.replace(/(\d+)(?!.*\d)/, (n) => String(Number(n) + 1)) : '1.0.0');

async function state() {
  const pack = (await readJson(path.join(PACK, 'pack.json'))) ?? { files: [] };
  const published = new Map(pack.files.filter((f) => f.path.startsWith('mods/')).map((f) => [f.path.slice(5), f]));
  const names = (await fs.readdir(MODS)).filter((n) => /\.jar$/i.test(n)).sort((a, b) => a.localeCompare(b));
  const mods = [];
  for (const name of names) {
    const file = path.join(MODS, name);
    const { size } = await fs.stat(file);
    const old = published.get(name);
    const status = !old ? 'new' : old.size !== size || old.sha1 !== (await sha1File(file)) ? 'changed' : 'same';
    mods.push({ name, size, status, key: modKey(name) });
  }
  const count = {};
  for (const m of mods) count[m.key] = (count[m.key] ?? 0) + 1;
  for (const m of mods) m.dupe = count[m.key] > 1;
  const live = LIVE_URL
    ? await fetch(`${LIVE_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((j) => j.version, () => null)
    : null;
  return {
    version: pack.version ?? null,
    changelog: pack.changelog ?? '',
    live,
    liveUrl: LIVE_URL ?? null,
    next: nextVersion(pack.version),
    mods,
    removed: [...published.keys()].filter((n) => !names.includes(n)),
    folder: MODS,
  };
}

async function publish({ version, changelog }) {
  version = String(version ?? '').trim();
  if (!/^[\w.+-]{1,32}$/.test(version)) throw new Error('Версия: цифры, буквы и точки, например 1.0.6');
  const current = (await readJson(path.join(PACK, 'pack.json')))?.version;
  if (version === current) throw new Error(`Версия ${version} уже выпущена — поставь новый номер, иначе лаунчеры не заметят обновление`);
  const log = [];
  const step = async (title, fn) => log.push(`▸ ${title}`, (await fn()) || 'ок');
  // Свои настройки git не трогаем; имя подставляем, только если его нет вовсе
  const who = (await git('config', 'user.name').catch(() => '')) ? [] : ['-c', 'user.name=Maretstem', '-c', 'user.email=Maretstem@users.noreply.github.com'];
  try {
    // merge, не rebase: уже опубликованные коммиты переписывать нельзя, иначе push в gh-pages будет отклонён
    await step('Забираю изменения с GitHub', () => git(...who, 'pull', '--no-rebase', '--no-edit', 'origin', 'main'));
    await step('Пересчитываю pack.json', async () =>
      (await exec(process.execPath, [path.join(here, 'make-pack.mjs'), PACK, '--version', version, '--changelog', String(changelog ?? '').trim()])).stdout.trim());
    await git('add', '-A');
    await step('Сохраняю версию', () => git(...who, 'commit', '-m', `Сборка ${version}`));
    await step('Отправляю на GitHub', () => git('push', 'origin', 'main:main', 'main:gh-pages'));
  } catch (e) {
    log.push(`✖ ${e.message}`);
    return { ok: false, log };
  }
  return { ok: true, log };
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const routes = {
  'GET state': () => state(),
  'POST ping': () => ({}),
  'POST publish': async (req) => publish(await body(req)),
  'POST remove': async (_req, q) => (await fs.rm(modPath(q.get('name'))), {}),
  'POST open': async () => (execFile('explorer.exe', [MODS]), {}),
  async 'POST add'(req, q) {
    const dest = modPath(q.get('name'));
    if (Number(req.headers['content-length']) > MAX_FILE) throw new Error('Файл больше 100 МБ — GitHub такой не примет');
    await pipeline(req, createWriteStream(dest + '.part'));
    await fs.rename(dest + '.part', dest);
    return {};
  },
};

let lastSeen = Date.now();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (code, data) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) return json(403, { error: 'Чужой адрес' });
  if (req.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('t') !== TOKEN) return json(403, { error: 'Открой панель ярлыком' });
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE.replace('__TOKEN__', TOKEN));
  }
  const handler = routes[`${req.method} ${url.pathname.replace('/api/', '')}`];
  if (!handler || req.headers['x-token'] !== TOKEN) return json(403, { error: 'Нет доступа' });
  lastSeen = Date.now();
  try {
    json(200, await handler(req, url.searchParams));
  } catch (e) {
    json(400, { error: e.message });
  }
});

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Сборка SHIZOSTAN</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--t:#f5f0fb;--m:#a99fbd;--g:rgba(255,255,255,.06);--l:rgba(255,255,255,.1);--pink:#f03fd0;--ok:#5fe39a;--warn:#ffc457;--bad:#ff6b81;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--t);font:15px/1.5 "Segoe UI",system-ui,sans-serif;background:linear-gradient(180deg,#0b0a1e,#1b1140 55%,#4a1f74) fixed}
main{max-width:860px;margin:0 auto;padding:28px 18px 60px;display:flex;flex-direction:column;gap:16px}
h1{font-size:30px;margin:0}h2{font-size:17px;margin:0}p{margin:0}.m{color:var(--m)}
.card{background:var(--g);border:1px solid var(--l);border-radius:18px;padding:20px;display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
.stat b{font-size:22px;display:block}.stat{flex:1;min-width:150px}
button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--l);background:rgba(255,255,255,.1);border-radius:11px;padding:9px 16px;font-weight:600}
button:hover:not(:disabled){background:rgba(255,255,255,.18)}button:disabled{opacity:.5;cursor:default}
button.go{background:linear-gradient(180deg,#f346d6,#a046f5);border:0;padding:13px 26px;font-size:16px}
button.x{color:var(--bad);padding:5px 11px}
input,textarea{font:inherit;color:inherit;width:100%;background:rgba(8,5,20,.5);border:1px solid var(--l);border-radius:11px;padding:10px 13px}
:focus-visible{outline:2px solid var(--pink);outline-offset:2px}
label{display:flex;flex-direction:column;gap:6px;font-weight:600;font-size:13px;color:var(--m)}
#drop{border:2px dashed var(--l);border-radius:16px;padding:26px;text-align:center;cursor:pointer}
#drop.over{border-color:var(--pink);background:rgba(240,63,208,.12)}
ul{list-style:none;margin:0;padding:0;max-height:46vh;overflow:auto}
li{display:flex;gap:10px;align-items:center;padding:8px 2px;border-top:1px solid var(--l)}li:first-child{border:0}
li span.n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:12px;font-weight:700;padding:2px 9px;border-radius:20px;white-space:nowrap}
.new{background:rgba(95,227,154,.18);color:var(--ok)}.changed{background:rgba(255,196,87,.18);color:var(--warn)}.dupe,.gone{background:rgba(255,107,129,.18);color:var(--bad)}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.6 Consolas,monospace;background:rgba(8,5,20,.5);border-radius:12px;padding:14px}
.okc{color:var(--ok)}.badc{color:var(--bad)}.warnc{color:var(--warn)}
</style></head><body><main>
<h1>Сборка SHIZOSTAN</h1>
<section class="card"><div class="row">
  <div class="stat"><span class="m">В папке</span><b id="cur">…</b></div>
  <div class="stat"><span class="m">У игроков сейчас</span><b id="live">…</b></div>
  <div class="stat"><span class="m">Модов</span><b id="count">…</b></div>
</div><p id="sync" class="m"></p></section>

<section class="card">
  <div id="drop" tabindex="0" role="button">Перетащи сюда файлы <b>.jar</b> или нажми, чтобы выбрать<br><span class="m">Новая версия мода? Перетащи её — старую панель предложит удалить.</span></div>
  <input id="pick" type="file" accept=".jar" multiple hidden>
  <div class="row"><input id="find" class="grow" type="search" placeholder="Поиск мода…" aria-label="Поиск мода"><button id="open">Открыть папку</button></div>
  <ul id="list"></ul>
</section>

<section class="card">
  <h2>Выпустить обновление</h2>
  <p id="changes" class="m"></p>
  <label>Номер версии<input id="ver" autocomplete="off"></label>
  <label>Что нового (игроки увидят это в лаунчере)<textarea id="log" rows="3"></textarea></label>
  <div class="row"><button id="pub" class="go">Опубликовать</button><span id="status" class="m grow" role="status"></span></div>
  <pre id="out" hidden></pre>
</section>
</main><script>
const T='__TOKEN__',$=(s)=>document.querySelector(s);
const api=async(p,o={})=>{const r=await fetch('/api/'+p,{method:'POST',...o,headers:{'X-Token':T,...o.headers}});const j=await r.json();if(!r.ok)throw new Error(j.error);return j};
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
const say=(text,cls='m')=>{$('#status').className=cls+' grow';$('#status').textContent=text};
const LABEL={new:'новый',changed:'изменён'};
let S,verTouched=false,waitFor=null;

async function load(){
  S=await api('state',{method:'GET'});
  $('#cur').textContent=S.version??'—';$('#live').textContent=S.live??'нет связи';$('#count').textContent=S.mods.length;
  const same=S.live&&S.live===S.version;
  $('#sync').textContent=!S.live?'Не удалось узнать версию на сайте — проверь прокси.':same?'Игроки получают ту же версию, что лежит в папке.':'Сайт ещё обновляется: GitHub публикует новую версию 1–6 минут.';
  $('#sync').className=same?'okc':'warnc';
  if(!verTouched)$('#ver').value=S.next;
  if(!$('#log').dataset.touched)$('#log').value='';
  draw();
  if(waitFor&&S.live===waitFor){say('Версия '+waitFor+' уже у игроков.','okc');waitFor=null}
}
function draw(){
  const q=$('#find').value.toLowerCase(),list=$('#list');list.replaceChildren();
  for(const name of S.removed){const li=el('li');li.append(el('span','n m',name),el('span','tag gone','будет удалён у игроков'));list.append(li)}
  for(const m of S.mods){
    if(q&&!m.name.toLowerCase().includes(q))continue;
    const li=el('li');li.append(el('span','n',m.name));
    if(m.dupe)li.append(el('span','tag dupe','две версии?'));
    if(LABEL[m.status])li.append(el('span','tag '+m.status,LABEL[m.status]));
    li.append(el('span','m',(m.size/1048576).toFixed(1)+' МБ'));
    const x=el('button','x','Удалить');x.setAttribute('aria-label','Удалить '+m.name);
    x.onclick=async()=>{x.disabled=true;try{await api('remove?name='+encodeURIComponent(m.name));await load()}catch(e){say(e.message,'badc')}};
    li.append(x);list.append(li);
  }
  const n=(s)=>S.mods.filter(m=>m.status===s).length,parts=[];
  if(n('new'))parts.push('новых: '+n('new'));if(n('changed'))parts.push('изменённых: '+n('changed'));if(S.removed.length)parts.push('удалённых: '+S.removed.length);
  const dupes=[...new Set(S.mods.filter(m=>m.dupe).map(m=>m.key))];
  $('#changes').textContent=(parts.length?'Изменения с прошлой версии — '+parts.join(', ')+'.':'С прошлой версии моды не менялись.')+(dupes.length?' Похоже на две версии одного мода: '+dupes.join(', ')+' — оставь одну, иначе игра может не запуститься.':'');
  $('#changes').className=dupes.length?'warnc':'m';
}
async function add(files){
  for(const f of files){
    if(!/\\.jar$/i.test(f.name)){say(f.name+': нужен файл .jar','badc');continue}
    say('Загружаю '+f.name+'…');
    try{await api('add?name='+encodeURIComponent(f.name),{body:f});say(f.name+' добавлен.','okc')}catch(e){say(f.name+': '+e.message,'badc')}
  }
  await load();
}
const drop=$('#drop');
drop.onclick=()=>$('#pick').click();drop.onkeydown=(e)=>{if(e.key==='Enter'||e.key===' ')$('#pick').click()};
$('#pick').onchange=(e)=>add([...e.target.files]);
for(const ev of['dragenter','dragover'])addEventListener(ev,(e)=>{e.preventDefault();drop.classList.add('over')});
for(const ev of['dragleave','drop'])addEventListener(ev,(e)=>{e.preventDefault();drop.classList.remove('over')});
addEventListener('drop',(e)=>add([...e.dataTransfer.files]));
$('#find').oninput=draw;$('#ver').oninput=()=>verTouched=true;$('#log').oninput=()=>$('#log').dataset.touched=1;
$('#open').onclick=()=>api('open').catch((e)=>say(e.message,'badc'));
$('#pub').onclick=async()=>{
  const version=$('#ver').value.trim();
  $('#pub').disabled=true;say('Публикую… при большой сборке это может занять несколько минут.');
  try{
    const r=await api('publish',{body:JSON.stringify({version,changelog:$('#log').value})});
    $('#out').hidden=false;$('#out').textContent=r.log.join('\\n');
    if(r.ok){verTouched=false;delete $('#log').dataset.touched;waitFor=version;say('Отправлено. Жду, пока GitHub опубликует версию '+version+' (1–6 минут)…','warnc')}
    else say('Не получилось — подробности ниже.','badc');
  }catch(e){say(e.message,'badc')}
  $('#pub').disabled=false;await load().catch(()=>{});
};
load().catch((e)=>say(e.message,'badc'));
setInterval(()=>{api('ping').catch(()=>{});if(waitFor)load().catch(()=>{})},20000);
</script></body></html>`;

// Запуск как программы; при импорте из тестов сервер не поднимается
if (process.argv[1]?.endsWith('pack-panel.mjs')) {
  await fs.access(MODS).catch(() => {
    console.error(`Не найдена папка с модами: ${MODS}`);
    process.exit(1);
  });
  server.listen(Number(process.env.PANEL_PORT) || 0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}`;
    console.log(`Панель сборки: ${url}\nЗакрой это окно, чтобы выключить панель.`);
    if (!process.env.PANEL_NO_OPEN) execFile('cmd', ['/c', 'start', '', url]);
  });
  // Вкладку закрыли — панель выключается сама (фоновые вкладки браузер будит редко, отсюда запас в 3 минуты)
  setInterval(() => Date.now() - lastSeen > 180_000 && process.exit(0), 20_000);
  git('pull', '--no-rebase', '--no-edit', 'origin', 'main').catch(() => {}); // сразу подтянуть загруженное через сайт
}
