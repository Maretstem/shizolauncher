// Server List Ping: онлайн, MOTD и задержка сервера Minecraft.
import dns from 'node:dns/promises';
import net from 'node:net';

function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

// -> [значение, смещение после] либо null, если данных пока не хватает
function readVarint(buf, at) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= buf.length) return null;
    const b = buf[at + i];
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [value, at + i + 1];
  }
  throw new Error('Некорректный ответ сервера');
}

const text = (c) => (typeof c === 'string' ? c : (c?.text ?? '') + (c?.extra ?? []).map(text).join('')).replace(/§./g, '');

export function parseAddress(address) {
  const [host, port] = String(address).trim().split(':');
  return { host, port: Number(port) || 25565 };
}

export async function ping(address, timeout = 4000) {
  let { host, port } = parseAddress(address);
  if (!address.includes(':')) {
    const [srv] = await dns.resolveSrv(`_minecraft._tcp.${host}`).catch(() => []);
    if (srv) ({ name: host, port } = srv);
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    sock.setTimeout(timeout, () => sock.destroy(new Error('Сервер не отвечает')));
    sock.on('error', reject);
    sock.on('connect', () => {
      const name = Buffer.from(host);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const handshake = Buffer.concat([varint(0), varint(0), varint(name.length), name, portBuf, varint(1)]);
      sock.write(Buffer.concat([varint(handshake.length), handshake, varint(1), varint(0)]));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len[1] + len[0]) return;
        const id = readVarint(buf, len[1]);
        const str = readVarint(buf, id[1]);
        const s = JSON.parse(buf.subarray(str[1], str[1] + str[0]).toString());
        // sample — ники игроков онлайн (сервер отдаёт до 12; некоторые серверы прячут их или пишут туда текст)
        const players = (s.players?.sample ?? []).map((p) => text(p.name).trim()).filter((n) => /^[A-Za-z0-9_]{2,16}$/.test(n));
        resolve({ online: s.players?.online ?? 0, max: s.players?.max ?? 0, players, motd: text(s.description).trim(), version: s.version?.name ?? '', latency: Date.now() - started });
      } catch (e) {
        reject(e);
      }
      sock.destroy();
    });
  });
}
