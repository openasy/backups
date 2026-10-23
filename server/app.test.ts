import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ago, DAY, HOUR, run, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
const job = async (name: string) => (await json(await app.admin("/api/v1/jobs?limit=500"))).jobs.find((j: { name: string }) => j.name === name);
const restoreTest = (name: string, extra: Record<string, unknown> = {}) =>
  app.post("/api/v1/restore-tests", { job: name, testedAt: ago(HOUR, app.clock.now), ok: true, durationSeconds: 340, verifiedBy: "automated", ...extra });

describe("jobs", () => {
  it("are defined by an admin, with how often they run and how much may be lost", async () => {
    const res = await app.post("/api/v1/jobs", {
      name: "db-nightly",
      tool: "restic",
      source: "postgres on db-1",
      location: "s3:backups/db",
      cadenceHours: 24,
      rpoHours: 48,
      retention: "7 daily, 4 weekly",
      owner: "platform",
      tags: ["prod", "db"],
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({
      name: "db-nightly",
      tool: "restic",
      cadenceHours: 24,
      rpoHours: 48,
      tags: ["prod", "db"],
      state: "unknown",
      reason: "No run has been reported yet.",
      lastRun: null,
      lastSuccessAt: null,
      lastRestoreTest: null,
      successRate30d: null,
    });
  });

  it("refuses what makes no sense", async () => {
    const make = (o: Record<string, unknown>) => app.post("/api/v1/jobs", { name: "x", cadenceHours: 24, rpoHours: 48, ...o });
    expect((await make({ name: "db-nightly" })).status).toBe(409);
    expect((await make({ name: "bad name" })).status).toBe(422);
    expect((await make({ tool: "tar" })).status).toBe(422);
    expect((await make({ cadenceHours: 0 })).status).toBe(422);
    expect((await make({ rpoHours: 12 })).status).toBe(422);
    expect((await make({ rpoHours: undefined })).status).toBe(422);
    expect((await make({ tags: ["has space"] })).status).toBe(422);
    expect((await make({ extra: 1 })).status).toBe(422);
    expect((await app.post("/api/v1/jobs", "nope")).status).toBe(400);
  });

  it("change, except for their name", async () => {
    const j = await job("db-nightly");
    const patch = (b: unknown) => app.admin(`/api/v1/jobs/${j.id}`, { method: "PATCH", body: JSON.stringify(b) });
    expect(await json(await patch({ owner: "dba", rpoHours: 72 }))).toMatchObject({ owner: "dba", rpoHours: 72, cadenceHours: 24 });
    expect((await patch({ name: "other" })).status).toBe(422);
    expect((await patch({})).status).toBe(422);
    expect((await patch({ cadenceHours: 96 })).status).toBe(422);
    expect((await app.admin("/api/v1/jobs/missing", { method: "PATCH", body: JSON.stringify({ owner: "x" }) })).status).toBe(404);
    await patch({ rpoHours: 48, owner: "platform" });
  });
});

describe("reports", () => {
  it("are refused for a job nobody defined, unless auto-create is on", async () => {
    const res = await app.report({}, run("web-files", HOUR, { tool: "restic" }));
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ code: "unknown-job", detail: expect.stringContaining("web-files") });
    expect((await app.admin("/api/v1/jobs?limit=500").then(json)).jobs).toHaveLength(1);
    expect((await app.report({}, JSON.stringify({ startedAt: ago(HOUR), endedAt: ago(0), status: "success" }))).status).toBe(422);
  });

  it("make a job healthy once a restore is tested, and are kept once per snapshot", async () => {
    const first = await app.report({}, run("db-nightly", 2 * HOUR, { snapshotId: "s1", sizeBytes: 5_000_000, filesNew: 4 }));
    expect(first.status).toBe(201);
    expect(first.headers.get("x-job-state")).toBe("untested");
    expect(await json(first)).toMatchObject({ status: "success", snapshotId: "s1", sizeBytes: 5_000_000 });
    // A retry from CI is the same run.
    const again = await app.report({}, run("db-nightly", 2 * HOUR, { snapshotId: "s1", sizeBytes: 5_000_000 }));
    expect(again.status).toBe(200);
    expect((await json(await app.admin(`/api/v1/jobs/${(await job("db-nightly")).id}/runs`))).runs).toHaveLength(1);

    expect((await restoreTest("db-nightly")).status).toBe(201);
    expect(await job("db-nightly")).toMatchObject({
      state: "healthy",
      lastRun: { status: "success" },
      sizeBytes: 5_000_000,
      successRate30d: 1,
      lastRestoreTest: { ok: true, verifiedBy: "automated", ageDays: 0 },
    });
  });

  it("move through late, at risk and back as time passes and backups come", async () => {
    const at = async () => (await job("db-nightly")).state;
    app.clock.now += 40 * HOUR;
    expect(await at()).toBe("late");
    app.clock.now += 20 * HOUR;
    expect(await at()).toBe("at-risk");
    expect((await job("db-nightly")).reason).toContain("62 hours old");
    await app.report({}, run("db-nightly", HOUR, { snapshotId: "s2" }, app.clock.now));
    expect(await at()).toBe("healthy");
  });

  it("make a job failing after two failed runs in a row", async () => {
    await app.report({}, run("db-nightly", 50 * 60_000, { status: "failed", error: "repository is locked" }, app.clock.now));
    expect((await job("db-nightly")).state).toBe("healthy");
    await app.report({}, run("db-nightly", 40 * 60_000, { status: "failed", error: "repository is locked, password=hunter2" }, app.clock.now));
    expect(await job("db-nightly")).toMatchObject({ state: "failing", reason: "The last 2 runs failed.", lastRun: { status: "failed" } });
    const runs = (await json(await app.admin(`/api/v1/jobs/${(await job("db-nightly")).id}/runs`))).runs;
    expect(runs[0].error).not.toContain("hunter2");
    await app.report({}, run("db-nightly", 5 * 60_000, { status: "warning", error: "1 file vanished" }, app.clock.now));
    // A warning is a backup that was made.
    expect(await job("db-nightly")).toMatchObject({ state: "healthy", lastRun: { status: "warning" } });
  });

  it("refuse reports that cannot be right", async () => {
    const bad = async (body: string, query: Record<string, string> = {}) => {
      const res = await app.report(query, body);
      expect(res.status, body).toBe(422);
      return json(res);
    };
    expect(await bad(run("db-nightly", -2 * HOUR, {}, app.clock.now))).toMatchObject({ code: "invalid-report", detail: expect.stringContaining("future") });
    await bad("{nope");
    await bad(JSON.stringify({ job: "bad name", startedAt: ago(HOUR), endedAt: ago(0), status: "success" }));
    await bad(run("db-nightly", HOUR, { status: "ok" }));
    await bad(run("db-nightly", HOUR), { tool: "tar" });
  });

  it("read the output of restic and Velero as they come", async () => {
    app.clock.now += 0;
    const restic = [
      '{"message_type":"status","percent_done":1}',
      JSON.stringify({ message_type: "summary", files_new: 2, files_changed: 1, total_bytes_processed: 9000, total_duration: 12, snapshot_id: "rs1" }),
    ].join("\n");
    expect((await app.report({ job: "db-nightly" }, restic)).status).toBe(201);
    const velero = JSON.stringify({
      kind: "Backup",
      metadata: { name: "nightly-1", labels: { "velero.io/schedule-name": "cluster" } },
      status: { phase: "PartiallyFailed", errors: 3, startTimestamp: ago(40 * 60_000, app.clock.now), completionTimestamp: ago(30 * 60_000, app.clock.now) },
    });
    expect((await app.report({}, velero)).status).toBe(422);
    expect((await app.report({ job: "db-nightly" }, velero)).status).toBe(201);
    const id = (await job("db-nightly")).id;
    const all = (await json(await app.admin(`/api/v1/jobs/${id}/runs?limit=100`))).runs as Array<{ snapshotId: string | null }>;
    expect(all.find((r) => r.snapshotId === "nightly-1")).toMatchObject({ status: "warning", error: expect.stringContaining("3 errors") });
    expect(all.find((r) => r.snapshotId === "rs1")).toMatchObject({ status: "success", sizeBytes: 9000, filesNew: 2 });
    // The newest run is first.
    expect(all[0]!.snapshotId).toBe("rs1");
    const page = await json(await app.admin(`/api/v1/jobs/${id}/runs?limit=2`));
    expect(page.runs).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();
    expect((await json(await app.admin(`/api/v1/jobs/${id}/runs?limit=2&cursor=${page.nextCursor}`))).runs.length).toBeGreaterThan(0);
  });
});

describe("auto-create", () => {
  it("makes a job from a report when an admin allows it, with cadence and RPO of a day and two", async () => {
    expect(await json(await app.admin("/api/v1/settings"))).toMatchObject({ autoCreate: false });
    expect(await json(await app.admin("/api/v1/settings", { method: "PUT", body: JSON.stringify({ autoCreate: true }) }))).toMatchObject({ autoCreate: true });
    const res = await app.report(
      {},
      JSON.stringify({ job: "cluster", tool: "velero", startedAt: ago(2 * HOUR, app.clock.now), endedAt: ago(HOUR, app.clock.now), status: "success" }),
    );
    expect(res.status).toBe(201);
    expect(await job("cluster")).toMatchObject({ tool: "velero", cadenceHours: 24, rpoHours: 48, state: "untested" });
    await app.admin("/api/v1/settings", { method: "PUT", body: JSON.stringify({ autoCreate: false }) });
    expect((await app.report({}, run("another", HOUR, {}, app.clock.now))).status).toBe(422);
  });

  it("changes when a restore test goes stale, and how many failures make a job failing", async () => {
    const put = (b: unknown) => app.admin("/api/v1/settings", { method: "PUT", body: JSON.stringify(b) });
    expect((await put({ restoreStaleDays: 0 })).status).toBe(422);
    expect((await put({ restoreStaleDays: 1.5 })).status).toBe(422);
    expect((await put({ failingRuns: 11 })).status).toBe(422);
    expect((await put({ autoCreate: "yes" })).status).toBe(422);
    expect((await put({})).status).toBe(422);
    expect((await put({ other: 1 })).status).toBe(422);
    expect(await json(await put({ restoreStaleDays: 1 }))).toMatchObject({ restoreStaleDays: 1 });
    app.clock.now += 2 * DAY;
    await app.report({}, run("db-nightly", HOUR, { snapshotId: "late-1" }, app.clock.now));
    expect((await job("db-nightly")).state).toBe("untested");
    await put({ restoreStaleDays: 30, failingRuns: 2 });
  });
});

describe("restore tests", () => {
  it("count when they pass, and a failed one makes the job untested again", async () => {
    await app.report({}, run("cluster", HOUR, { snapshotId: "c-fresh" }, app.clock.now));
    const ok = await json(await restoreTest("cluster", { verifiedBy: "manual", notes: "Restored to staging; row counts match", snapshotId: "c1" }));
    expect(ok).toMatchObject({ ok: true, verifiedBy: "manual", reportedBy: "admin token", durationSeconds: 340, snapshotId: "c1" });
    expect((await job("cluster")).state).toBe("healthy");
    await restoreTest("cluster", { ok: false, notes: "restore failed with password=hunter2" });
    expect(await job("cluster")).toMatchObject({ state: "untested", reason: "The last restore test failed.", lastRestoreTest: { ok: false } });
    const tests = (await json(await app.admin(`/api/v1/jobs/${(await job("cluster")).id}/restore-tests`))).restoreTests;
    expect(tests).toHaveLength(2);
    expect(JSON.stringify(tests)).not.toContain("hunter2");
  });

  it("refuse what cannot be right", async () => {
    const t = (o: Record<string, unknown>) => restoreTest("cluster", o);
    expect((await restoreTest("missing")).status).toBe(404);
    expect((await t({ ok: "yes" })).status).toBe(422);
    expect((await t({ verifiedBy: "someone" })).status).toBe(422);
    expect((await t({ testedAt: "yesterday" })).status).toBe(422);
    expect((await t({ testedAt: ago(-2 * HOUR, app.clock.now) })).status).toBe(422);
    expect((await t({ durationSeconds: -5 })).status).toBe(422);
    expect((await t({ extra: 1 })).status).toBe(422);
    expect((await t({ job: undefined })).status).toBe(422);
  });
});

describe("overview", () => {
  it("counts jobs by state and filters them", async () => {
    const summary = await json(await app.admin("/api/v1/summary"));
    expect(summary.jobs).toBe(2);
    expect(Object.values(summary.states as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(2);
    const untested = (await json(await app.admin("/api/v1/jobs?state=untested"))).jobs;
    expect(untested.map((j: { name: string }) => j.name).sort()).toEqual(
      ["cluster", "db-nightly"].filter((n) => untested.some((j: { name: string }) => j.name === n)),
    );
    expect((await app.admin("/api/v1/jobs?state=great")).status).toBe(422);
    expect((await app.admin("/api/v1/jobs?limit=1")).status).toBe(200);
  });

  it("publishes each job's state and last success for Prometheus", async () => {
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="backups",version="0.1.0"} 1');
    expect(metrics).toContain('openasy_backups_job_state{job="cluster",state="untested"} 1');
    expect(metrics).toContain('openasy_backups_job_state{job="cluster",state="healthy"} 0');
    expect(metrics).toMatch(/openasy_backups_last_success_timestamp_seconds\{job="db-nightly"\} \d{10}/);
    expect(metrics).toContain('openasy_backups_last_size_bytes{job="db-nightly"}');
  });
});

describe("access", () => {
  it("lets the ingest token report and nothing else", async () => {
    const anon = (path: string, init: RequestInit = {}) => fetch(app.base + path, init);
    expect((await anon("/api/v1/runs", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await anon("/api/v1/runs", { method: "POST", body: "{}", headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await anon("/api/v1/jobs")).status).toBe(401);
    expect((await anon("/api/v1/settings", { method: "PUT", body: "{}" })).status).toBe(401);
    expect((await app.ingest("/api/v1/jobs")).status).toBe(401);
    expect((await app.ingest("/api/v1/jobs", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app.ingest("/api/v1/settings")).status).toBe(401);
    const res = await app.ingest("/api/v1/restore-tests", {
      method: "POST",
      body: JSON.stringify({ job: "cluster", testedAt: ago(HOUR, app.clock.now), ok: true, verifiedBy: "automated" }),
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ reportedBy: "ingest token" });
    const closed = await startApp({ version: "0.1.0", ingestToken: undefined, adminToken: undefined });
    expect((await fetch(`${closed.base}/api/v1/runs`, { method: "POST", body: "{}" })).status).toBe(503);
    await closed.close();
  });

  it("deletes a job with its runs and tests", async () => {
    const j = await job("cluster");
    expect((await app.admin(`/api/v1/jobs/${j.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.admin(`/api/v1/jobs/${j.id}`)).status).toBe(404);
    expect((await app.admin(`/api/v1/jobs/${j.id}/runs`)).status).toBe(404);
    expect((await app.admin(`/api/v1/jobs/${j.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("answers version and health", async () => {
    expect(await json(await fetch(`${app.base}/api/v1/version`))).toEqual({ product: "backups", version: "0.1.0" });
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${app.base}/readyz`)).status).toBe(200);
  });
});
