import vitestPlugin from "eslint-plugin-vitest";
import prettierConfig from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "**/*.d.mts", "**/*.d.ts"],
  },
  {
    files: ["tests/**/*.mts"],
    plugins: { vitest: vitestPlugin },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "warn",
      "vitest/expect-expect": "warn",
      "vitest/no-identical-title": "error",
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  },
  {
    ...prettierConfig,
  },
  {
    files: ["**/*.ts", "**/*.mts"],
    ignores: ["vitest.config.mts", "eslint.config.*"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
];
