// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * A MINIMAL lint gate for the account/auth product code (작업 12 §6).
 *
 * The frontend had no lint gate at all: `typecheck`, `test` and `export:web`
 * were the only checks, and none of them can see an effect with a missing
 * dependency, a floating promise, or a hook called conditionally — which is
 * precisely the class of defect the account-switch work has been fixing by
 * hand (stale responses, teardown ordering, refetching a disabled query).
 *
 * WHY THIS IS SCOPED RATHER THAN REPOSITORY-WIDE
 * ---------------------------------------------
 * The repository has pre-existing lint debt, and gating all of it would mean
 * fixing hundreds of unrelated findings before this could protect anything —
 * the same reason the backend gates only its candle and trading-account layers.
 * `lint:accounts:check` therefore names the account, auth, order, FX and home
 * files this work actually touches. The config below applies to any file
 * ESLint is pointed at; the SCOPE lives in the npm script, so widening it later
 * is a one-line change with no config surgery.
 *
 * WHY THESE RULES AND NOT A STYLE PACK
 * ------------------------------------
 * No Prettier plugin, no import ordering, no naming conventions, no React style
 * rules. Every rule enabled here can fail a real behaviour, not a preference:
 * type-aware correctness from typescript-eslint, plus the two React hook rules.
 * Formatting is deliberately not gated — this is a correctness check, and a
 * check that also reformats is a check people learn to run with `--fix`.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // TypeScript already resolves identifiers; `no-undef` on TS files only
      // produces false positives for types and platform globals.
      'no-undef': 'off',

      // A hook called conditionally is a bug that survives typecheck and tests
      // and then corrupts state at runtime.
      'react-hooks/rules-of-hooks': 'error',
      // The account-scope work lives in effects. A missing dependency here is
      // how a screen keeps rendering the previous account.
      'react-hooks/exhaustive-deps': 'error',

      // The defect this whole release keeps finding: a promise nobody awaits,
      // whose rejection nobody sees.
      '@typescript-eslint/no-floating-promises': 'error',

      // `any` is not banned outright — the DTO layer earns some of it — but
      // silently spreading it through the money code is not free.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
