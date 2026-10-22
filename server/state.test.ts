import { describe, expect, it } from "vitest";
import { deriveState, type StateInput } from "./backups.ts";
import { ago, DAY, HOUR, START } from "./test-app.ts";

const input = (o: Partial<StateInput> = {}): StateInput => ({
  cadenceHours: 24,
  rpoHours: 48,
  recent: [{ status: "success" }],
  lastOkAt: ago(2 * HOUR),
  lastTest: { testedAt: ago(5 * DAY), ok: true },
  now: START,
  settings: { restoreStaleDays: 30, failingRuns: 2 },
  ...o,
});
const state = (o?: Partial<StateInput>) => deriveState(input(o)).state;

describe("deriveState", () => {
  it("is healthy when backups are on time and a restore was tested", () => {
    expect(deriveState(input())).toEqual({ state: "healthy", reason: "Backups are on time and a restore has been tested." });
  });

  it("is unknown until a run is reported", () => {
    expect(state({ recent: [], lastOkAt: null, lastTest: null })).toBe("unknown");
  });

  it("is late after one and a half cadences, not before", () => {
    expect(state({ lastOkAt: ago(36 * HOUR) })).toBe("healthy");
    expect(state({ lastOkAt: ago(36 * HOUR + 60_000) })).toBe("late");
  });

  it("is at risk once the data could be lost for longer than the RPO, whatever the cadence", () => {
    expect(state({ lastOkAt: ago(48 * HOUR) })).toBe("late");
    expect(state({ lastOkAt: ago(48 * HOUR + 60_000) })).toBe("at-risk");
    expect(deriveState(input({ lastOkAt: ago(60 * HOUR) })).reason).toContain("60 hours old");
    expect(state({ cadenceHours: 1, rpoHours: 1, lastOkAt: ago(90 * 60_000) })).toBe("at-risk");
  });

  it("is at risk when nothing has ever succeeded but the last runs are not all failed", () => {
    expect(deriveState(input({ recent: [{ status: "failed" }], lastOkAt: null }))).toEqual({ state: "at-risk", reason: "No run has succeeded yet." });
  });

  it("is failing after the configured number of failed runs in a row", () => {
    expect(state({ recent: [{ status: "failed" }, { status: "failed" }] })).toBe("failing");
    expect(state({ recent: [{ status: "failed" }, { status: "success" }] })).toBe("healthy");
    expect(state({ recent: [{ status: "failed" }] })).toBe("healthy");
    expect(state({ recent: [{ status: "failed" }], settings: { restoreStaleDays: 30, failingRuns: 1 } })).toBe("failing");
    expect(state({ recent: [{ status: "failed" }, { status: "warning" }] })).toBe("healthy");
  });

  it("puts failing before at-risk, at-risk before late, late before untested", () => {
    expect(state({ recent: [{ status: "failed" }, { status: "failed" }], lastOkAt: ago(90 * HOUR), lastTest: null })).toBe("failing");
    expect(state({ lastOkAt: ago(90 * HOUR), lastTest: null })).toBe("at-risk");
    expect(state({ lastOkAt: ago(40 * HOUR), lastTest: null })).toBe("late");
  });

  it("is untested without a restore test, with a failed one, or with a stale one", () => {
    expect(deriveState(input({ lastTest: null })).reason).toBe("No restore has been tested.");
    expect(deriveState(input({ lastTest: { testedAt: ago(DAY), ok: false } })).reason).toBe("The last restore test failed.");
    expect(state({ lastTest: { testedAt: ago(30 * DAY), ok: true } })).toBe("healthy");
    expect(deriveState(input({ lastTest: { testedAt: ago(31 * DAY), ok: true } })).reason).toContain("31 days old");
    expect(state({ lastTest: { testedAt: ago(10 * DAY), ok: true }, settings: { restoreStaleDays: 7, failingRuns: 2 } })).toBe("untested");
  });
});
