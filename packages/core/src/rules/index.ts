import type { Rule } from "../types/index.js";
import { bfe001 } from "./bfe-001-security-headers.js";

export { bfe001, evaluateSecurityHeaders } from "./bfe-001-security-headers.js";
export {
  securityHeadersInputSchema,
  type HeaderObservation,
  type HelmetMount,
  type SecurityHeadersInput,
} from "./bfe-001-input.js";

/** Built-in rules, sorted by id. Each rule validates its own input. */
export const builtinRules: readonly Rule<unknown>[] = [bfe001];
