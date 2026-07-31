/**
 * Vercel function entrypoint. Deliberately plain CommonJS, not TypeScript.
 *
 * Vercel's Node runtime transpiles a TypeScript entrypoint *in place* with
 * esbuild — file by file, no bundling, and no tsconfig `paths` resolution. So a
 * `.ts` entry here would be emitted still containing `require("@/app.module")`,
 * which Node reads as a missing npm package:
 *
 *   Cannot find module '@/app.module'
 *   Did you forget to add it to "dependencies" in package.json?
 *
 * There is no package to add. The fix is to keep the aliases away from Vercel's
 * transpile step entirely: `nest build` already rewrites every `@/…` to a
 * relative path, so this file just forwards to that output.
 *
 * Consequently: never turn this file into TypeScript, and never import from
 * `../src` here.
 */
const handler = require('../dist/src/serverless.js')

module.exports = handler.default || handler
