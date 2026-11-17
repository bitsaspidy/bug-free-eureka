import { z } from "zod";

/** Input caps: oversized input is rejected, never truncated (docs/rules/BFE-006.md section 2.1). */
const MAX_ENTRIES = 64;
const MAX_ENTRY_LENGTH = 100;
const MAX_HOPS = 1000;
const MAX_LOCATION = 500;
const MAX_LIMITS = 200;

const tri = z.enum(["yes", "no", "unknown"]);
const addressList = z.array(z.string().max(MAX_ENTRY_LENGTH)).max(MAX_ENTRIES);

export const trustProxyValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({
    kind: z.literal("hops"),
    hops: z.number().int().min(0).max(MAX_HOPS),
  }),
  z.strictObject({ kind: z.literal("list"), entries: addressList }),
  z.strictObject({ kind: z.literal("function"), alwaysTrue: z.boolean() }),
]);

/** Zod schema for the BFE-006 input contract (docs/rules/BFE-006.md section 2.1). */
export const trustedProxyInputSchema = z.strictObject({
  app: z.strictObject({ expressAppFound: z.boolean() }),
  deployment: z
    .strictObject({
      topology: z.enum(["none", "single-proxy", "cdn-plus-lb", "unknown"]),
      declaredHops: z.number().int().min(1).max(16).exactOptional(),
      proxyAddresses: addressList,
      directExposure: tri,
      forwardedHeaderHandling: z.enum(["overwrite", "append", "unknown"]),
    })
    .refine(
      (d) => d.declaredHops === undefined || d.topology !== "none",
      "declaredHops requires a declared proxy topology",
    )
    .refine(
      (d) => d.declaredHops === undefined || d.topology !== "unknown",
      "declaredHops requires a declared proxy topology",
    ),
  trustProxy: z
    .strictObject({
      state: z.enum(["not_set", "set", "unresolved", "conditional"]),
      value: trustProxyValueSchema.exactOptional(),
      location: z.string().max(MAX_LOCATION).exactOptional(),
    })
    .refine((t) => (t.state === "set") === (t.value !== undefined), "value must match state"),
  coverage: z.strictObject({
    complete: z.boolean(),
    limitsHit: z.array(z.string().max(MAX_LOCATION)).max(MAX_LIMITS),
  }),
});

export type TrustedProxyInput = z.infer<typeof trustedProxyInputSchema>;
export type TrustProxyValue = z.infer<typeof trustProxyValueSchema>;
