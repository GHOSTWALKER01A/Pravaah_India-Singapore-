import { config } from '@pravaah/eslint-config/base'

/**
 * Root ESLint configuration.
 * Apps and packages are linted by their own eslint.config files.
 *
 * @type {import("eslint").Linter.Config}
 */
export default [
  ...config,
  {
    ignores: ['apps/**', 'packages/**', 'node_modules/**'],
  },
]
