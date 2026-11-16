import type { Rule } from "../types/index.js";
import { DuplicateRuleError, InvalidRuleError, InvalidRuleIdError } from "./errors.js";
import { issuePaths, RULE_ID_PATTERN, ruleShapeSchema } from "./schemas.js";
import { compare } from "./sort.js";

export class RuleRegistry<TInput = unknown> {
  readonly #rules = new Map<string, Rule<TInput>>();

  register(rule: Rule<TInput>): this {
    const id: unknown = (rule as { id?: unknown }).id;
    if (typeof id !== "string" || !RULE_ID_PATTERN.test(id)) {
      throw new InvalidRuleIdError(typeof id === "string" ? id : "");
    }
    const parsed = ruleShapeSchema.safeParse(rule);
    if (!parsed.success) throw new InvalidRuleError(`${id}: ${issuePaths(parsed.error)}`);
    if (this.#rules.has(id)) throw new DuplicateRuleError(id);
    this.#rules.set(id, rule);
    return this;
  }

  get(id: string): Rule<TInput> | undefined {
    return this.#rules.get(id);
  }

  /** Rules sorted by id. */
  list(): Rule<TInput>[] {
    return [...this.#rules.values()].sort((a, b) => compare(a.id, b.id));
  }
}

export function createRegistry<TInput = unknown>(
  rules: readonly Rule<TInput>[],
): RuleRegistry<TInput> {
  const registry = new RuleRegistry<TInput>();
  for (const rule of rules) registry.register(rule);
  return registry;
}
