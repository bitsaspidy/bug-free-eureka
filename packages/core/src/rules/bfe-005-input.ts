import { z } from "zod";

/** Input caps: oversized input is rejected, never truncated (docs/rules/BFE-005.md section 2.1). */
const MAX_LOGGERS = 100;
const MAX_PATHS = 200;
const MAX_PATH_LENGTH = 200;
const MAX_LOCATION = 500;
const MAX_LIMITS = 200;

const tri = z.enum(["yes", "no", "unknown"]);

export const redactionSchema = z.discriminatedUnion("state", [
  /** No redaction configured. */
  z.strictObject({ state: z.literal("none") }),
  /** Literal Pino-style redact paths, e.g. `req.headers.authorization`. */
  z.strictObject({
    state: z.literal("paths"),
    paths: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).max(MAX_PATHS),
  }),
  /** Redaction exists but its effect cannot be read statically (variable, function, custom format). */
  z.strictObject({ state: z.literal("unresolved") }),
]);

export const loggerSchema = z.strictObject({
  library: z.enum([
    "pino",
    "pino-http",
    "winston",
    "express-winston",
    "morgan",
    "bunyan",
    "console",
    "other",
  ]),
  /** `request` = per-request middleware; `call` = an explicit log call site. */
  kind: z.enum(["request", "call"]),
  scope: z.enum(["global", "route", "conditional", "unresolved"]),
  location: z.string().max(MAX_LOCATION),
  /** Which parts of the request/response the logger writes. */
  emits: z.strictObject({
    requestHeaders: tri,
    responseHeaders: tri,
    requestBody: tri,
    query: tri,
  }),
  redaction: redactionSchema,
});

/** Zod schema for the BFE-005 input contract (docs/rules/BFE-005.md section 2.1). */
export const sensitiveLoggingInputSchema = z.strictObject({
  app: z.strictObject({ expressAppFound: z.boolean() }),
  loggers: z.array(loggerSchema).max(MAX_LOGGERS),
  coverage: z.strictObject({
    complete: z.boolean(),
    limitsHit: z.array(z.string().max(MAX_LOCATION)).max(MAX_LIMITS),
  }),
});

export type SensitiveLoggingInput = z.infer<typeof sensitiveLoggingInputSchema>;
export type LoggerDeclaration = z.infer<typeof loggerSchema>;
export type RedactionConfig = z.infer<typeof redactionSchema>;
