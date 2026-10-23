import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { mask, parseRun, ParseError, type RunStatus, type Tool } from "./parse.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "invalid-report"
  | "unknown-job"
  | "not-found"
  | "conflict"
  | "not-configured"
  | "payload-too-large"
  | "internal-error";

export class BackupsError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

export type JobState = "healthy" | "late" | "at-risk" | "failing" | "untested" | "unknown";
export const STATES: JobState[] = ["failing", "at-risk", "late", "untested", "unknown", "healthy"];

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TOOLS: Tool[] = ["restic", "velero", "other"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A run may be reported a little before this server's clock says it ended. */
const SKEW = 5 * 60_000;
/** A job that has not succeeded within this many cadences is late. */
const LATE_FACTOR = 1.5;

const bad = (detail: string) => new BackupsError(422, "invalid-body", detail);
const notFound = (what: string) => new BackupsError(404, "not-found", `${what} does not exist.`);

export interface Page<T> {
  items: T[];
  /** Opaque; pass it back as `cursor` for the next page. Absent on the last page (ADR 0024). */
  nextCursor?: string;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isSafeInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

export function parseLimit(value: string | null, max = 500, fallback = 100): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be between 1 and ${max}.`);
  return n;
}

export interface Settings {
  /** A report for a job nobody defined creates it. Off by default: a typo should not become a job. */
  autoCreate: boolean;
  /** A job whose newest successful restore test is older than this is untested. */
  restoreStaleDays: number;
  /** This many failed runs in a row make a job failing. */
  failingRuns: number;
}

export interface StateInput {
  cadenceHours: number;
  rpoHours: number;
  /** Newest first. At least the last `failingRuns` runs. */
  recent: Array<{ status: RunStatus }>;
  lastOkAt: string | null;
  lastTest: { testedAt: string; ok: boolean } | null;
  now: number;
  settings: Pick<Settings, "restoreStaleDays" | "failingRuns">;
}

const hours = (ms: number) => Math.floor(ms / HOUR);

/** The one word that says how a job is doing, and why. Failing outranks at-risk, then late, then untested. */
export function deriveState(i: StateInput): { state: JobState; reason: string } {
  if (i.recent.length === 0) return { state: "unknown", reason: "No run has been reported yet." };
  const n = i.settings.failingRuns;
  if (i.recent.length >= n && i.recent.slice(0, n).every((r) => r.status === "failed")) {
    return { state: "failing", reason: `The last ${n} runs failed.` };
  }
  if (i.lastOkAt === null) return { state: "at-risk", reason: "No run has succeeded yet." };
  const age = i.now - Date.parse(i.lastOkAt);
  if (age > i.rpoHours * HOUR)
    return { state: "at-risk", reason: `The last backup is ${hours(age)} hours old, past the ${i.rpoHours} hours the data may be lost for.` };
  if (age > i.cadenceHours * LATE_FACTOR * HOUR)
    return { state: "late", reason: `The last backup is ${hours(age)} hours old; one is expected every ${i.cadenceHours} hours.` };
  if (!i.lastTest) return { state: "untested", reason: "No restore has been tested." };
  if (!i.lastTest.ok) return { state: "untested", reason: "The last restore test failed." };
  const testAge = i.now - Date.parse(i.lastTest.testedAt);
  if (testAge > i.settings.restoreStaleDays * DAY)
    return {
      state: "untested",
      reason: `The last restore test is ${Math.floor(testAge / DAY)} days old; one is expected every ${i.settings.restoreStaleDays} days.`,
    };
  return { state: "healthy", reason: "Backups are on time and a restore has been tested." };
}

export interface BackupsOptions {
  /** Runs and restore tests older than this are deleted (ADR 0015). */
  retentionDays?: number;
  /** Stands in for the clock in tests. */
  now?: () => number;
}

export function createBackups(db: DatabaseSync, { retentionDays = 400, now = Date.now }: BackupsOptions = {}) {
  const iso = (ms = now()) => new Date(ms).toISOString();

  const getSetting = (key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const setSetting = (key: string, value: string) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  const settings = (): Settings => ({
    autoCreate: getSetting("auto_create") === "true",
    restoreStaleDays: Number(getSetting("restore_stale_days") ?? 30),
    failingRuns: Number(getSetting("failing_runs") ?? 2),
  });

  const jobRow = (id: string) => {
    const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, any> | undefined;
    if (!r) throw notFound("The job");
    return r;
  };

  function presentJob(j: Record<string, any>, s = settings()) {
    const recent = db
      .prepare("SELECT status, ended_at, size_bytes FROM runs WHERE job_id = ? ORDER BY ended_at DESC, rowid DESC LIMIT ?")
      .all(j.id, Math.max(s.failingRuns, 1)) as Array<{ status: RunStatus; ended_at: string; size_bytes: number | null }>;
    const lastOk = (db.prepare("SELECT MAX(ended_at) AS t FROM runs WHERE job_id = ? AND status <> 'failed'").get(j.id) as { t: string | null }).t;
    const test = db.prepare("SELECT tested_at, ok, verified_by FROM restore_tests WHERE job_id = ? ORDER BY tested_at DESC, rowid DESC LIMIT 1").get(j.id) as
      { tested_at: string; ok: number; verified_by: string } | undefined;
    const since = iso(now() - 30 * DAY);
    const month = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(status <> 'failed'), 0) AS ok FROM runs WHERE job_id = ? AND ended_at > ?")
      .get(j.id, since) as { n: number; ok: number };
    const size = db.prepare("SELECT size_bytes FROM runs WHERE job_id = ? AND size_bytes IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 1").get(j.id) as
      { size_bytes: number } | undefined;
    const { state, reason } = deriveState({
      cadenceHours: j.cadence_hours,
      rpoHours: j.rpo_hours,
      recent,
      lastOkAt: lastOk,
      lastTest: test ? { testedAt: test.tested_at, ok: test.ok === 1 } : null,
      now: now(),
      settings: s,
    });
    return {
      id: j.id as string,
      name: j.name as string,
      tool: j.tool as Tool,
      source: j.source as string,
      location: j.location as string,
      cadenceHours: j.cadence_hours as number,
      rpoHours: j.rpo_hours as number,
      retention: j.retention as string,
      owner: j.owner as string,
      tags: JSON.parse(j.tags) as string[],
      state,
      reason,
      lastRun: recent[0] ? { endedAt: recent[0].ended_at, status: recent[0].status } : null,
      lastSuccessAt: lastOk,
      lastRestoreTest: test
        ? {
            testedAt: test.tested_at,
            ok: test.ok === 1,
            verifiedBy: test.verified_by as "automated" | "manual",
            ageDays: Math.floor((now() - Date.parse(test.tested_at)) / DAY),
          }
        : null,
      successRate30d: month.n ? Math.round((month.ok / month.n) * 1000) / 1000 : null,
      sizeBytes: size?.size_bytes ?? null,
      createdAt: j.created_at as string,
    };
  }

  function jobFields(body: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {};
    const text = (key: string, max: number) => {
      if (body[key] === undefined) return;
      if (typeof body[key] !== "string" || (body[key] as string).length > max) throw bad(`${key} must be text of at most ${max} characters.`);
      out[key] = body[key];
    };
    const hoursOf = (key: string) => {
      if (body[key] === undefined) return;
      const v = body[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 8760) throw bad(`${key} must be a whole number of hours, 1 to 8760.`);
      out[key] = v;
    };
    if (body.tool !== undefined) {
      if (!TOOLS.includes(body.tool as Tool)) throw bad(`tool must be one of ${TOOLS.join(", ")}.`);
      out.tool = body.tool;
    }
    text("source", 500);
    text("location", 500);
    text("retention", 200);
    text("owner", 100);
    hoursOf("cadenceHours");
    hoursOf("rpoHours");
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.length > 10 || body.tags.some((t) => typeof t !== "string" || !/^[A-Za-z0-9._:-]{1,32}$/.test(t)))
        throw bad("tags is up to 10 short words: letters, digits and . _ : -.");
      out.tags = body.tags;
    }
    if (!partial && (out.cadenceHours === undefined || out.rpoHours === undefined)) throw bad("cadenceHours and rpoHours are required.");
    return out;
  }

  const insertJob = (name: string, f: Record<string, any>) => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO jobs (id, name, tool, source, location, cadence_hours, rpo_hours, retention, owner, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      name,
      f.tool ?? "other",
      f.source ?? "",
      f.location ?? "",
      f.cadenceHours,
      f.rpoHours,
      f.retention ?? "",
      f.owner ?? "",
      JSON.stringify(f.tags ?? []),
      iso(),
    );
    return id;
  };

  function presentRun(r: Record<string, any>) {
    return {
      id: r.id as string,
      startedAt: r.started_at as string,
      endedAt: r.ended_at as string,
      status: r.status as RunStatus,
      snapshotId: (r.snapshot_id as string | null) ?? null,
      sizeBytes: (r.size_bytes as number | null) ?? null,
      filesNew: (r.files_new as number | null) ?? null,
      filesChanged: (r.files_changed as number | null) ?? null,
      error: (r.error as string | null) ?? null,
    };
  }

  function presentTest(t: Record<string, any>) {
    return {
      id: t.id as string,
      testedAt: t.tested_at as string,
      ok: t.ok === 1,
      durationSeconds: (t.duration_seconds as number | null) ?? null,
      snapshotId: (t.snapshot_id as string | null) ?? null,
      verifiedBy: t.verified_by as "automated" | "manual",
      notes: t.notes as string,
      reportedBy: (t.reported_by as string | null) ?? null,
    };
  }

  function paged<T>(sql: string, args: SQLInputValue[], cursor: string | undefined, limit: number, map: (r: Record<string, any>) => T): Page<T> {
    const offset = decodeCursor(cursor);
    const rows = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...args, limit + 1, offset) as Array<Record<string, any>>;
    return { items: rows.slice(0, limit).map(map), ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }) };
  }

  return {
    settings,
    updateSettings(body: Record<string, unknown>) {
      const { autoCreate, restoreStaleDays, failingRuns, ...rest } = body;
      if (Object.keys(rest).length || (autoCreate === undefined && restoreStaleDays === undefined && failingRuns === undefined))
        throw bad("Expected { autoCreate?, restoreStaleDays?, failingRuns? }.");
      if (autoCreate !== undefined) {
        if (typeof autoCreate !== "boolean") throw bad("autoCreate must be true or false.");
        setSetting("auto_create", String(autoCreate));
      }
      if (restoreStaleDays !== undefined) {
        if (typeof restoreStaleDays !== "number" || !Number.isInteger(restoreStaleDays) || restoreStaleDays < 1 || restoreStaleDays > 365)
          throw bad("restoreStaleDays must be 1 to 365.");
        setSetting("restore_stale_days", String(restoreStaleDays));
      }
      if (failingRuns !== undefined) {
        if (typeof failingRuns !== "number" || !Number.isInteger(failingRuns) || failingRuns < 1 || failingRuns > 10) throw bad("failingRuns must be 1 to 10.");
        setSetting("failing_runs", String(failingRuns));
      }
      return settings();
    },

    createJob(body: Record<string, unknown>) {
      const { name, ...rest } = body;
      if (typeof name !== "string" || !NAME.test(name)) throw bad("name is required: letters, digits and . _ : / -, up to 128.");
      const f = jobFields(rest, false);
      const allowed = ["tool", "source", "location", "retention", "owner", "cadenceHours", "rpoHours", "tags"];
      if (Object.keys(rest).some((k) => !allowed.includes(k))) throw bad(`Unknown field; a job has name and ${allowed.join(", ")}.`);
      if ((f.rpoHours as number) < (f.cadenceHours as number))
        throw bad("rpoHours must not be less than cadenceHours: a backup every day cannot lose less than a day of data.");
      if (db.prepare("SELECT 1 FROM jobs WHERE name = ?").get(name)) throw new BackupsError(409, "conflict", "A job with this name exists.");
      return presentJob(jobRow(insertJob(name, f)));
    },

    listJobs(state: JobState | undefined, cursor: string | undefined, limit: number): Page<ReturnType<typeof presentJob>> {
      const s = settings();
      const all = (db.prepare("SELECT * FROM jobs ORDER BY name").all() as Array<Record<string, any>>)
        .map((j) => presentJob(j, s))
        .filter((j) => !state || j.state === state);
      const offset = decodeCursor(cursor);
      return { items: all.slice(offset, offset + limit), ...(all.length > offset + limit && { nextCursor: encodeCursor(offset + limit) }) };
    },

    job: (id: string) => presentJob(jobRow(id)),

    updateJob(id: string, body: Record<string, unknown>) {
      const current = jobRow(id);
      const allowed = ["tool", "source", "location", "retention", "owner", "cadenceHours", "rpoHours", "tags"];
      if (!Object.keys(body).length || Object.keys(body).some((k) => !allowed.includes(k)))
        throw bad(`Expected some of ${allowed.join(", ")}; the name cannot change, reports use it.`);
      const f = jobFields(body, true);
      const cadence = (f.cadenceHours as number | undefined) ?? current.cadence_hours;
      const rpo = (f.rpoHours as number | undefined) ?? current.rpo_hours;
      if (rpo < cadence) throw bad("rpoHours must not be less than cadenceHours.");
      const columns: Record<string, string> = {
        tool: "tool",
        source: "source",
        location: "location",
        retention: "retention",
        owner: "owner",
        cadenceHours: "cadence_hours",
        rpoHours: "rpo_hours",
        tags: "tags",
      };
      for (const [key, value] of Object.entries(f))
        db.prepare(`UPDATE jobs SET ${columns[key]} = ? WHERE id = ?`).run((key === "tags" ? JSON.stringify(value) : value) as SQLInputValue, id);
      return presentJob(jobRow(id));
    },

    deleteJob(id: string) {
      if (db.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes === 0) throw notFound("The job");
    },

    runs(jobId: string, cursor: string | undefined, limit: number) {
      jobRow(jobId);
      return paged("SELECT * FROM runs WHERE job_id = ? ORDER BY ended_at DESC, rowid DESC", [jobId], cursor, limit, presentRun);
    },

    restoreTests(jobId: string, cursor: string | undefined, limit: number) {
      jobRow(jobId);
      return paged("SELECT * FROM restore_tests WHERE job_id = ? ORDER BY tested_at DESC, rowid DESC", [jobId], cursor, limit, presentTest);
    },

    /** Takes one finished run. The same snapshot twice is the same run, so a CI retry changes nothing. */
    ingestRun(raw: string, query: { job?: string | null; tool?: string | null }) {
      let run: ReturnType<typeof parseRun>;
      try {
        run = parseRun(raw, query, new Date(now()));
      } catch (err) {
        if (err instanceof ParseError) throw new BackupsError(422, "invalid-report", err.message);
        throw err;
      }
      if (!run.job || !NAME.test(run.job)) throw new BackupsError(422, "invalid-report", "job is required: the name of the job, in the body or as ?job=.");
      if (Date.parse(run.endedAt) > now() + SKEW) throw new BackupsError(422, "invalid-report", "endedAt is in the future.");
      let job = db.prepare("SELECT * FROM jobs WHERE name = ?").get(run.job) as Record<string, any> | undefined;
      let jobCreated = false;
      if (!job) {
        if (!settings().autoCreate)
          throw new BackupsError(422, "unknown-job", `There is no job named ${run.job}. Add it first, or let reports create jobs under Settings.`);
        job = jobRow(insertJob(run.job, { tool: run.tool, cadenceHours: 24, rpoHours: 48 }));
        jobCreated = true;
      }
      const same = run.snapshotId
        ? (db.prepare("SELECT * FROM runs WHERE job_id = ? AND snapshot_id = ?").get(job.id, run.snapshotId) as Record<string, any> | undefined)
        : undefined;
      if (same) return { created: false, jobCreated, run: presentRun(same), job: presentJob(job) };
      const id = randomUUID();
      db.prepare(
        "INSERT INTO runs (id, job_id, started_at, ended_at, status, snapshot_id, size_bytes, files_new, files_changed, error, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, job.id, run.startedAt, run.endedAt, run.status, run.snapshotId, run.sizeBytes, run.filesNew, run.filesChanged, run.error, iso());
      return { created: true, jobCreated, run: presentRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, any>), job: presentJob(job) };
    },

    ingestRestoreTest(body: Record<string, unknown>, by: string | null) {
      const { job: name, testedAt, ok, durationSeconds, snapshotId, verifiedBy, notes, ...rest } = body;
      if (Object.keys(rest).length) throw bad("Expected { job, testedAt, ok, durationSeconds?, snapshotId?, verifiedBy, notes? }.");
      if (typeof name !== "string" || !NAME.test(name)) throw bad("job is required: the name of the job.");
      const job = db.prepare("SELECT * FROM jobs WHERE name = ?").get(name) as Record<string, any> | undefined;
      if (!job) throw notFound("The job");
      const t = typeof testedAt === "string" ? Date.parse(testedAt) : NaN;
      if (Number.isNaN(t)) throw bad("testedAt must be a date and time such as 2026-10-22T02:00:00Z.");
      if (t > now() + SKEW) throw bad("testedAt is in the future.");
      if (typeof ok !== "boolean") throw bad("ok must be true or false.");
      if (verifiedBy !== "automated" && verifiedBy !== "manual") throw bad("verifiedBy must be automated or manual.");
      if (
        durationSeconds !== undefined &&
        durationSeconds !== null &&
        (typeof durationSeconds !== "number" || !Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 1_000_000)
      )
        throw bad("durationSeconds must be a whole number of seconds.");
      if (snapshotId !== undefined && snapshotId !== null && (typeof snapshotId !== "string" || snapshotId.length > 256))
        throw bad("snapshotId must be text of at most 256 characters.");
      if (notes !== undefined && (typeof notes !== "string" || notes.length > 1000)) throw bad("notes must be text of at most 1000 characters.");
      const id = randomUUID();
      db.prepare(
        "INSERT INTO restore_tests (id, job_id, tested_at, ok, duration_seconds, snapshot_id, verified_by, notes, reported_by, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        job.id,
        iso(t),
        ok ? 1 : 0,
        (durationSeconds as number | null | undefined) ?? null,
        (snapshotId as string | null | undefined) ?? null,
        verifiedBy,
        mask((notes as string | undefined) ?? ""),
        by,
        iso(),
      );
      return presentTest(db.prepare("SELECT * FROM restore_tests WHERE id = ?").get(id) as Record<string, any>);
    },

    /** What this product knows servers by, to say which in the hosts file it has nothing for (ADR 0052): names in job names and sources. */
    knownHosts(): string[] {
      return (db.prepare("SELECT name, source FROM jobs").all() as Array<{ name: string; source: string }>).flatMap((r) =>
        `${r.name} ${r.source}`.split(/[^A-Za-z0-9._-]+/),
      );
    },

    summary() {
      const s = settings();
      const jobs = (db.prepare("SELECT * FROM jobs").all() as Array<Record<string, any>>).map((j) => presentJob(j, s));
      const states = Object.fromEntries(STATES.map((k) => [k, 0])) as Record<JobState, number>;
      for (const j of jobs) states[j.state]++;
      const lastRunAt = (db.prepare("SELECT MAX(ended_at) AS t FROM runs").get() as { t: string | null }).t;
      return { jobs: jobs.length, states, autoCreate: s.autoCreate, lastRunAt };
    },

    /** Every job with its state and last success, for /metrics. */
    allJobs() {
      const s = settings();
      return (db.prepare("SELECT * FROM jobs ORDER BY name").all() as Array<Record<string, any>>).map((j) => presentJob(j, s));
    },

    purge() {
      const before = iso(now() - retentionDays * DAY);
      db.prepare("DELETE FROM runs WHERE ended_at < ?").run(before);
      db.prepare("DELETE FROM restore_tests WHERE tested_at < ?").run(before);
    },
  };
}

export type Backups = ReturnType<typeof createBackups>;
