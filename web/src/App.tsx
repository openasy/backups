import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  FacetFilter,
  FilterBar,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SelectField,
  StatusBadge,
  Switch,
  TextField,
  TimeSeriesChart,
  usePath,
  type Column,
  type ProductId,
  useThemePreference,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { DatabaseBackup, KeyRound, LogIn, LogOut, Plus, Settings2, SlidersHorizontal, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Job, type JobState, type ProductLink, type RestoreTest, type Run, type Settings, type Summary, type Tool } from "./api.ts";
import { ago, bytes, duration } from "./format.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const PAGES = ["settings", "setup", "account", "members", "signin", "tokens"] as const;
type Route = { page: "jobs" | (typeof PAGES)[number] } | { page: "job"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["jobs", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "jobs" && id) return { page: "job", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "jobs" };
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

const STATE_ORDER: JobState[] = ["failing", "at-risk", "late", "untested", "unknown", "healthy"];
const STATE_LABEL: Record<JobState, string> = { failing: "Failing", "at-risk": "At risk", late: "Late", untested: "Untested", unknown: "Waiting", healthy: "Healthy" };
const STATE_TONE: Record<JobState, "danger" | "warning" | "success" | "neutral" | "info"> = { failing: "danger", "at-risk": "danger", late: "warning", untested: "info", unknown: "neutral", healthy: "success" };

function StateBadge({ state }: { state: JobState }) {
  return <StatusBadge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</StatusBadge>;
}

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs text-fg">{children}</pre>;
}

const TOOLS: Array<{ value: Tool; label: string }> = [
  { value: "restic", label: "restic" },
  { value: "velero", label: "Velero" },
  { value: "other", label: "Something else" },
];

// ---------------------------------------------------------------- Jobs

function JobDialog({ open, onClose, call, job, onSaved }: { open: boolean; onClose: () => void; call: Call; job?: Job; onSaved: (j: Job) => void }) {
  const [name, setName] = useState(job?.name ?? "");
  const [tool, setTool] = useState<Tool>(job?.tool ?? "restic");
  const [source, setSource] = useState(job?.source ?? "");
  const [location, setLocation] = useState(job?.location ?? "");
  const [cadence, setCadence] = useState(String(job?.cadenceHours ?? 24));
  const [rpo, setRpo] = useState(String(job?.rpoHours ?? 48));
  const [owner, setOwner] = useState(job?.owner ?? "");
  const [error, setError] = useState<string>();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const fields = { tool, source, location, owner, cadenceHours: Number(cadence), rpoHours: Number(rpo) };
    try {
      const saved = job
        ? await call<Job>(`/api/v1/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify(fields) })
        : await call<Job>("/api/v1/jobs", { method: "POST", body: JSON.stringify({ name, ...fields }) });
      setError(undefined);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={job ? `Change ${job.name}` : "Define a job"}
      description="Backups tracks what makes your backups; it does not make them. The job reports each run, and a restore test now and then."
      onSubmit={save}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !cadence || !rpo}>
            {job ? "Save" : "Define job"}
          </Button>
        </>
      }
    >
      {!job && <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} hint="Reports use this name. It cannot change later." />}
      <SelectField label="Made by" value={tool} onChange={(e) => setTool(e.target.value as Tool)} options={TOOLS} />
      <TextField label="What it backs up" value={source} onChange={(e) => setSource(e.target.value)} hint="For example: Postgres on db-1." />
      <TextField label="Where it goes" value={location} onChange={(e) => setLocation(e.target.value)} hint="For example: s3:backups/db." />
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Runs every (hours)" inputMode="numeric" value={cadence} onChange={(e) => setCadence(e.target.value)} hint="Late after one and a half of these." />
        <TextField label="May lose up to (hours)" inputMode="numeric" value={rpo} onChange={(e) => setRpo(e.target.value)} hint="At risk beyond this. Not less than the first." error={error} />
      </div>
      <TextField label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
    </Dialog>
  );
}

function JobsPage({ call, summary, reload }: { call: Call; summary?: Summary; reload: () => void }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<Job[]>();
  const [states, setStates] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => void call<{ jobs: Job[] }>("/api/v1/jobs?limit=500").then((r) => setRows(r.jobs), () => setRows([])), [call]);
  useEffect(load, [load]);

  const shown = (rows ?? []).filter((j) => !states.length || states.includes(j.state)).sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
  const columns: Column<Job>[] = [
    { id: "state", header: "State", width: "110px", sortValue: (j) => STATE_ORDER.indexOf(j.state), cell: (j) => <StateBadge state={j.state} /> },
    {
      id: "name",
      header: "Job",
      width: "26%",
      sortValue: (j) => j.name,
      cell: (j) => (
        <span className="flex min-w-0 flex-col">
          <a href={`/jobs/${j.id}`} className="font-medium">
            {j.name}
          </a>
          <span className="backups-clamp text-xs text-fg-muted" title={j.reason}>
            {j.reason}
          </span>
        </span>
      ),
    },
    { id: "tool", header: "Made by", cell: (j) => <Badge>{j.tool}</Badge> },
    { id: "last", header: "Last backup", sortValue: (j) => j.lastSuccessAt ?? "", cell: (j) => <span className="text-xs whitespace-nowrap">{ago(j.lastSuccessAt)}</span> },
    {
      id: "test",
      header: "Last restore test",
      cell: (j) => (j.lastRestoreTest ? <span className="text-xs whitespace-nowrap">{j.lastRestoreTest.ok ? ago(j.lastRestoreTest.testedAt) : `failed ${ago(j.lastRestoreTest.testedAt)}`}</span> : <span className="text-xs text-fg-muted">Never</span>),
    },
    { id: "size", header: "Size", align: "right", cell: (j) => bytes(j.sizeBytes) },
  ];
  const s = summary;
  return (
    <>
      <PageHeader
        title="Jobs"
        description={s ? `${plural(s.jobs, "job")} · last run ${ago(s.lastRunAt)}` : undefined}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Define job
            </Button>
          )
        }
      />
      {s && (
        <KpiGrid minWidth={140}>
          <KpiCard label="Failing" value={s.states.failing} tone={s.states.failing ? "danger" : "success"} />
          <KpiCard label="At risk" value={s.states["at-risk"]} tone={s.states["at-risk"] ? "danger" : "success"} />
          <KpiCard label="Late" value={s.states.late} tone={s.states.late ? "warning" : "success"} />
          <KpiCard label="Untested" value={s.states.untested} tone={s.states.untested ? "info" : "success"} />
          <KpiCard label="Healthy" value={s.states.healthy} tone="success" />
        </KpiGrid>
      )}
      <FilterBar onClear={() => setStates([])}>
        <FacetFilter label="State" selected={states} onChange={setStates} options={STATE_ORDER.map((k) => ({ value: k, label: STATE_LABEL[k], count: s?.states[k] }))} />
      </FilterBar>
      <Panel flush>
        <DataTable
          label="Backup jobs"
          columns={columns}
          rows={shown}
          loading={!rows}
          getRowId={(j) => j.id}
          minWidth={900}
          empty={
            <EmptyState title="No jobs yet">
              {can("admin") ? (
                <>
                  Define the first job, or let reports create jobs under <a href="/settings">Settings</a>. See <a href="/setup">Setup</a>.
                </>
              ) : (
                "An admin defines the jobs to track."
              )}
            </EmptyState>
          }
        />
      </Panel>
      {adding && (
        <JobDialog
          open
          onClose={() => setAdding(false)}
          call={call}
          onSaved={(j) => {
            setAdding(false);
            reload();
            navigate(`/jobs/${j.id}`);
          }}
        />
      )}
    </>
  );
}

function RestoreTestDialog({ job, call, onClose, onSaved }: { job: Job; call: Call; onClose: () => void; onSaved: () => void }) {
  const [ok, setOk] = useState("yes");
  const [minutes, setMinutes] = useState("");
  const [snapshot, setSnapshot] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call("/api/v1/restore-tests", {
        method: "POST",
        body: JSON.stringify({ job: job.name, testedAt: new Date().toISOString(), ok: ok === "yes", verifiedBy: "manual", notes, ...(minutes && { durationSeconds: Math.round(Number(minutes) * 60) }), ...(snapshot && { snapshotId: snapshot }) }),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Record a restore test of ${job.name}`}
      description="You restored a backup somewhere safe and looked at what came back. Say how it went."
      onSubmit={save}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Record test
          </Button>
        </>
      }
    >
      <SelectField
        label="Did the restore work?"
        value={ok}
        onChange={(e) => setOk(e.target.value)}
        options={[
          { value: "yes", label: "Yes, the data was complete" },
          { value: "no", label: "No, it failed or was incomplete" },
        ]}
      />
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Took (minutes)" inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <TextField label="Snapshot" value={snapshot} onChange={(e) => setSnapshot(e.target.value)} hint="Optional." />
      </div>
      <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} hint="What you checked. Do not paste passwords." error={error} />
    </Dialog>
  );
}

function JobPage({ call, id, reload }: { call: Call; id: string; reload: () => void }) {
  const { can } = useAuth();
  const [job, setJob] = useState<Job | null>();
  const [runs, setRuns] = useState<Run[]>();
  const [tests, setTests] = useState<RestoreTest[]>();
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    call<Job>(`/api/v1/jobs/${id}`).then(setJob, () => setJob(null));
    call<{ runs: Run[] }>(`/api/v1/jobs/${id}/runs?limit=100`).then((r) => setRuns(r.runs), () => setRuns([]));
    call<{ restoreTests: RestoreTest[] }>(`/api/v1/jobs/${id}/restore-tests?limit=50`).then((r) => setTests(r.restoreTests), () => setTests([]));
  }, [call, id]);
  useEffect(load, [load]);

  const remove = () =>
    call(`/api/v1/jobs/${id}`, { method: "DELETE" }).then(
      () => {
        reload();
        navigate("/jobs");
      },
      (err: Error) => setError(err.message),
    );

  if (job === null)
    return (
      <EmptyState title="Job not found">
        It may have been deleted. <a href="/jobs">Back to jobs</a>.
      </EmptyState>
    );

  const sized = (runs ?? []).filter((r) => r.sizeBytes !== null).slice().reverse();
  const runColumns: Column<Run>[] = [
    { id: "when", header: "Ended", sortValue: (r) => r.endedAt, cell: (r) => <span className="text-xs whitespace-nowrap">{ago(r.endedAt)}</span> },
    { id: "status", header: "Result", cell: (r) => <StatusBadge tone={r.status === "success" ? "success" : r.status === "warning" ? "warning" : "danger"}>{r.status}</StatusBadge> },
    { id: "took", header: "Took", align: "right", cell: (r) => duration(Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)) },
    { id: "size", header: "Size", align: "right", cell: (r) => bytes(r.sizeBytes) },
    { id: "files", header: "New / changed", align: "right", cell: (r) => (r.filesNew === null ? "–" : `${r.filesNew} / ${r.filesChanged ?? 0}`) },
    { id: "snapshot", header: "Snapshot", cell: (r) => <span className="backups-wrap font-mono text-xs">{r.snapshotId ?? "–"}</span> },
    { id: "error", header: "Note", width: "28%", cell: (r) => <span className="backups-clamp text-xs text-fg-muted" title={r.error ?? undefined}>{r.error ?? ""}</span> },
  ];
  const testColumns: Column<RestoreTest>[] = [
    { id: "when", header: "Tested", sortValue: (t) => t.testedAt, cell: (t) => <span className="text-xs whitespace-nowrap">{ago(t.testedAt)}</span> },
    { id: "ok", header: "Result", cell: (t) => <StatusBadge tone={t.ok ? "success" : "danger"}>{t.ok ? "Restored" : "Failed"}</StatusBadge> },
    { id: "by", header: "How", cell: (t) => <Badge>{t.verifiedBy}</Badge> },
    { id: "took", header: "Took", align: "right", cell: (t) => duration(t.durationSeconds) },
    { id: "notes", header: "Notes", width: "36%", cell: (t) => <span className="backups-clamp text-xs text-fg-muted" title={t.notes}>{t.notes}{t.reportedBy ? ` (${t.reportedBy})` : ""}</span> },
  ];

  return (
    <>
      <PageHeader
        title={job?.name ?? "Job"}
        description={job ? `${job.source || "No source described"}${job.location ? ` → ${job.location}` : ""} · every ${job.cadenceHours} h, may lose ${job.rpoHours} h${job.owner ? ` · ${job.owner}` : ""}` : undefined}
        actions={
          job && (
            <span className="flex items-center gap-2">
              <StateBadge state={job.state} />
              {can("editor") && (
                <Button onClick={() => setTesting(true)}>
                  Record restore test
                </Button>
              )}
              {can("admin") && (
                <Button onClick={() => setEditing(true)}>
                  Change
                </Button>
              )}
            </span>
          )
        }
      />
      {job && (
        <KpiGrid minWidth={150}>
          <KpiCard label="Last backup" value={ago(job.lastSuccessAt)} />
          <KpiCard label="Success, 30 days" value={job.successRate30d === null ? "–" : `${Math.round(job.successRate30d * 100)}%`} tone={job.successRate30d === null || job.successRate30d >= 0.95 ? "success" : "warning"} />
          <KpiCard label="Last restore test" value={job.lastRestoreTest ? (job.lastRestoreTest.ok ? `${job.lastRestoreTest.ageDays} d ago` : "Failed") : "Never"} tone={job.lastRestoreTest?.ok ? "success" : "info"} />
          <KpiCard label="Size" value={bytes(job.sizeBytes)} />
        </KpiGrid>
      )}
      {job && job.state !== "healthy" && <p className="m-0 text-sm text-fg-muted">{job.reason}</p>}
      {sized.length > 1 && (
        <Panel title="Size of each backup">
          <TimeSeriesChart label={`Size of each backup of ${job?.name ?? "the job"}`} series={[{ id: "size", name: "Size", data: sized.map((r) => r.sizeBytes ?? 0) }]} labels={sized.map((r) => new Date(r.endedAt).toLocaleDateString())} format={bytes} area height={160} />
        </Panel>
      )}
      <Panel title="Runs" flush>
        <DataTable label="Runs" columns={runColumns} rows={runs ?? []} loading={!runs} getRowId={(r) => r.id} minWidth={820} pageSize={20} empty={<EmptyState title="No runs yet">Nothing has been reported for this job. See <a href="/setup">Setup</a>.</EmptyState>} />
      </Panel>
      <Panel title="Restore tests" description="A backup nobody has restored is a hope." flush>
        <DataTable label="Restore tests" columns={testColumns} rows={tests ?? []} loading={!tests} getRowId={(t) => t.id} minWidth={640} pageSize={10} empty={<EmptyState title="Never restored">Record a restore test when you try one, or send them from the script that does.</EmptyState>} />
      </Panel>
      {can("admin") && job && (
        <div>
          <Button icon={<Trash2 />} onClick={() => setRemoving(true)}>
            Delete job
          </Button>
          {error && <span className="ml-2 text-xs text-danger">{error}</span>}
        </div>
      )}
      {testing && job && (
        <RestoreTestDialog
          job={job}
          call={call}
          onClose={() => setTesting(false)}
          onSaved={() => {
            setTesting(false);
            load();
            reload();
          }}
        />
      )}
      {editing && job && (
        <JobDialog
          open
          job={job}
          onClose={() => setEditing(false)}
          call={call}
          onSaved={() => {
            setEditing(false);
            load();
            reload();
          }}
        />
      )}
      {job && (
        <Dialog
          open={removing}
          onOpenChange={setRemoving}
          title={`Delete ${job.name}?`}
          description="Its runs and restore tests are deleted. A later report creates it again only if reports may create jobs."
          footer={
            <>
              <Button type="button" onClick={() => setRemoving(false)}>
                Cancel
              </Button>
              <Button type="button" variant="primary" onClick={() => void remove()}>
                Delete
              </Button>
            </>
          }
        >
          <></>
        </Dialog>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Settings and setup

function BackupSettingsPage({ call, reload }: { call: Call; reload: () => void }) {
  const { can } = useAuth();
  const [settings, setSettings] = useState<Settings>();
  const [days, setDays] = useState("");
  const [runs, setRuns] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => void call<Settings>("/api/v1/settings").then((s) => (setSettings(s), setDays(String(s.restoreStaleDays)), setRuns(String(s.failingRuns))), () => {}), [call]);

  const put = async (body: Partial<Settings>) => {
    try {
      const s = await call<Settings>("/api/v1/settings", { method: "PUT", body: JSON.stringify(body) });
      setSettings(s);
      setError(undefined);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const admin = can("admin");
  return (
    <>
      <PageHeader title="Settings" description="When a job counts as untested or failing, and whether a report may create a job." />
      {settings && (
        <Panel title="Jobs from reports" description="Off by default, so that a typo in a job's name does not become a new job.">
          <Switch checked={settings.autoCreate} disabled={!admin} onCheckedChange={(v) => void put({ autoCreate: v })} label="A report for an unknown job creates it" description="With a cadence of 24 hours and room to lose 48. Change them on the job." />
        </Panel>
      )}
      {settings && (
        <Panel title="Thresholds">
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField label="A restore test is stale after (days)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={!admin} />
            <TextField label="Failing after this many failed runs in a row" inputMode="numeric" value={runs} onChange={(e) => setRuns(e.target.value)} disabled={!admin} error={error} />
          </div>
          {admin && (
            <div className="mt-3">
              <Button variant="primary" onClick={() => void put({ restoreStaleDays: Number(days), failingRuns: Number(runs) })} disabled={Number(days) === settings.restoreStaleDays && Number(runs) === settings.failingRuns}>
                Save thresholds
              </Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

function SetupPage() {
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title="Setup" description="Define a job, then send each run, and each restore test, from where the backup runs. Backups tracks them; it makes no backups." />
      <Panel title="restic" description="Send the summary restic prints. Use BACKUPS_INGEST_TOKEN, set where backups runs, or an API token with the editor role from API tokens.">
        <Code>{`restic backup --json /srv | tail -n 1 | curl -sf -X POST \\
  -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' --data-binary @- \\
  "${origin}/api/v1/runs?job=files"`}</Code>
      </Panel>
      <Panel title="Velero" description="Send the Backup resource once it has finished. Its schedule's name is the job, unless you give one.">
        <Code>{`kubectl -n velero get backup nightly-20261022 -o json | curl -sf -X POST \\
  -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' --data-binary @- \\
  "${origin}/api/v1/runs?job=cluster"`}</Code>
      </Panel>
      <Panel title="Anything else, and restore tests" description="A run is a small JSON. A restore test says you tried one, and whether it worked.">
        <Code>{`curl -sf -X POST -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' \\
  -d '{"job":"db","startedAt":"2026-10-22T01:00:00Z","endedAt":"2026-10-22T01:20:00Z","status":"success","sizeBytes":5000000}' \\
  "${origin}/api/v1/runs"

curl -sf -X POST -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' \\
  -d '{"job":"db","testedAt":"2026-10-22T04:00:00Z","ok":true,"durationSeconds":340,"verifiedBy":"automated"}' \\
  "${origin}/api/v1/restore-tests"`}</Code>
      </Panel>
      <Panel title="What the states mean">
        <ul className="backups-list flex flex-col gap-1 text-sm text-fg-muted">
          <li>
            <b>Failing</b>: the last runs all failed. <b>At risk</b>: the last backup is older than the hours the job may lose. <b>Late</b>: older than one and a half times how often it should run.
          </li>
          <li>
            <b>Untested</b>: no restore has been tested lately, or the last one failed. A warning counts as a backup that was made.
          </li>
          <li>/metrics has each job's state and last success for Prometheus, to alert on.</li>
        </ul>
      </Panel>
    </>
  );
}

/** The first screen, until the first job exists. The summary is polled, so it gives way by itself. */
function WelcomePage() {
  return (
    <>
      <PageHeader title="Get started" description="Define a job, or let reports create jobs." actions={<StatusBadge tone="info">Waiting for the first job</StatusBadge>} />
      <SetupPage />
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title="Admins only">Ask an admin of this backups for access.</EmptyState>;
  const titles = {
    account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
    members: ["Members", "Who can sign in to this backups, and with which role. Viewers see everything; editors also record restore tests; admins also define jobs, change settings, and manage members and tokens."],
    signin: ["Sign-in", "Identity providers people can sign in with, such as OpenAsy Identity, Keycloak or Microsoft Entra ID, and which of their groups give which role."],
    tokens: ["API tokens", "For scripts and CI. Each token has one role and an expiry; the secret is shown once."],
  } as const;
  return (
    <>
      <PageHeader
        title={titles[page][0]}
        description={titles[page][1]}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              Sign out
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const [theme, setTheme] = useThemePreference();
  const { me, can } = useAuth();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "backups" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const nav = [
    { id: "jobs", label: "Jobs", icon: DatabaseBackup, count: summary?.jobs },
  ];
  const footerNav = [
    { id: "setup", label: "Setup", icon: Settings2 },
    { id: "settings", label: "Settings", icon: SlidersHorizontal },
    ...(can("admin")
      ? [
          { id: "members", label: "Members", icon: Users },
          { id: "signin", label: "Sign-in", icon: LogIn },
          { id: "tokens", label: "API tokens", icon: KeyRound },
        ]
      : []),
    { id: "account", label: "Account", icon: UserRound },
  ];
  const active = route.page === "job" ? "jobs" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell
      product="backups"
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
      theme={theme}
      onThemeChange={setTheme}
    >
      {route.page === "jobs" && summary && summary.jobs === 0 && !summary.autoCreate ? (
        <WelcomePage />
      ) : route.page === "jobs" ? (
        <JobsPage call={call} summary={summary} reload={reload} />
      ) : route.page === "job" ? (
        <JobPage key={route.id} call={call} id={route.id} reload={reload} />
      ) : route.page === "settings" ? (
        <BackupSettingsPage call={call} reload={reload} />
      ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <SettingsPage page={route.page} />
      ) : (
        <SetupPage />
      )}
    </AppShell>
  );
}

export function App() {
  const [theme] = useThemePreference();
  return (
    // No organization until branding is configurable (ADR 0004); the library's default is a placeholder.
    <BrandProvider theme={theme} brand={{ name: "OpenAsy", organization: undefined }} className="min-h-screen">
      <AuthGate product="OpenAsy Backups">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
