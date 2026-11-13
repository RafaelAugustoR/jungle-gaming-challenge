import { createConnection, createServer, type Socket } from 'node:net';

// Faults affect only clients explicitly pointed at these ephemeral proxies.
export async function databaseFault(databaseUrl: string) {
  const upstream = new URL(databaseUrl);
  const targetHost = upstream.hostname;
  const targetPort = Number(upstream.port || 5432);
  let available = true;
  let rejected = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (!available) {
      rejected++;
      socket.destroy();
      return;
    }
    const target = createConnection({ host: targetHost, port: targetPort });
    for (const connection of [socket, target]) {
      sockets.add(connection);
      connection.on('error', () => {
        socket.destroy();
        target.destroy();
      });
      connection.on('close', () => sockets.delete(connection));
    }
    socket.pipe(target).pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP proxy has no port');
  upstream.hostname = '127.0.0.1';
  upstream.port = String(address.port);
  return {
    url: upstream.toString(),
    get rejected() {
      return rejected;
    },
    setAvailable(value: boolean) {
      available = value;
      if (!value) for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function brokerFault(endpoint: string, queueUrl: string) {
  let available = false;
  let rejected = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (!available) {
        rejected++;
        return Response.json(
          { __type: 'ServiceUnavailable', message: 'isolated recovery fault' },
          { status: 503 },
        );
      }
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('content-length');
      return fetch(endpoint, { method: request.method, headers, body: await request.text() });
    },
  });
  const queue = new URL(queueUrl);
  const proxyQueue = new URL(queue.pathname, server.url).toString();
  return {
    endpoint: server.url.toString(),
    queue: proxyQueue,
    get rejected() {
      return rejected;
    },
    restore() {
      available = true;
    },
    close: () => server.stop(true),
  };
}
