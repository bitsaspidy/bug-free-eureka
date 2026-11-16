import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

// Resolved by package name through each package's `exports` map (workspace symlink in node_modules).
describe.each(["core", "express", "cli"])("built package @bug-free-eureka/%s", (name) => {
  const specifier = `@bug-free-eureka/${name}`;

  it("loads via import() and require() with the same exports", async () => {
    const m = (await import(/* @vite-ignore */ specifier)) as { version: string };
    const c = require(specifier) as { version: string };
    expect(m.version).toBe("0.0.0");
    expect(c.version).toBe(m.version);
  });
});
