import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Callout,
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
  useAgo,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { DatabaseBackup, KeyRound, LogIn, LogOut, Plus, Settings2, SlidersHorizontal, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Job, type JobState, type ProductLink, type RestoreTest, type Run, type Settings, type HostsCoverage, type Summary, type Tool } from "./api.ts";
import { bytes, duration } from "./format.ts";
import { useT, type T } from "./i18n.ts";

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
const STATE_LABEL = (t: T): Record<JobState, string> => ({ failing: "Failing", "at-risk": t("stateLabel.atRisk"), late: "Late", untested: "Untested", unknown: "Waiting", healthy: "Healthy" });
const STATE_TONE: Record<JobState, "danger" | "warning" | "success" | "neutral" | "info"> = { failing: "danger", "at-risk": "danger", late: "warning", untested: "info", unknown: "neutral", healthy: "success" };

function StateBadge({ state }: { state: JobState }) {
  const t = useT();
  return <StatusBadge tone={STATE_TONE[state]}>{STATE_LABEL(t)[state]}</StatusBadge>;
}

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs text-fg">{children}</pre>;
}

const TOOLS = (t: T): Array<{ value: Tool; label: string }> => ([
  { value: "restic", label: "restic" },
  { value: "velero", label: t("tools.velero") },
  { value: "other", label: t("tools.somethingElse") },
]);

// ---------------------------------------------------------------- Jobs

function JobDialog({ open, onClose, call, job, onSaved }: { open: boolean; onClose: () => void; call: Call; job?: Job; onSaved: (j: Job) => void }) {
  const t = useT();
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
      title={job ? t("jobDialog.change", { name: job.name }) : t("jobDialog.defineAJob")}
      description={t("jobDialog.backupsTracksWhatMakesYour")}
      onSubmit={save}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("jobDialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !cadence || !rpo}>
            {job ? t("jobDialog.save") : t("jobDialog.defineJob")}
          </Button>
        </>
      }
    >
      {!job && <TextField label={t("jobDialog.name")} value={name} onChange={(e) => setName(e.target.value)} hint={t("jobDialog.reportsUseThisNameIt")} />}
      <SelectField label={t("jobDialog.madeBy")} value={tool} onChange={(e) => setTool(e.target.value as Tool)} options={TOOLS(t)} />
      <TextField label={t("jobDialog.whatItBacksUp")} value={source} onChange={(e) => setSource(e.target.value)} hint={t("jobDialog.forExamplePostgresOnDb")} />
      <TextField label={t("jobDialog.whereItGoes")} value={location} onChange={(e) => setLocation(e.target.value)} hint={t("jobDialog.forExampleS3BackupsDb")} />
      <div className="grid grid-cols-2 gap-2">
        <TextField label={t("jobDialog.runsEveryHours")} inputMode="numeric" value={cadence} onChange={(e) => setCadence(e.target.value)} hint={t("jobDialog.lateAfterOneAndA")} />
        <TextField label={t("jobDialog.mayLoseUpToHours")} inputMode="numeric" value={rpo} onChange={(e) => setRpo(e.target.value)} hint={t("jobDialog.atRiskBeyondThisNot")} error={error} />
      </div>
      <TextField label={t("jobDialog.owner")} value={owner} onChange={(e) => setOwner(e.target.value)} />
    </Dialog>
  );
}

/** Servers in the install's hosts file Backups has no backup job for, and the file's own problems (ADR 0052). */
function HostsCoverageNote({ file }: { file?: HostsCoverage | null }) {
  const t = useT();
  if (!file) return null;
  if (file.error) {
    return (
      <Callout tone="danger" title={t("hostsCoverageNote.theHostsFileIsNot")}>
        {t("hostsCoverageNote.itsLastGoodVersionIs", { error: file.error, path: file.path })}</Callout>
    );
  }
  if (!file.missing.length) return null;
  return (
    <Callout tone="warning" title={t("hostsCoverageNote.inTheHostsFileNo", { length: file.missing.length, value: file.missing.length === 1 ? "server" : "servers", value2: file.missing.length === 1 ? "has" : "have" })}>
      {file.missing.map((h) => h.name).join(", ")}. Define a job whose name or source names the server, such as db-1:/var/lib/postgresql.
    </Callout>
  );
}

function JobsPage({ call, summary, reload }: { call: Call; summary?: Summary; reload: () => void }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const [rows, setRows] = useState<Job[]>();
  const [states, setStates] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => void call<{ jobs: Job[] }>("/api/v1/jobs?limit=500").then((r) => setRows(r.jobs), () => setRows([])), [call]);
  useEffect(load, [load]);

  const shown = (rows ?? []).filter((j) => !states.length || states.includes(j.state)).sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
  const columns: Column<Job>[] = [
    { id: "state", header: t("jobsPage.state"), width: "110px", sortValue: (j) => STATE_ORDER.indexOf(j.state), cell: (j) => <StateBadge state={j.state} /> },
    {
      id: "name",
      header: t("jobsPage.job"),
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
    { id: "tool", header: t("jobsPage.madeBy"), cell: (j) => <Badge>{j.tool}</Badge> },
    { id: "last", header: t("jobsPage.lastBackup"), sortValue: (j) => j.lastSuccessAt ?? "", cell: (j) => <span className="text-xs whitespace-nowrap">{ago(j.lastSuccessAt)}</span> },
    {
      id: "test",
      header: t("jobsPage.lastRestoreTest"),
      cell: (j) => (j.lastRestoreTest ? <span className="text-xs whitespace-nowrap">{j.lastRestoreTest.ok ? ago(j.lastRestoreTest.testedAt) : t("jobsPage.failed", { ago: ago(j.lastRestoreTest.testedAt) })}</span> : <span className="text-xs text-fg-muted">{t("jobsPage.never")}</span>),
    },
    { id: "size", header: t("jobsPage.size"), align: "right", cell: (j) => bytes(j.sizeBytes) },
  ];
  const s = summary;
  return (
    <>
      <PageHeader
        title={t("jobsPage.jobs")}
        description={s ? t("jobsPage.lastRun", { plural: t("plurals.job", { count: s.jobs }), ago: ago(s.lastRunAt) }) : undefined}
        actions={
          can("admin") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("jobsPage.defineJob")}
            </Button>
          )
        }
      />
      <HostsCoverageNote file={s?.hostsFile} />
      {s && (
        <KpiGrid minWidth={140}>
          <KpiCard label={t("jobsPage.failing")} value={s.states.failing} tone={s.states.failing ? "danger" : "success"} />
          <KpiCard label={t("jobsPage.atRisk")} value={s.states["at-risk"]} tone={s.states["at-risk"] ? "danger" : "success"} />
          <KpiCard label={t("jobsPage.late")} value={s.states.late} tone={s.states.late ? "warning" : "success"} />
          <KpiCard label={t("jobsPage.untested")} value={s.states.untested} tone={s.states.untested ? "info" : "success"} />
          <KpiCard label={t("jobsPage.healthy")} value={s.states.healthy} tone="success" />
        </KpiGrid>
      )}
      <FilterBar onClear={() => setStates([])}>
        <FacetFilter label={t("jobsPage.state")} selected={states} onChange={setStates} options={STATE_ORDER.map((k) => ({ value: k, label: STATE_LABEL(t)[k], count: s?.states[k] }))} />
      </FilterBar>
      <Panel flush>
        <DataTable
          label={t("jobsPage.backupJobs")}
          columns={columns}
          rows={shown}
          loading={!rows}
          getRowId={(j) => j.id}
          minWidth={900}
          empty={
            <EmptyState title={t("jobsPage.noJobsYet")}>
              {can("admin") ? (
                <>
                  {t("jobsPage.defineTheFirstJobOr")}{" "}<a href="/settings">{t("jobsPage.settings")}</a>. See <a href="/setup">{t("jobsPage.setup")}</a>.
                </>
              ) : (
                t("jobsPage.anAdminDefinesTheJobs")
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
  const t = useT();
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
      title={t("restoreTestDialog.recordARestoreTestOf", { name: job.name })}
      description={t("restoreTestDialog.youRestoredABackupSomewhere")}
      onSubmit={save}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            {t("restoreTestDialog.cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {t("restoreTestDialog.recordTest")}
          </Button>
        </>
      }
    >
      <SelectField
        label={t("restoreTestDialog.didTheRestoreWork")}
        value={ok}
        onChange={(e) => setOk(e.target.value)}
        options={[
          { value: "yes", label: t("restoreTestDialog.yesTheDataWasComplete") },
          { value: "no", label: t("restoreTestDialog.noItFailedOrWas") },
        ]}
      />
      <div className="grid grid-cols-2 gap-2">
        <TextField label={t("restoreTestDialog.tookMinutes")} inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <TextField label={t("restoreTestDialog.snapshot")} value={snapshot} onChange={(e) => setSnapshot(e.target.value)} hint={t("restoreTestDialog.optional")} />
      </div>
      <TextField label={t("restoreTestDialog.notes")} value={notes} onChange={(e) => setNotes(e.target.value)} hint={t("restoreTestDialog.whatYouCheckedDoNot")} error={error} />
    </Dialog>
  );
}

function JobPage({ call, id, reload }: { call: Call; id: string; reload: () => void }) {
  const ago = useAgo();
  const msg = useT();
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
      <EmptyState title={msg("jobPage.jobNotFound")}>
        {msg("jobPage.itMayHaveBeenDeleted")}{" "}<a href="/jobs">{msg("jobPage.backToJobs")}</a>.
      </EmptyState>
    );

  const sized = (runs ?? []).filter((r) => r.sizeBytes !== null).slice().reverse();
  const runColumns: Column<Run>[] = [
    { id: "when", header: msg("jobPage.ended"), sortValue: (r) => r.endedAt, cell: (r) => <span className="text-xs whitespace-nowrap">{ago(r.endedAt)}</span> },
    { id: "status", header: msg("jobPage.result"), cell: (r) => <StatusBadge tone={r.status === "success" ? "success" : r.status === "warning" ? "warning" : "danger"}>{r.status}</StatusBadge> },
    { id: "took", header: msg("jobPage.took"), align: "right", cell: (r) => duration(Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)) },
    { id: "size", header: msg("jobPage.size"), align: "right", cell: (r) => bytes(r.sizeBytes) },
    { id: "files", header: msg("jobPage.newChanged"), align: "right", cell: (r) => (r.filesNew === null ? "–" : `${r.filesNew} / ${r.filesChanged ?? 0}`) },
    { id: "snapshot", header: msg("jobPage.snapshot"), cell: (r) => <span className="backups-wrap font-mono text-xs">{r.snapshotId ?? "–"}</span> },
    { id: "error", header: msg("jobPage.note"), width: "28%", cell: (r) => <span className="backups-clamp text-xs text-fg-muted" title={r.error ?? undefined}>{r.error ?? ""}</span> },
  ];
  const testColumns: Column<RestoreTest>[] = [
    { id: "when", header: msg("jobPage.tested"), sortValue: (t) => t.testedAt, cell: (t) => <span className="text-xs whitespace-nowrap">{ago(t.testedAt)}</span> },
    { id: "ok", header: msg("jobPage.result"), cell: (t) => <StatusBadge tone={t.ok ? "success" : "danger"}>{t.ok ? msg("jobPage.restored") : msg("jobPage.failed")}</StatusBadge> },
    { id: "by", header: msg("jobPage.how"), cell: (t) => <Badge>{t.verifiedBy}</Badge> },
    { id: "took", header: msg("jobPage.took"), align: "right", cell: (t) => duration(t.durationSeconds) },
    { id: "notes", header: msg("jobPage.notes"), width: "36%", cell: (t) => <span className="backups-clamp text-xs text-fg-muted" title={t.notes}>{t.notes}{t.reportedBy ? ` (${t.reportedBy})` : ""}</span> },
  ];

  return (
    <>
      <PageHeader
        title={job?.name ?? msg("jobPage.job")}
        description={job ? msg("jobPage.everyHMayLoseH", { value: job.source || "No source described", value2: job.location ? ` → ${job.location}` : "", cadenceHours: job.cadenceHours, rpoHours: job.rpoHours, value3: job.owner ? ` · ${job.owner}` : "" }) : undefined}
        actions={
          job && (
            <span className="flex items-center gap-2">
              <StateBadge state={job.state} />
              {can("editor") && (
                <Button onClick={() => setTesting(true)}>
                  {msg("jobPage.recordRestoreTest")}
                </Button>
              )}
              {can("admin") && (
                <Button onClick={() => setEditing(true)}>
                  {msg("jobPage.change")}
                </Button>
              )}
            </span>
          )
        }
      />
      {job && (
        <KpiGrid minWidth={150}>
          <KpiCard label={msg("jobPage.lastBackup")} value={ago(job.lastSuccessAt)} />
          <KpiCard label={msg("jobPage.success30Days")} value={job.successRate30d === null ? "–" : `${Math.round(job.successRate30d * 100)}%`} tone={job.successRate30d === null || job.successRate30d >= 0.95 ? "success" : "warning"} />
          <KpiCard label={msg("jobPage.lastRestoreTest")} value={job.lastRestoreTest ? (job.lastRestoreTest.ok ? `${job.lastRestoreTest.ageDays} d ago` : "Failed") : "Never"} tone={job.lastRestoreTest?.ok ? "success" : "info"} />
          <KpiCard label={msg("jobPage.size")} value={bytes(job.sizeBytes)} />
        </KpiGrid>
      )}
      {job && job.state !== "healthy" && <p className="m-0 text-sm text-fg-muted">{job.reason}</p>}
      {sized.length > 1 && (
        <Panel title={msg("jobPage.sizeOfEachBackup")}>
          <TimeSeriesChart label={msg("jobPage.sizeOfEachBackupOf", { value: job?.name ?? "the job" })} series={[{ id: "size", name: "Size", data: sized.map((r) => r.sizeBytes ?? 0) }]} labels={sized.map((r) => new Date(r.endedAt).toLocaleDateString())} format={bytes} area height={160} />
        </Panel>
      )}
      <Panel title={msg("jobPage.runs")} flush>
        <DataTable label={msg("jobPage.runs")} columns={runColumns} rows={runs ?? []} loading={!runs} getRowId={(r) => r.id} minWidth={820} pageSize={20} empty={<EmptyState title={msg("jobPage.noRunsYet")}>{msg("jobPage.nothingHasBeenReportedFor")}{" "}<a href="/setup">{msg("jobPage.setup")}</a>.</EmptyState>} />
      </Panel>
      <Panel title={msg("jobPage.restoreTests")} description={msg("jobPage.aBackupNobodyHasRestored")} flush>
        <DataTable label={msg("jobPage.restoreTests")} columns={testColumns} rows={tests ?? []} loading={!tests} getRowId={(t) => t.id} minWidth={640} pageSize={10} empty={<EmptyState title={msg("jobPage.neverRestored")}>{msg("jobPage.recordARestoreTestWhen")}</EmptyState>} />
      </Panel>
      {can("admin") && job && (
        <div>
          <Button icon={<Trash2 />} onClick={() => setRemoving(true)}>
            {msg("jobPage.deleteJob")}
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
          title={msg("jobPage.delete", { name: job.name })}
          description={msg("jobPage.itsRunsAndRestoreTests")}
          footer={
            <>
              <Button type="button" onClick={() => setRemoving(false)}>
                {msg("jobPage.cancel")}
              </Button>
              <Button type="button" variant="primary" onClick={() => void remove()}>
                {msg("jobPage.delete2")}
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
  const t = useT();
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
      <PageHeader title={t("backupSettingsPage.settings")} description={t("backupSettingsPage.whenAJobCountsAs")} />
      {settings && (
        <Panel title={t("backupSettingsPage.jobsFromReports")} description={t("backupSettingsPage.offByDefaultSoThat")}>
          <Switch checked={settings.autoCreate} disabled={!admin} onCheckedChange={(v) => void put({ autoCreate: v })} label={t("backupSettingsPage.aReportForAnUnknown")} description={t("backupSettingsPage.withACadenceOf24")} />
        </Panel>
      )}
      {settings && (
        <Panel title={t("backupSettingsPage.thresholds")}>
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField label={t("backupSettingsPage.aRestoreTestIsStale")} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={!admin} />
            <TextField label={t("backupSettingsPage.failingAfterThisManyFailed")} inputMode="numeric" value={runs} onChange={(e) => setRuns(e.target.value)} disabled={!admin} error={error} />
          </div>
          {admin && (
            <div className="mt-3">
              <Button variant="primary" onClick={() => void put({ restoreStaleDays: Number(days), failingRuns: Number(runs) })} disabled={Number(days) === settings.restoreStaleDays && Number(runs) === settings.failingRuns}>
                {t("backupSettingsPage.saveThresholds")}
              </Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

function SetupPage() {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.defineAJobThenSend")} />
      <Panel title="restic" description={t("setupPage.sendTheSummaryResticPrints")}>
        <Code>{`restic backup --json /srv | tail -n 1 | curl -sf -X POST \\
  -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' --data-binary @- \\
  "${origin}/api/v1/runs?job=files"`}</Code>
      </Panel>
      <Panel title={t("setupPage.velero")} description={t("setupPage.sendTheBackupResourceOnce")}>
        <Code>{`kubectl -n velero get backup nightly-20261022 -o json | curl -sf -X POST \\
  -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' --data-binary @- \\
  "${origin}/api/v1/runs?job=cluster"`}</Code>
      </Panel>
      <Panel title={t("setupPage.anythingElseAndRestoreTests")} description={t("setupPage.aRunIsASmall")}>
        <Code>{`curl -sf -X POST -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' \\
  -d '{"job":"db","startedAt":"2026-10-22T01:00:00Z","endedAt":"2026-10-22T01:20:00Z","status":"success","sizeBytes":5000000}' \\
  "${origin}/api/v1/runs"

curl -sf -X POST -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' \\
  -d '{"job":"db","testedAt":"2026-10-22T04:00:00Z","ok":true,"durationSeconds":340,"verifiedBy":"automated"}' \\
  "${origin}/api/v1/restore-tests"`}</Code>
      </Panel>
      <Panel title={t("setupPage.whatTheStatesMean")}>
        <ul className="backups-list flex flex-col gap-1 text-sm text-fg-muted">
          <li>
            <b>{t("setupPage.failing")}</b>: the last runs all failed. <b>{t("setupPage.atRisk")}</b>: the last backup is older than the hours the job may lose. <b>{t("setupPage.late")}</b>: older than one and a half times how often it should run.
          </li>
          <li>
            <b>{t("setupPage.untested")}</b>{t("setupPage.noRestoreHasBeenTested")}
          </li>
          <li>/metrics has each job's state and last success for Prometheus, to alert on.</li>
        </ul>
      </Panel>
    </>
  );
}

/** The first screen, until the first job exists. The summary is polled, so it gives way by itself. */
function WelcomePage() {
  const t = useT();
  return (
    <>
      <PageHeader title={t("welcomePage.getStarted")} description={t("welcomePage.defineAJobOrLet")} actions={<StatusBadge tone="info">{t("welcomePage.waitingForTheFirstJob")}</StatusBadge>} />
      <SetupPage />
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdminOfThis")}</EmptyState>;
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
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
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
    { id: "jobs", label: msg("product.jobs"), icon: DatabaseBackup, count: summary?.jobs },
  ];
  const footerNav = [
    { id: "setup", label: msg("product.setup"), icon: Settings2 },
    { id: "settings", label: msg("product.settings"), icon: SlidersHorizontal },
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
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
