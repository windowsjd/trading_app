// Added for react-native-reanimated 4: its worklets runtime requires this
// Babel plugin, and it must stay LAST in the plugin list. Everything else is
// the Expo default that Metro used before this file existed.
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
