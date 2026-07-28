# BALLISTIC EDGE online lobby

The lobby is an independent Node/WebSocket process. The browser connects to
`wss://bullet.xedoc.ru/multiplayer`; Nginx proxies that endpoint to port 8787.

## Local run

```bash
cd server
npm install
npm run check
npm run dev
```

Environment variables:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `8787`)
- `WS_PATH` (default `/multiplayer`)
- `ALLOWED_ORIGINS` (comma-separated; defaults to production and Vite origins)
- `MAX_CONNECTIONS` (default `500`)
- `MAX_ROOMS` (default `256`; the public directory returns at most 48 rooms)
- `HANDSHAKE_TIMEOUT_MS` (default `8000`)
- `ROOM_IDLE_TIMEOUT_MS` (default `1800000`; empty lobby expiry)

`GET /health` returns process health, connection and room counts. `GET /rooms`
is a read-only room directory. Client WebSocket frames are limited to 16 KiB,
server snapshots to 64 KiB, and only text JSON frames are accepted.

## Production

1. Stage the `server` directory and `src/online/protocol.ts` plus
   `src/core/types.ts` in a versioned backend release while preserving paths.
2. Run `npm ci --omit=dev` inside the staged `server`, write its `RELEASE_ID`
   to `server/.env.production`, and probe it on a temporary loopback port.
3. Apply read-only runtime permissions, rename staging to its final release,
   then atomically repoint `/var/www/bullet.xedoc.ru/backend-current`.
4. Install `ballistic-edge-online.service` in `/etc/systemd/system/`, run
   `systemctl daemon-reload && systemctl enable --now ballistic-edge-online`,
   and verify that `/health` returns the expected protocol and release.
5. Include `nginx-location.conf` inside the TLS virtual host, validate with
   `nginx -t`, reload Nginx, then verify public JSON `/online-health`.
6. Switch the frontend symlink only after backend health succeeds. Roll back
   both symlinks and restart the service if the final WebSocket smoke-test fails.

The service intentionally runs on loopback. Only Nginx exposes its WebSocket.

## Browser integration

```ts
const lobby = new LobbyClient({
  url: defaultLobbyUrl(),
  name: playerName,
  loadout: { weapon, ability, garage },
});

await lobby.connect();
lobby.on('room', ({ room }) => renderLobby(room));
lobby.on('chat', ({ message }) => appendChat(message));
lobby.on('raceStarted', ({ config }) => {
  const mine = config.humans.find((player) => player.id === lobby.playerId);
  if (mine) setTimeout(() => game.startRun(mine.runConfig), lobby.delayUntil(config.startsAt));
});
```

The host may update `track`, `aiOpponents`, and `playerSlots`. A race can start
only with at least two humans. The server creates the match id, 32-bit seed and
future `startsAt`, then broadcasts immutable per-player `RunConfig` objects.
`sendRaceState` is throttled to 24 Hz; terminal snapshots always pass through.
If the host leaves, ownership migrates to the earliest remaining player.
Calling `ping()` periodically refines the client's server-clock estimate used by
`delayUntil`, so every browser crosses the countdown boundary together.
