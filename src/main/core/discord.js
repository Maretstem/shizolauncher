// Статус в Discord («Играет на SHIZOSTAN») через локальный канал клиента Discord (Rich Presence, без библиотек).
import { randomUUID } from 'node:crypto';
import net from 'node:net';

// Кадр протокола: код операции (int32 LE) + длина (int32 LE) + JSON
export function frame(op, data) {
  const body = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

const pipes = (prefix) => Array.from({ length: 10 }, (_, i) => `${prefix}${i}`);

// Подключается к запущенному Discord и выставляет статус. -> { stop() } или null, если Discord не запущен.
// pid — процесс самой игры: по нему Discord понимает, что человек играет, и даёт друзьям смотреть трансляцию.
// С pid лаунчера друзья на запросе трансляции видели «Не играет».
export function showPresence(clientId, activity, { prefix = '\\\\?\\pipe\\discord-ipc-', timeout = 3000, pid = process.pid } = {}) {
  if (!clientId) return Promise.resolve(null);
  const tryPipe = (list) =>
    new Promise((resolve) => {
      if (!list.length) return resolve(null);
      const sock = net.connect(list[0]);
      const fail = () => (sock.destroy(), resolve(tryPipe(list.slice(1))));
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        sock.on('error', () => {}); // Discord закрылся посреди игры — не страшно
        let buf = Buffer.alloc(0);
        let ready = false;
        const timer = setTimeout(() => (sock.destroy(), resolve(null)), timeout);
        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4)) {
            const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString());
            buf = buf.subarray(8 + buf.readInt32LE(4));
            if (!ready && msg.evt === 'READY') {
              ready = true;
              clearTimeout(timer);
              sock.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid, activity }, nonce: randomUUID() }));
              resolve({ stop: () => sock.end() });
            } else if (!ready && msg.evt === 'ERROR') {
              clearTimeout(timer);
              sock.destroy();
              resolve(null); // неверный ID приложения Discord
            }
          }
        });
        sock.write(frame(0, { v: 1, client_id: clientId }));
      });
    });
  return tryPipe(pipes(prefix));
}
