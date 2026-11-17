import { issuePaths } from "../engine/schemas.js";
import { compare } from "../engine/sort.js";
import type { Confidence, Evidence, Rule, RuleResult } from "../types/index.js";
import {
  sensitiveLoggingInputSchema,
  type LoggerDeclaration,
  type SensitiveLoggingInput,
} from "./bfe-005-input.js";
import { safeLocation } from "./shared/safe-location.js";

// Evidence is built only from fixed phrases, enum values, counts and a
// validated "file:line" location. Redact paths and location text are never
// echoed (docs/rules/BFE-005.md section 2.3).

type Status = RuleResult["status"];

const UNKNOWN_LOCATION = "unknown-location";
const MAX_EVIDENCE = 20;
const RANK: Readonly<Record<Status, number>> = { pass: 0, not_assessed: 1, warning: 2, fail: 3 };
const CONF_RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };

interface Category {
  readonly label: string;
  readonly keys: readonly string[];
}

const REQUEST_HEADERS: readonly Category[] = [
  { label: "Authorization header", keys: ["authorization"] },
  { label: "Proxy-Authorization header", keys: ["proxy-authorization"] },
  { label: "Cookie header", keys: ["cookie"] },
  { label: "API key header", keys: ["x-api-key"] },
];
const RESPONSE_HEADERS: readonly Category[] = [
  { label: "Set-Cookie header", keys: ["set-cookie"] },
];
const BODY_FIELDS: readonly Category[] = [
  { label: "password field", keys: ["password", "passwd", "pwd"] },
  { label: "OTP field", keys: ["otp", "totp", "code", "mfaCode", "mfa_code"] },
  { label: "refresh token field", keys: ["refreshToken", "refresh_token"] },
  {
    label: "access token field",
    keys: ["accessToken", "access_token", "token", "idToken", "id_token"],
  },
];

/**
 * Parses a Pino-style redact path (`req.headers["set-cookie"]`, `*.password`,
 * `a[*].b`) into segments. Hand-written, linear, no regex. Returns undefined
 * for anything it cannot parse, which then counts as covering nothing.
 */
export function parseRedactPath(path: string): string[] | undefined {
  const segments: string[] = [];
  let i = 0;
  let current = "";
  const flush = (): boolean => {
    if (current === "") return false;
    segments.push(current);
    current = "";
    return true;
  };
  while (i < path.length) {
    const ch = path[i] as string;
    if (ch === ".") {
      if (!flush()) return undefined;
      i += 1;
      // A dot must be followed by a plain segment: rejects "a." and "a.[b]".
      if (i >= path.length || path[i] === "." || path[i] === "[") return undefined;
    } else if (ch === "[") {
      if (current !== "" && !flush()) return undefined;
      const quote = path[i + 1];
      if (quote === '"' || quote === "'") {
        const end = path.indexOf(quote, i + 2);
        if (end < 0 || path[end + 1] !== "]") return undefined;
        segments.push(path.slice(i + 2, end));
        i = end + 2;
      } else {
        const end = path.indexOf("]", i + 1);
        if (end < 0) return undefined;
        const inner = path.slice(i + 1, end);
        if (inner === "") return undefined;
        segments.push(inner);
        i = end + 1;
      }
      if (i < path.length && path[i] === ".") i += 1;
      else if (i < path.length && path[i] !== "[") return undefined;
    } else {
      current += ch;
      i += 1;
    }
  }
  if (current !== "") segments.push(current);
  return segments.length > 0 ? segments : undefined;
}

type Side = "request" | "response";

/** A path that names the other side (`res...` for a request part) never covers it. */
function onSide(segments: readonly string[], side: Side): boolean {
  const other = side === "request" ? ["res", "response"] : ["req", "request"];
  return !segments.some((s) => other.includes(s));
}

/**
 * Path ends in `<container>.<key>`. Key match is exact (Pino is case-sensitive).
 * A `*` in the container position only counts below the root (`req.*.cookie`),
 * because Pino wildcards match exactly one level: `*.cookie` never reaches
 * `req.headers.cookie`.
 */
function endsWith(segments: readonly string[], container: string, key: string): boolean {
  const n = segments.length;
  if (n < 2 || segments[n - 1] !== key) return false;
  const prev = segments[n - 2];
  return prev === container || (prev === "*" && n >= 3);
}

class Coverage {
  private readonly parsed: readonly (readonly string[])[];
  constructor(paths: readonly string[]) {
    this.parsed = paths.map(parseRedactPath).filter((p): p is string[] => p !== undefined);
  }
  /** Whole container removed, e.g. `req.headers` or `req.body`. */
  whole(container: string, side: Side): boolean {
    return this.parsed.some((p) => {
      const n = p.length;
      const last = p[n - 1];
      return onSide(p, side) && (last === container || (last === "*" && p[n - 2] === container));
    });
  }
  key(container: string, key: string, side: Side): boolean {
    return this.parsed.some((p) => onSide(p, side) && endsWith(p, container, key));
  }
  category(container: string, cat: Category, side: Side): boolean {
    if (this.whole(container, side)) return true;
    return cat.keys.every((k) => this.key(container, k, side));
  }
}

interface Outcome {
  status: Status;
  confidence: Confidence;
  exposed: string[];
  reasons: string[];
}

const worst = (a: Status, b: Status): Status => (RANK[b] > RANK[a] ? b : a);

/** Decides one logger (spec section 3). */
export function decideLogger(logger: LoggerDeclaration): Outcome {
  const { emits, redaction } = logger;
  const parts = [emits.requestHeaders, emits.responseHeaders, emits.requestBody, emits.query];
  if (parts.every((p) => p === "no")) {
    return { status: "pass", confidence: "high", exposed: [], reasons: ["writes no request data"] };
  }
  if (redaction.state === "unresolved") {
    return {
      status: "not_assessed",
      confidence: "low",
      exposed: [],
      reasons: ["redaction is configured but cannot be read statically"],
    };
  }
  const cov = new Coverage(redaction.state === "paths" ? redaction.paths : []);
  let status: Status = "pass";
  const exposed: string[] = [];
  const reasons: string[] = [];

  const headerPart = (
    state: "yes" | "no" | "unknown",
    cats: readonly Category[],
    side: Side,
    what: string,
  ): void => {
    if (state === "no") return;
    const open = cats.filter((c) => !c.keys.every((k) => cov.key("headers", k, side)));
    if (cov.whole("headers", side) || open.length === 0) return;
    if (state === "yes") {
      status = worst(status, "fail");
      exposed.push(...open.map((c) => c.label));
    } else {
      status = worst(status, "not_assessed");
      reasons.push(`unknown whether ${what} are written`);
    }
  };
  headerPart(emits.requestHeaders, REQUEST_HEADERS, "request", "request headers");
  headerPart(emits.responseHeaders, RESPONSE_HEADERS, "response", "response headers");

  if (emits.requestBody !== "no" && !cov.whole("body", "request")) {
    const open = BODY_FIELDS.filter((c) => !cov.category("body", c, "request"));
    if (emits.requestBody === "unknown") {
      status = worst(status, "not_assessed");
      reasons.push("unknown whether the request body is written");
    } else if (open.length > 0) {
      status = worst(status, "fail");
      exposed.push(...open.map((c) => c.label));
    } else {
      status = worst(status, "warning");
      reasons.push(
        "request body written with field-level redaction only; nested or differently cased secret fields are not covered",
      );
    }
  }

  if (emits.query !== "no" && !cov.whole("query", "request") && !cov.whole("url", "request")) {
    if (emits.query === "yes") {
      status = worst(status, "warning");
      reasons.push("query strings are written and can carry tokens or reset codes");
    } else {
      status = worst(status, "not_assessed");
      reasons.push("unknown whether query strings are written");
    }
  }

  const located = safeLocation(logger.location) !== undefined;
  const definite = logger.scope === "global" || logger.scope === "route";
  let confidence: Confidence;
  if (status === "fail") confidence = located && definite ? "high" : "medium";
  else if (status === "warning") confidence = "medium";
  else if (status === "not_assessed") confidence = "low";
  else confidence = "high";
  if (status === "fail" && !definite) reasons.push("logger may run only in some environments");
  if (status === "pass") reasons.push("every sensitive part it writes is redacted");
  return { status, confidence, exposed, reasons };
}

function sortLoggers(loggers: readonly LoggerDeclaration[]): LoggerDeclaration[] {
  return [...loggers].sort(
    (a, b) =>
      compare(a.location, b.location) || compare(a.library, b.library) || compare(a.kind, b.kind),
  );
}

function describe(logger: LoggerDeclaration, o: Outcome): string {
  const written = (
    [
      ["request headers", logger.emits.requestHeaders],
      ["response headers", logger.emits.responseHeaders],
      ["request body", logger.emits.requestBody],
      ["query", logger.emits.query],
    ] as const
  )
    .filter(([, v]) => v !== "no")
    .map(([k, v]) => (v === "yes" ? k : `${k} (unknown)`));
  const redaction =
    logger.redaction.state === "paths"
      ? `redaction: ${logger.redaction.paths.length} path(s)`
      : `redaction: ${logger.redaction.state}`;
  const bits = [
    `${logger.library} ${logger.kind} logger (${logger.scope} scope): ${o.status}`,
    `writes: ${written.length > 0 ? written.join(", ") : "nothing sensitive"}`,
    redaction,
  ];
  if (o.exposed.length > 0) bits.push(`unredacted: ${[...new Set(o.exposed)].join(", ")}`);
  bits.push(...o.reasons);
  return bits.join("; ");
}

const REMEDIATION = [
  "1. Never log raw Authorization, Proxy-Authorization, Cookie, Set-Cookie or API-key headers, passwords, OTPs, access tokens or refresh tokens.",
  "2. Prefer allow-listing: log only the fields you need (method, route, status, duration, request id) instead of whole headers or bodies.",
  "3. Pino / pino-http: set redact paths, for example",
  '   pino({ redact: { paths: ["req.headers.authorization", "req.headers.cookie", "req.headers[\\"x-api-key\\"]", "res.headers[\\"set-cookie\\"]", "req.body"], censor: "[REDACTED]" } })',
  "   Pino paths are exact and case-sensitive: redact the whole body or use custom serializers instead of listing fields.",
  "4. winston / express-winston: do not log req.body or req.headers; with express-winston set requestWhitelist to safe fields and add headerBlacklist for the headers above.",
  "5. morgan: use a format without query strings or headers, or a custom token that strips them.",
  "6. Declare the logging setup with literal values so the next scan can confirm it, and run the redaction test with canary secrets against your real logger output.",
].join("\n");

function buildRemediation(status: Status, gate?: string): string {
  if (gate === "G1") {
    return "Point the audit at an Express project. Logging in other frameworks is not assessed by this rule yet.";
  }
  if (status === "pass") {
    return "No change needed: no unredacted sensitive request data was found in the supplied logging configuration. This is not a guarantee about the application. Re-run the audit after logging changes.";
  }
  return REMEDIATION;
}

function decide(input: SensitiveLoggingInput): RuleResult {
  if (!input.app.expressAppFound) {
    return {
      status: "not_assessed",
      confidence: "low",
      evidence: [{ source: "app", detail: "no Express application found" }],
      remediation: buildRemediation("not_assessed", "G1"),
    };
  }
  const coverageEvidence: Evidence[] = input.coverage.complete
    ? []
    : [
        {
          source: "coverage",
          detail: `scan incomplete: ${input.coverage.limitsHit.length} limit(s) hit; other loggers may exist`,
        },
      ];
  if (input.loggers.length === 0) {
    const complete = input.coverage.complete;
    return {
      status: complete ? "pass" : "not_assessed",
      confidence: complete ? "medium" : "low",
      evidence: [
        { source: "logging-config", detail: "no request logging configuration found" },
        ...coverageEvidence,
      ],
      remediation: buildRemediation(complete ? "pass" : "not_assessed"),
    };
  }

  const loggers = sortLoggers(input.loggers);
  const outcomes = loggers.map(decideLogger);
  let status: Status = outcomes.reduce<Status>((acc, o) => worst(acc, o.status), "pass");
  let confidence = outcomes
    .filter((o) => o.status === status)
    .reduce<Confidence>(
      (acc, o) => (CONF_RANK[o.confidence] > CONF_RANK[acc] ? o.confidence : acc),
      "low",
    );
  if (status === "pass" && !input.coverage.complete) {
    status = "not_assessed";
    confidence = "low";
  }

  const evidence: Evidence[] = loggers.slice(0, MAX_EVIDENCE).map((logger, i) => ({
    source: "logging-config",
    location: safeLocation(logger.location) ?? UNKNOWN_LOCATION,
    detail: describe(logger, outcomes[i] as Outcome),
  }));
  if (loggers.length > MAX_EVIDENCE) {
    evidence.push({
      source: "logging-config",
      detail: `${loggers.length - MAX_EVIDENCE} more logger(s) not listed`,
    });
  }
  evidence.push(...coverageEvidence);
  return { status, confidence, evidence, remediation: buildRemediation(status) };
}

export function evaluateSensitiveLogging(raw: unknown): RuleResult {
  const parsed = sensitiveLoggingInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "not_assessed",
      confidence: "low",
      evidence: [{ source: "input", detail: `input invalid: ${issuePaths(parsed.error)}` }],
      remediation:
        "Provide input matching the SensitiveLoggingInput schema (see docs/rules/BFE-005.md section 2.1).",
    };
  }
  return decide(parsed.data);
}

export const bfe005: Rule<unknown> = {
  id: "BFE-005",
  version: "1.0.0",
  title: "Sensitive data in configured logging",
  description:
    "Checks whether configured request loggers write credentials (auth headers, cookies, passwords, OTPs, tokens) without redaction. A pass means no unredacted sensitive data was found in the supplied logging configuration, not that the application is secure.",
  defaultSeverity: "high",
  references: [
    "https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html",
    "https://cwe.mitre.org/data/definitions/532.html",
    "https://getpino.io/#/docs/redaction",
  ],
  evaluate: (ctx) => evaluateSensitiveLogging(ctx.input),
};
