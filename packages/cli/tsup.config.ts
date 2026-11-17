import { defineConfig } from "tsup";

const shared = {
  clean: false,
  sourcemap: true,
  target: "node22",
  platform: "node",
  splitting: false,
  treeshake: true,
  // Type-check against core's built declarations, not its sources (see tsconfig.build.json).
  tsconfig: "tsconfig.build.json",
} as const;

export default defineConfig([
  { ...shared, entry: ["src/index.ts"], format: ["esm", "cjs"], dts: true, clean: true },
  // The executable: ESM only, with a shebang. npm creates the Windows .cmd shim.
  {
    ...shared,
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
