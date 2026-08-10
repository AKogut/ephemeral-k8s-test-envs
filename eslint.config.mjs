// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * One flat config for five independently installed packages.
 *
 * The projects are listed explicitly rather than discovered, because the
 * discovery default picks the nearest `tsconfig.json` — and `scripts` has two:
 * one that drives the build and excludes `*.test.ts`, and one that covers
 * everything. Linting the unit tests is the entire reason the second exists, so
 * the choice is spelled out.
 *
 * Type-aware rules are on. Without type information the interesting failures in
 * this codebase — a promise nobody awaited, an `async` handler passed where a
 * synchronous one is expected — are invisible to a linter.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/allure-results/**',
      '**/allure-report/**',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: [
          './app/auth-service/tsconfig.json',
          './app/notes-service/tsconfig.json',
          './app/gateway/tsconfig.json',
          './scripts/tsconfig.typecheck.json',
          './tests/api/tsconfig.json',
        ],
      },
    },
    linterOptions: {
      // A disable comment for a rule that no longer fires is a lie about the
      // code. Fail on it rather than let it rot.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off', // the services log to stdout on purpose; so do the CLIs

      // `node:test` returns a promise from every one of these and tracks
      // completion itself — awaiting them is not how the runner is meant to be
      // used. Narrowed to that package by name rather than switched off for
      // test files, so a genuinely dropped promise in a test is still an error.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],

      // `_`-prefixed arguments are the established way to say "required by the
      // signature, deliberately unused" — Express error handlers need all four.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    // The suite asserts on responses whose shape is `any` by construction —
    // `response.json()` cannot be typed without duplicating every contract in
    // the test package, and the assertions are the specification.
    files: ['tests/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  {
    // Plain JavaScript that no tsconfig covers: this file, and the shard entry
    // point that Playwright's config loads before TypeScript is in play.
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
