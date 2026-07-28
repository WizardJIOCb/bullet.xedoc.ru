import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
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
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? 'https://bullet.xedoc.ru,http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const lobby = new LobbyServer({ maxRooms });
const idleRoomSweep = setInterval(
  () => lobby.expireIdleRooms(idleRoomTimeoutMs),
  Math.min(60_000, Math.max(15_000, Math.floor(idleRoomTimeoutMs / 4))),
);
idleRoomSweep.unref();
const httpServer = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200);
    response.end(JSON.stringify({
      ok: true,
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
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
