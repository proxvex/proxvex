import vitestPlugin from "eslint-plugin-vitest";
import prettierConfig from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default [
  // Ignore build outputs and declaration files
  {
    ignores: ["dist/**", "**/*.d.mts", "**/*.d.ts"],
  },
  // Vitest rules for test files
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
  // Prettier configuration for all files
  {
    ...prettierConfig,
  },
  // General TypeScript/ESM rules for the project
  {
    files: ["**/*.ts", "**/*.mts"],
    ignores: ["vitest.config.mts", "vite.config.*", "eslint.config.*"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.eslint.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
];
