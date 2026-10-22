// Starts the app on a random port for tests, with a clock the test moves.
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.ts";
import { createBackups } from "./backups.ts";
import { openDb } from "./db.ts";

export const INGEST_TOKEN = "test-ingest-token";
export const ADMIN_TOKEN = "test-admin-token";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** 22 October 2026, 12:00 UTC. */
export const START = Date.UTC(2026, 9, 22, 12, 0, 0);

export const ago = (ms: number, from = START) => new Date(from - ms).toISOString();

/** A run in our own report format, ended `endedAgo` ms before the test's clock. */
export function run(job: string, endedAgo: number, extra: Record<string, unknown> = {}, from = START) {
  return JSON.stringify({ job, startedAt: ago(endedAgo + 10 * 60_000, from), endedAt: ago(endedAgo, from), status: "success", ...extra });
}

export async function startApp(opts: Partial<AppOptions> & { version: string }) {
  const db = openDb(":memory:");
  const clock = { now: START };
  const backups = createBackups(db, { now: () => clock.now });
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "backups", productName: "OpenAsy Backups", origin: base });
  handler = createApp({ db, backups, auth, ingestToken: INGEST_TOKEN, adminToken: ADMIN_TOKEN, ...opts });
  const as = (token: string) => (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const ingest = as(INGEST_TOKEN);
  const report = (query: Record<string, string>, body: string) => ingest(`/api/v1/runs?${new URLSearchParams(query)}`, { method: "POST", body });
  const post = (path: string, body: unknown) => admin(path, { method: "POST", body: JSON.stringify(body) });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, backups, auth, base, admin, ingest, report, post, clock, close };
}
