// Перенос из других лаунчеров: миры, скриншоты, ресурспаки и настройки игры.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exists = (p) => fs.access(p).then(() => true, () => false);
const subdirs = async (dir) => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);

// Где другие лаунчеры держат папку игры. TLauncher и официальный лаунчер — %APPDATA%\.minecraft.
export function knownLaunchers(appData = process.env.APPDATA ?? '', home = os.homedir()) {
  return [
    { launcher: 'TLauncher / официальный', single: path.join(appData, '.minecraft') },
    { launcher: 'Prism Launcher', instances: path.join(appData, 'PrismLauncher', 'instances'), inner: ['.minecraft', 'minecraft'] },
    { launcher: 'MultiMC', instances: path.join(home, 'MultiMC', 'instances'), inner: ['.minecraft', 'minecraft'] },
    { launcher: 'FreesmLauncher', instances: path.join(appData, 'FreesmLauncher', 'instances'), inner: ['.minecraft', 'minecraft'] },
    { launcher: 'Modrinth App', instances: path.join(appData, 'ModrinthApp', 'profiles'), inner: [''] },
    { launcher: 'CurseForge', instances: path.join(home, 'curseforge', 'minecraft', 'Instances'), inner: [''] },
    { launcher: 'ATLauncher', instances: path.join(appData, 'ATLauncher', 'instances'), inner: [''] },
  ];
}

async function describe(dir) {
  const worlds = (await subdirs(path.join(dir, 'saves'))).length;
  const shots = (await fs.readdir(path.join(dir, 'screenshots')).catch(() => [])).filter((f) => /\.(png|jpe?g)$/i.test(f)).length;
  const options = await exists(path.join(dir, 'options.txt'));
  return worlds || shots || options ? { worlds, shots, options } : null;
}

// -> [{ launcher, name, dir, worlds, shots, options }] — только те, где есть что переносить
export async function findSources(list = knownLaunchers()) {
  const out = [];
  for (const l of list) {
    if (l.single) {
      const d = await describe(l.single);
      if (d) out.push({ launcher: l.launcher, name: '.minecraft', dir: l.single, ...d });
      continue;
    }
    for (const name of await subdirs(l.instances)) {
      for (const inner of l.inner) {
        const dir = path.join(l.instances, name, inner);
        const d = await describe(dir);
        if (d) {
          out.push({ launcher: l.launcher, name, dir, ...d });
          break;
        }
      }
    }
  }
  return out;
}

// Копирует, ничего не перезаписывая: одноимённый мир получает приписку « (перенос)».
// options=true — перенести и настройки игры (управление, графика, звук).
export async function importFrom(src, dest, { options = false } = {}) {
  const done = { worlds: 0, shots: 0, packs: 0, options: false };
  await fs.mkdir(dest, { recursive: true });
  for (const world of await subdirs(path.join(src, 'saves'))) {
    let target = path.join(dest, 'saves', world);
    for (let n = 1; await exists(target); n++) target = path.join(dest, 'saves', `${world} (перенос${n > 1 ? ` ${n}` : ''})`);
    await fs.cp(path.join(src, 'saves', world), target, { recursive: true });
    done.worlds++;
  }
  for (const [folder, key] of [['screenshots', 'shots'], ['resourcepacks', 'packs']]) {
    for (const file of await fs.readdir(path.join(src, folder)).catch(() => [])) {
      const target = path.join(dest, folder, file);
      if (await exists(target)) continue;
      await fs.cp(path.join(src, folder, file), target, { recursive: true });
      done[key]++;
    }
  }
  if (options && (await exists(path.join(src, 'options.txt')))) {
    await fs.copyFile(path.join(src, 'options.txt'), path.join(dest, 'options.txt'));
    done.options = true;
  }
  return done;
}
