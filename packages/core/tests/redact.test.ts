import { describe, expect, it } from "vitest";
import { isSensitiveKey, MASK, redact, redactHeaders } from "../src/index.js";

// redaction-check skill canaries
const C = {
  token: "BFE_CANARY_TOKEN_7f3a91",
  pass: "BFE_CANARY_PASS_c02e44",
  cookie: "BFE_CANARY_COOKIE_9b11d5",
  otp: "BFE_CANARY_OTP_448120",
  refresh: "BFE_CANARY_REFRESH_e5d7c2",
  env: "BFE_CANARY_ENV_a1b2c3",
};
const LEAK = /BFE_CANARY_[A-Z]+_[0-9a-f]{6}/;

const out = (v: unknown, opts?: Parameters<typeof redact>[1]): string =>
  JSON.stringify(redact(v, opts));

describe("redact: canaries never survive", () => {
  it("request-shaped object: headers, cookies, body, nested and arrays", () => {
    const req = {
      headers: {
        Authorization: `Bearer ${C.token}`,
        "proxy-authorization": `Basic ${C.token}`,
        cookie: `sid=${C.cookie}; theme=dark`,
        "X-API-KEY": C.env,
        "user-agent": "curl/8",
      },
      body: {
        PassWord: C.pass,
        user: { profile: { settings: { auth: { credentials: { password: C.pass } } } } },
        otp: C.otp,
        mfa_code: C.otp,
        tokens: [{ refreshToken: C.refresh }, { refresh_token: C.refresh }],
        note: `{"password":"${C.pass}"}`,
      },
      query: { access_token: C.token, page: "2" },
    };
    const s = out(req);
    expect(s).not.toMatch(LEAK);
    expect(s).toContain("curl/8");
    expect(s).toContain('"page":"2"');
    expect(s).toContain(MASK);
  });

  it("response Set-Cookie arrays and env-like config", () => {
    expect(out({ "set-cookie": [`a=${C.cookie}`, `b=${C.cookie}`] })).not.toMatch(LEAK);
    expect(out({ DB_PASSWORD: C.env, API_KEY: C.env, NODE_ENV: "production" })).not.toMatch(LEAK);
  });

  it("secrets inside free text values and keys", () => {
    const s = out({
      message: `login failed Authorization: Bearer ${C.token} password=${C.pass}`,
      [`token=${C.token}`]: "x",
      nested: `{\\"refreshToken\\":\\"${C.refresh}\\"}`,
    });
    expect(s).not.toMatch(LEAK);
  });

  it("errors: message, stack and own properties", () => {
    const err = new Error(`bad password=${C.pass} cookie: sid=${C.cookie}`) as Error & {
      config?: unknown;
    };
    err.config = { headers: { authorization: `Bearer ${C.token}` } };
    const s = out({ err });
    expect(s).not.toMatch(LEAK);
    expect(s).toContain('"name":"Error"');
  });

  it("Map, Set, Date, bigint, symbol and function values", () => {
    const s = out({
      m: new Map<unknown, unknown>([
        ["otp", C.otp],
        ["safe", `token=${C.token}`],
        [1, "one"],
      ]),
      s: new Set([`password=${C.pass}`]),
      d: new Date(0),
      bad: new Date(Number.NaN),
      n: 10n,
      f: () => C.token,
      sym: Symbol("x"),
    });
    expect(s).not.toMatch(LEAK);
    expect(s).toContain("1970-01-01T00:00:00.000Z");
    expect(s).toContain("Invalid Date");
    expect(s).toContain("[function]");
  });
});

describe("redact: bounded and non-throwing", () => {
  it("circular objects", () => {
    const a: Record<string, unknown> = { password: C.pass };
    a.self = a;
    expect(out(a)).toContain("[Circular]");
    expect(out(a)).not.toMatch(LEAK);
  });

  it("deep nesting and node limits", () => {
    let deep: Record<string, unknown> = { password: C.pass };
    for (let i = 0; i < 5000; i++) deep = { next: deep };
    expect(out(deep)).toContain("[MaxDepth]");
    const wide = Array.from({ length: 5000 }, () => ({ v: 1 }));
    expect(out(wide, { maxNodes: 10 })).toContain("[Truncated]");
  });

  it("getters are not invoked and hostile proxies do not throw", () => {
    const obj = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error(C.token);
      },
    });
    expect(out(obj)).toContain("[Getter]");
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(C.token);
        },
      },
    );
    expect(redact(hostile)).toBe("[Unredactable]");
  });

  it("huge strings are capped", () => {
    const big = `${"a".repeat(20_000)} password=${C.pass}`;
    expect(out(big)).not.toMatch(LEAK);
  });

  it("does not mutate input and passes primitives through", () => {
    const input = { password: C.pass };
    redact(input);
    expect(input.password).toBe(C.pass);
    expect(redact(null)).toBeNull();
    expect(redact(5)).toBe(5);
    expect(redact(undefined)).toBeUndefined();
  });
});

describe("isSensitiveKey and redactHeaders", () => {
  it.each([
    "Authorization",
    "X-API-KEY",
    "set-cookie",
    "refresh_token",
    "OTP",
    "client_secret",
    "DB_PASSWORD",
  ])("%s is sensitive", (k) => expect(isSensitiveKey(k)).toBe(true));
  it.each(["footprint", "user-agent", "page", "content-type"])("%s is not", (k) =>
    expect(isSensitiveKey(k)).toBe(false),
  );
  it("extra keys", () => {
    expect(isSensitiveKey("X-Tenant-Key", ["x_tenant_key"])).toBe(true);
    expect(out({ "x-tenant-key": C.env }, { extraKeys: ["X-Tenant-Key"] })).not.toMatch(LEAK);
  });
  it("lower-cases names and masks values", () => {
    const h = redactHeaders({ Cookie: C.cookie, Accept: "json" });
    expect(h).toEqual({ cookie: MASK, accept: "json" });
  });
});
