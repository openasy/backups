// What a backup tool reports becomes one run. Our own JSON is accepted as it is; the summary of `restic backup --json`
// and a Velero Backup resource are read as they come from the tool (ADR 0048).

export type RunStatus = "success" | "warning" | "failed";
export type Tool = "restic" | "velero" | "other";

export interface ParsedRun {
  /** The job's name, from the body or the query. */
  job: string | null;
  tool: Tool;
  startedAt: string;
  endedAt: string;
  status: RunStatus;
  snapshotId: string | null;
  sizeBytes: number | null;
  filesNew: number | null;
  filesChanged: number | null;
  error: string | null;
}

export class ParseError extends Error {}

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, name: string): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ParseError(`${name} must be a whole number, 0 or more.`);
  return v;
};
const str = (v: unknown, name: string, max: number): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) throw new ParseError(`${name} must be text of at most ${max} characters.`);
  return v;
};
const time = (v: unknown, name: string): string => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new ParseError(`${name} must be a date and time such as 2026-10-22T02:00:00Z.`);
  return new Date(t).toISOString();
};

/** Passwords and tokens that tools print in their error messages are replaced before anything is stored. */
export function mask(value: string): string {
  return value
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|credential)s?["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi, "$1***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer ***")
    .replace(/(:\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1***@");
}

/** The last JSON object of a body that may be the many lines `restic backup --json` prints. */
function lastObject(raw: string): Obj {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const whole = parse(raw);
  if (isObj(whole)) return whole;
  const objects = lines.map(parse).filter(isObj);
  // restic prints status lines, then one summary.
  const summary = objects.findLast((o) => o.message_type === "summary");
  const found = summary ?? objects.at(-1);
  if (!found) throw new ParseError("The body must be JSON: an object, or the lines `restic backup --json` prints.");
  return found;
}

/** Reads a report. `now` stands in for the end of a restic run, which does not say when it ended. */
export function parseRun(raw: string, query: { job?: string | null; tool?: string | null } = {}, now = new Date()): ParsedRun {
  const body = lastObject(raw);
  const hint = query.tool ?? undefined;
  if (hint !== undefined && hint !== "restic" && hint !== "velero" && hint !== "other") throw new ParseError("tool must be restic, velero or other.");

  // A Velero Backup resource, as `kubectl get backup <name> -o json` prints it.
  if (body.kind === "Backup" && isObj(body.status) && isObj(body.metadata)) {
    const st = body.status;
    const phase = String(st.phase ?? "");
    const errors = count(st.errors, "status.errors") ?? 0;
    const warnings = count(st.warnings, "status.warnings") ?? 0;
    let status: RunStatus;
    if (phase === "Completed") status = warnings > 0 ? "warning" : "success";
    else if (phase === "PartiallyFailed") status = "warning";
    else if (phase === "Failed" || phase === "FailedValidation") status = "failed";
    else throw new ParseError(`The backup is ${phase || "not finished"}: send it when its phase is Completed, PartiallyFailed or Failed.`);
    const ended = st.completionTimestamp ?? st.startTimestamp;
    const labels = isObj(body.metadata.labels) ? body.metadata.labels : {};
    return {
      job: query.job ?? str(body.job, "job", 128) ?? str(labels["velero.io/schedule-name"], "label velero.io/schedule-name", 128),
      tool: "velero",
      startedAt: time(st.startTimestamp ?? ended, "status.startTimestamp"),
      endedAt: time(ended, "status.completionTimestamp"),
      status,
      snapshotId: str(body.metadata.name, "metadata.name", 256),
      sizeBytes: null,
      filesNew: null,
      filesChanged: null,
      error:
        phase === "Completed" && !warnings
          ? null
          : mask(`${phase}: ${errors} errors, ${warnings} warnings${st.failureReason ? `: ${String(st.failureReason).slice(0, 500)}` : ""}`),
    };
  }

  // The summary of `restic backup --json`.
  if (body.message_type === "summary") {
    const endedAt = body.endedAt === undefined ? now.toISOString() : time(body.endedAt, "endedAt");
    const seconds = typeof body.total_duration === "number" && Number.isFinite(body.total_duration) && body.total_duration >= 0 ? body.total_duration : 0;
    return {
      job: query.job ?? str(body.job, "job", 128),
      tool: "restic",
      startedAt: body.startedAt === undefined ? new Date(Date.parse(endedAt) - seconds * 1000).toISOString() : time(body.startedAt, "startedAt"),
      endedAt,
      // restic exits non-zero when it fails, so a summary is a backup that was made.
      status: "success",
      snapshotId: str(body.snapshot_id, "snapshot_id", 256),
      sizeBytes: count(body.total_bytes_processed === undefined ? undefined : Math.trunc(body.total_bytes_processed), "total_bytes_processed"),
      filesNew: count(body.files_new, "files_new"),
      filesChanged: count(body.files_changed, "files_changed"),
      error: null,
    };
  }

  // Our own report.
  if (!["success", "warning", "failed"].includes(body.status)) throw new ParseError("status must be success, warning or failed.");
  const startedAt = time(body.startedAt, "startedAt");
  const endedAt = time(body.endedAt, "endedAt");
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new ParseError("endedAt must not be before startedAt.");
  const error = str(body.error, "error", 1000);
  if (body.status === "failed" && !error) throw new ParseError("A failed run needs an error saying why.");
  return {
    job: query.job ?? str(body.job, "job", 128),
    tool: hint ?? (body.tool === "restic" || body.tool === "velero" ? body.tool : "other"),
    startedAt,
    endedAt,
    status: body.status,
    snapshotId: str(body.snapshotId, "snapshotId", 256),
    sizeBytes: count(body.sizeBytes, "sizeBytes"),
    filesNew: count(body.filesNew, "filesNew"),
    filesChanged: count(body.filesChanged, "filesChanged"),
    error: error ? mask(error) : null,
  };
}
