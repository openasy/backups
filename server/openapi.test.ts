import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, ago, HOUR, INGEST_TOKEN, run, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "backups-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared ? `openapi#/components/responses/${shared}` : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({ headers: { authorization: `Bearer ${token}`, "content-type": type }, ...(body !== undefined && { body }) });
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // backups's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let id = "";
  const report = (b = run("db-nightly", 2 * HOUR, { snapshotId: "s1", sizeBytes: 1000 }), token = INGEST_TOKEN) => auth(token, b);
  const test = (o: Record<string, unknown> = {}) => admin({ job: "db-nightly", testedAt: ago(HOUR), ok: true, durationSeconds: 60, verifiedBy: "automated", ...o });

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("jobs: define, change, list", async () => {
    const created = (await call("POST", "/api/v1/jobs", admin({ name: "db-nightly", tool: "restic", cadenceHours: 24, rpoHours: 48, tags: ["prod"] }))).body as { id: string };
    id = created.id;
    await call("POST", "/api/v1/jobs", admin({ name: "db-nightly", cadenceHours: 24, rpoHours: 48 }));
    await call("POST", "/api/v1/jobs", admin({ name: "x", cadenceHours: 24, rpoHours: 1 }));
    await call("POST", "/api/v1/jobs", admin("nope"));
    await call("POST", "/api/v1/jobs", {});
    await call("GET", "/api/v1/jobs", admin());
    await call("GET", "/api/v1/jobs", admin(), "/api/v1/jobs?state=unknown&limit=1");
    await call("GET", "/api/v1/jobs", admin(), "/api/v1/jobs?state=great");
    await call("GET", "/api/v1/jobs", {});
    await call("GET", "/api/v1/jobs/{id}", admin(), `/api/v1/jobs/${id}`);
    await call("GET", "/api/v1/jobs/{id}", admin(), "/api/v1/jobs/missing");
    await call("PATCH", "/api/v1/jobs/{id}", admin({ owner: "platform" }), `/api/v1/jobs/${id}`);
    await call("PATCH", "/api/v1/jobs/{id}", admin({ name: "other" }), `/api/v1/jobs/${id}`);
    await call("PATCH", "/api/v1/jobs/{id}", admin("nope"), `/api/v1/jobs/${id}`);
    await call("PATCH", "/api/v1/jobs/{id}", admin({ owner: "x" }), "/api/v1/jobs/missing");
    await call("PATCH", "/api/v1/jobs/{id}", { method: "PATCH" }, `/api/v1/jobs/${id}`);
  });

  it("reports and restore tests, and every refusal", async () => {
    await call("POST", "/api/v1/runs", report());
    await call("POST", "/api/v1/runs", report());
    await call("POST", "/api/v1/runs", report(run("db-nightly", HOUR, { status: "failed", error: "locked" })));
    await call("POST", "/api/v1/runs", report(run("nobody", HOUR)));
    await call("POST", "/api/v1/runs", report("{nope"));
    await call("POST", "/api/v1/runs", report(run("db-nightly", HOUR, { status: "ok" })));
    await call("POST", "/api/v1/runs", report(run("db-nightly", HOUR), "wrong"));
    await call("POST", "/api/v1/runs", { method: "POST" });
    await call("POST", "/api/v1/restore-tests", test());
    await call("POST", "/api/v1/restore-tests", test({ job: "nobody" }));
    await call("POST", "/api/v1/restore-tests", test({ ok: "yes" }));
    await call("POST", "/api/v1/restore-tests", admin("nope"));
    await call("POST", "/api/v1/restore-tests", { method: "POST" });
    await call("GET", "/api/v1/jobs/{id}/runs", admin(), `/api/v1/jobs/${id}/runs`);
    await call("GET", "/api/v1/jobs/{id}/runs", admin(), `/api/v1/jobs/${id}/runs?limit=1`);
    await call("GET", "/api/v1/jobs/{id}/runs", admin(), "/api/v1/jobs/missing/runs");
    await call("GET", "/api/v1/jobs/{id}/runs", admin(), `/api/v1/jobs/${id}/runs?cursor=junk`);
    await call("GET", "/api/v1/jobs/{id}/runs", {}, `/api/v1/jobs/${id}/runs`);
    await call("GET", "/api/v1/jobs/{id}/restore-tests", admin(), `/api/v1/jobs/${id}/restore-tests`);
    await call("GET", "/api/v1/jobs/{id}/restore-tests", admin(), "/api/v1/jobs/missing/restore-tests");
    await call("GET", "/api/v1/jobs/{id}/restore-tests", {}, `/api/v1/jobs/${id}/restore-tests`);
    const { body } = await call("GET", "/api/v1/jobs/{id}", admin(), `/api/v1/jobs/${id}`);
    // One failed run after a good one is not yet failing.
    expect((body as { state: string }).state).toBe("healthy");
  });

  it("settings and overview", async () => {
    await call("GET", "/api/v1/settings", admin());
    await call("GET", "/api/v1/settings", {});
    await call("PUT", "/api/v1/settings", admin({ autoCreate: true, restoreStaleDays: 14 }));
    await call("PUT", "/api/v1/settings", admin({ failingRuns: 99 }));
    await call("PUT", "/api/v1/settings", admin("nope"));
    await call("PUT", "/api/v1/settings", { method: "PUT" });
    await call("POST", "/api/v1/runs", report(run("created-by-report", HOUR, { tool: "velero" })));
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
  });

  it("deletes a job", async () => {
    await call("DELETE", "/api/v1/jobs/{id}", admin(), `/api/v1/jobs/${id}`);
    await call("DELETE", "/api/v1/jobs/{id}", admin(), `/api/v1/jobs/${id}`);
    await call("DELETE", "/api/v1/jobs/{id}", { method: "DELETE" }, "/api/v1/jobs/x");
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
