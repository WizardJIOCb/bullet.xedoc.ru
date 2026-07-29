import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'account-foundation',
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        handle_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL,
        disabled_at INTEGER,
        legacy_imported_at INTEGER
      ) STRICT;

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        csrf_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      ) STRICT;
      CREATE INDEX sessions_account_active ON sessions(account_id, expires_at) WHERE revoked_at IS NULL;

      CREATE TABLE recovery_credentials (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;
      CREATE INDEX recovery_account_active ON recovery_credentials(account_id) WHERE used_at IS NULL;

      CREATE TABLE player_progress (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        credits INTEGER NOT NULL DEFAULT 900 CHECK (credits >= 0),
        engine INTEGER NOT NULL DEFAULT 0 CHECK (engine BETWEEN 0 AND 5),
        cooling INTEGER NOT NULL DEFAULT 0 CHECK (cooling BETWEEN 0 AND 5),
        shield INTEGER NOT NULL DEFAULT 0 CHECK (shield BETWEEN 0 AND 5),
        weapon INTEGER NOT NULL DEFAULT 0 CHECK (weapon BETWEEN 0 AND 5),
        total_runs INTEGER NOT NULL DEFAULT 0 CHECK (total_runs >= 0),
        total_finishes INTEGER NOT NULL DEFAULT 0 CHECK (total_finishes >= 0),
        victories INTEGER NOT NULL DEFAULT 0 CHECK (victories >= 0),
        total_score INTEGER NOT NULL DEFAULT 0 CHECK (total_score >= 0),
        best_score INTEGER NOT NULL DEFAULT 0 CHECK (best_score >= 0),
        max_speed REAL NOT NULL DEFAULT 0 CHECK (max_speed >= 0),
        total_perfects INTEGER NOT NULL DEFAULT 0 CHECK (total_perfects >= 0),
        total_near_misses INTEGER NOT NULL DEFAULT 0 CHECK (total_near_misses >= 0),
        total_kills INTEGER NOT NULL DEFAULT 0 CHECK (total_kills >= 0),
        profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version >= 1),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE track_progress (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL CHECK (track_id IN ('aurora', 'reactor', 'void', 'forge')),
        runs INTEGER NOT NULL DEFAULT 0 CHECK (runs >= 0),
        finishes INTEGER NOT NULL DEFAULT 0 CHECK (finishes >= 0),
        wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
        best_score INTEGER NOT NULL DEFAULT 0 CHECK (best_score >= 0),
        max_speed REAL NOT NULL DEFAULT 0 CHECK (max_speed >= 0),
        best_accuracy REAL NOT NULL DEFAULT 0 CHECK (best_accuracy BETWEEN 0 AND 1),
        perfects INTEGER NOT NULL DEFAULT 0 CHECK (perfects >= 0),
        near_misses INTEGER NOT NULL DEFAULT 0 CHECK (near_misses >= 0),
        kills INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
        PRIMARY KEY (account_id, track_id)
      ) STRICT;

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('solo', 'online')),
        track_id TEXT NOT NULL CHECK (track_id IN ('aurora', 'reactor', 'void', 'forge')),
        music_source TEXT NOT NULL CHECK (music_source IN ('synthetic', 'catalog', 'local')),
        music_id TEXT NOT NULL,
        seed INTEGER NOT NULL,
        weapon TEXT NOT NULL,
        ability TEXT NOT NULL,
        ai_opponents INTEGER NOT NULL,
        garage_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('started', 'accepted', 'rejected', 'expired')),
        ranked_eligible INTEGER NOT NULL CHECK (ranked_eligible IN (0, 1)),
        ranked INTEGER CHECK (ranked IN (0, 1)),
        result_hash TEXT,
        result_json TEXT,
        response_json TEXT
      ) STRICT;
      CREATE INDEX runs_account_started ON runs(account_id, started_at DESC);
      CREATE INDEX runs_expiry ON runs(status, expires_at);

      CREATE TABLE achievement_progress (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        achievement_key TEXT NOT NULL,
        current_value REAL NOT NULL DEFAULT 0,
        target_value REAL NOT NULL,
        unlocked_at INTEGER,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        PRIMARY KEY (account_id, achievement_key)
      ) STRICT;

      CREATE TABLE leaderboard_best (
        board_key TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        score INTEGER NOT NULL CHECK (score >= 0),
        achieved_at INTEGER NOT NULL,
        PRIMARY KEY (board_key, account_id)
      ) STRICT;
      CREATE INDEX leaderboard_order ON leaderboard_best(board_key, score DESC, achieved_at ASC, account_id ASC);
    `,
  },
] as const;

function checksum(migration: Migration): string {
  return createHash('sha256').update(`${migration.version}\n${migration.name}\n${migration.sql}`).digest('hex');
}

export function runAccountMigrations(database: DatabaseSync, now: number): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  database.exec('BEGIN IMMEDIATE');
  try {
    const select = database.prepare('SELECT name, checksum FROM schema_migrations WHERE version = ?');
    const insert = database.prepare(
      'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    );
    for (const migration of MIGRATIONS) {
      const expected = checksum(migration);
      const existing = select.get(migration.version) as { name: string; checksum: string } | undefined;
      if (existing) {
        if (existing.name !== migration.name || existing.checksum !== expected) {
          throw new Error(`Account migration ${migration.version} checksum mismatch`);
        }
        continue;
      }
      database.exec(migration.sql);
      insert.run(migration.version, migration.name, expected, now);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
