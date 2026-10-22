import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- A backup job that something else runs: restic, Velero or a script. Backups only tracks it (ADR 0048).
   CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     tool TEXT NOT NULL CHECK (tool IN ('restic', 'velero', 'other')),
     source TEXT NOT NULL DEFAULT '',
     location TEXT NOT NULL DEFAULT '',
     cadence_hours INTEGER NOT NULL CHECK (cadence_hours BETWEEN 1 AND 8760),
     rpo_hours INTEGER NOT NULL CHECK (rpo_hours BETWEEN 1 AND 8760),
     retention TEXT NOT NULL DEFAULT '',
     owner TEXT NOT NULL DEFAULT '',
     tags TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL
   );
   -- One row per finished run. A warning is a backup that was made with things to look at.
   CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
     started_at TEXT NOT NULL,
     ended_at TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('success', 'warning', 'failed')),
     snapshot_id TEXT,
     size_bytes INTEGER,
     files_new INTEGER,
     files_changed INTEGER,
     error TEXT,
     reported_at TEXT NOT NULL
   );
   CREATE INDEX runs_job ON runs (job_id, ended_at DESC);
   CREATE UNIQUE INDEX runs_snapshot ON runs (job_id, snapshot_id) WHERE snapshot_id IS NOT NULL;
   -- A backup nobody has restored is a hope. A test says a restore was tried, and whether it worked.
   CREATE TABLE restore_tests (
     id TEXT PRIMARY KEY,
     job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
     tested_at TEXT NOT NULL,
     ok INTEGER NOT NULL,
     duration_seconds INTEGER,
     snapshot_id TEXT,
     verified_by TEXT NOT NULL CHECK (verified_by IN ('automated', 'manual')),
     notes TEXT NOT NULL DEFAULT '',
     reported_by TEXT,
     reported_at TEXT NOT NULL
   );
   CREATE INDEX restore_tests_job ON restore_tests (job_id, tested_at DESC)`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
