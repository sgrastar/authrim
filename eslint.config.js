import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  // Ignore patterns
  {
    ignores: ["dist/**", ".wrangler/**", "node_modules/**"]
  },

  // Base configuration for all files
  js.configs.recommended,

  // TypeScript files configuration
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: [
          "./packages/*/tsconfig.json"
        ]
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
        // Cloudflare Workers globals
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        crypto: "readonly",
        btoa: "readonly",
        atob: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        DurableObjectState: "readonly",
        DurableObjectId: "readonly",
        DurableObjectStorage: "readonly",
        SqlStorage: "readonly",
        KVNamespace: "readonly",
        D1Database: "readonly",
        Fetcher: "readonly"
      }
    },
    plugins: {
      "@typescript-eslint": tseslint
    },
    rules: {
      ...tseslint.configs["recommended"].rules,
      ...tseslint.configs["recommended-requiring-type-checking"].rules,
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/require-await": "off",
      "no-console": ["warn", { "allow": ["warn", "error"] }]
    }
  }
];
