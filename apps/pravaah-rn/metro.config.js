// Learn more: https://docs.expo.dev/guides/monorepo/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch ONLY the hoisted node_modules, not the whole monorepo.
//
//    This app imports nothing from `packages/` or its sibling apps — it needs the
//    workspace root purely because npm hoists `expo`, `expo-router`,
//    `react-native` and `@react-navigation/*` up there. Watching the entire
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

// 3. Disable hierarchical (walk-up) lookup so EVERY module — including packages
//    hoisted to the root such as react-native — resolves `react` through the
//    app-first paths above. Without this, root-hoisted packages find the
//    admin/web app's react@19.2.x at the root, producing a second React
//    instance and the runtime "Cannot read property 'useMemoCache' of null"
//    crash from the React Compiler runtime. This guarantees a single React.
config.resolver.disableHierarchicalLookup = true;

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
