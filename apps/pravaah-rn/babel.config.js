/**
 * Reanimated 4 runs its animations on worklets, and worklets only exist if the
 * `react-native-worklets` Babel plugin compiles them. Without this file the
 * `react-native-worklets` dependency is inert and every `useAnimatedStyle` in
 * the app silently animates nothing — which is exactly the state this app was
 * in before the design pass.
 *
 * The plugin MUST be last: it needs to see the fully-transformed output.
 * `babel-preset-expo` still reads `experiments.reactCompiler` from app.json, so
 * adding this file does not turn the React Compiler off.
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
