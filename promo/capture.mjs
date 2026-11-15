// Кадры лаунчера для ролика: electron promo/capture.mjs <папка>
// Снимает через DevTools-протокол с эмуляцией окна 1040x1160 @2x — чётче и выше, чем влезает на экран.
// Запускать с SHIZO_DATA=<временная папка>, чтобы не трогать настоящие данные.
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const outDir = process.argv[2];
const SETUP = "api.call('addOffline','Shizo_Player').then(()=>S.instances.some(i=>i.id!==S.packId)||api.call('createInstance',{name:'Выживание с друзьями',mc:'1.21.11',type:'fabric'})).then(refresh)";
// Перед снимком: догрузить ленивые картинки, показать версию лаунчера (а не Electron), убрать живой онлайн/пинг
const PREP = `{ document.querySelectorAll("img").forEach((i) => { i.loading = "eager"; });
  document.querySelector(".ver").textContent = "Лаунчер 1.0.0";
  const sub = document.querySelector("#view > p.sub");
  if (sub && /сейчас на сервере|не отвечает/.test(sub.textContent)) sub.textContent = "Официальная сборка сервера: ставится и обновляется одной кнопкой";
  } 0`; // блок: иначе const sub объявится повторно на следующем шаге
const SHOTS = {
  home: 'select(S.packId)',
  accounts: "go('accounts')",
  instance: 'select(S.instances.find(i=>i.id!==S.packId).id)',
  mods: "go('mods')",
  packs: "go('packs')",
};

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const run = (js) => win.webContents.executeJavaScript(js, true).catch((e) => console.log('[ошибка шага]', js, e.message));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const dbg = win.webContents.debugger;
    dbg.attach();
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1040, height: 1160, deviceScaleFactor: 2, mobile: false });
    await fs.mkdir(outDir, { recursive: true });
    await wait(2500);
    await run(SETUP);
    await wait(2500);
    for (const [name, js] of Object.entries(SHOTS)) {
      await run(js);
      await wait(3500); // пинг сервера, статус сборки, выдача Modrinth
      await run(PREP);
      await wait(2500);
      const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
      console.log('снято:', name);
    }
    app.quit();
  });
});
await import('../src/main/main.js');
