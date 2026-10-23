// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type JobState = "healthy" | "late" | "at-risk" | "failing" | "untested" | "unknown";
export type Tool = "restic" | "velero" | "other";
export type RunStatus = "success" | "warning" | "failed";

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface Job {
  id: string;
  name: string;
  tool: Tool;
  source: string;
  location: string;
  cadenceHours: number;
  rpoHours: number;
  retention: string;
  owner: string;
  tags: string[];
  state: JobState;
  reason: string;
  lastRun: { endedAt: string; status: RunStatus } | null;
  lastSuccessAt: string | null;
  lastRestoreTest: { testedAt: string; ok: boolean; verifiedBy: "automated" | "manual"; ageDays: number } | null;
  successRate30d: number | null;
  sizeBytes: number | null;
  createdAt: string;
}

export interface Run {
  id: string;
  startedAt: string;
  endedAt: string;
  status: RunStatus;
  snapshotId: string | null;
  sizeBytes: number | null;
  filesNew: number | null;
  filesChanged: number | null;
  error: string | null;
}

export interface RestoreTest {
  id: string;
  testedAt: string;
  ok: boolean;
  durationSeconds: number | null;
  snapshotId: string | null;
  verifiedBy: "automated" | "manual";
  notes: string;
  reportedBy: string | null;
}

export interface Settings {
  autoCreate: boolean;
  restoreStaleDays: number;
  failingRuns: number;
}

export interface Summary {
  jobs: number;
  states: Record<JobState, number>;
  autoCreate: boolean;
  lastRunAt: string | null;
  hostsFile: HostsCoverage | null;
}

/** The hosts file (ADR 0052) and the servers in it this product has nothing for. */
export interface HostsCoverage {
  path: string;
  appliedAt: string | null;
  entries: number;
  error: string | null;
  warnings: string[];
  missing: Array<{ name: string; address: string }>;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
