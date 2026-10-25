// What the search window (Cmd+K) finds in Backups: jobs by name, source, location, owner or tag. They are read whole
// and filtered here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { DatabaseBackup } from "lucide-react";
import type { Job } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const found = await call<{ jobs: Job[] }>("/api/v1/jobs?limit=500", { signal });
    return found.jobs
      .filter((j) => [j.name, j.source, j.location, j.owner, ...j.tags].some((x) => x.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((j): SearchResult => ({
        id: `job:${j.id}`,
        label: j.name,
        detail: `${j.source} · ${j.reason}`,
        kind: t("search.job"),
        icon: DatabaseBackup,
        severity: j.state === "healthy" ? undefined : "high",
        href: `/jobs/${encodeURIComponent(j.id)}`,
      }));
  };
}
