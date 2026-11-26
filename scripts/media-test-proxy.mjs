// Тестовый HTTP CONNECT-прокси: пускает только `pbs.twimg.com:443` и пересылает на локальный TLS-стенд.
// Нужен тестам медиа-канала: прямого соединения в продакшен-коде больше нет, весь трафик идёт через прокси.
import net from 'node:net';

export async function startFixtureProxy() {
  let target = 0;
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  const server = net.createServer(client => {
    track(client);
    let buffered = Buffer.alloc(0);
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      if (!/^CONNECT pbs\.twimg\.com:443 HTTP\/1\.1/.test(buffered.subarray(0, end).toString('latin1')) || !target) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = net.connect({ host: '127.0.0.1', port: target });
      track(upstream);
      upstream.on('error', () => client.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const rest = buffered.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on('data', onData);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    setTarget(port) { target = port; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
