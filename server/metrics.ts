// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface JobGauge {
  job: string;
  state: string;
  lastSuccessAt: string | null;
  sizeBytes: number | null;
}

const STATES = ["healthy", "late", "at-risk", "failing", "untested", "unknown"];
const label = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function renderMetrics(version: string, jobs: JobGauge[]): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="backups",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_backups_jobs Jobs being tracked.",
    "# TYPE openasy_backups_jobs gauge",
    `openasy_backups_jobs ${jobs.length}`,
    "# HELP openasy_backups_job_state 1 for the state a job is in, 0 for the others.",
    "# TYPE openasy_backups_job_state gauge",
    ...jobs.flatMap((j) => STATES.map((s) => `openasy_backups_job_state{job="${label(j.job)}",state="${s}"} ${j.state === s ? 1 : 0}`)),
    "# HELP openasy_backups_last_success_timestamp_seconds When the job last made a backup; 0 when it never has.",
    "# TYPE openasy_backups_last_success_timestamp_seconds gauge",
    ...jobs.map(
      (j) => `openasy_backups_last_success_timestamp_seconds{job="${label(j.job)}"} ${j.lastSuccessAt ? Math.floor(Date.parse(j.lastSuccessAt) / 1000) : 0}`,
    ),
    "# HELP openasy_backups_last_size_bytes Size of the last backup that reported one.",
    "# TYPE openasy_backups_last_size_bytes gauge",
    ...jobs.filter((j) => j.sizeBytes !== null).map((j) => `openasy_backups_last_size_bytes{job="${label(j.job)}"} ${j.sizeBytes}`),
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
