// Learn more: https://docs.expo.dev/guides/monorepo/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch ONLY the hoisted node_modules, not the whole monorepo.
//
//    This app imports nothing from `packages/` or its sibling apps — it needs the
//    workspace root purely because npm hoists `expo`, `expo-router` and
//    `react-native` up there. (Since SDK 56 expo-router vendors React Navigation
//    itself, so there is no `@react-navigation/*` to resolve.) Watching the entire
//    monorepo instead asked Metro to crawl ~122k files, including several
//    directories it has no business reading:
//
//      apps/ml/.venv             12,654 files (Python virtualenv)
//      apps/pravaah-admin/.next   3,191 files (rewritten on every Next build)
//      apps/pravaah-be/dist         476 files (nest build deletes this wholesale)
//
//    The `dist` one is not merely wasteful. `nest build` runs with
//    `deleteOutDir: true`, so Metro would stat a directory that vanished
//    mid-crawl and log `Error "ENOENT" reading contents of ...` for each one —
//    a race against another workspace's build, on every cold start.
//
//    If this app ever does import a workspace package, add that package's
//    directory here specifically rather than widening this back to the root.
config.watchFolders = [path.resolve(monorepoRoot, 'node_modules')];

// 2. Resolve modules from the app first, then the hoisted root node_modules.
//    App-first ordering keeps react-native (and its native modules) pinned to
//    the single version this app declares, even though expo / react-navigation
//    are hoisted to the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 3. Packages THIS APP installs are singletons; everything else resolves the way
//    npm laid it out.
//
//    The app pins its own copies of a few packages that the monorepo root also
//    has at a different version — react (root has the admin/web app's 19.2.4),
//    react-native-screens (root has expo-router's newer one). A root-hoisted
//    package walking up the tree would find those root copies: two Reacts is the
//    "Cannot read property 'useMemoCache' of null" crash from the React Compiler
//    runtime, and a screens JS that does not match the native binary is worse.
//    So any package present in the app's own node_modules is ALWAYS resolved
//    from there, whoever imports it.
//
//    This replaced `disableHierarchicalLookup = true`, which guaranteed the same
//    thing by switching off nested lookup for EVERY package — and so silently
//    ignored every version npm deliberately nested. It crashed the dev client at
//    boot: expo needs pretty-format@29 (nested at node_modules/expo/node_modules),
//    Metro took the root's 30.x (hoisted for the backend's Jest), whose ESM
//    wrapper `build/index.mjs` exports `undefined` under Metro's interop, and
//    expo's HMR client died on `prettyFormat.default.default` with
//    "[runtime not ready] Cannot read property 'default' of undefined".
//    Do NOT go back to the blanket flag.
const fs = require('fs');

const appNodeModules = path.resolve(projectRoot, 'node_modules');
const appOwned = new Map();

/** The package a bare specifier names: `react/jsx-runtime` → `react`, `@a/b/c` → `@a/b`. */
function packageNameOf(moduleName) {
  if (moduleName.startsWith('.') || path.isAbsolute(moduleName)) return null;
  const parts = moduleName.split('/');
  return moduleName.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isAppOwned(name) {
  if (!appOwned.has(name)) {
    appOwned.set(name, fs.existsSync(path.join(appNodeModules, name, 'package.json')));
  }
  return appOwned.get(name);
}

// Any file at the app root works as the origin: resolution then starts in
// apps/pravaah-rn/node_modules, so the app's copy wins.
const appOrigin = path.join(projectRoot, 'package.json');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const name = packageNameOf(moduleName);
  if (name && isAppOwned(name) && !context.originModulePath.startsWith(appNodeModules)) {
    return context.resolveRequest(
      { ...context, originModulePath: appOrigin },
      moduleName,
      platform,
    );
  }
  return context.resolveRequest(context, moduleName, platform);
};

// 4. Belt and braces: refuse to resolve out of build output or virtualenvs even
//    if something reaches into them by absolute path. Step 1 keeps them out of
//    the crawl; this keeps them out of the graph.
//
//    Scoped to sibling apps and package dists deliberately — a blanket /dist/
//    pattern would break real dependencies inside node_modules, most of which
//    ship their compiled code in exactly that folder.
config.resolver.blockList = [
  /[\\/]apps[\\/]ml[\\/]\.venv[\\/].*/,
  /[\\/]apps[\\/]ml[\\/]models[\\/].*/,
  /[\\/]apps[\\/]pravaah-be[\\/]dist[\\/].*/,
  /[\\/]apps[\\/]pravaah-be[\\/]generated[\\/].*/,
  /[\\/]apps[\\/]pravaah-admin[\\/]\.next[\\/].*/,
  /[\\/]__pycache__[\\/].*/,
];

module.exports = config;
