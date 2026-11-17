import { issuePaths } from "../engine/schemas.js";
import { compare } from "../engine/sort.js";
import { safeLocation as sharedSafeLocation } from "./shared/safe-location.js";
import type { Confidence, Evidence, Rule, RuleResult } from "../types/index.js";
import {
  requestSizeInputSchema,
  requestSizeOptionsSchema,
  type BodyDeclaration,
  type LimitValue,
  type RequestSizeInput,
  type RequestSizeOptions,
} from "./bfe-003-input.js";

// Evidence contains only fixed enums (kind, source, scope), normalized integers,
// fixed verdict phrases and a location accepted by safeLocation (shared/safe-location.ts). Route paths,
// option expressions, limitsHit text and raw source never reach the output.

const UNKNOWN_LOCATION = "unknown-location";
const MAX_ITEMIZED = 20;
/** Express and body-parser default `limit` (100kb) when the option is omitted. */
const DEFAULT_LIMIT_BYTES = 102_400;
/** Nginx `client_max_body_size` default (1m) when the directive is absent. */
const NGINX_DEFAULT_BYTES = 1_048_576;
const DEFAULT_LIMIT: LimitValue = { state: "default" };

const LEVELS: readonly Confidence[] = ["low", "medium", "high"];
function minConf(list: readonly Confidence[]): Confidence {
  let out: Confidence = "high";
  for (const c of list) if (LEVELS.indexOf(c) < LEVELS.indexOf(out)) out = c;
  return list.length === 0 ? "low" : out;
}

type Status = "pass" | "warning" | "fail" | "not_assessed";

/** Per-declaration outcome before the proxy adjustment (spec 3.1). */
interface Base {
  status: Status;
  reason: string;
  /** true for P5, P6, P9, P10, P11: the proxy adjustment in 3.2 applies. */
  adjustable: boolean;
  confidence: Confidence;
}

interface DState {
  status: Status;
  confidence: Confidence;
  reason: string;
  kind: string;
  source: string;
  scope: string;
  location: string;
}

const base = (
  status: Status,
  reason: string,
  adjustable = false,
  confidence: Confidence = "medium",
): Base => ({ status, reason, adjustable, confidence });

const notAssessedBase = (reason: string): Base => base("not_assessed", reason, false, "low");

function safeLocation(location: string): string {
  return sharedSafeLocation(location) ?? UNKNOWN_LOCATION;
}

// ---------------------------------------------------------------- per-declaration (3.1)

function judgeParser(d: BodyDeclaration, lim: LimitValue, opts: RequestSizeOptions): Base {
  const warnAt = d.scope === "route" ? opts.routeWarnBytes : opts.warnBytes;
  let out: Base;
  if (lim.state === "non-literal") {
    return notAssessedBase("limit is not a literal; value cannot be verified");
  } else if (lim.state === "unbounded") {
    out = base("fail", "limit is unbounded", true);
  } else if (lim.state === "default") {
    out = base("pass", `default limit applies (${DEFAULT_LIMIT_BYTES} bytes)`);
  } else if (lim.bytes > opts.failBytes) {
    out = base("fail", `limit ${lim.bytes} bytes is above ${opts.failBytes}`, true);
  } else if (lim.bytes > warnAt) {
    out = base("warning", `limit ${lim.bytes} bytes is above ${warnAt} for ${d.scope} scope`, true);
  } else {
    out = base("pass", `limit ${lim.bytes} bytes is within ${warnAt}`);
  }
  const pl = d.parameterLimit;
  if (d.kind === "urlencoded" && pl !== undefined && out.status === "pass") {
    if (pl.state === "non-literal") {
      return notAssessedBase("parameterLimit is not a literal; value cannot be verified");
    }
    if (pl.state === "unbounded") {
      return base("warning", "parameterLimit is unbounded (byte cap still applies)");
    }
    if (pl.state === "literal" && pl.bytes > opts.parameterWarn) {
      return base("warning", `parameterLimit ${pl.bytes} is above ${opts.parameterWarn}`);
    }
  }
  return out;
}

function countIssue(lim: LimitValue, warnAt: number): "loose" | "non-literal" | "ok" {
  if (lim.state === "non-literal") return "non-literal";
  if (lim.state === "literal") return lim.bytes > warnAt ? "loose" : "ok";
  return "loose"; // default and unbounded are both unlimited for multer counts
}

function judgeMulter(d: BodyDeclaration, opts: RequestSizeOptions): Base {
  const m = d.multer;
  if (m === undefined) return notAssessedBase("multer details missing");
  if (m.limitsObject === "non-literal") {
    return notAssessedBase("multer limits object is not a literal; values cannot be verified");
  }
  const storage = `storage ${m.storage}`;
  const fileSize = m.limitsObject === "absent" ? DEFAULT_LIMIT : (d.limit ?? DEFAULT_LIMIT);
  if (fileSize.state === "non-literal") {
    return notAssessedBase("fileSize is not a literal; value cannot be verified");
  }
  if (fileSize.state === "default" || fileSize.state === "unbounded") {
    return base("fail", `no file size cap (${storage}, limits ${m.limitsObject})`, true);
  }
  if (fileSize.bytes > opts.failBytes) {
    return base("fail", `fileSize ${fileSize.bytes} bytes is above ${opts.failBytes}`, true);
  }
  const storageWarn = m.storage === "disk" ? opts.diskUploadWarnBytes : opts.memoryUploadWarnBytes;
  if (fileSize.bytes > storageWarn) {
    return base(
      "warning",
      `fileSize ${fileSize.bytes} bytes is above ${storageWarn} (${storage})`,
      true,
    );
  }
  const issues = [
    countIssue(m.files, opts.filesWarn),
    countIssue(m.fields, opts.fieldsWarn),
    countIssue(m.parts, opts.fieldsWarn),
  ];
  if (issues.includes("loose")) {
    return base("warning", "files, fields or parts are unbounded or high");
  }
  if (issues.includes("non-literal")) {
    return notAssessedBase("a files, fields or parts limit is not a literal");
  }
  return base("pass", `fileSize ${fileSize.bytes} bytes with bounded counts (${storage})`);
}

function judgeDeclaration(d: BodyDeclaration, opts: RequestSizeOptions): Base {
  if (d.scope === "conditional" || d.scope === "unresolved") {
    return notAssessedBase(
      "declared inside a condition or an unresolved module; production behavior unknown",
    );
  }
  if (d.kind === "custom-reader") {
    return d.byteCounted === true
      ? notAssessedBase("stream handler with a byte counter; the bound cannot be verified")
      : base("warning", "request stream read directly; no size bound observed", false, "low");
  }
  if (d.kind === "multer") return judgeMulter(d, opts);
  return judgeParser(d, d.limit ?? DEFAULT_LIMIT, opts);
}

// ---------------------------------------------------------------- proxy adjustment (3.2)

type ProxyView =
  | { kind: "none" }
  | { kind: "unseen"; why: "declared-not-supplied" | "not-declared" }
  | { kind: "incomplete" }
  | { kind: "loose"; why: string }
  | { kind: "bounded"; cap: number; declared: boolean };

function declaredView(lim: LimitValue, failBytes: number): ProxyView {
  if (lim.state === "literal") {
    return lim.bytes <= failBytes
      ? { kind: "bounded", cap: lim.bytes, declared: true }
      : { kind: "loose", why: `declared proxy cap ${lim.bytes} bytes is above ${failBytes}` };
  }
  if (lim.state === "unbounded") {
    return { kind: "loose", why: "declared proxy cap is unbounded" };
  }
  return { kind: "incomplete" };
}

function nginxView(
  nginx: NonNullable<RequestSizeInput["proxy"]["nginx"]>,
  fail: number,
): ProxyView {
  const entries = nginx.clientMaxBodySize;
  if (!nginx.configComplete || entries.some((e) => e.value.state === "non-literal")) {
    return { kind: "incomplete" };
  }
  const reach = (e: (typeof entries)[number]): number =>
    e.value.state === "literal" ? e.value.bytes : Infinity;
  const wide = entries.filter((e) => e.scope !== "location").map(reach);
  const locations = entries.filter((e) => e.scope === "location" && reach(e) > fail);
  const wideCap = wide.length === 0 ? NGINX_DEFAULT_BYTES : Math.max(...wide);
  if (wideCap > fail) {
    return { kind: "loose", why: "supplied nginx cap is unlimited or above the fail threshold" };
  }
  if (locations.length > 0) {
    const count = locations.reduce((n, e) => n + e.locationCount, 0);
    return {
      kind: "loose",
      why: `${locations.length} nginx location entries covering ${count} locations are unlimited or above the fail threshold`,
    };
  }
  return { kind: "bounded", cap: wideCap, declared: false };
}

function proxyView(input: RequestSizeInput, failBytes: number): ProxyView {
  const { proxy } = input;
  if (proxy.present === "no") return { kind: "none" };
  if (proxy.present === "unknown") return { kind: "unseen", why: "not-declared" };
  if (proxy.declaredLimit !== undefined) return declaredView(proxy.declaredLimit, failBytes);
  if (proxy.nginx === undefined) return { kind: "unseen", why: "declared-not-supplied" };
  return nginxView(proxy.nginx, failBytes);
}

function adjust(
  b: Base,
  view: ProxyView,
  reachable: string,
): Omit<DState, "kind" | "source" | "scope" | "location"> {
  if (!b.adjustable) return { status: b.status, confidence: b.confidence, reason: b.reason };
  const keep = (reason: string): ReturnType<typeof adjust> => ({
    status: b.status,
    confidence: "medium",
    reason: `${b.reason}; ${reason}`,
  });
  switch (view.kind) {
    case "none":
      return keep("no proxy declared");
    case "loose":
      return keep(view.why);
    case "incomplete":
      return {
        status: "not_assessed",
        confidence: "low",
        reason: `${b.reason}; proxy body-size configuration is incomplete or not a literal`,
      };
    case "unseen":
      return {
        status: "warning",
        confidence: "low",
        reason:
          view.why === "declared-not-supplied"
            ? `${b.reason}; a proxy is declared and its body-size config was not supplied (supply the config or declare the cap)`
            : `${b.reason}; a proxy or gateway not described to this tool may cap request size`,
      };
    case "bounded":
      return {
        status: "warning",
        confidence: reachable === "no" ? (view.declared ? "high" : "medium") : "low",
        reason:
          reachable === "no"
            ? `${b.reason}; proxy caps bodies at ${view.cap} bytes (assumes clients cannot reach the app directly)`
            : `${b.reason}; proxy caps bodies at ${view.cap} bytes but can be bypassed or reachability is not declared`,
      };
  }
}

// ---------------------------------------------------------------- text and aggregation

const STATUS_ORDER: Readonly<Record<Status, number>> = {
  fail: 0,
  warning: 1,
  not_assessed: 2,
  pass: 3,
};

function declarationEvidence(s: DState): Evidence {
  return {
    source: "source",
    detail: `${s.kind} (${s.source}, ${s.scope}): ${s.status} (${s.confidence}) - ${s.reason}`,
    location: s.location,
  };
}

function compareEvidence(a: Evidence, b: Evidence): number {
  return (
    compare(a.source, b.source) ||
    compare(a.location ?? "", b.location ?? "") ||
    compare(a.detail, b.detail)
  );
}

function notAssessed(evidence: Evidence[], remediation: string): RuleResult {
  return {
    status: "not_assessed",
    confidence: "low",
    evidence: evidence.sort(compareEvidence),
    remediation,
  };
}

function buildRemediation(status: Status, proxyPresent: boolean): string {
  if (status === "pass") {
    return "No change needed for the checked declarations: body-reading declarations were observed with limits within the default thresholds in the supplied evidence. This is not a guarantee about the application. Re-run the audit after changing parsers, uploads or proxy configuration.";
  }
  const lines = [
    "Choose a body-size cap per content type and enforce it at the earliest layer you control (proxy or gateway), and again in the application. Start small (for example 100 KiB for JSON APIs) and raise it only on the routes that need more. Bound counts as well as bytes (urlencoded parameters, multipart fields, files, parts). Reject oversized requests with HTTP 413. For large uploads, stream to disk or object storage with a per-request byte counter. If a proxy or gateway already enforces the cap, declare it in the deployment block (cap in bytes, and whether clients can reach the app directly) or supply its config, so the next scan can see it.",
  ];
  if (proxyPresent) {
    lines.push(
      "Nginx: set client_max_body_size explicitly in http or server scope (default 1m); 0 disables the check. Raise it per location, not globally.",
    );
  }
  lines.push(
    'Express: app.use(express.json({ limit: "100kb" })); app.use(express.urlencoded({ extended: false, limit: "100kb", parameterLimit: 1000 })); raise limits per route and mount that parser before any global parser for the same content type. multer: set limits { fileSize, files, fields, parts } because they default to unlimited. Map parser errors to 413.',
  );
  return lines.join("\n");
}

export function evaluateRequestSize(raw: unknown): RuleResult {
  const parsed = requestSizeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return notAssessed(
      [{ source: "input", detail: `input invalid: ${issuePaths(parsed.error)}` }],
      "Provide input matching the RequestSizeInput schema (see docs/rules/BFE-003.md section 2.1).",
    );
  }
  const input = parsed.data;
  const opts = input.options ?? requestSizeOptionsSchema.parse({});
  const view = proxyView(input, opts.failBytes);

  const states: DState[] = input.declarations.map((d) => ({
    ...adjust(judgeDeclaration(d, opts), view, input.proxy.appReachableDirectly),
    kind: d.kind,
    source: d.source,
    scope: d.scope,
    location: safeLocation(d.location),
  }));
  states.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      compare(a.location, b.location) ||
      compare(declarationEvidence(a).detail, declarationEvidence(b).detail),
  );

  const resolved = input.declarations.filter(
    (d) => d.scope === "global" || d.scope === "route",
  ).length;
  const missing: string[] = [];
  if (!input.app.expressAppFound) missing.push("no Express app was resolved");
  if (input.app.legacyBodyParser) {
    missing.push("legacy express.bodyParser() is not modeled (unsupported Express)");
  }
  if (input.coverage.unresolvedMiddleware && resolved === 0) {
    missing.push("middleware is built dynamically or has unresolved aliases");
  }
  if (!input.coverage.complete && resolved === 0) {
    const n = input.coverage.limitsHit.length;
    missing.push(
      `scan coverage incomplete; not seen is not absent (${n} limit${n === 1 ? "" : "s"} hit)`,
    );
  }
  if (missing.length > 0) {
    return notAssessed(
      missing.map((detail) => ({ source: "input", detail })),
      "Point the audit at an Express project, resolve the scan limits and unresolved middleware, or declare the deployment block. Non-Express frameworks and Express before 4.16 are not assessed by this rule.",
    );
  }

  const count = (st: Status): DState[] => states.filter((s) => s.status === st);
  const fails = count("fail");
  const warnings = count("warning");
  const unresolved = count("not_assessed");
  const passes = count("pass");
  const gap =
    unresolved.length > 0 || !input.coverage.complete || input.coverage.unresolvedMiddleware;

  const evidence: Evidence[] = states.slice(0, MAX_ITEMIZED).map(declarationEvidence);
  if (states.length > MAX_ITEMIZED) {
    evidence.push({
      source: "input",
      detail: `and ${states.length - MAX_ITEMIZED} more declarations`,
    });
  }
  const { proxy, app } = input;
  evidence.push({
    source: "input",
    detail: `context: express.major=${app.expressMajor}, declarations=${states.length}, proxy.present=${proxy.present}, proxy.bodyLimitConfig=${proxy.bodyLimitConfig}, proxy.appReachableDirectly=${proxy.appReachableDirectly}, limits.hit=${input.coverage.limitsHit.length}`,
  });
  if (gap && (fails.length > 0 || warnings.length > 0)) {
    evidence.push({
      source: "input",
      detail: `result is incomplete: ${unresolved.length} unresolved declarations, coverage complete=${input.coverage.complete}, unresolved middleware=${input.coverage.unresolvedMiddleware}`,
    });
  }

  let status: Status;
  let confidence: Confidence;
  if (fails.length > 0) {
    status = "fail";
    confidence = minConf([...fails.map((s) => s.confidence), "medium"]);
  } else if (warnings.length > 0) {
    status = "warning";
    confidence = minConf(warnings.map((s) => s.confidence));
  } else if (gap) {
    status = "not_assessed";
    confidence = "low";
    evidence.push({
      source: "input",
      detail: `${unresolved.length} declarations could not be assessed, or scan coverage is incomplete; not seen is not absent`,
    });
  } else if (passes.length > 0) {
    status = "pass";
    confidence = minConf(passes.map((s) => s.confidence));
    evidence.push({
      source: "input",
      detail:
        "body-reading declarations were observed with limits within the default thresholds in the supplied evidence",
    });
  } else {
    status = "pass";
    confidence = "low";
    evidence.push({
      source: "input",
      detail:
        "no body parser, upload handler or stream reader observed; nothing to limit in the analyzed code",
    });
  }

  return {
    status,
    confidence,
    evidence: evidence.sort(compareEvidence),
    remediation: buildRemediation(status, proxy.present !== "no"),
  };
}

export const bfe003: Rule<unknown> = {
  id: "BFE-003",
  version: "1.0.0",
  title: "Missing request-size limit",
  description:
    "Checks that request-body readers (body parsers, multer, raw stream readers) have bounded size limits in the supplied evidence. A pass does not mean the application is secure or resistant to denial of service.",
  defaultSeverity: "medium",
  references: [
    "https://expressjs.com/en/resources/middleware/body-parser.html",
    "https://expressjs.com/en/resources/middleware/multer.html",
    "https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html",
    "https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption",
  ],
  evaluate: (ctx) => evaluateRequestSize(ctx.input),
};
