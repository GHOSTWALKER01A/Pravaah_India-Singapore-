# `@pravaah/eslint-config`

Shared ESLint configuration for the workspace.

## Usage

In a package's `eslint.config.mjs`:

```js
import { config } from '@pravaah/eslint-config/base'

/** @type {import("eslint").Linter.Config} */
export default config
```

Available configs:

- `base` — the shared base for every package.
- `next-js` — Next.js apps (`nextJsConfig`).
- `react-internal` — React component libraries.
