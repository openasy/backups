import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "backups-")), "nested", "backups.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();

    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    second.close();
  });

  it("deletes a job's runs and restore tests with it", () => {
    const db = openDb(":memory:");
    db.exec(`INSERT INTO jobs VALUES ('j', 'db', 'restic', '', '', 24, 48, '', '', '[]', 'now');
      INSERT INTO runs VALUES ('r', 'j', 'a', 'b', 'success', 's1', 1, 1, 1, NULL, 'now');
      INSERT INTO restore_tests VALUES ('t', 'j', 'a', 1, 10, NULL, 'manual', '', NULL, 'now');
      DELETE FROM jobs`);
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM runs) + (SELECT COUNT(*) FROM restore_tests) AS n").get()).toEqual({ n: 0 });
  });

  it("holds a snapshot once per job", () => {
    const db = openDb(":memory:");
    db.exec(`INSERT INTO jobs VALUES ('j', 'db', 'restic', '', '', 24, 48, '', '', '[]', 'now'), ('k', 'web', 'restic', '', '', 24, 48, '', '', '[]', 'now');
      INSERT INTO runs VALUES ('r1', 'j', 'a', 'b', 'success', 's1', NULL, NULL, NULL, NULL, 'now');
      INSERT INTO runs VALUES ('r2', 'k', 'a', 'b', 'success', 's1', NULL, NULL, NULL, NULL, 'now');
      INSERT INTO runs VALUES ('r3', 'j', 'a', 'b', 'success', NULL, NULL, NULL, NULL, NULL, 'now');
      INSERT INTO runs VALUES ('r4', 'j', 'a', 'b', 'success', NULL, NULL, NULL, NULL, NULL, 'now')`);
    expect(() => db.exec("INSERT INTO runs VALUES ('r5', 'j', 'a', 'b', 'success', 's1', NULL, NULL, NULL, NULL, 'now')")).toThrow(/UNIQUE/);
  });
});
