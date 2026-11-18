// Runs every example the docs site shows (examples/*), so the docs cannot drift from working code.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Express } from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";

// The built package is loaded at runtime (like dist-import.test.ts): typecheck runs before the build.
const expressPkg = "@bug-free-eureka/express";
const { REDIS_HIT_SCRIPT, REDIS_RESET_SCRIPT } = (await import(/* @vite-ignore */ expressPkg)) as {
  REDIS_HIT_SCRIPT: string;
  REDIS_RESET_SCRIPT: string;
};
/** Opaque to this test: a store created by the example and handed back to it. */
type Store = object;

const root = fileURLToPath(new URL("../../", import.meta.url));
const bin = join(root, "packages/cli/dist/bin.js");
const temp: string[] = [];
afterAll(() => temp.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Finding {
  ruleId: string;
  status: string;
}

/** Copies examples/quickstart outside the repository, as a user would have it. */
function quickstartCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "bfe-docs-"));
  temp.push(dir);
  cpSync(join(root, "examples/quickstart"), dir, { recursive: true });
  return dir;
}

function audit(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, "audit", ...args], {
    cwd,
    encoding: "utf8",
    env: { NO_COLOR: "1" },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function statusOf(json: string, id: string): string | undefined {
  return (JSON.parse(json) as { findings: Finding[] }).findings.find((f) => f.ruleId === id)
    ?.status;
}

describe("docs/quickstart.md", () => {
  it("fails on trust proxy true, then passes with the fixed evidence", () => {
    const dir = quickstartCopy();
    const before = audit(dir, "--format", "json");
    expect(before.code).toBe(1);
    expect(statusOf(before.stdout, "BFE-006")).toBe("fail");
    expect(statusOf(before.stdout, "BFE-001")).toBe("not_assessed");

    const after = audit(dir, "--format", "json", "--config", "bug-free-eureka.fixed.json");
    expect(after.code).toBe(0);
    expect(statusOf(after.stdout, "BFE-006")).toBe("pass");

    expect(audit(dir, "--config", "bug-free-eureka.fixed.json", "--fail-on-unassessed").code).toBe(
      1,
    );
    expect(audit(dir, "--fail-on", "none").code).toBe(0);
  });

  it("writes SARIF with --output", () => {
    const dir = quickstartCopy();
    expect(audit(dir, "--format", "sarif", "--output", "results.sarif").code).toBe(1);
    const sarif = JSON.parse(readFileSync(join(dir, "results.sarif"), "utf8")) as {
      version: string;
    };
    expect(sarif.version).toBe("2.1.0");
  });

  it("init writes a config with every rule enabled and refuses to overwrite it", () => {
    const dir = mkdtempSync(join(tmpdir(), "bfe-docs-"));
    temp.push(dir);
    const init = () =>
      spawnSync(process.execPath, [bin, "init"], { cwd: dir, encoding: "utf8" }).status;
    expect(init()).toBe(0);
    expect(init()).toBe(2);
    const text = audit(dir);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("4 not assessed");
  });
});

type CreateApp = (o?: {
  trustProxy?: unknown;
  store?: Store;
  sink?: (e: unknown) => void;
}) => Express;
const load = async <T>(rel: string): Promise<T> =>
  (await import(pathToFileURL(join(root, rel)).href)) as T;

/** Minimal ioredis stand-in: ioredis's eval(script, numKeys, ...keys, ...args) signature. */
function fakeIoredis() {
  const data = new Map<string, number>();
  return {
    eval: async (script: string, numKeys: number, ...rest: string[]) => {
      const keys = rest.slice(0, numKeys);
      if (script === REDIS_HIT_SCRIPT) {
        const c = (data.get(keys[0] ?? "") ?? 0) + 1;
        data.set(keys[0] ?? "", c);
        return [c, data.get(keys[1] ?? "") ?? 0];
      }
      if (script === REDIS_RESET_SCRIPT) return keys.filter((k) => data.delete(k)).length;
      throw new Error("NOSCRIPT");
    },
  };
}

describe("docs/express.md and docs/deployment.md examples", () => {
  it("express-basic: limits /login to 5 per client and logs the route pattern", async () => {
    const { createApp } = await load<{ createApp: CreateApp }>("examples/express-basic/app.js");
    const events: Array<{ route?: string }> = [];
    const app = createApp({ sink: (e) => events.push(e as { route?: string }) });
    expect((await request(app).get("/health")).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await request(app).post("/login")).status).toBe(200);
    const blocked = await request(app).post("/login");
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    // trust proxy 1: the proxy-supplied X-Forwarded-For identifies a different client.
    expect((await request(app).post("/login").set("X-Forwarded-For", "203.0.113.7")).status).toBe(
      200,
    );
    expect(events.some((e) => e.route === "/health")).toBe(true);
  });

  it("trust proxy 1 reads the proxy's X-Forwarded-For and X-Forwarded-Proto; trust proxy false ignores them", async () => {
    const { createApp } = await load<{ createApp: CreateApp }>("examples/express-basic/app.js");
    const sink = () => {};
    const behind = await request(createApp({ sink }))
      .get("/whoami")
      .set("X-Forwarded-For", "198.51.100.1, 203.0.113.7")
      .set("X-Forwarded-Proto", "https");
    expect(behind.body).toEqual({ ip: "203.0.113.7", protocol: "https", secure: true });
    const direct = await request(createApp({ trustProxy: false, sink }))
      .get("/whoami")
      .set("X-Forwarded-For", "203.0.113.7")
      .set("X-Forwarded-Proto", "https");
    expect(direct.body.ip).not.toBe("203.0.113.7");
    expect(direct.body.secure).toBe(false);
  });

  it("express-redis: two instances share one login limit", async () => {
    const { createApp } = await load<{ createApp: CreateApp }>("examples/express-basic/app.js");
    const { createSharedStore } = await load<{ createSharedStore: (r: unknown) => Store }>(
      "examples/express-redis/store.js",
    );
    const redis = fakeIoredis();
    const sink = () => {};
    const a = createApp({ store: createSharedStore(redis), sink });
    const b = createApp({ store: createSharedStore(redis), sink });
    for (let i = 0; i < 5; i++)
      expect((await request(i % 2 ? a : b).post("/login")).status).toBe(200);
    expect((await request(a).post("/login")).status).toBe(429);
    expect((await request(b).post("/login")).status).toBe(429);
  });
});
