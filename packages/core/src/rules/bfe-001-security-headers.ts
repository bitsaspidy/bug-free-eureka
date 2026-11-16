import { issuePaths } from "../engine/schemas.js";
import { compare } from "../engine/sort.js";
import type { Confidence, Evidence, Rule, RuleResult } from "../types/index.js";
import { securityHeadersInputSchema, type SecurityHeadersInput } from "./bfe-001-input.js";

// Evidence never contains raw header values: only allowlisted header names,
// fixed verdict phrases and normalized numbers (e.g. the HSTS max-age).

const ALLOWLIST: ReadonlySet<string> = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "x-xss-protection",
  "x-powered-by",
]);

const CSP = "content-security-policy";
const CSP_RO = "content-security-policy-report-only";
const HSTS_MIN = 31_536_000;
/** Analysis cap per value, so a huge value can never cause heavy work. */
const MAX_ANALYSIS = 65_536;

/** helmet majors whose defaults are pinned in the expansion table (spec 2.4). */
const HELMET_MAJORS: ReadonlySet<number> = new Set([8]);

const HELMET_DEFAULTS: readonly (readonly [string, string | null])[] = [
  [
    CSP,
    "default-src 'self'; script-src 'self'; frame-ancestors 'self'; object-src 'none'; upgrade-insecure-requests",
  ],
  ["strict-transport-security", "max-age=31536000; includeSubDomains"],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "SAMEORIGIN"],
  ["referrer-policy", "no-referrer"],
  ["cross-origin-opener-policy", "same-origin"],
  ["cross-origin-resource-policy", "same-origin"],
  ["x-xss-protection", "0"],
  ["x-powered-by", null], // null = removed
];

type Level = Confidence;
const LEVELS: readonly Level[] = ["low", "medium", "high"];
const rank = (c: Confidence): number => LEVELS.indexOf(c);
const lowerOf = (c: Confidence): Confidence => LEVELS[Math.max(0, rank(c) - 1)] ?? "low";
function minConf(list: readonly Confidence[]): Confidence {
  let out: Confidence = "high";
  for (const c of list) if (rank(c) < rank(out)) out = c;
  return list.length === 0 ? "low" : out;
}
const capAt = (c: Confidence, cap: Confidence): Confidence => minConf([c, cap]);

interface Obs {
  name: string;
  state: "set" | "removed";
  value: string | undefined;
  layer: "app" | "proxy" | "sample";
  scope: "global" | "route" | "unknown";
  origin: string;
  location: string | undefined;
  helmetUnknown: boolean;
}

type HStatus = "pass" | "fail" | "warning" | "not_assessed" | "skipped";

interface HState {
  id: string;
  label: string;
  status: HStatus;
  confidence: Confidence;
  reasons: string[];
  source: string;
  location: string | undefined;
  /** true when a fail/pass rests only on an edge sample. */
  edge: boolean;
}

interface Judgement {
  status: "pass" | "warning" | "fail" | "unseen";
  reasons: string[];
}

interface Env {
  input: SecurityHeadersInput;
  kind: SecurityHeadersInput["app"]["kind"];
  obs: Obs[];
  uncertain: Map<string, string>;
  disabledVia: Map<string, string>;
  edgeAuth: boolean;
  sampleAbsence: boolean;
  advisories: string[];
}

interface Spec {
  id: string;
  label: string;
  names: readonly string[];
  tier: "A" | "B";
  htmlOnly: boolean;
  apiApplies: boolean;
  judge(sets: readonly Obs[]): Judgement;
}

// ---------------------------------------------------------------- helpers

function minString(list: readonly (string | undefined)[]): string | undefined {
  let out: string | undefined;
  for (const s of list) if (s !== undefined && (out === undefined || compare(s, out) < 0)) out = s;
  return out;
}

const LOCATION_PATTERN = /^[\w./-]{1,200}:\d{1,9}$/;
const UNKNOWN_LOCATION = "unknown-location";

/** Only a plain "file:line" location is echoed; anything else is dropped. */
function safeLocation(location: string | undefined): string | undefined {
  return location !== undefined && LOCATION_PATTERN.test(location) ? location : undefined;
}

function uniqSorted(list: readonly string[]): string[] {
  return [...new Set(list)].sort(compare);
}

function parseDirectives(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of value.slice(0, MAX_ANALYSIS).split(";")) {
    const tokens = part.split(/\s+/).filter((t) => t.length > 0);
    const [name, ...rest] = tokens;
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (!out.has(key))
      out.set(
        key,
        rest.map((t) => t.toLowerCase()),
      );
  }
  return out;
}

const NEUTRALISERS = ["'nonce-", "'sha256-", "'sha384-", "'sha512-"];

function weakScriptReasons(csp: string): string[] {
  const directives = parseDirectives(csp);
  const tokens = directives.get("script-src") ?? directives.get("default-src");
  if (tokens === undefined) return ["no script-src or default-src directive"];
  const reasons: string[] = [];
  const neutralised =
    tokens.includes("'strict-dynamic'") ||
    tokens.some((t) => NEUTRALISERS.some((p) => t.startsWith(p)));
  if (tokens.includes("'unsafe-inline'") && !neutralised) {
    reasons.push("script sources allow 'unsafe-inline' without nonce, hash or strict-dynamic");
  }
  if (tokens.includes("'unsafe-eval'")) reasons.push("script sources allow 'unsafe-eval'");
  if (tokens.includes("*")) reasons.push("script sources allow a bare wildcard");
  if (tokens.includes("data:")) reasons.push("script sources allow data: URLs");
  if (tokens.includes("http:")) reasons.push("script sources allow http: URLs");
  return reasons;
}

/** "ok" frame-ancestors, "permissive" (wildcard or bare scheme), or "none" when not declared. */
function frameAncestors(csp: string): "ok" | "permissive" | "none" {
  const tokens = parseDirectives(csp).get("frame-ancestors");
  if (tokens === undefined) return "none";
  const permissive = tokens.some((t) => t === "*" || /^[a-z][a-z0-9+.-]*:$/.test(t));
  return permissive ? "permissive" : "ok";
}

const isLiteral = (o: Obs): boolean => o.value !== undefined;
const valueOf = (o: Obs): string => o.value ?? "";

function passJudgement(sets: readonly Obs[]): Judgement {
  // D3: a value that is not a literal cannot be verified, so it never counts as a pass.
  return sets.some((o) => !isLiteral(o))
    ? {
        status: "warning",
        reasons: ["present, but the value is not a literal and cannot be verified"],
      }
    : { status: "pass", reasons: ["acceptable value"] };
}

// ---------------------------------------------------------------- judges

function judgeH1(sets: readonly Obs[]): Judgement {
  const bad = sets.some((o) => isLiteral(o) && valueOf(o).trim().toLowerCase() !== "nosniff");
  return bad
    ? { status: "fail", reasons: ["value is not nosniff, so browsers ignore it"] }
    : passJudgement(sets);
}

function judgeH2(sets: readonly Obs[]): Judgement {
  const xfo = sets.filter((o) => o.name === "x-frame-options");
  const csp = sets.filter((o) => o.name === CSP && isLiteral(o));
  const cspStates = csp.map((o) => frameAncestors(valueOf(o)));
  if (cspStates.includes("permissive")) {
    return {
      status: "warning",
      reasons: ["CSP frame-ancestors is permissive (wildcard or scheme)"],
    };
  }
  if (cspStates.includes("ok")) {
    return { status: "pass", reasons: ["CSP frame-ancestors restricts framing"] };
  }
  const xfoInvalid = xfo.some(
    (o) => isLiteral(o) && !["DENY", "SAMEORIGIN"].includes(valueOf(o).trim().toUpperCase()),
  );
  if (xfoInvalid) {
    return {
      status: "fail",
      reasons: ["X-Frame-Options value is invalid or ALLOW-FROM (ignored by browsers)"],
    };
  }
  if (xfo.length > 0) return passJudgement(xfo);
  return { status: "unseen", reasons: [] };
}

function judgeH3(sets: readonly Obs[]): Judgement {
  const enforcing = sets.filter((o) => o.name === CSP);
  if (enforcing.length === 0) {
    return sets.some((o) => o.name === CSP_RO)
      ? { status: "warning", reasons: ["only Content-Security-Policy-Report-Only is set"] }
      : { status: "unseen", reasons: [] };
  }
  const weak = enforcing.flatMap((o) => (isLiteral(o) ? weakScriptReasons(valueOf(o)) : []));
  return weak.length > 0
    ? { status: "warning", reasons: uniqSorted(weak) }
    : passJudgement(enforcing);
}

function judgeH4(sets: readonly Obs[]): Judgement {
  const reasons: string[] = [];
  for (const o of sets) {
    if (!isLiteral(o)) continue;
    const part = valueOf(o)
      .slice(0, MAX_ANALYSIS)
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.toLowerCase().startsWith("max-age"));
    const raw = part?.split("=")[1]?.trim().replace(/^"|"$/g, "") ?? "";
    if (!/^\d{1,15}$/.test(raw)) {
      reasons.push("no valid max-age directive");
    } else if (Number(raw) < HSTS_MIN) {
      reasons.push(`max-age=${Number(raw)} is below ${HSTS_MIN}`);
    }
  }
  return reasons.length > 0
    ? { status: "warning", reasons: uniqSorted(reasons) }
    : passJudgement(sets);
}

const REFERRER_GOOD = new Set([
  "no-referrer",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "origin",
  "origin-when-cross-origin",
]);
const REFERRER_KNOWN = new Set([...REFERRER_GOOD, "unsafe-url", "no-referrer-when-downgrade"]);

function judgeH5(sets: readonly Obs[]): Judgement {
  let bad = false;
  for (const o of sets) {
    if (!isLiteral(o)) continue;
    const tokens = valueOf(o)
      .slice(0, MAX_ANALYSIS)
      .split(",")
      .map((t) => t.trim().toLowerCase());
    // Browsers use the last policy they recognise.
    const effective = [...tokens].reverse().find((t) => REFERRER_KNOWN.has(t));
    if (effective === undefined || !REFERRER_GOOD.has(effective)) bad = true;
  }
  return bad
    ? { status: "warning", reasons: ["policy is permissive, empty or unrecognized"] }
    : passJudgement(sets);
}

function judgeH6(sets: readonly Obs[]): Judgement {
  const bad = sets.some((o) => {
    if (!isLiteral(o)) return false;
    const v = valueOf(o).trim().toLowerCase();
    return v === "" || v === "unsafe-none";
  });
  return bad
    ? { status: "warning", reasons: ["value is empty or unsafe-none"] }
    : passJudgement(sets);
}

function judgeH7(sets: readonly Obs[]): Judgement {
  const bad = sets.some(
    (o) =>
      isLiteral(o) &&
      !["same-origin", "same-site", "cross-origin"].includes(valueOf(o).trim().toLowerCase()),
  );
  return bad
    ? { status: "warning", reasons: ["value is not same-origin, same-site or cross-origin"] }
    : passJudgement(sets);
}

function judgeH8(sets: readonly Obs[]): Judgement {
  void sets;
  return { status: "warning", reasons: ["X-Powered-By is sent"] };
}

function judgeH9(sets: readonly Obs[]): Judgement {
  const bad = sets.some((o) => isLiteral(o) && valueOf(o).trim().startsWith("1"));
  return bad
    ? { status: "warning", reasons: ["X-XSS-Protection is enabled (obsolete; send 0 or omit)"] }
    : passJudgement(sets);
}

const SPECS: readonly Spec[] = [
  {
    id: "H1",
    label: "X-Content-Type-Options",
    names: ["x-content-type-options"],
    tier: "A",
    htmlOnly: false,
    apiApplies: true,
    judge: judgeH1,
  },
  {
    id: "H2",
    label: "Framing protection (X-Frame-Options or CSP frame-ancestors)",
    names: ["x-frame-options", CSP],
    tier: "A",
    htmlOnly: true,
    apiApplies: false,
    judge: judgeH2,
  },
  {
    id: "H3",
    label: "Content-Security-Policy",
    names: [CSP, CSP_RO],
    tier: "A",
    htmlOnly: true,
    apiApplies: false,
    judge: judgeH3,
  },
  {
    id: "H4",
    label: "Strict-Transport-Security",
    names: ["strict-transport-security"],
    tier: "A",
    htmlOnly: false,
    apiApplies: true,
    judge: judgeH4,
  },
  {
    id: "H5",
    label: "Referrer-Policy",
    names: ["referrer-policy"],
    tier: "B",
    htmlOnly: false,
    apiApplies: false,
    judge: judgeH5,
  },
  {
    id: "H6",
    label: "Cross-Origin-Opener-Policy",
    names: ["cross-origin-opener-policy"],
    tier: "B",
    htmlOnly: false,
    apiApplies: false,
    judge: judgeH6,
  },
  {
    id: "H7",
    label: "Cross-Origin-Resource-Policy",
    names: ["cross-origin-resource-policy"],
    tier: "B",
    htmlOnly: false,
    apiApplies: false,
    judge: judgeH7,
  },
  {
    id: "H8",
    label: "X-Powered-By",
    names: ["x-powered-by"],
    tier: "B",
    htmlOnly: false,
    apiApplies: true,
    judge: judgeH8,
  },
  {
    id: "H9",
    label: "X-XSS-Protection",
    names: ["x-xss-protection"],
    tier: "B",
    htmlOnly: false,
    apiApplies: true,
    judge: judgeH9,
  },
];

// ---------------------------------------------------------------- environment

function helmetMajor(version: string | undefined): number | undefined {
  const m = /^[\s^~>=v]{0,5}(\d{1,4})(?:\.|$)/.exec(version ?? "");
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

function buildEnv(input: SecurityHeadersInput): Env {
  const kind = input.app.kind;
  const sample = input.sample;
  const usable = sample !== undefined && (sample.isHtml === "yes" || kind === "api");
  const edgeAuth = usable && sample.capturedAt === "edge";
  const obs: Obs[] = [];
  const uncertain = new Map<string, string>();
  const disabledVia = new Map<string, string>();
  const advisories: string[] = [];

  for (const h of input.headers) {
    const name = h.name.trim().toLowerCase();
    if (!ALLOWLIST.has(name)) continue; // unknown names are ignored, never echoed
    if (h.state === "absent") continue; // absence is inferred from what a sample lacks
    if (h.layer === "sample" && sample === undefined) continue; // no sample supplied
    obs.push({
      name,
      state: h.state,
      value: h.state === "set" ? h.value : undefined,
      layer: h.layer,
      scope: h.scope,
      origin: h.origin,
      location: safeLocation(h.location),
      helmetUnknown: false,
    });
  }

  const major = helmetMajor(input.helmet.version);
  const known = major !== undefined && HELMET_MAJORS.has(major);
  for (const mount of input.helmet.mounts) {
    const location = safeLocation(mount.location) ?? UNKNOWN_LOCATION;
    const unresolved =
      mount.scope === "conditional" ||
      mount.scope === "unresolved" ||
      mount.options === "unresolved";
    if (unresolved) {
      for (const [name] of HELMET_DEFAULTS) {
        const prev = uncertain.get(name);
        if (prev === undefined || compare(location, prev) < 0) uncertain.set(name, location);
      }
      continue;
    }
    const scope: "global" | "route" = mount.scope === "global" ? "global" : "route";
    for (const [name, def] of HELMET_DEFAULTS) {
      const opts = mount.options;
      const opt =
        opts !== "default" && opts !== "unresolved" && Object.hasOwn(opts, name)
          ? opts[name]
          : undefined;
      const state = opt?.state ?? "default";
      if (state === "disabled") {
        if (scope === "global") {
          const prev = disabledVia.get(name);
          if (prev === undefined || compare(location, prev) < 0) disabledVia.set(name, location);
        }
        continue;
      }
      const base = {
        name,
        layer: "app" as const,
        scope,
        origin: "source",
        location,
      };
      if (state === "custom") {
        obs.push({ ...base, state: "set", value: opt?.value, helmetUnknown: false });
      } else if (def === null) {
        obs.push({ ...base, state: "removed", value: undefined, helmetUnknown: !known });
      } else {
        obs.push({ ...base, state: "set", value: known ? def : undefined, helmetUnknown: !known });
      }
    }
  }

  if (input.helmet.dependency === "present" && input.helmet.mounts.length === 0) {
    advisories.push(
      "helmet is listed in package.json but no mount was observed (presence is not use)",
    );
  }

  return {
    input,
    kind,
    obs,
    uncertain,
    disabledVia,
    edgeAuth,
    sampleAbsence: usable && !edgeAuth,
    advisories,
  };
}

/** Observations that count for the given header names, after authority and removal rules. */
function relevant(env: Env, names: readonly string[]): Obs[] {
  const all = env.obs.filter((o) => names.includes(o.name));
  if (env.edgeAuth) return all.filter((o) => o.layer === "sample"); // what the browser got
  const proxyRemoved = new Set(
    all
      .filter((o) => o.state === "removed" && o.layer === "proxy" && o.scope === "global")
      .map((o) => o.name),
  );
  // D13: a header removed at the proxy layer voids what the app set for it.
  return all.filter((o) => !(o.layer === "app" && o.state === "set" && proxyRemoved.has(o.name)));
}

function obsConfidence(o: Obs, env: Env): Confidence {
  let base: Confidence;
  if (o.layer === "sample") base = env.edgeAuth ? "high" : "medium";
  else base = o.origin === "declared" ? "high" : "medium";
  const lowered = (o.state === "set" && o.value === undefined) || o.helmetUnknown;
  return lowered ? lowerOf(base) : base;
}

function describeLayer(list: readonly Obs[]): string {
  const layers = uniqSorted(list.map((o) => o.layer));
  return layers.length === 0 ? "input" : layers.join("+");
}

function state(
  spec: Pick<Spec, "id" | "label">,
  status: HStatus,
  confidence: Confidence,
  reasons: string[],
  extra: { source?: string; location?: string | undefined; edge?: boolean } = {},
): HState {
  return {
    id: spec.id,
    label: spec.label,
    status,
    confidence,
    reasons,
    source: extra.source ?? "input",
    location: extra.location,
    edge: extra.edge ?? false,
  };
}

// ---------------------------------------------------------------- per-header evaluation

function absentOutcome(
  spec: Spec,
  env: Env,
  confidence: Confidence,
  reasons: string[],
  edge: boolean,
): HState {
  const via = spec.names.map((n) => env.disabledVia.get(n)).find((l) => l !== undefined);
  const why = via === undefined ? reasons : [...reasons, "disabled via helmet option"];
  const extra = { source: edge ? "sample" : "app", location: via, edge };
  if (spec.id === "H9")
    return state(spec, "pass", confidence, [...why, "header not sent (acceptable)"], extra);
  if (spec.id === "H8")
    return state(
      spec,
      "warning",
      confidence,
      [...why, "Express sends X-Powered-By unless disabled"],
      extra,
    );
  if (spec.tier === "A") {
    const eligible = !spec.htmlOnly || env.kind === "html" || env.kind === "mixed";
    return eligible
      ? state(spec, "fail", confidence, [...why, "header not found"], extra)
      : state(
          spec,
          "warning",
          confidence,
          [...why, "header not found; app kind not declared, so not failed"],
          extra,
        );
  }
  return state(spec, "warning", confidence, [...why, "header not found"], extra);
}

function unseen(spec: Spec, env: Env): HState {
  const { input } = env;
  if (env.edgeAuth) {
    return absentOutcome(spec, env, "high", ["absent from the edge sample"], true);
  }
  const uncertainAt = spec.names.map((n) => env.uncertain.get(n)).find((l) => l !== undefined);
  if (uncertainAt !== undefined) {
    return state(
      spec,
      "not_assessed",
      "low",
      ["helmet mount is conditional or unresolved, so the header may be set in production"],
      { location: uncertainAt },
    );
  }
  if (!input.coverage.complete) {
    const n = input.coverage.limitsHit.length;
    return state(spec, "not_assessed", "low", [
      `scan coverage incomplete; not seen is not absent (${n} limit${n === 1 ? "" : "s"} hit)`,
    ]);
  }
  if (input.coverage.unresolvedMiddleware) {
    return state(spec, "not_assessed", "low", [
      "middleware is built dynamically or has unresolved aliases",
    ]);
  }
  if (!input.app.expressAppFound) {
    return state(spec, "not_assessed", "low", ["no Express app was resolved"]);
  }
  if (spec.id === "H4" && input.transport.https === "unknown") {
    return state(spec, "not_assessed", "low", ["TLS location unknown; HSTS is ignored over HTTP"]);
  }
  const proxy = input.proxy.present;
  if (
    env.sampleAbsence &&
    proxy !== "no" &&
    !(spec.id === "H4" && input.sample?.scheme !== "https")
  ) {
    return state(spec, "not_assessed", "low", [
      "header absent in a non-edge sample; a proxy or CDN may add it",
    ]);
  }
  if (env.sampleAbsence && spec.id === "H4" && input.sample?.scheme !== "https") {
    return state(spec, "not_assessed", "low", [
      "sample was not over HTTPS; HSTS is ignored over HTTP",
    ]);
  }
  if (proxy === "yes") {
    return input.proxy.headerConfig === "not_supplied"
      ? state(spec, "not_assessed", "low", [
          "a proxy is declared and its header config was not supplied",
        ])
      : absentOutcome(
          spec,
          env,
          "medium",
          ["not set by the app or by the supplied proxy header config"],
          false,
        );
  }
  if (proxy === "unknown") {
    if (spec.id === "H9") {
      return state(spec, "not_assessed", "low", [
        "proxy presence not declared; it may add the header",
      ]);
    }
    return state(spec, "warning", "low", [
      "not found in app code; a proxy or CDN not described to this tool may add it",
    ]);
  }
  return absentOutcome(
    spec,
    env,
    "medium",
    ["no proxy declared and not found in the scanned app"],
    false,
  );
}

function routeNote(sets: readonly Obs[]): string {
  const n = sets.length;
  return `set only on route-scoped or unknown-scope layers (${n} observation${n === 1 ? "" : "s"}); other routes are unseen`;
}

function evaluateHeader(spec: Spec, env: Env): HState {
  const { input } = env;
  if (spec.id === "H4") {
    if (input.transport.https === "none") {
      return state(spec, "skipped", "high", ["HTTP-only deployment declared"]);
    }
    if (env.edgeAuth && input.sample?.scheme !== "https") {
      return state(spec, "not_assessed", "low", [
        "sample was not over HTTPS; HSTS is ignored over HTTP",
      ]);
    }
  }
  if (spec.id === "H8") return evaluatePoweredBy(spec, env);

  const sets = relevant(env, spec.names).filter((o) => o.state === "set");
  const globals = sets.filter((o) => o.scope === "global");
  const others = sets.filter((o) => o.scope !== "global");
  const edgeOnly = (list: readonly Obs[]): boolean =>
    list.length > 0 && list.every((o) => o.layer === "sample") && env.edgeAuth;

  if (globals.length > 0) {
    const j = spec.judge(globals);
    if (j.status !== "unseen") {
      const conf = minConf(globals.map((o) => obsConfidence(o, env)));
      const location = minString(globals.map((o) => o.location));
      const extra = { source: describeLayer(globals), location, edge: edgeOnly(globals) };
      if (j.status === "pass") return state(spec, "pass", conf, j.reasons, extra);
      const cap = edgeOnly(globals) ? "high" : "medium";
      return state(spec, j.status, capAt(conf, cap), j.reasons, extra);
    }
  }
  if (others.length > 0 && spec.judge(others).status !== "unseen") {
    return state(spec, "warning", "medium", [routeNote(others)], {
      source: describeLayer(others),
      location: minString(others.map((o) => o.location)),
    });
  }
  return unseen(spec, env);
}

function evaluatePoweredBy(spec: Spec, env: Env): HState {
  const obs = relevant(env, spec.names);
  const sets = obs.filter((o) => o.state === "set");
  const removed = obs.filter((o) => o.state === "removed" && o.scope === "global");
  if (sets.length > 0) {
    const edge = env.edgeAuth;
    return state(spec, "warning", edge ? "high" : "medium", ["X-Powered-By is sent"], {
      source: describeLayer(sets),
      location: minString(sets.map((o) => o.location)),
      edge,
    });
  }
  if (env.edgeAuth) {
    return state(spec, "pass", "high", ["absent from the edge sample"], {
      source: "sample",
      edge: true,
    });
  }
  if (removed.length > 0) {
    const unverified = removed.some((o) => o.helmetUnknown);
    return state(
      spec,
      unverified ? "warning" : "pass",
      minConf(removed.map((o) => obsConfidence(o, env))),
      [
        unverified
          ? "helmet version unknown, so removal cannot be verified"
          : "removed (helmet, declared config or proxy layer)",
      ],
      {
        source: describeLayer(removed),
        location: minString(removed.map((o) => o.location)),
      },
    );
  }
  if (env.input.settings.poweredBy === "disabled") {
    return state(spec, "pass", "medium", ["x-powered-by disabled in app settings"], {
      source: "app",
    });
  }
  if (env.input.settings.poweredBy === "enabled") {
    return state(spec, "warning", "medium", ["x-powered-by enabled in app settings"], {
      source: "app",
    });
  }
  return unseen(spec, env);
}

// ---------------------------------------------------------------- aggregation and text

const HEADER_FIX: Readonly<Record<string, string>> = {
  H1: "X-Content-Type-Options: nosniff",
  H2: "Content-Security-Policy: frame-ancestors 'self'  (or X-Frame-Options: DENY / SAMEORIGIN)",
  H3: "Content-Security-Policy: default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  H4: "Strict-Transport-Security: max-age=31536000; includeSubDomains  (HTTPS only)",
  H5: "Referrer-Policy: strict-origin-when-cross-origin",
  H6: "Cross-Origin-Opener-Policy: same-origin",
  H7: "Cross-Origin-Resource-Policy: same-origin",
  H8: 'Remove X-Powered-By: app.disable("x-powered-by") or helmet()',
  H9: "X-XSS-Protection: 0  (or omit it; do not enable it)",
};

function buildRemediation(
  status: RuleResult["status"],
  states: readonly HState[],
  proxyPresent: boolean,
): string {
  if (status === "pass") {
    return "No change needed for the checked headers: they were observed with acceptable values in the supplied evidence. This is not a guarantee about the application. Re-run the audit after changes to headers or proxy configuration.";
  }
  const lines: string[] = [];
  const fix = states.filter((s) => s.status === "fail" || s.status === "warning");
  if (fix.length > 0) {
    lines.push(
      "Set these response headers on HTML responses (at the app or at the proxy, somewhere you control):",
    );
    for (const s of fix) lines.push(`  ${HEADER_FIX[s.id] ?? s.label}`);
  }
  const unresolved = states.filter((s) => s.status === "not_assessed").map((s) => s.id);
  if (unresolved.length > 0) {
    lines.push(
      `Not assessed (${unresolved.join(", ")}): supply the missing evidence, for example declare the deployment block, supply the proxy header config or an edge response-header sample, or resolve the scan limits.`,
    );
  }
  lines.push(
    "Notes: test the CSP in Content-Security-Policy-Report-Only first and tighten script-src with nonces or hashes instead of 'unsafe-inline'. Raise HSTS max-age gradually; add includeSubDomains only if every subdomain serves HTTPS; do not add preload without reading its requirements. Do not enable X-XSS-Protection. JSON-only APIs need fewer headers: declare app.kind \"api\" in the config. If a proxy or CDN already sets these, declare it in the deployment block so the next scan can see it.",
  );
  if (fix.length > 0) {
    lines.push(
      'Express (helmet): app.disable("x-powered-by"); app.use(helmet());  // mount before routes; add Permissions-Policy manually',
    );
  }
  if (proxyPresent) {
    lines.push(
      'Nginx: add_header X-Content-Type-Options "nosniff" always;  repeat add_header lines inside any location block that defines its own add_header.',
    );
  }
  return lines.join("\n");
}

function headerEvidence(s: HState): Evidence {
  const ev: Evidence = {
    source: s.source,
    detail: `${s.id} ${s.label}: ${s.status === "skipped" ? "not evaluated" : s.status} (${s.confidence}) - ${s.reasons.join("; ")}`,
  };
  if (s.location !== undefined) ev.location = s.location;
  return ev;
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

export function evaluateSecurityHeaders(raw: unknown): RuleResult {
  const parsed = securityHeadersInputSchema.safeParse(raw);
  if (!parsed.success) {
    return notAssessed(
      [{ source: "input", detail: `input invalid: ${issuePaths(parsed.error)}` }],
      "Provide input matching the SecurityHeadersInput schema (see docs/rules/BFE-001.md section 2.1).",
    );
  }
  const input = parsed.data;
  const env = buildEnv(input);

  const nothingToExamine =
    !input.app.expressAppFound &&
    input.sample === undefined &&
    !env.obs.some((o) => o.layer === "proxy");
  if (nothingToExamine) {
    return notAssessed(
      [
        {
          source: "input",
          detail: "no Express app was resolved and no sample or proxy header evidence was supplied",
        },
      ],
      "Point the audit at an Express project, declare the deployment block, or supply a response-header sample. Non-Express frameworks are not assessed by this rule.",
    );
  }

  const evidence: Evidence[] = [];
  const states: HState[] = [];
  for (const spec of SPECS) {
    if (env.kind === "api" && !spec.apiApplies) {
      evidence.push({
        source: "input",
        detail: `${spec.id} ${spec.label}: not evaluated: declared API-only`,
      });
      continue;
    }
    const st = evaluateHeader(spec, env);
    states.push(st);
    evidence.push(headerEvidence(st));
  }

  if (env.kind !== "api") {
    const set = relevant(env, ["permissions-policy"]).some((o) => o.state === "set");
    evidence.push({
      source: "input",
      detail: `H10 Permissions-Policy: advisory only, ${set ? "observed" : "not observed in the supplied evidence"}; never changes status`,
    });
  }
  for (const a of env.advisories) evidence.push({ source: "input", detail: a });
  evidence.push({
    source: "input",
    detail: `context: app.kind=${input.app.kind}, transport.https=${input.transport.https}, proxy.present=${input.proxy.present}, proxy.headerConfig=${input.proxy.headerConfig}, sample=${input.sample === undefined ? "none" : input.sample.capturedAt}`,
  });

  const by = (st: HStatus): HState[] => states.filter((s) => s.status === st);
  const fails = by("fail");
  const warnings = by("warning");
  const unresolved = by("not_assessed");
  const passes = by("pass");

  let status: RuleResult["status"];
  let confidence: Confidence;
  if (fails.length > 0) {
    status = "fail";
    const min = minConf(fails.map((s) => s.confidence));
    confidence = fails.every((s) => s.edge) ? min : capAt(min, "medium");
  } else if (warnings.length > 0) {
    status = "warning";
    confidence = minConf(warnings.map((s) => s.confidence));
  } else if (unresolved.length > 0) {
    status = "not_assessed";
    confidence = "low";
  } else {
    status = "pass";
    confidence = minConf(passes.map((s) => s.confidence));
  }
  if (status === "fail" && unresolved.length > 0) {
    evidence.push({
      source: "input",
      detail: `unresolved headers (not assessed, result is incomplete): ${unresolved.map((s) => s.id).join(", ")}`,
    });
  }
  if (status === "pass") {
    evidence.push({
      source: "input",
      detail: "recommended headers were observed with acceptable values in the supplied evidence",
    });
  }

  return {
    status,
    confidence,
    evidence: evidence.sort(compareEvidence),
    remediation: buildRemediation(status, states, input.proxy.present !== "no"),
  };
}

export const bfe001: Rule<unknown> = {
  id: "BFE-001",
  version: "1.0.0",
  title: "Missing recommended security headers",
  description:
    "Checks that recommended HTTP security headers are observed with acceptable values in the supplied evidence. A pass does not mean the application is secure.",
  defaultSeverity: "medium",
  references: [
    "https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html",
    "https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html",
    "https://owasp.org/www-project-secure-headers/",
    "https://expressjs.com/en/advanced/best-practice-security.html",
    "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP",
    "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security",
    "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Content-Type-Options",
    "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options",
  ],
  evaluate: (ctx) => evaluateSecurityHeaders(ctx.input),
};
