import { z } from "zod";

/** Upper bound for any single header value (4 MiB). Larger input is rejected, not truncated. */
const MAX_VALUE = 4 * 1024 * 1024;
const MAX_HEADERS = 500;
const MAX_MOUNTS = 50;
const MAX_OPTION_KEYS = 20;
const MAX_LIMITS = 200;

const tri = z.enum(["yes", "no", "unknown"]);

const helmetOptionSchema = z.strictObject({
  state: z.enum(["default", "disabled", "custom"]),
  value: z.string().max(MAX_VALUE).exactOptional(),
});

export const helmetMountSchema = z.strictObject({
  scope: z.enum(["global", "route", "conditional", "unresolved"]),
  location: z.string().max(500),
  options: z.union([
    z.literal("default"),
    z.literal("unresolved"),
    z
      .record(z.string().max(100), helmetOptionSchema)
      .refine((o) => Object.keys(o).length <= MAX_OPTION_KEYS, "too many helmet option keys"),
  ]),
});

export const headerObservationSchema = z.strictObject({
  name: z.string().max(200),
  state: z.enum(["set", "removed", "absent"]),
  value: z.string().max(MAX_VALUE).exactOptional(),
  layer: z.enum(["app", "proxy", "sample"]),
  scope: z.enum(["global", "route", "unknown"]),
  origin: z.enum(["source", "declared", "parsed-proxy-config", "sample"]),
  location: z.string().max(500).exactOptional(),
  route: z.string().max(2000).exactOptional(),
});

/** Zod schema for the BFE-001 input contract (docs/rules/BFE-001.md section 2.1). */
export const securityHeadersInputSchema = z.strictObject({
  app: z.strictObject({
    kind: z.enum(["html", "api", "mixed", "unknown"]),
    expressAppFound: z.boolean(),
  }),
  transport: z.strictObject({ https: z.enum(["app", "proxy", "none", "unknown"]) }),
  proxy: z.strictObject({
    present: tri,
    headerConfig: z.enum(["supplied", "not_supplied"]),
  }),
  coverage: z.strictObject({
    complete: z.boolean(),
    limitsHit: z.array(z.string().max(500)).max(MAX_LIMITS),
    unresolvedMiddleware: z.boolean(),
  }),
  settings: z.strictObject({ poweredBy: z.enum(["disabled", "enabled", "unknown"]) }),
  helmet: z.strictObject({
    dependency: z.enum(["present", "absent", "unknown"]),
    version: z.string().max(100).exactOptional(),
    mounts: z.array(helmetMountSchema).max(MAX_MOUNTS),
  }),
  headers: z.array(headerObservationSchema).max(MAX_HEADERS),
  sample: z
    .strictObject({
      capturedAt: z.enum(["edge", "origin", "unknown"]),
      scheme: z.enum(["https", "http", "unknown"]),
      route: z.string().max(2000),
      isHtml: tri,
    })
    .exactOptional(),
});

export type SecurityHeadersInput = z.infer<typeof securityHeadersInputSchema>;
export type HelmetMount = z.infer<typeof helmetMountSchema>;
export type HeaderObservation = z.infer<typeof headerObservationSchema>;
