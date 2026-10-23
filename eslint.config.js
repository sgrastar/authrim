import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';

// Packages whose tsconfig.json excludes their tests (so the build does not emit
// them). tsconfig.eslint.json in each adds the tests back for type-aware lint.
const PACKAGES_WITH_LINT_TSCONFIG = [
  'ar-agent-access',
  'ar-lib-core',
  'ar-lib-logging',
  'ar-lib-scim',
  'ar-policy',
];

export default [
  // Ignore patterns
  {
    ignores: ['dist/**', '.wrangler/**', 'node_modules/**', 'packages/setup/**'],
  },

  // Base configuration for all files
  js.configs.recommended,

  // TypeScript files configuration
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        tsconfigRootDir: import.meta.dirname,
        // Each file uses its nearest tsconfig.json. Listing every tsconfig here
        // made typescript-eslint build a program per listed project until one
        // contained the file (~4 GB RSS for a single file in a late package).
        project: true,
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
        // Cloudflare Workers globals
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        crypto: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        DurableObjectState: 'readonly',
        DurableObjectId: 'readonly',
        DurableObjectStorage: 'readonly',
        DurableObjectNamespace: 'readonly',
        DurableObjectStub: 'readonly',
        SqlStorage: 'readonly',
        KVNamespace: 'readonly',
        D1Database: 'readonly',
        Fetcher: 'readonly',
        ScheduledEvent: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs['recommended'].rules,
      ...tseslint.configs['recommended-requiring-type-checking'].rules,
      // Same options as ar-vc and ar-lib-plugin: a leading _ marks an intentional
      // unused binding (omitted destructured fields, unused arguments).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/require-await': 'off',
      // typescript-eslint recommends turning these core rules off for TS: tsc
      // already reports undefined names and invalid redeclarations, and the core
      // rules flag ambient types (R2Bucket, RequestInit, ...) and overloads.
      'no-undef': 'off',
      'no-redeclare': 'off',
      // Disallow console.log - use structured logger instead
      // See docs/logging.md for migration guide
      'no-console': 'error',

      // Deprecation enforcement: Prevent use of createRFCErrorResponse
      // Use createErrorResponse() with AR_ERROR_CODES instead for security masking
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@authrim/ar-lib-core',
              importNames: ['createRFCErrorResponse'],
              message:
                'createRFCErrorResponse is deprecated. Use createErrorResponse() with AR_ERROR_CODES instead.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='createRFCErrorResponse']",
          message:
            'createRFCErrorResponse is deprecated. Use createErrorResponse() with AR_ERROR_CODES instead.',
        },
      ],
    },
  },

  ...PACKAGES_WITH_LINT_TSCONFIG.map((pkg) => ({
    files: [`packages/${pkg}/src/**/*.ts`],
    languageOptions: {
      parserOptions: {
        project: `./packages/${pkg}/tsconfig.eslint.json`,
      },
    },
  })),
];
