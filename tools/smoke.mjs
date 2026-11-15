// Проверка ядра без окна: ставит версию и запускает игру, пока та не дойдёт до главного меню (или 90 с).
//   node tools/smoke.mjs [версия=1.21.11] [fabric|quilt|vanilla]
import path from 'node:path';
import { offlineAccount } from '../src/main/core/auth.js';
import { ensureLoader, launch } from '../src/main/core/minecraft.js';

const [mc = '1.21.11', loader = 'fabric'] = process.argv.slice(2);
const root = process.env.SHIZO_DATA ?? path.join(process.env.APPDATA, 'ShizostanLauncher');
let lastLabel;
let seenLoader;
const progress = (p) => {
  if (p.label !== lastLabel) console.log(`${(lastLabel = p.label)}: ${p.totalFiles} файлов, ${(p.totalBytes / 1048576).toFixed(0)} МБ`);
};
const versionId = await ensureLoader(root, mc, { type: loader }, { onProgress: progress });
console.log('версия:', versionId);
const child = await launch({
  root,
  versionId,
  gameDir: path.join(root, 'instances', 'smoke-test', '.minecraft'),
  account: offlineAccount('SmokeTest'),
  memory: 2048,
  onProgress: progress,
  onLog: (text) => {
    process.stdout.write(text);
    if (/Sound engine started|OpenAL initialized/.test(text)) finish(0, 'ИГРА ДОШЛА ДО МЕНЮ');
    if (/ModLauncher running|Loading \d+ mods|FML|NeoForge/.test(text) && !seenLoader) console.log(`\n== загрузчик стартовал: ${(seenLoader = text.trim().slice(0, 120))} ==`);
  },
});
const timer = setTimeout(() => finish(1, 'ТАЙМАУТ 150 с'), 150_000);
child.on('exit', (code) => finish(code ?? 1, `игра завершилась сама, код ${code}`));
function finish(code, why) {
  clearTimeout(timer);
  console.log(`\n== ${why} ==`);
  child.removeAllListeners('exit');
  child.kill();
  process.exit(code);
}
