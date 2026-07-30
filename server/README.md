# BALLISTIC EDGE online lobby and account service

The backend is an independent Node HTTP/WebSocket process. The browser connects
to `wss://bullet.xedoc.ru/multiplayer` and the same-origin `/api/v1` account API;
Nginx proxies both to loopback port 8787.

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
- `ACCOUNT_DATABASE_PATH` (default `server/data/accounts.sqlite` outside production)
- `ACCOUNT_PASSWORD_PEPPER` (required in production; at least 32 random bytes)
- `ACCOUNT_COOKIE_SECURE` (default `true` in production)

`GET /health` returns process health, connection and room counts. `GET /rooms`
is a read-only room directory. Client WebSocket frames are limited to 16 KiB,
server snapshots to 64 KiB, and only text JSON frames are accepted.

## Accounts and persistence

Account state is stored in SQLite using the Node 24 `node:sqlite` runtime. The
production database is `/var/lib/ballistic-edge/accounts.sqlite`, deliberately
outside versioned backend releases. SQLite uses WAL, foreign keys and bounded
busy waits. Schema migrations run transactionally before the HTTP listener is
opened.

Authentication uses an opaque random session cookie. Only its SHA-256 digest is
stored; the cookie is `HttpOnly`, `SameSite=Lax`, `Path=/` and `Secure` in
production. Passwords are processed with asynchronous scrypt, a per-account
salt and the deployment pepper. Mutating authenticated requests require the
session CSRF token in `X-CSRF-Token`; every mutating API request must also have
an allowed `Origin`.

The public API prefix is `/api/v1`:

- `GET /auth/session`
- `POST /auth/register`, `/auth/login`, `/auth/recover`, `/auth/logout`
- `GET /me/profile`
- `POST /me/import-legacy`, `/me/garage/upgrade`
- `POST /runs/start`, `/runs/:runId/finish`
- `GET /leaderboards?scope=global|aurora|reactor|void|forge|skyline|abyss&limit=25`
- `GET /achievements`

Synthetic solo tickets are provisionally ranked. Catalog, local-audio and
online tickets still update account progression but remain unranked because the
current simulation is client-authoritative. The global score is the sum of the
four ranked route personal bests, preventing a single high-density route from
dominating the board.

## Production

1. Stage the `server` directory, `src/online/protocol.ts`, `src/core/types.ts`,
   and `src/account/` in a versioned backend release while preserving paths.
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

Before the first account deployment, create a persistent secret file and keep
it out of every release:

```bash
install -d -o root -g root -m 0750 /etc/ballistic-edge
umask 077
printf 'ACCOUNT_PASSWORD_PEPPER=%s\n' "$(openssl rand -hex 32)" \
  > /etc/ballistic-edge/account.env
chown root:root /etc/ballistic-edge/account.env
chmod 0600 /etc/ballistic-edge/account.env
```

`StateDirectory=ballistic-edge` creates the database directory owned by the
service user. Back up a live database safely before migrations with SQLite's
online backup command rather than copying the database and WAL separately:

```bash
sqlite3 /var/lib/ballistic-edge/accounts.sqlite \
  ".backup '/var/lib/ballistic-edge/accounts-before-release.sqlite'"
```

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
