import { describe, expect, it } from "vitest";
import { mask, parseRun, ParseError } from "./parse.ts";

const now = new Date("2026-10-22T12:00:00Z");

describe("our own report", () => {
  it("reads the fields as they are", () => {
    expect(
      parseRun(
        JSON.stringify({
          job: "db",
          startedAt: "2026-10-22T01:00:00Z",
          endedAt: "2026-10-22T01:20:00Z",
          status: "warning",
          snapshotId: "abc",
          sizeBytes: 1024,
          filesNew: 3,
          filesChanged: 4,
          error: "2 files vanished",
        }),
        {},
        now,
      ),
    ).toEqual({
      job: "db",
      tool: "other",
      startedAt: "2026-10-22T01:00:00.000Z",
      endedAt: "2026-10-22T01:20:00.000Z",
      status: "warning",
      snapshotId: "abc",
      sizeBytes: 1024,
      filesNew: 3,
      filesChanged: 4,
      error: "2 files vanished",
    });
  });

  it("takes the job and tool from the query, which win", () => {
    const r = parseRun(
      JSON.stringify({ job: "x", status: "success", startedAt: "2026-10-22T01:00:00Z", endedAt: "2026-10-22T01:05:00Z" }),
      { job: "web", tool: "restic" },
      now,
    );
    expect(r).toMatchObject({ job: "web", tool: "restic" });
  });

  it("refuses what it cannot trust", () => {
    const body = (o: object) => JSON.stringify({ job: "x", startedAt: "2026-10-22T01:00:00Z", endedAt: "2026-10-22T01:05:00Z", status: "success", ...o });
    expect(() => parseRun(body({ status: "ok" }))).toThrow(/status must be/);
    expect(() => parseRun(body({ endedAt: "2026-10-22T00:00:00Z" }))).toThrow(/before startedAt/);
    expect(() => parseRun(body({ startedAt: "yesterday" }))).toThrow(/startedAt must be a date/);
    expect(() => parseRun(body({ status: "failed" }))).toThrow(/needs an error/);
    expect(() => parseRun(body({ sizeBytes: -1 }))).toThrow(/whole number/);
    expect(() => parseRun(body({ filesNew: 1.5 }))).toThrow(/whole number/);
    expect(() => parseRun("not json")).toThrow(ParseError);
    expect(() => parseRun(body({}), { tool: "tar" })).toThrow(/tool must be/);
  });

  it("masks passwords and tokens in an error", () => {
    const r = parseRun(
      JSON.stringify({
        job: "x",
        status: "failed",
        startedAt: "2026-10-22T01:00:00Z",
        endedAt: "2026-10-22T01:05:00Z",
        error: "connect s3://key:hunter2@host failed, password=hunter2 token: abcd1234",
      }),
    );
    expect(r.error).not.toMatch(/hunter2|abcd1234/);
  });
});

describe("restic", () => {
  const summary = {
    message_type: "summary",
    files_new: 12,
    files_changed: 3,
    files_unmodified: 100,
    total_files_processed: 115,
    total_bytes_processed: 2048.0,
    total_duration: 90.5,
    snapshot_id: "9f8e7d6c",
  };

  it("reads the summary of restic backup --json", () => {
    expect(parseRun(JSON.stringify(summary), { job: "files" }, now)).toEqual({
      job: "files",
      tool: "restic",
      startedAt: "2026-10-22T11:58:29.500Z",
      endedAt: "2026-10-22T12:00:00.000Z",
      status: "success",
      snapshotId: "9f8e7d6c",
      sizeBytes: 2048,
      filesNew: 12,
      filesChanged: 3,
      error: null,
    });
  });

  it("finds the summary among the lines restic prints", () => {
    const lines = [{ message_type: "status", percent_done: 0.5 }, { message_type: "status", percent_done: 1 }, summary]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(parseRun(lines, { job: "files" }, now)).toMatchObject({ tool: "restic", snapshotId: "9f8e7d6c" });
  });

  it("takes the end time from the sender when it has one", () => {
    expect(parseRun(JSON.stringify({ ...summary, endedAt: "2026-10-22T03:00:00Z" }), { job: "f" }, now)).toMatchObject({
      endedAt: "2026-10-22T03:00:00.000Z",
      startedAt: "2026-10-22T02:58:29.500Z",
    });
  });
});

describe("velero", () => {
  const backup = (status: object, labels: object = { "velero.io/schedule-name": "nightly" }) =>
    JSON.stringify({
      apiVersion: "velero.io/v1",
      kind: "Backup",
      metadata: { name: "nightly-20261022", labels },
      status: { startTimestamp: "2026-10-22T02:00:00Z", completionTimestamp: "2026-10-22T02:09:00Z", ...status },
    });

  it("maps the phase to a status and takes the job from the schedule label", () => {
    expect(parseRun(backup({ phase: "Completed", warnings: 0, errors: 0 }))).toMatchObject({
      job: "nightly",
      tool: "velero",
      status: "success",
      snapshotId: "nightly-20261022",
      error: null,
      endedAt: "2026-10-22T02:09:00.000Z",
    });
    expect(parseRun(backup({ phase: "Completed", warnings: 2, errors: 0 }))).toMatchObject({ status: "warning", error: "Completed: 0 errors, 2 warnings" });
    expect(parseRun(backup({ phase: "PartiallyFailed", warnings: 0, errors: 4 }))).toMatchObject({
      status: "warning",
      error: "PartiallyFailed: 4 errors, 0 warnings",
    });
    expect(parseRun(backup({ phase: "Failed", errors: 1, failureReason: "volume snapshot timed out" }))).toMatchObject({
      status: "failed",
      error: expect.stringContaining("volume snapshot timed out"),
    });
    expect(parseRun(backup({ phase: "FailedValidation" }))).toMatchObject({ status: "failed" });
  });

  it("waits for a backup that is not finished, and prefers the query's job", () => {
    expect(() => parseRun(backup({ phase: "InProgress" }))).toThrow(/InProgress/);
    expect(parseRun(backup({ phase: "Completed" }), { job: "cluster" })).toMatchObject({ job: "cluster" });
    expect(parseRun(backup({ phase: "Completed" }, {}))).toMatchObject({ job: null });
  });
});

describe("mask", () => {
  it("keeps what is not secret", () => {
    expect(mask("repository is locked by another process")).toBe("repository is locked by another process");
  });
});
