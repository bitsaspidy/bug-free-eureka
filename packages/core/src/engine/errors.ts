import { maskSecrets } from "./mask.js";

export type BfeErrorCode =
  "E_INPUT_INVALID" | "E_RULE_CRASH" | "E_RULE_DUPLICATE" | "E_RULE_ID_INVALID" | "E_RULE_INVALID";

/** Base class. Detect by `code` (string), not `instanceof`, across package boundaries. */
export class BfeError extends Error {
  readonly code: BfeErrorCode;
  constructor(code: BfeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BfeError";
    this.code = code;
  }
}

export class InvalidRuleIdError extends BfeError {
  constructor(id: string) {
    // Truncate, mask and JSON-quote the echoed id so a hostile value cannot leak or inject.
    super(
      "E_RULE_ID_INVALID",
      `Rule id ${JSON.stringify(maskSecrets(id.slice(0, 40)))} is invalid. Use the form BFE-NNN (for example BFE-001).`,
    );
    this.name = "InvalidRuleIdError";
  }
}

export class DuplicateRuleError extends BfeError {
  constructor(id: string) {
    super(
      "E_RULE_DUPLICATE",
      `Rule ${id} is registered more than once. Each rule id must be unique; remove the duplicate.`,
    );
    this.name = "DuplicateRuleError";
  }
}

export class InvalidRuleError extends BfeError {
  constructor(detail: string) {
    super("E_RULE_INVALID", `Rule definition is invalid (${detail}). Fix the rule's fields.`);
    this.name = "InvalidRuleError";
  }
}

export class InputInvalidError extends BfeError {
  constructor(detail: string) {
    super("E_INPUT_INVALID", `Input is invalid (${detail}). Check the documented option shapes.`);
    this.name = "InputInvalidError";
  }
}
