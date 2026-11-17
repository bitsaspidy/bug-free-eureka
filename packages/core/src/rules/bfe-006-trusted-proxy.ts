import { issuePaths } from "../engine/schemas.js";
import { compare } from "../engine/sort.js";
import { safeLocation as sharedSafeLocation } from "./shared/safe-location.js";
import type { Confidence, Evidence, Rule, RuleResult } from "../types/index.js";
import { trustedProxyInputSchema, type TrustedProxyInput } from "./bfe-006-input.js";
import { classifyList, proxyCoverage, type ListClass } from "./bfe-006-ip.js";

// Evidence is built only from fixed phrases, form names, topology names,
// validated integers, counts and a validated "file:line" location. Proxy
// addresses, CIDRs, entry text and limit text are never echoed (spec 2.3).

const UNKNOWN_LOCATION = "unknown-location";

/** A plain "file:line" location is echoed; anything else becomes "unknown-location". */
function safeLocation(location: string | undefined): string | undefined {
  if (location === undefined) return undefined;
  return sharedSafeLocation(location) ?? UNKNOWN_LOCATION;
}

type Status = RuleResult["status"];

type Form =
  | { kind: "off" }
  | { kind: "trust-all" }
  | { kind: "hops"; hops: number }
  | { kind: "list"; cls: Exclude<ListClass, "invalid" | "trust-all">; entries: number }
  | { kind: "unevaluable" };

interface Verdict {
  status: Status;
  confidence: Confidence;
  rows: string;
  reason: string;
}

const verdict = (
  status: Status,
  confidence: Confidence,
  rows: string,
  reason: string,
): Verdict => ({ status, confidence, rows, reason });

const FORM_NAMES: Readonly<Record<string, string>> = {
  off: "not set",
  "trust-all": "true",
  hops: "hop count",
  list: "address list",
  unevaluable: "function or invalid entry",
};

/** Collapses the observed setting into one of the forms of spec section 3. */
function formOf(input: TrustedProxyInput, entries: readonly string[]): Form {
  const { trustProxy } = input;
  const value = trustProxy.value;
  if (trustProxy.state !== "set" || value === undefined) return { kind: "off" };
  switch (value.kind) {
    case "boolean":
      return value.value ? { kind: "trust-all" } : { kind: "off" };
    case "hops":
      return value.hops === 0 ? { kind: "off" } : { kind: "hops", hops: value.hops };
    case "function":
      return value.alwaysTrue ? { kind: "trust-all" } : { kind: "unevaluable" };
    case "list": {
      const { cls } = classifyList(entries);
      if (cls === "invalid") return { kind: "unevaluable" };
      if (cls === "trust-all") return { kind: "trust-all" };
      return { kind: "list", cls, entries: new Set(entries).size };
    }
  }
}

function listEntries(input: TrustedProxyInput): string[] {
  const value = input.trustProxy.value;
  return value?.kind === "list" ? value.entries : [];
}

/** Gate rows G1 to G4 (before the value is looked at). */
function gate(input: TrustedProxyInput): Verdict | undefined {
  const { trustProxy, coverage } = input;
  if (!input.app.expressAppFound) {
    return verdict("not_assessed", "low", "G1", "no Express app was resolved");
  }
  if (trustProxy.state === "unresolved") {
    return verdict("not_assessed", "low", "G2", "the trust proxy value is not a literal");
  }
  if (trustProxy.state === "conditional") {
    return verdict("not_assessed", "low", "G2", "the trust proxy setting is set conditionally");
  }
  if (!coverage.complete) {
    return trustProxy.state === "not_set"
      ? verdict(
          "not_assessed",
          "low",
          "G3",
          "scan coverage is incomplete; the setting may be in a file that was not read",
        )
      : verdict(
          "not_assessed",
          "low",
          "G4",
          "scan coverage is incomplete; a later assignment may override the value found",
        );
  }
  return undefined;
}

const EXPOSURE =
  "a client that reaches the app without a proxy can supply forwarded headers that are trusted";

/** Rows E1 to E3 (any topology). */
function exposureRows(input: TrustedProxyInput, form: Form): Verdict | undefined {
  if (form.kind !== "trust-all" && form.kind !== "hops") return undefined;
  const { deployment } = input;
  if (deployment.directExposure === "yes") return verdict("fail", "high", "E1", EXPOSURE);
  if (deployment.topology === "none") {
    return verdict(
      "fail",
      "high",
      "E2",
      "trust proxy trusts forwarded headers although no proxy is declared, so clients can forge them",
    );
  }
  if (form.kind === "trust-all" && deployment.forwardedHeaderHandling === "append") {
    return verdict(
      "fail",
      "high",
      "E3",
      "the outermost trusted proxy appends to a client-supplied header, so the left-most entry is client-controlled",
    );
  }
  return undefined;
}

function noProxyRows(form: Form): Verdict {
  if (form.kind === "off") {
    return verdict("pass", "high", "T1", "no proxy is declared and trust proxy is not enabled");
  }
  return verdict(
    "warning",
    "medium",
    "T2",
    "trusted addresses are configured although no proxy is declared",
  );
}

function proxiedHopsRow(input: TrustedProxyInput, hops: number): Verdict {
  const { deployment } = input;
  const real = deployment.declaredHops ?? (deployment.topology === "single-proxy" ? 1 : 2);
  if (hops > real) {
    return verdict(
      "fail",
      deployment.declaredHops === undefined ? "medium" : "high",
      "T6",
      "trust proxy trusts more hops than declared, so a client-supplied entry is believed",
    );
  }
  if (hops < real) {
    return verdict(
      "warning",
      "medium",
      "T9",
      "trust proxy trusts fewer hops than declared, so req.ip resolves to an inner proxy address (not spoofable)",
    );
  }
  return deployment.directExposure === "no"
    ? verdict(
        "pass",
        "medium",
        "T7",
        "the trust proxy setting matches the declared topology in the supplied evidence",
      )
    : verdict(
        "warning",
        "low",
        "T8",
        "cannot establish that no path bypasses the proxies; paths of different lengths make a hop count unsafe",
      );
}

function proxiedListRow(input: TrustedProxyInput, form: Form & { kind: "list" }): Verdict {
  if (form.cls !== "specific") {
    return verdict(
      "warning",
      "medium",
      "T13",
      "trusts a wider range than the proxies; any peer in it can set forwarded headers; a narrower subnet is preferable",
    );
  }
  const addresses = input.deployment.proxyAddresses;
  if (addresses.length === 0) {
    return verdict(
      "not_assessed",
      "low",
      "T11",
      "cannot compare trusted entries with the real proxy addresses, none were declared",
    );
  }
  const { ranges } = classifyList(listEntries(input));
  const { uncovered, invalid } = proxyCoverage(ranges, addresses);
  if (invalid > 0) {
    return verdict(
      "not_assessed",
      "low",
      "T11",
      "a declared proxy address cannot be parsed, so it cannot be compared with the trusted entries",
    );
  }
  return uncovered === 0
    ? verdict(
        "pass",
        "medium",
        "T10",
        "the trust proxy setting matches the declared topology in the supplied evidence",
      )
    : verdict(
        "warning",
        "medium",
        "T12",
        "a declared proxy is not trusted, so req.ip is a proxy address",
      );
}

function proxiedRows(input: TrustedProxyInput, form: Form): Verdict {
  const { deployment } = input;
  switch (form.kind) {
    case "hops":
      return proxiedHopsRow(input, form.hops);
    case "list":
      return proxiedListRow(input, form);
    case "trust-all":
      return deployment.directExposure === "no" &&
        deployment.forwardedHeaderHandling === "overwrite"
        ? verdict(
            "warning",
            "medium",
            "T4",
            "works only while every request passes the overwriting proxy; prefer an exact hop count or address list",
          )
        : verdict(
            "warning",
            "low",
            "T5",
            "trusts every hop and depends on proxy behaviour that was not declared",
          );
    default:
      return verdict(
        "warning",
        "medium",
        "T3",
        "req.ip is a proxy address and clients share one bucket; req.secure is wrong when TLS ends at the proxy; this is not a spoofing fault",
      );
  }
}

function unknownTopologyRows(form: Form): Verdict {
  switch (form.kind) {
    case "off":
      return verdict(
        "not_assessed",
        "low",
        "T14",
        "topology not declared; the unset value is correct only if no proxy sits in front",
      );
    case "trust-all":
      return verdict(
        "warning",
        "medium",
        "T15",
        "trusts every hop; unsafe unless every request passes a proxy that overwrites the header",
      );
    case "hops":
      return verdict(
        "not_assessed",
        "low",
        "T16",
        "the hop count cannot be compared with an undeclared topology",
      );
    default:
      return verdict(
        "not_assessed",
        "low",
        "T17",
        "the trusted entries cannot be compared with an undeclared topology",
      );
  }
}

function decide(input: TrustedProxyInput): { v: Verdict; form: Form } {
  const entries = listEntries(input);
  const gated = gate(input);
  const form = formOf(input, entries);
  if (gated !== undefined) return { v: gated, form };
  if (form.kind === "unevaluable") {
    return {
      v: verdict(
        "not_assessed",
        "low",
        "G5",
        "a function body or an entry cannot be evaluated statically",
      ),
      form,
    };
  }
  const exposure = exposureRows(input, form);
  if (exposure !== undefined) return { v: exposure, form };
  const { topology } = input.deployment;
  if (topology === "none") return { v: noProxyRows(form), form };
  if (topology === "unknown") return { v: unknownTopologyRows(form), form };
  return { v: proxiedRows(input, form), form };
}

function describeForm(input: TrustedProxyInput, form: Form): string {
  if (input.trustProxy.state !== "set") {
    return `trust proxy state: ${input.trustProxy.state.replace("_", " ")}`;
  }
  const value = input.trustProxy.value;
  const name = FORM_NAMES[form.kind] ?? "unknown";
  if (value?.kind === "hops") return `trust proxy form: ${name} (${value.hops})`;
  if (form.kind === "list") {
    return `trust proxy form: ${name} (${form.entries} trusted entries, class ${form.cls})`;
  }
  return `trust proxy form: ${name}`;
}

function compareEvidence(a: Evidence, b: Evidence): number {
  return (
    compare(a.source, b.source) ||
    compare(a.location ?? "", b.location ?? "") ||
    compare(a.detail, b.detail)
  );
}

function buildEvidence(input: TrustedProxyInput, form: Form, v: Verdict): Evidence[] {
  const { deployment, trustProxy, coverage } = input;
  const evidence: Evidence[] = [];
  const location = safeLocation(trustProxy.location);

  const code: Evidence = {
    source: "source",
    detail: `${v.rows} ${v.status}: ${v.reason}; ${describeForm(input, form)}`,
  };
  if (location !== undefined) code.location = location;
  evidence.push(code);

  const hops =
    deployment.declaredHops === undefined ? "" : `, declared hops ${deployment.declaredHops}`;
  evidence.push({
    source: "declared",
    detail: `declared topology: ${deployment.topology}${hops}; directExposure: ${deployment.directExposure}; forwardedHeaderHandling: ${deployment.forwardedHeaderHandling}`,
  });

  const declared = new Set(deployment.proxyAddresses).size;
  if (declared > 0) {
    const entries = listEntries(input);
    let detail = `${declared} declared proxy address${declared === 1 ? "" : "es"}`;
    if (form.kind === "list") {
      const { uncovered, invalid } = proxyCoverage(
        classifyList(entries).ranges,
        deployment.proxyAddresses,
      );
      detail += `, ${uncovered} not covered, ${invalid} invalid`;
    }
    evidence.push({ source: "declared", detail });
  }

  if (!coverage.complete) {
    const n = new Set(coverage.limitsHit).size;
    evidence.push({
      source: "input",
      detail: `scan coverage incomplete (${n} limit${n === 1 ? "" : "s"} hit); not seen is not absent`,
    });
  }
  evidence.push({
    source: "input",
    detail:
      "Express properties that depend on trust proxy: req.ip, req.ips, req.protocol, req.secure, req.hostname",
  });
  return evidence.sort(compareEvidence);
}

const REMEDIATION_NEUTRAL = [
  "1. Draw the real path from the internet to the app and count the proxy hops you control (CDN, load balancer, ingress, sidecar). Trust exactly that many hops, or exactly those addresses. Do not use trust-everything.",
  "2. Make the outermost trusted proxy set the client address itself instead of forwarding what the client sent (Nginx: proxy_set_header X-Forwarded-For $remote_addr; overwrites, $proxy_add_x_forwarded_for appends). Set X-Forwarded-Proto and X-Forwarded-Host explicitly. Check your CDN or cloud load balancer documentation for its own behaviour.",
  "3. Make the app reachable only through the proxy: restrict the origin firewall or security group to the proxy or CDN ranges, or use mutual TLS or an authenticated origin pull. A hop count is only correct if no path is shorter than the declared chain.",
  "4. Prefer an address list of your proxy subnets over a hop count when the chain can change. With a list, a client that reaches the app directly is simply not trusted.",
  "5. Declare the topology in the deployment block (topology, declaredHops, proxyAddresses, directExposure, forwardedHeaderHandling) so the next scan can confirm the setting.",
  "6. If a limiter or allow-list keys on the client address, send a request with a forged X-Forwarded-For through the real entry point and confirm that the address the app logs is not the forged one.",
].join("\n");

const REMEDIATION_EXPRESS = [
  "Express:",
  '  app.set("trust proxy", false);                 // no proxy in front',
  '  app.set("trust proxy", 1);                     // exactly one proxy in front',
  '  app.set("trust proxy", 2);                     // CDN plus load balancer, both yours',
  '  app.set("trust proxy", ["loopback", "10.0.1.0/28"]); // or, better, only your proxy addresses',
  'Set it before middleware that reads req.ip (rate limiters, sessions, audit logging). Express does not accept the string "1" as a hop count: convert environment values with Number.parseInt and validate the range. Never use app.set("trust proxy", true) on an app that clients can reach directly.',
].join("\n");

function buildRemediation(status: Status, v: Verdict): string {
  if (status === "pass") {
    return "No change needed: the trust proxy setting matches the declared topology in the supplied evidence. This is not a guarantee about the application. Re-run the audit after changes to the proxy chain or the setting.";
  }
  if (v.rows === "G1") {
    return "Point the audit at an Express project. Non-Express frameworks (Fastify trustProxy, Koa app.proxy) are not assessed by this rule.";
  }
  if (v.rows === "G2" || v.rows === "G3" || v.rows === "G4" || v.rows === "G5") {
    return `${REMEDIATION_NEUTRAL}\nSet trust proxy as a literal in code that always runs, resolve the scan limits, and declare the deployment block so the value can be validated.\n${REMEDIATION_EXPRESS}`;
  }
  return `${REMEDIATION_NEUTRAL}\n${REMEDIATION_EXPRESS}`;
}

export function evaluateTrustedProxy(raw: unknown): RuleResult {
  const parsed = trustedProxyInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "not_assessed",
      confidence: "low",
      evidence: [{ source: "input", detail: `input invalid: ${issuePaths(parsed.error)}` }],
      remediation:
        "Provide input matching the TrustedProxyInput schema (see docs/rules/BFE-006.md section 2.1).",
    };
  }
  const input = parsed.data;
  const { v, form } = decide(input);
  return {
    status: v.status,
    confidence: v.confidence,
    evidence: buildEvidence(input, form, v),
    remediation: buildRemediation(v.status, v),
  };
}

export const bfe006: Rule<unknown> = {
  id: "BFE-006",
  version: "1.0.0",
  title: "Unsafe trusted-proxy configuration",
  description:
    "Compares the Express trust proxy setting with the declared proxy topology. A pass means the setting matched the declared topology in the supplied evidence, not that the application is secure.",
  defaultSeverity: "high",
  references: [
    "https://expressjs.com/en/guide/behind-proxies.html",
    "https://expressjs.com/en/advanced/best-practice-security.html",
    "https://community.owasp.org/pages/attacks/ip_spoofing_via_http_headers",
  ],
  evaluate: (ctx) => evaluateTrustedProxy(ctx.input),
};
