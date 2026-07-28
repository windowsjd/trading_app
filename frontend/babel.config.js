// Plain Expo default. The Worklets Babel plugin that once lived here was only
// needed by react-native-reanimated, which the app no longer depends on — the
// chart's gestures are gesture-handler recognizers with JS callbacks, so there
// is no worklet to compile.
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
