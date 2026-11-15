import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { offlineAccount, offlineUuid } from '../src/main/core/auth.js';
import { allowed, buildArgs, libraryFiles, mavenPath, mergeVersion } from '../src/main/core/minecraft.js';
import { mrpackLoader } from '../src/main/core/modrinth.js';
import { httpsUrl, safeJoin } from '../src/main/core/net.js';
import { packTasks, staleFiles } from '../src/main/core/pack.js';
import { parseAddress, ping } from '../src/main/core/ping.js';

const win = { name: 'windows', arch: 'x64' };
const mac = { name: 'osx', arch: 'arm64' };

test('правила Mojang', () => {
  assert.equal(allowed(undefined), true);
  assert.equal(allowed([{ action: 'allow', os: { name: 'osx' } }], {}, win), false);
  assert.equal(allowed([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], {}, mac), false);
  assert.equal(allowed([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], {}, win), true);
  assert.equal(allowed([{ action: 'allow', features: { is_demo_user: true } }], {}, win), false);
  assert.equal(allowed([{ action: 'allow', features: { has_custom_resolution: true } }], { has_custom_resolution: true }, win), true);
});

test('maven-пути', () => {
  assert.equal(mavenPath('net.fabricmc:fabric-loader:0.16.9'), 'net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar');
  assert.equal(mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
});

test('Microsoft: понятные ошибки вместо кодов AADSTS', async () => {
  const { msError, msDeviceCode } = await import('../src/main/core/auth.js');
  assert.match(msError({ body: { error_description: 'AADSTS7000218: The request body must contain client_assertion. Trace ID: x' } }).message, /Allow public client flows/);
  assert.match(msError({ body: { error_description: 'AADSTS700038: 123 is not a valid application identifier.' } }).message, /Application \(client\) ID/);
  assert.equal(msError({ body: { error_description: 'Something else. Trace ID: 1' } }).message, 'Microsoft: Something else.');
  await assert.rejects(msDeviceCode(''), /ещё не подключён/);
});

test('оффлайн-аккаунт: UUID как у ванильного сервера', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
  assert.throws(() => offlineAccount('a b'));
  assert.throws(() => offlineAccount('ab'));
  assert.equal(offlineAccount('Shizo_1').type, 'offline');
});

test('загрузчик поверх ванилы: библиотеки потомка главнее, аргументы склеиваются', () => {
  const vanilla = { id: '1.21', mainClass: 'net.minecraft.Main', libraries: [{ name: 'org.ow2.asm:asm:9.6' }, { name: 'a:b:1' }], arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}'] } };
  const fabric = { id: 'fabric', inheritsFrom: '1.21', mainClass: 'Knot', libraries: [{ name: 'org.ow2.asm:asm:9.7', url: 'https://maven.fabricmc.net/' }], arguments: { jvm: ['-DFabric'], game: [] } };
  const v = mergeVersion(vanilla, fabric);
  assert.equal(v.mainClass, 'Knot');
  assert.equal(v.jar, '1.21');
  const libs = libraryFiles(v, 'R', win);
  assert.equal(libs.length, 2);
  assert.ok(libs[0].url.startsWith('https://maven.fabricmc.net/org/ow2/asm/asm/9.7/'));
  const args = buildArgs(v, { classpath: 'CP', auth_player_name: 'Bob' }, { jvmExtra: ['-Xmx2G'], gameExtra: ['--x'] });
  assert.deepEqual(args, ['-Xmx2G', '-cp', 'CP', '-DFabric', 'Knot', '--username', 'Bob', '--x']);
});

test('аргументы: правила с features и старый формат', () => {
  const v = { mainClass: 'M', arguments: { jvm: ['-cp', '${classpath}'], game: [{ rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] }] } };
  assert.deepEqual(buildArgs(v, { classpath: 'CP', quickPlayMultiplayer: 'h:1' }), ['-cp', 'CP', 'M']);
  assert.deepEqual(buildArgs(v, { classpath: 'CP', quickPlayMultiplayer: 'h:1' }, { features: { is_quick_play_multiplayer: true } }).slice(-2), ['--quickPlayMultiplayer', 'h:1']);
  const legacy = { mainClass: 'M', minecraftArguments: '--username ${auth_player_name}' };
  assert.deepEqual(buildArgs(legacy, { natives_directory: 'N', classpath: 'CP', auth_player_name: 'Bob' }), ['-Djava.library.path=N', '-cp', 'CP', 'M', '--username', 'Bob']);
});

test('пути и адреса из внешних данных', () => {
  assert.equal(safeJoin('base', 'mods/a.jar'), path.resolve('base', 'mods', 'a.jar'));
  for (const bad of ['../x', 'mods/../../x', path.resolve('/etc/passwd'), '', null]) assert.throws(() => safeJoin('base', bad));
  assert.throws(() => httpsUrl('file:///c:/x'));
  assert.equal(httpsUrl('files/a b.jar', 'https://h.ru/pack/pack.json'), 'https://h.ru/pack/files/a%20b.jar');
});

test('сборка: задачи, относительные адреса, удаление только своих старых файлов', () => {
  const m = { files: [{ path: 'mods/Мод 1.jar', sha1: 'x', size: 1 }, { path: 'config/a.toml', overwrite: false }, { path: 'mods/b.jar', url: 'https://cdn.ru/b.jar' }] };
  const t = packTasks(m, 'https://h.ru/pack/pack.json', 'G');
  assert.equal(t[0].url, 'https://h.ru/pack/files/mods/%D0%9C%D0%BE%D0%B4%201.jar');
  assert.equal(t[1].keep, true);
  assert.equal(t[2].url, 'https://cdn.ru/b.jar');
  assert.throws(() => packTasks({ files: [{ path: '../../evil.exe' }] }, 'https://h.ru/pack.json', 'G'));
  assert.deepEqual(staleFiles(['mods/old.jar', 'mods/b.jar'], m), ['mods/old.jar']);
  assert.deepEqual(staleFiles(undefined, m), []);
});

test('mrpack: загрузчик', () => {
  assert.deepEqual(mrpackLoader({ minecraft: '1.21', 'fabric-loader': '0.16' }), { type: 'fabric', version: '0.16' });
  assert.equal(mrpackLoader({ minecraft: '1.21' }), null);
  assert.deepEqual(mrpackLoader({ minecraft: '1.21', forge: '1' }), { type: 'forge', version: '1' });
});

test('пинг сервера', async () => {
  assert.deepEqual(parseAddress('mc.ru'), { host: 'mc.ru', port: 25565 });
  assert.deepEqual(parseAddress('mc.ru:1234'), { host: 'mc.ru', port: 1234 });
  const json = Buffer.from(JSON.stringify({ players: { online: 7, max: 50 }, version: { name: '1.21.11' }, description: { text: '§dSHIZO', extra: [{ text: 'STAN' }] } }));
  const payload = Buffer.concat([Buffer.from([0x00, json.length]), json]); // id пакета + длина строки (json < 128 байт)
  const server = net.createServer((s) => s.once('data', () => s.write(Buffer.concat([Buffer.from([payload.length]), payload]))));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await ping(`127.0.0.1:${server.address().port}`);
    assert.equal(r.online, 7);
    assert.equal(r.max, 50);
    assert.equal(r.motd, 'SHIZOSTAN');
  } finally {
    server.close();
  }
});

test('сборка сервера: установка, обновление, удаление убранных файлов, конфиги не перезаписываются', async () => {
  const fs = await import('node:fs/promises');
  const http = await import('node:http');
  const os = await import('node:os');
  const { createHash } = await import('node:crypto');
  const { syncPack, packStatus, PACK_ID } = await import('../src/main/core/pack.js');
  const { gameDir } = await import('../src/main/core/instances.js');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shizo-test-'));
  const served = {}; // url -> содержимое
  const file = (p, body, extra = {}) => ((served[`/files/${p}`] = body), { path: p, sha1: createHash('sha1').update(body).digest('hex'), size: body.length, ...extra });
  const publish = (version, files) => (served['/pack.json'] = JSON.stringify({ name: 'T', version, minecraft: '1.21.11', loader: { type: 'fabric', version: '0.1' }, files }));
  const server = http.createServer((req, res) => (served[req.url] != null ? res.end(served[req.url]) : res.writeHead(404).end()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/pack.json`;
  const dir = gameDir(root, PACK_ID);
  const read = (p) => fs.readFile(path.join(dir, p), 'utf8').catch(() => null);
  try {
    publish('1.0', [file('mods/a.jar', 'A1'), file('mods/old.jar', 'OLD'), file('config/x.toml', 'default', { overwrite: false })]);
    assert.equal((await packStatus(root, url)).installed, null);
    await syncPack(root, url);
    assert.equal(await read('mods/a.jar'), 'A1');
    assert.deepEqual(await packStatus(root, url).then((s) => [s.installed, s.updateAvailable]), ['1.0', false]);

    await fs.writeFile(path.join(dir, 'config/x.toml'), 'мои настройки');
    await fs.writeFile(path.join(dir, 'mods/minimap.jar'), 'свой мод игрока');
    await fs.writeFile(path.join(dir, 'mods/a.jar'), 'испорчен');
    publish('1.1', [file('mods/a.jar', 'A2'), file('config/x.toml', 'new default', { overwrite: false })]);
    assert.equal((await packStatus(root, url)).updateAvailable, true);
    await syncPack(root, url);
    assert.equal(await read('mods/a.jar'), 'A2'); // обновлён
    assert.equal(await read('mods/old.jar'), null); // убран из сборки — удалён
    assert.equal(await read('mods/minimap.jar'), 'свой мод игрока'); // чужое не трогаем
    assert.equal(await read('config/x.toml'), 'мои настройки'); // настройки игрока целы

    served['/files/mods/a.jar'] = 'ПОДМЕНА';
    await fs.rm(path.join(dir, 'mods/a.jar'));
    await assert.rejects(syncPack(root, url), /хеш/); // подменённый файл не принимается
    assert.equal(await read('mods/a.jar'), null);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('панель сборки: ключ мода и следующая версия', async () => {
  const { modKey, nextVersion } = await import('../tools/pack-panel.mjs');
  assert.equal(modKey('binary-barrier-1.4.1.jar'), modKey('binary-barrier-1.2.0.jar'));
  assert.equal(modKey('sodium-fabric-0.8.15-beta.1+mc1.21.11.jar'), modKey('sodium-fabric-0.8.14+mc1.21.11.jar'));
  assert.notEqual(modKey('sodium-fabric-0.8.14.jar'), modKey('sodium-extra-fabric-0.9.5.jar'));
  assert.notEqual(modKey('fabric-api-0.141.6.jar'), modKey('fabric-language-kotlin-1.14.2.jar'));
  assert.equal(modKey('races.jar'), 'races');
  assert.equal(nextVersion('1.0.5'), '1.0.6');
  assert.equal(nextVersion('1.9'), '1.10');
  assert.equal(nextVersion(undefined), '1.0.0');
});

test('веб-панель: публикация через API GitHub (макет сервера)', async (t) => {
  const corePath = new URL('../../shizostan-pack/admin/core.js', import.meta.url);
  const fs = await import('node:fs');
  if (!fs.existsSync(corePath)) return t.skip('нет папки shizostan-pack');
  const http = await import('node:http');
  const { createHash } = await import('node:crypto');
  const core = await import(corePath.href);
  const sha1 = (s) => createHash('sha1').update(s).digest('hex');
  const gitSha = (buf) => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));

  // Макет: blobs по sha, одно дерево, ветки
  const blobs = new Map();
  const put = (text) => { const b = Buffer.from(text); blobs.set(gitSha(b), b); return gitSha(b); };
  const a = put('AAA'), old = put('OLD'), site = put('uploaded-via-site');
  const pack0 = { name: 'T', version: '1.0', minecraft: '1.21.11', loader: { type: 'fabric', version: '0.1' }, changelog: '', files: [
    { path: 'mods/a-1.0.jar', sha1: sha1('AAA'), size: 3, git: a },
    { path: 'mods/old-1.0.jar', sha1: sha1('OLD'), size: 3, git: old },
  ] };
  let tree = { 'pack.json': put(JSON.stringify(pack0)), 'files/mods/a-1.0.jar': a, 'files/mods/old-1.0.jar': old, 'files/mods/site-1.0.jar': site };
  const refs = { main: 'c0' };
  const commits = { c0: { tree: 't0' } };
  const trees = { t0: tree };
  const calls = [];
  let race = null; // что «другой админ» успевает сделать прямо перед нашим обновлением ветки
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const p = req.url.replace('/repos/Maretstem/shizo-mods', '');
    calls.push(`${req.method} ${p.split('?')[0].replace(/[0-9a-f]{40}/, ':sha')}`);
    const json = (code, d) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(d));
    let m;
    if (p === '') return json(200, { permissions: { push: req.headers.authorization === 'Bearer good' } });
    if ((m = p.match(/^\/git\/ref\/heads\/(.+)$/))) return json(200, { object: { sha: refs[m[1]] } });
    if ((m = p.match(/^\/git\/commits\/(.+)$/))) return json(200, { tree: { sha: commits[m[1]].tree } });
    if ((m = p.match(/^\/git\/trees\/([^?]+)/))) return json(200, { truncated: false, tree: Object.entries(trees[m[1]]).map(([path, sha]) => ({ path, sha, type: 'blob', size: blobs.get(sha).length })) });
    if (req.method === 'GET' && (m = p.match(/^\/git\/blobs\/(.+)$/))) return res.writeHead(200).end(blobs.get(m[1]));
    if (req.method === 'POST' && p === '/git/blobs') { const b = Buffer.from(body.content, 'base64'); blobs.set(gitSha(b), b); return json(201, { sha: gitSha(b) }); }
    if (req.method === 'POST' && p === '/git/trees') {
      const next = { ...trees[body.base_tree] };
      for (const e of body.tree) { if (e.sha === null) delete next[e.path]; else next[e.path] = e.sha ?? put(e.content); }
      trees.t1 = next; return json(201, { sha: 't1' });
    }
    if (req.method === 'POST' && p === '/git/commits') { commits.c1 = { tree: body.tree, parents: body.parents, message: body.message }; return json(201, { sha: 'c1' }); }
    if (req.method === 'PATCH' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) {
      if (m[1] === 'main' && race) { race(); race = null; return json(422, { message: 'Update is not a fast forward' }); }
      if (!refs[m[1]]) return json(422, {}); refs[m[1]] = body.sha; return json(200, {});
    }
    if (req.method === 'POST' && p === '/git/refs') { refs[body.ref.replace('refs/heads/', '')] = body.sha; return json(201, {}); }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await core.canPush(core.client('bad', base)), false);
    const gh = core.client('good', base);
    assert.equal(await core.canPush(gh), true);
    const state = await core.loadState(gh);
    assert.deepEqual(state.files.map((f) => `${f.path}:${f.status}`), ['mods/a-1.0.jar:same', 'mods/old-1.0.jar:same', 'mods/site-1.0.jar:new']);
    await assert.rejects(core.publish(gh, state, { version: '1.0' }), /уже выпущена/);
    await assert.rejects(core.publish(gh, state, { version: '1.1', adds: [{ name: '../x.jar', data: new ArrayBuffer(1) }] }), /\.jar/);

    const data = new TextEncoder().encode('NEWMOD').buffer;
    const pack = await core.publish(gh, state, { version: '1.1', changelog: 'тест', adds: [{ name: 'new-2.0.jar', data }], removes: ['mods/old-1.0.jar'] });
    assert.deepEqual(pack.files.map((f) => f.path), ['mods/a-1.0.jar', 'mods/new-2.0.jar', 'mods/site-1.0.jar']);
    assert.equal(pack.files[1].sha1, sha1('NEWMOD'));
    assert.equal(pack.files[2].sha1, sha1('uploaded-via-site')); // загруженное через сайт дохешировано по содержимому
    assert.equal(pack.files[0].sha1, sha1('AAA'));
    assert.deepEqual([pack.name, pack.minecraft, pack.loader.version, pack.changelog], ['T', '1.21.11', '0.1', 'тест']);
    // В репозитории: один коммит поверх прежнего, файлы и pack.json согласованы, обе ветки на нём
    assert.deepEqual(Object.keys(trees.t1).sort(), ['files/mods/a-1.0.jar', 'files/mods/new-2.0.jar', 'files/mods/site-1.0.jar', 'pack.json']);
    assert.deepEqual(JSON.parse(blobs.get(trees.t1['pack.json'])), pack);
    assert.equal(trees.t1['files/mods/new-2.0.jar'], pack.files[1].git);
    assert.deepEqual([commits.c1.parents, commits.c1.message], [['c0'], 'Сборка 1.1']);
    assert.deepEqual(refs, { main: 'c1', 'gh-pages': 'c1' });
    assert.equal(calls.filter((c) => c === 'GET /git/blobs/:sha').length, 2); // pack.json + один файл с сайта, остальное не перекачивалось

    // Два админа одновременно: пока мы публикуем 1.2, другой успевает выпустить свою 1.2 с новым модом
    const mine = await core.loadState(gh);
    race = () => {
      const theirs = { ...pack, version: '1.2', history: [{ version: '1.2', date: '2026-01-01', changelog: 'чужая' }] };
      trees.t9 = { ...trees[commits[refs.main].tree], 'pack.json': put(JSON.stringify(theirs)), 'files/mods/other-1.0.jar': put('OTHER') };
      delete trees.t9['files/mods/mine-1.0.jar'];
      commits.c9 = { tree: 't9' };
      refs.main = 'c9';
    };
    const steps = [];
    const done = await core.publishSafe(gh, mine, { version: '1.2', changelog: 'моя', adds: [{ name: 'mine-1.0.jar', data: new TextEncoder().encode('MINE').buffer }], onStep: (s) => steps.push(s) });
    assert.equal(done.pack.version, '1.3'); // номер 1.2 занят — выпущено следующим
    assert.ok(done.pack.files.some((f) => f.path === 'mods/other-1.0.jar'), 'чужой мод сохранён');
    assert.ok(done.pack.files.some((f) => f.path === 'mods/mine-1.0.jar'), 'свой мод добавлен');
    assert.deepEqual(done.pack.history.map((h) => h.version).slice(0, 2), ['1.3', '1.2']);
    assert.deepEqual(commits.c1.parents, ['c9']); // поверх чужого коммита, ничего не затёрто
    assert.equal(refs.main, 'c1');
    assert.ok(steps.some((s) => /поверх его версии/.test(s)) && steps.some((s) => /выпускаю как 1\.3/.test(s)));
  } finally {
    server.close();
  }
});

test('подбор памяти и флагов, разбор вылета, чистка кэша', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const { recommendMemory, recommendFlags, diagnose, cleanCache } = await import('../src/main/core/care.js');
  assert.equal(recommendMemory(4096, 90), 2048); // слабый ПК: не больше половины ОЗУ
  assert.equal(recommendMemory(8192, 90), 4096);
  assert.equal(recommendMemory(16384, 90), 6144);
  assert.equal(recommendMemory(32768, 0), 3072); // без модов много не нужно
  assert.equal(recommendMemory(2048, 10), 2048);
  assert.match(recommendFlags(4096), /UseG1GC.*G1HeapRegionSize=8M/);
  assert.match(recommendFlags(16384), /G1HeapRegionSize=16M/);

  assert.deepEqual(diagnose('[main/INFO]: всё хорошо'), []);
  assert.equal(diagnose('java.lang.OutOfMemoryError: Java heap space')[0].title, 'Игре не хватило памяти');
  const dep = diagnose("[main/ERROR]: Mod resolution encountered an incompatible mod set!\n - Mod 'Sodium' requires version 0.5 of fabric-api, which is missing!");
  assert.equal(dep[0].lines.length, 2);
  assert.match(diagnose('Unrecognized VM option \'UseFoo\'')[0].fix, /Аргументы JVM/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shizo-clean-'));
  const mk = async (rel, ageDays) => {
    const f = path.join(root, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, 'x'.repeat(10));
    const t = new Date(Date.now() - ageDays * 86_400_000);
    await fs.utimes(f, t, t);
  };
  try {
    await mk('libraries/a.jar.part', 0);
    await mk('instances/i/.minecraft/logs/2026-01-01-1.log.gz', 30);
    await mk('instances/i/.minecraft/logs/fresh.log.gz', 1);
    await mk('instances/i/.minecraft/logs/latest.log', 30);
    await mk('instances/i/.minecraft/crash-reports/old.txt', 60);
    await mk('instances/i/.minecraft/saves/world/level.dat', 400);
    await mk('instances/i/.minecraft/screenshots/old.png', 400);
    assert.deepEqual(await cleanCache(root, { dry: true, tmp: root }), { files: 3, bytes: 30 });
    assert.deepEqual(await cleanCache(root, { tmp: root }), { files: 3, bytes: 30 });
    const left = (await fs.readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
    assert.deepEqual(left, ['fresh.log.gz', 'latest.log', 'level.dat', 'old.png']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('обновление лаунчера: сравнение версий, поиск релиза, проверка контрольной суммы', async () => {
  const fs = await import('node:fs/promises');
  const http = await import('node:http');
  const os = await import('node:os');
  const { createHash } = await import('node:crypto');
  const { compareVersions, checkUpdate, downloadUpdate } = await import('../src/main/core/update.js');
  assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(compareVersions('v1.2.0', '1.2'), 0);
  assert.equal(compareVersions('1.1.9', '1.2.0'), -1);

  const exe = Buffer.from('installer-bytes');
  let digest = `sha256:${createHash('sha256').update(exe).digest('hex')}`;
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/repos/a/b/releases/latest') return res.end(JSON.stringify({ tag_name: 'v1.3.0', body: 'что нового', assets: [{ name: 'notes.txt' }, { name: 'Setup.exe', size: exe.length, digest, browser_download_url: `${base}/Setup.exe` }] }));
    if (req.url === '/Setup.exe') return res.end(exe);
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shizo-upd-'));
  try {
    assert.equal(await checkUpdate('', '1.0.0', api), null); // репозиторий не задан
    assert.equal(await checkUpdate('no/repo', '1.0.0', api), null); // релизов нет — не ошибка
    assert.equal(await checkUpdate('a/b', '1.3.0', api), null); // уже последняя
    const info = await checkUpdate('a/b', '1.2.0', api);
    assert.deepEqual([info.version, info.notes, info.size], ['1.3.0', 'что нового', exe.length]);
    assert.equal(await fs.readFile(await downloadUpdate(info, dir), 'utf8'), 'installer-bytes');
    await assert.rejects(downloadUpdate({ ...info, sha256: '0'.repeat(64) }, dir), /контрольная сумма/);
    assert.deepEqual(await fs.readdir(dir), []); // повреждённый установщик не остаётся на диске
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('моды: опознание по хешу и обновление (макет Modrinth)', async () => {
  const fs = await import('node:fs/promises');
  const http = await import('node:http');
  const os = await import('node:os');
  const { createHash } = await import('node:crypto');
  const { contentInfo, updateContent } = await import('../src/main/core/modrinth.js');
  const { createInstance, gameDir } = await import('../src/main/core/instances.js');
  const sha1 = (s) => createHash('sha1').update(s).digest('hex');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shizo-mods-'));
  const inst = await createInstance(root, { name: 'T', mc: '1.21.11', loader: { type: 'fabric', version: '0.1' } });
  const mods = path.join(gameDir(root, inst.id), 'mods');
  await fs.mkdir(mods, { recursive: true });
  await fs.writeFile(path.join(mods, 'sodium-1.0.jar'), 'SODIUM1');
  await fs.writeFile(path.join(mods, 'lithium-2.0.jar.disabled'), 'LITHIUM2');
  await fs.writeFile(path.join(mods, 'private.jar'), 'PRIVATE'); // свой мод, на Modrinth его нет
  let asked;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const base = `http://127.0.0.1:${server.address().port}`;
    const ver = (id, project, number, date, body) => ({ id, project_id: project, version_number: number, date_published: date, files: [{ primary: true, filename: `${project}-${number}.jar`, url: `${base}/f/${project}-${number}`, hashes: { sha1: sha1(body) }, size: body.length }] });
    const cur = { [sha1('SODIUM1')]: ver('s1', 'sodium', '1.0', '2026-01-01', 'SODIUM1'), [sha1('LITHIUM2')]: ver('l2', 'lithium', '2.0', '2026-01-01', 'LITHIUM2') };
    if (req.url === '/version_files') return res.end(JSON.stringify(cur));
    if (req.url === '/version_files/update') { asked = JSON.parse(raw); return res.end(JSON.stringify({ [sha1('SODIUM1')]: ver('s2', 'sodium', '1.1', '2026-02-01', 'SODIUM-NEW'), [sha1('LITHIUM2')]: ver('l3', 'lithium', '2.1', '2026-02-01', 'LITHIUM-NEW') })); }
    if (req.url === '/f/sodium-1.1') return res.end('SODIUM-NEW');
    if (req.url === '/f/lithium-2.1') return res.end('LITHIUM-NEW');
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  try {
    const info = await contentInfo(root, inst.id, api);
    assert.deepEqual(info.map((m) => [m.file, m.projectId ?? null, m.update?.version ?? null]), [['lithium-2.0.jar.disabled', 'lithium', '2.1'], ['private.jar', null, null], ['sodium-1.0.jar', 'sodium', '1.1']]);
    assert.deepEqual([asked.loaders, asked.game_versions], [['fabric'], ['1.21.11']]);
    assert.equal(await updateContent(root, inst.id, ['sodium-1.0.jar'], {}, api), 1); // только один
    assert.deepEqual((await fs.readdir(mods)).sort(), ['lithium-2.0.jar.disabled', 'private.jar', 'sodium-1.1.jar']);
    assert.equal(await updateContent(root, inst.id, null, {}, api), 1); // остальные; sodium уже новый — его хеша в «текущих» нет
    assert.deepEqual((await fs.readdir(mods)).sort(), ['lithium-2.1.jar.disabled', 'private.jar', 'sodium-1.1.jar']); // выключенный мод остался выключенным
    assert.equal(await fs.readFile(path.join(mods, 'sodium-1.1.jar'), 'utf8'), 'SODIUM-NEW');
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('NeoForge: префикс версии по версии игры', async () => {
  const { neoforgePrefix, isForge } = await import('../src/main/core/forge.js');
  assert.equal(neoforgePrefix('1.21.11'), '21.11.');
  assert.equal(neoforgePrefix('1.21'), '21.0.');
  assert.equal(neoforgePrefix('26.3'), '26.3.');
  assert.deepEqual(['forge', 'neoforge', 'fabric'].map(isForge), [true, true, false]);
});

test('свой сервер авторизации (authlib-injector): поиск API, вход, продление сессии', async () => {
  const http = await import('node:http');
  const { resolveAuthServer, customLogin, freshAccount } = await import('../src/main/core/auth.js');
  let valid = true;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const json = (code, d) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(d === undefined ? '' : JSON.stringify(d));
    if (req.url === '/') return res.writeHead(200, { 'X-Authlib-Injector-API-Location': '/api/yggdrasil/' }).end('<html>сайт</html>');
    if (req.url === '/api/yggdrasil') return json(200, { meta: { serverName: 'Тестовый скин-сервер' }, skinDomains: ['x'] });
    if (req.url === '/plain') return json(200, { hello: 1 });
    if (req.url === '/api/yggdrasil/authserver/authenticate') {
      if (body.password !== 'secret') return json(403, { error: 'ForbiddenOperationException', errorMessage: 'Invalid credentials' });
      return json(200, { accessToken: 'tok1', clientToken: body.clientToken, availableProfiles: [{ id: 'abc123', name: 'Hero' }] });
    }
    if (req.url === '/api/yggdrasil/authserver/validate') return valid ? json(204) : json(403, { error: 'ForbiddenOperationException' });
    if (req.url === '/api/yggdrasil/authserver/refresh') return json(200, { accessToken: 'tok2', selectedProfile: { id: 'abc123', name: 'Hero2' } });
    json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await resolveAuthServer(site), { api: `${site}/api/yggdrasil`, name: 'Тестовый скин-сервер' });
    await assert.rejects(resolveAuthServer(`${site}/plain`), /нет сервера авторизации/);
    await assert.rejects(resolveAuthServer('http://example.com'), /https/); // пароль по открытому каналу не отправляем
    await assert.rejects(customLogin(site, 'u', 'wrong'), /Неверный логин или пароль/);
    const acc = await customLogin(site, 'u', 'secret');
    assert.deepEqual([acc.type, acc.name, acc.uuid, acc.accessToken, acc.server, acc.serverName], ['custom', 'Hero', 'abc123', 'tok1', `${site}/api/yggdrasil`, 'Тестовый скин-сервер']);
    assert.equal((await freshAccount(acc)).accessToken, 'tok1'); // сессия жива — ничего не меняется
    valid = false;
    assert.deepEqual(await freshAccount(acc).then((a) => [a.accessToken, a.name]), ['tok2', 'Hero2']); // истекла — продлена
  } finally {
    server.close();
  }
});
