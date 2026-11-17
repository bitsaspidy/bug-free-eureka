import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// tests/integration/dist-import.test.ts imports the built packages. CI runs tests before
// `npm run build`, so build once here when any package's dist entry is missing.
export default function setup(): void {
  const missing = ["core", "express", "cli"].some(
    (name) => !existsSync(new URL(`../packages/${name}/dist/index.cjs`, import.meta.url)),
  );
  if (missing) execSync("npm run build", { stdio: "inherit" });
}
