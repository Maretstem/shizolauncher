// 3D-превью скина без библиотек: каждая часть тела — коробка из шести div с кусками текстуры, собранная CSS 3D.
// Развёртка текстуры как в Minecraft: у коробки w×h×d с углом (u, v) сверху лежат верх и низ, ниже — правый бок, перед, левый бок, спина.
/* exported SkinView */
const SkinView = (() => {
  const S = 6; // экранных пикселей на пиксель скина

  function box(src, texH, [u, v], [w, hh, d], transform) {
    const cube = document.createElement('div');
    cube.className = 'cube';
    if (transform) cube.style.transform = transform;
    const faces = [
      [u + d, v + d, w, hh, `translateZ(${(d * S) / 2}px)`], // перед
      [u + 2 * d + w, v + d, w, hh, `rotateY(180deg) translateZ(${(d * S) / 2}px)`], // спина
      [u, v + d, d, hh, `rotateY(-90deg) translateZ(${(w * S) / 2}px)`], // правый бок персонажа (слева на экране)
      [u + d + w, v + d, d, hh, `rotateY(90deg) translateZ(${(w * S) / 2}px)`], // левый бок
      [u + d, v, w, d, `rotateX(90deg) translateZ(${(hh * S) / 2}px)`], // верх
      [u + d + w, v, w, d, `rotateX(-90deg) translateZ(${(hh * S) / 2}px)`], // низ
    ];
    for (const [x, y, fw, fh, t] of faces) {
      const f = document.createElement('div');
      f.className = 'face';
      Object.assign(f.style, {
        width: `${fw * S}px`,
        height: `${fh * S}px`,
        left: `${(-fw * S) / 2}px`,
        top: `${(-fh * S) / 2}px`,
        backgroundImage: `url("${src}")`,
        backgroundSize: `${64 * S}px ${texH * S}px`,
        backgroundPosition: `${-x * S}px ${-y * S}px`,
        transform: t,
      });
      cube.append(f);
    }
    return cube;
  }

  // Второй слой (шапка, куртка, рукава, штанины) чуть больше основного — как в игре
  const inflate = ([w, hh, d]) => `scale3d(${(w + 1) / w}, ${(hh + 1) / hh}, ${(d + 1) / d})`;

  // Часть тела: точка крепления (x, y) в пикселях скина от центра модели; конечности качаются вокруг неё
  function part(x, y, size, layers, swing) {
    const pivot = document.createElement('div');
    pivot.className = 'part';
    pivot.style.transform = `translate3d(${x * S}px, ${y * S}px, 0)`;
    const swinger = document.createElement('div');
    swinger.className = `part${swing ? ` swing ${swing}` : ''}`;
    const body = document.createElement('div');
    body.className = 'part';
    body.style.transform = `translateY(${(size[1] * S) / 2}px)`;
    body.append(...layers);
    swinger.append(body);
    pivot.append(swinger);
    return pivot;
  }

  function build(src, texH, slim) {
    const legacy = texH === 32; // старый формат 64×32: левые руки и ноги — зеркало правых, второго слоя на теле нет
    const aw = slim ? 3 : 4;
    const arm = [aw, 12, 4];
    const leg = [4, 12, 4];
    const layer = (uv, size, mirror, over) => box(src, texH, uv, size, over ? inflate(size) : mirror ? 'scaleX(-1)' : '');
    const limb = (base, over, size, mirror) => [layer(base, size, mirror), over && !legacy && layer(over, size, false, true)].filter(Boolean);
    const model = document.createElement('div');
    model.className = 'model';
    const ax = slim ? 5.5 : 6;
    model.append(
      part(0, -16, [8, 8, 8], [layer([0, 0], [8, 8, 8]), layer([32, 0], [8, 8, 8], false, true)]),
      part(0, -8, [8, 12, 4], limb([16, 16], [16, 32], [8, 12, 4])),
      part(-ax, -8, arm, limb([40, 16], [40, 32], arm), 'a'),
      part(ax, -8, arm, legacy ? limb([40, 16], null, arm, true) : limb([32, 48], [48, 48], arm), 'b'),
      part(-2, 4, leg, limb([0, 16], [0, 32], leg), 'b'),
      part(2, 4, leg, legacy ? limb([0, 16], null, leg, true) : limb([16, 48], [0, 48], leg), 'a'),
    );
    return model;
  }

  // Запасной скин, если у аккаунта своего нет: простая фигурка в цветах лаунчера
  function fallback() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const rect = (color, x, y, w, hh) => ((g.fillStyle = color), g.fillRect(x, y, w, hh));
    const paint = (color, [u, v], [w, hh, d]) => (rect(color, u + d, v, 2 * w, d), rect(color, u, v + d, 2 * (w + d), hh));
    paint('#e3b48f', [0, 0], [8, 8, 8]);
    rect('#3b2150', 8, 0, 8, 8); // макушка
    rect('#3b2150', 24, 8, 8, 8); // затылок
    rect('#3b2150', 0, 8, 32, 2); // чёлка по кругу
    rect('#3b2150', 0, 10, 8, 2);
    rect('#3b2150', 16, 10, 8, 2);
    rect('#ffffff', 9, 12, 2, 1);
    rect('#ffffff', 13, 12, 2, 1);
    rect('#7a3cff', 10, 12, 1, 1);
    rect('#7a3cff', 13, 12, 1, 1);
    rect('#b5786a', 11, 14, 2, 1);
    paint('#d43fb8', [16, 16], [8, 12, 4]);
    for (const uv of [[40, 16], [32, 48]]) (paint('#e3b48f', uv, [4, 12, 4]), rect('#d43fb8', uv[0], uv[1] + 4, 16, 4), rect('#d43fb8', uv[0] + 4, uv[1], 8, 4));
    for (const uv of [[0, 16], [16, 48]]) (paint('#2a2346', uv, [4, 12, 4]), rect('#15111f', uv[0], uv[1] + 14, 16, 2));
    return c.toDataURL();
  }

  // -> Promise<HTMLElement>: сцена, которая сама медленно крутится и поворачивается мышью
  async function create(src, slim) {
    const img = new Image();
    img.src = src;
    await img.decode().catch(() => null);
    const texH = img.naturalWidth === 64 && img.naturalHeight === 32 ? 32 : 64;
    const stage = document.createElement('div');
    stage.className = 'skin3d';
    stage.title = 'Покрути мышью';
    const model = build(src, texH, slim);
    stage.append(model);
    let angle = 30;
    let tilt = -10;
    let drag = null;
    let last = 0;
    let running = false;
    const paint = () => (model.style.transform = `rotateX(${tilt}deg) rotateY(${angle}deg)`);
    const tick = (t) => {
      if (!stage.isConnected) return void (running = false); // меню закрыли — не крутим зря
      if (!drag && last) angle += ((t - last) / 1000) * 24;
      last = t;
      paint();
      requestAnimationFrame(tick);
    };
    stage.start = () => {
      if (running) return;
      running = true;
      last = 0;
      requestAnimationFrame(tick);
    };
    stage.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, angle, tilt };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      angle = drag.angle + (e.clientX - drag.x) * 0.8;
      tilt = Math.max(-40, Math.min(40, drag.tilt - (e.clientY - drag.y) * 0.5));
    });
    const up = () => (drag = null);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    paint();
    return stage;
  }

  return { create, fallback };
})();
