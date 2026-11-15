// Забота о системе: подбор памяти и флагов JVM, разбор причин вылета, чистка кэша.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DAY = 86_400_000;

// Сколько памяти дать игре: с запасом под моды, но не больше половины ОЗУ — остальное нужно системе и видеодрайверу.
export function recommendMemory(totalMb, modCount = 0) {
  const want = modCount > 60 ? 6144 : modCount > 0 ? 4096 : 3072;
  const half = Math.floor(totalMb / 2 / 512) * 512;
  return Math.max(2048, Math.min(want, half, 8192));
}

// Флаги G1 от Aikar (без AlwaysPreTouch: на клиенте он только замедляет запуск). Большой куче — регионы покрупнее.
export function recommendFlags(memoryMb) {
  const big = memoryMb >= 12288;
  return [
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC',
    `-XX:G1NewSizePercent=${big ? 40 : 30}`, `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`, `-XX:G1HeapRegionSize=${big ? 16 : 8}M`,
    `-XX:G1ReservePercent=${big ? 15 : 20}`, '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${big ? 20 : 15}`, '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1',
  ].join(' ');
}

// Известные причины вылета: [признак в журнале, что случилось, что делать]
const PROBLEMS = [
  [/OutOfMemoryError|Java heap space|GC overhead limit exceeded/, 'Игре не хватило памяти', 'Увеличь память в настройках или нажми «Подобрать под мой компьютер».'],
  [/Could not reserve enough space|Invalid maximum heap size|Could not create the Java Virtual Machine/, 'Java не смогла занять столько памяти', 'Уменьши память в настройках: столько свободной памяти на компьютере нет.'],
  [/Unrecognized (VM )?option|Improperly specified VM option/, 'В аргументах JVM ошибка', 'Очисти поле «Аргументы JVM» или нажми «Подобрать под мой компьютер».'],
  [/UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime/, 'Игре нужна более новая Java', 'Очисти поле «Путь к Java» — лаунчер сам скачает подходящую версию.'],
  [/Не удалось запустить Java|spawn .* ENOENT/, 'Java не найдена', 'Проверь «Путь к Java» в настройках или очисти его — лаунчер скачает Java сам.'],
  [/DuplicateModsFoundException|[Dd]uplicate mod|duplicate versions of mod/, 'Один мод установлен дважды', 'Открой вкладку «Моды» и оставь только одну версию каждого мода.'],
  [/requires .* which is missing|Mod resolution encountered an incompatible mod set|Incompatible mods? found|Unmet dependency/, 'Модам не хватает зависимостей или они несовместимы', 'Поставь недостающие моды (их названия — в строках ниже) или убери несовместимый мод.'],
  [/GLFW error 65542|Pixel format not accelerated|driver does not appear to support OpenGL|Failed to create (the )?(GLFW )?window/, 'Не удалось запустить графику', 'Обнови драйвер видеокарты. На ноутбуке проверь, что игра запускается на дискретной видеокарте.'],
  [/authlib-injector.*Failed to fetch metadata|Failed to fetch metadata/, 'Игра не смогла связаться с сервером аккаунта', 'Проверь интернет. Если у тебя VPN или прокси — включи его и запусти игру ещё раз.'],
  [/Invalid session|Failed to (verify|log in)|Invalid access token/, 'Сессия аккаунта недействительна', 'Выйди из аккаунта во вкладке «Аккаунты» и войди заново.'],
  [/There is not enough space on the disk|No space left on device/, 'На диске закончилось место', 'Освободи место на диске с лаунчером или нажми «Очистить кэш».'],
];

// -> [{ title, fix, lines }] — что пошло не так, по хвосту журнала игры
export function diagnose(log) {
  const lines = log.split(/\r?\n/);
  return PROBLEMS.filter(([re]) => re.test(log)).map(([re, title, fix]) => ({ title, fix, lines: lines.filter((l) => re.test(l)).slice(0, 4).map((l) => l.trim().slice(0, 300)) }));
}

async function walk(dir, visit) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, visit);
    else await visit(full, e.name);
  }
}

// Что удаляется: недокачанные *.part, сжатые журналы игры старше недели, отчёты о вылетах старше месяца, наши временные файлы.
// Миры, моды, скриншоты, настройки и сами файлы игры не трогаются. dry=true — только посчитать.
export async function cleanCache(root, { dry = false, now = Date.now(), tmp = os.tmpdir() } = {}) {
  const doomed = [];
  const old = async (file, age) => now - (await fs.stat(file)).mtimeMs > age;
  await walk(root, async (file, name) => {
    const dir = path.basename(path.dirname(file));
    if (name.endsWith('.part')) doomed.push(file);
    else if (dir === 'logs' && name.endsWith('.log.gz') && (await old(file, 7 * DAY))) doomed.push(file);
    else if (dir === 'crash-reports' && (await old(file, 30 * DAY))) doomed.push(file);
  });
  for (const e of await fs.readdir(tmp, { withFileTypes: true }).catch(() => [])) {
    if (/^shizo-(mrpack-|\d+\.mrpack$)/.test(e.name) && (await old(path.join(tmp, e.name), DAY))) doomed.push(path.join(tmp, e.name));
  }
  let bytes = 0;
  for (const file of doomed) {
    const st = await fs.stat(file).catch(() => null);
    if (st?.isFile()) bytes += st.size;
    if (!dry) await fs.rm(file, { recursive: true, force: true });
  }
  return { files: doomed.length, bytes };
}
