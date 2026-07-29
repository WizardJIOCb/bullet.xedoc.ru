import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { AccountApi } from './account/AccountApi.ts';
import { AccountStore } from './account/AccountStore.ts';
import { LobbyServer } from './LobbyServer.ts';
import { ONLINE_LIMITS, ONLINE_PROTOCOL_VERSION } from '../src/online/protocol.ts';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const host = process.env.HOST ?? '127.0.0.1';
const wsPath = process.env.WS_PATH ?? '/multiplayer';
const maxConnections = Math.max(2, Number.parseInt(process.env.MAX_CONNECTIONS ?? '500', 10) || 500);
const maxRooms = Math.max(1, Number.parseInt(process.env.MAX_ROOMS ?? '256', 10) || 256);
const handshakeTimeoutMs = Math.max(1_000, Number.parseInt(process.env.HANDSHAKE_TIMEOUT_MS ?? '8000', 10) || 8_000);
const idleRoomTimeoutMs = Math.max(60_000, Number.parseInt(process.env.ROOM_IDLE_TIMEOUT_MS ?? '1800000', 10) || 1_800_000);
const releaseId = process.env.RELEASE_ID ?? 'development';
const production = process.env.NODE_ENV === 'production';
const accountDatabasePath = process.env.ACCOUNT_DATABASE_PATH
  ?? resolve(process.cwd(), 'data', 'accounts.sqlite');
const accountPasswordPepper = process.env.ACCOUNT_PASSWORD_PEPPER
  ?? process.env.BALLISTIC_EDGE_PASSWORD_PEPPER
  ?? process.env.PASSWORD_PEPPER
  ?? '';
const secureAccountCookies = process.env.ACCOUNT_COOKIE_SECURE === undefined
  ? production
  : process.env.ACCOUNT_COOKIE_SECURE !== 'false';
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? 'https://bullet.xedoc.ru,http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const lobby = new LobbyServer({ maxRooms });
if (production && Buffer.byteLength(accountPasswordPepper, 'utf8') < 32) {
  throw new Error('ACCOUNT_PASSWORD_PEPPER must contain at least 32 bytes in production.');
}
const accountStore = new AccountStore({
  path: accountDatabasePath,
  passwordPepper: accountPasswordPepper,
});
const accountApi = new AccountApi(accountStore, {
  allowedOrigins,
  secureCookies: secureAccountCookies,
});
const idleRoomSweep = setInterval(
  () => lobby.expireIdleRooms(idleRoomTimeoutMs),
  Math.min(60_000, Math.max(15_000, Math.floor(idleRoomTimeoutMs / 4))),
);
idleRoomSweep.unref();
async function handleHttpRequest(request: Parameters<typeof accountApi.handle>[0], response: Parameters<typeof accountApi.handle>[1]): Promise<void> {
  if (await accountApi.handle(request, response)) return;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET' && request.url === '/health') {
    let accountStorage = false;
    try {
      accountStorage = (accountStore.database.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
    } catch {
      accountStorage = false;
    }
    if (!accountStorage) response.statusCode = 503;
    else response.statusCode = 200;
    response.end(JSON.stringify({
      ok: accountStorage,
      accountStorage,
      connections: lobby.connectionCount,
      rooms: lobby.roomCount,
      protocolVersion: ONLINE_PROTOCOL_VERSION,
      release: releaseId,
      uptime: process.uptime(),
    }));
    return;
  }
  if (request.method === 'GET' && request.url === '/rooms') {
    response.writeHead(200);
    response.end(JSON.stringify({ rooms: lobby.listRoomSummaries() }));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: 'not found' }));
}

const httpServer = createServer((request, response) => {
  void handleHttpRequest(request, response).catch((error) => {
    process.stderr.write(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}\n`);
    if (response.writableEnded) return;
    if (!response.headersSent) {
      response.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({ error: 'internal server error' }));
    } else {
      response.destroy();
    }
  });
});

const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: ONLINE_LIMITS.clientMessageBytes,
  perMessageDeflate: false,
});

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const origin = request.headers.origin;
  if (sockets.clients.size >= maxConnections) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\n\r\n');
    socket.destroy();
    return;
  }
  if (url.pathname !== wsPath || !origin || !allowedOrigins.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    sockets.emit('connection', webSocket, request);
  });
});

sockets.on('connection', (socket) => {
  const connectionId = randomUUID();
  let alive = true;
  lobby.connect({
    id: connectionId,
    send(payload) {
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < ONLINE_LIMITS.serverMessageBytes * 4) {
        socket.send(payload);
      }
    },
    close(code, reason) {
      socket.close(code, reason);
    },
  });

  const handshakeTimeout = setTimeout(() => {
    if (!lobby.isIdentified(connectionId)) socket.close(1008, 'hello timeout');
  }, handshakeTimeoutMs);
  handshakeTimeout.unref();

  socket.on('pong', () => { alive = true; });
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      socket.close(1003, 'text frames only');
      return;
    }
    lobby.receive(connectionId, data.toString('utf8'));
    if (lobby.isIdentified(connectionId)) clearTimeout(handshakeTimeout);
  });
  socket.once('close', () => lobby.disconnect(connectionId));
  socket.once('error', () => lobby.disconnect(connectionId));

  const heartbeat = setInterval(() => {
    if (!alive) {
      clearInterval(heartbeat);
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 30_000);
  heartbeat.unref();
  socket.once('close', () => clearInterval(heartbeat));
  socket.once('close', () => clearTimeout(handshakeTimeout));
});

httpServer.listen(port, host, () => {
  process.stdout.write(`BALLISTIC EDGE lobby listening on http://${host}:${port}${wsPath}\n`);
});

function shutdown(): void {
  clearInterval(idleRoomSweep);
  for (const socket of sockets.clients) socket.close(1001, 'server restart');
  sockets.close();
  httpServer.close(() => {
    accountStore.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
