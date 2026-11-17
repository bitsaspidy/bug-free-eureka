import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
  // Type-check against core's built declarations, not its sources (see tsconfig.build.json).
  tsconfig: "tsconfig.build.json",
  splitting: false,
  treeshake: true,
});
