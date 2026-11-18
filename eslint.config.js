// Tooling note: typescript-eslint 8.72.2 supports TypeScript <6.1, so root pins typescript "~6.0.0".
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.vitepress/cache/**",
      "**/coverage/**",
      "**/node_modules/**",
      "scripts/dev/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
