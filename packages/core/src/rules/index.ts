import type { Rule } from "../types/index.js";
import { bfe001 } from "./bfe-001-security-headers.js";
import { bfe003 } from "./bfe-003-request-size.js";

import { bfe006 } from "./bfe-006-trusted-proxy.js";

export { bfe001, evaluateSecurityHeaders } from "./bfe-001-security-headers.js";
export { bfe003, evaluateRequestSize } from "./bfe-003-request-size.js";
export { requestSizeInputSchema, type RequestSizeInput } from "./bfe-003-input.js";
export { bfe006, evaluateTrustedProxy } from "./bfe-006-trusted-proxy.js";
export { trustedProxyInputSchema, type TrustedProxyInput } from "./bfe-006-input.js";
export {
  securityHeadersInputSchema,
  type HeaderObservation,
  type HelmetMount,
  type SecurityHeadersInput,
} from "./bfe-001-input.js";

/** Built-in rules, sorted by id. Each rule validates its own input. */
export const builtinRules: readonly Rule<unknown>[] = [bfe001, bfe003, bfe006];
