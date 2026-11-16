// Вкладка «Разработка» и уведомления: devlog.json лежит рядом с pack.json, его пишет веб-панель админов.
//
// devlog.json: { posts: [{ id, date, title, tag: 'dev'|'event'|'update', text, media: [{ src, type: 'image'|'video' }] }] }
import { fetchJson, httpsUrl } from './net.js';

export const devlogUrl = (packUrl) => (packUrl ? new URL('devlog.json', httpsUrl(packUrl)).href : null);

export async function fetchDevlog(packUrl) {
  const url = devlogUrl(packUrl);
  if (!url) return { posts: [] };
  const d = await fetchJson(url, { cache: 'no-store' }).catch((e) => {
    if (e.status === 404) return null; // постов ещё не было
    throw e;
  });
  const posts = Array.isArray(d?.posts) ? d.posts : [];
  return {
    posts: posts
      .filter((p) => p && typeof p.id === 'string' && typeof p.title === 'string')
      .slice(0, 50)
      .map((p) => ({
        id: p.id,
        date: p.date ?? null,
        title: p.title.slice(0, 120),
        tag: ['dev', 'event', 'update'].includes(p.tag) ? p.tag : 'dev',
        text: String(p.text ?? '').slice(0, 5000),
        // Картинки и видео — только веб-адреса (относительные — рядом с devlog.json), никаких file: и прочих схем
        media: (Array.isArray(p.media) ? p.media : []).slice(0, 10).flatMap((m) => {
          try {
            return [{ src: httpsUrl(m.src, url), type: m.type === 'video' ? 'video' : 'image' }];
          } catch {
            return [];
          }
        }),
      })),
  };
}

const newsKey = (n) => (n ? `${n.date ?? ''}|${String(n.text ?? '').slice(0, 80)}` : null);
const firstLine = (s, max = 140) => {
  const line = String(s ?? '').trim().split(/\r?\n/)[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// Что появилось с прошлой проверки. now: { launcher, pack: { version, changelog }, news: [], posts: [] } — любое поле может быть null
// (не удалось узнать) — тогда оно не сравнивается и не забывается. Первая проверка только запоминает, ничего не показывает.
// -> { items: [{ kind, title, body, tab }], seen }
export function diffNews(seen, now) {
  const first = !seen || !Object.keys(seen).length;
  const next = { ...seen };
  const items = [];
  const push = (item) => !first && items.push(item);

  if (now.launcher !== undefined) {
    if (now.launcher && now.launcher !== seen?.launcher) push({ kind: 'launcher', title: `Вышел ShizoLauncher ${now.launcher}`, body: 'Открой лаунчер и нажми «Обновление» — он обновится и перезапустится сам.', tab: 'update' });
    next.launcher = now.launcher;
  }
  if (now.pack) {
    if (now.pack.version !== seen?.pack) push({ kind: 'pack', title: `Сборка обновлена до ${now.pack.version}`, body: firstLine(now.pack.changelog) || 'Нажми «Играть» — лаунчер докачает только изменения.', tab: 'home' });
    next.pack = now.pack.version;
  }
  if (now.news) {
    const key = newsKey(now.news[0]);
    if (key && key !== seen?.news) push({ kind: 'news', title: 'Новость сервера', body: firstLine(now.news[0].text), tab: 'home' });
    next.news = key;
  }
  if (now.posts) {
    const known = new Set(seen?.posts ?? []);
    for (const p of now.posts.filter((x) => !known.has(x.id)).slice(0, 3)) {
      push({ kind: p.tag === 'event' ? 'news' : 'devlog', title: p.tag === 'event' ? `Ивент: ${p.title}` : `Разработка: ${p.title}`, body: firstLine(p.text) || 'Подробности во вкладке «Разработка».', tab: 'dev', post: p.id });
    }
    next.posts = now.posts.map((p) => p.id).slice(0, 50);
  }
  return { items, seen: next };
}

// Какие уведомления игрок оставил включёнными
export const wanted = (cfg, kind) => cfg.notifications !== false && cfg.notify?.[kind] !== false;
