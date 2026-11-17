import { z } from "zod";

const MAX_DECLARATIONS = 200;
const MAX_LIMITS = 200;
const MAX_NGINX_ENTRIES = 200;
const MAX_LOCATION = 500;

const tri = z.enum(["yes", "no", "unknown"]);

/** Integers from 1 to Number.MAX_SAFE_INTEGER. Zero, negatives, NaN and floats are rejected. */
const bytes = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const limitValueSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("default") }),
  z.strictObject({ state: z.literal("literal"), bytes }),
  z.strictObject({ state: z.literal("unbounded") }),
  z.strictObject({ state: z.literal("non-literal") }),
]);

const multerSchema = z.strictObject({
  storage: z.enum(["memory", "disk", "unknown"]),
  limitsObject: z.enum(["literal", "absent", "non-literal"]),
  files: limitValueSchema,
  fields: limitValueSchema,
  fieldSize: limitValueSchema,
  parts: limitValueSchema,
});

export const bodyDeclarationSchema = z
  .strictObject({
    kind: z.enum(["json", "urlencoded", "raw", "text", "multer", "custom-reader"]),
    source: z.enum(["express", "body-parser", "multer", "other"]),
    scope: z.enum(["global", "route", "conditional", "unresolved"]),
    location: z.string().max(MAX_LOCATION),
    limit: limitValueSchema.exactOptional(),
    parameterLimit: limitValueSchema.exactOptional(),
    multer: multerSchema.exactOptional(),
    byteCounted: z.boolean().exactOptional(),
  })
  .refine((d) => d.kind === "custom-reader" || d.kind === "multer" || d.limit !== undefined, {
    message: "limit is required",
    path: ["limit"],
  })
  .refine((d) => d.kind !== "multer" || d.multer !== undefined, {
    message: "multer details are required",
    path: ["multer"],
  });

const nginxValueSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("literal"), bytes }),
  z.strictObject({ state: z.literal("unlimited") }),
  z.strictObject({ state: z.literal("non-literal") }),
]);

export const requestSizeOptionsSchema = z
  .strictObject({
    warnBytes: bytes.default(1_048_576),
    routeWarnBytes: bytes.default(10_485_760),
    failBytes: bytes.default(104_857_600),
    memoryUploadWarnBytes: bytes.default(10_485_760),
    diskUploadWarnBytes: bytes.default(104_857_600),
    parameterWarn: bytes.default(10_000),
    fieldsWarn: bytes.default(1_000),
    filesWarn: bytes.default(20),
  })
  .refine((o) => o.warnBytes <= o.failBytes && o.routeWarnBytes <= o.failBytes, {
    message: "warn thresholds must not exceed failBytes",
    path: ["failBytes"],
  });

/** Zod schema for the BFE-003 input contract (docs/rules/BFE-003.md section 2.1). */
export const requestSizeInputSchema = z.strictObject({
  app: z.strictObject({
    expressAppFound: z.boolean(),
    expressMajor: z.union([z.literal(4), z.literal(5), z.literal("unknown")]),
    legacyBodyParser: z.boolean(),
  }),
  coverage: z.strictObject({
    complete: z.boolean(),
    limitsHit: z.array(z.string().max(MAX_LOCATION)).max(MAX_LIMITS),
    unresolvedMiddleware: z.boolean(),
  }),
  declarations: z.array(bodyDeclarationSchema).max(MAX_DECLARATIONS),
  proxy: z.strictObject({
    present: tri,
    bodyLimitConfig: z.enum(["supplied", "not_supplied"]),
    appReachableDirectly: tri,
    nginx: z
      .strictObject({
        clientMaxBodySize: z
          .array(
            z.strictObject({
              scope: z.enum(["http", "server", "location"]),
              value: nginxValueSchema,
              locationCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            }),
          )
          .max(MAX_NGINX_ENTRIES),
        configComplete: z.boolean(),
      })
      .exactOptional(),
    declaredLimit: limitValueSchema.exactOptional(),
  }),
  options: requestSizeOptionsSchema.exactOptional(),
});

export type RequestSizeInput = z.infer<typeof requestSizeInputSchema>;
export type RequestSizeOptions = z.infer<typeof requestSizeOptionsSchema>;
export type BodyDeclaration = z.infer<typeof bodyDeclarationSchema>;
export type LimitValue = z.infer<typeof limitValueSchema>;
