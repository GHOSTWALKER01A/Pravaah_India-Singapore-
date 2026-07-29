import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Lint scoped to ONE job: keeping the React Compiler honest.
 *
 * This app has `experiments.reactCompiler: true`, and most of its `useMemo` / `useCallback`
 * calls have been removed in favour of the compiler's automatic memoization. That trade is
 * only safe if two things stay visible, and neither is visible in a typecheck:
 *
 *  1. **Bail-outs.** The compiler silently skips any component or hook it cannot safely
 *     compile. A skipped component gets NO memoization — and since manual memoization is
 *     gone, that means every value it produces is newly created on every render.
 *     `unsupported-syntax`, `purity`, `immutability` and `static-components` are what turn a
 *     silent skip into a message.
 *
 *  2. **Effect dependencies.** React's docs are explicit that the compiler's memoization is a
 *     performance optimization with no semantic guarantee, and that manual memoization
 *     remains the escape hatch when a value feeds an effect dependency array.
 *     `memoized-effect-dependencies` is the rule that checks it. In this app those effects
 *     issue payment requests and set intervals, so an unstable dependency is not a dropped
 *     frame — it is an unbounded request loop.
 *
 * Deliberately NOT a general lint setup. The app had no ESLint config at all, so switching on
 * a full recommended preset would bury these findings under hundreds of unrelated ones. Style
 * and correctness rules beyond this are a separate decision.
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.expo/**',
      'dist/**',
      'android/**',
      'ios/**',
      'expo-env.d.ts',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The two classic rules. `exhaustive-deps` still matters WITH the compiler: it is what
      // catches a dependency array that no longer lists something the body reads.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // ── compiler diagnostics (eslint-plugin-react-hooks v7) ──
      // A bail-out means "this component is not memoized at all". Errors, not warnings:
      // that is precisely the state the manual hooks used to cover for.
      'react-hooks/unsupported-syntax': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/set-state-in-render': 'error',
      'react-hooks/static-components': 'error',
      'react-hooks/component-hook-factories': 'error',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/globals': 'error',
      'react-hooks/refs': 'warn',

      // The rule this whole change rests on: flags a value used as an effect dependency
      // that the compiler will not keep referentially stable.
      'react-hooks/memoized-effect-dependencies': 'error',
      // Complains if a `useMemo`/`useCallback` that IS still written would be dropped or
      // weakened — so the ones deliberately kept cannot be silently defeated.
      'react-hooks/preserve-manual-memoization': 'error',
    },
  },
);
