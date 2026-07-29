// @pravaah/ui
//
// Shared React component library. Add components under src/components,
// hooks under src/hooks, and shared utilities under src/lib, then export
// them here or import them via their subpath (e.g. "@pravaah/ui/components/button").

// `.js`, not `.ts`, and not extensionless: this package resolves as ESM under
// `moduleResolution: nodenext`, where a relative import must carry the extension of the
// EMITTED file. TypeScript maps `./lib/utils.js` back to `./lib/utils.ts` at compile time.
export { cn } from './lib/utils.js'
