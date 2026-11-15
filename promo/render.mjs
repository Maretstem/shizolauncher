// Рендер ролика: electron promo/render.mjs  ->  promo/out/shizolauncher_tiktok.mp4
// Скрытое окно покадрово вызывает renderAt(t) из tiktok.html и передаёт кадры в ffmpeg.
// Окно без рамки: окну с рамкой Windows не даёт стать выше экрана, и кадр получается сплюснутым.
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FPS = 30;
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out', 'shizolauncher_tiktok.mp4');

app.whenReady().then(async () => {
  await fs.mkdir(path.dirname(out), { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1080, height: 1920, useContentSize: true, frame: false, webPreferences: { offscreen: true } });
  win.setMinimumSize(1080, 1920);
  win.setContentSize(1080, 1920);
  await win.loadFile(path.join(here, 'tiktok.html'));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const duration = await js('Promise.all([...document.images].map((i) => i.decode())).then(() => DURATION)');

  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', FPS, '-i', '-',
    '-vf', 'scale=1080:1920:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-movflags', '+faststart', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });

  const frames = Math.round(duration * FPS);
  for (let n = 0; n < frames; n++) {
    // два кадра отрисовки: стили применены и картинка действительно обновилась
    await js(`renderAt(${n / FPS}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const image = await win.webContents.capturePage();
    const { width, height } = image.getSize();
    if (width * 16 !== height * 9) throw new Error(`кадр ${width}x${height} — не 9:16, ролик исказится`);
    const png = image.toPNG();
    if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain');
    if (n % 90 === 0) console.log(`кадр ${n} из ${frames}`);
  }
  ffmpeg.stdin.end();
  const [code] = await once(ffmpeg, 'exit');
  console.log(code === 0 ? `готово: ${out}` : `ffmpeg завершился с кодом ${code}`);
  app.exit(code ?? 1);
});
