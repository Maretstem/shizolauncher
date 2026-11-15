// Снимки экрана для проверки интерфейса: electron tools/shot.mjs <папка> <шаги.json>
// шаги.json — массив выражений; каждое выполняется в окне перед очередным снимком.
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const [outDir, stepsFile] = process.argv.slice(2);
const steps = stepsFile ? JSON.parse(await fs.readFile(stepsFile, 'utf8')) : [];
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    win.webContents.on('console-message', (ev) => console.log('[окно]', ev.message));
    await fs.mkdir(outDir, { recursive: true });
    for (const [n, js] of ['0', ...steps].entries()) {
      await win.webContents.executeJavaScript(js, true).catch((e) => console.log('[ошибка шага]', js, e.message));
      await new Promise((r) => setTimeout(r, n ? 1800 : 3000));
      await fs.writeFile(path.join(outDir, `${n}.png`), (await win.webContents.capturePage()).toPNG());
    }
    app.quit();
  });
});
await import('../src/main/main.js');
