# `@pravaah/typescript-config`

Shared TypeScript configuration for the workspace.

## Usage

In a package's `tsconfig.json`:

```jsonc
{
  "extends": "@pravaah/typescript-config/base.json"
}
```

Available configs:

- `base.json` — the shared base for every package.
- `nestjs.json` — NestJS apps/libraries (CommonJS, decorators).
- `nextjs.json` — Next.js apps.
- `react-library.json` — React component libraries.
