// Public identifiers, not credentials. Only EAS build profiles choose the mode.
const TEST_REWARDED_UNITS = Object.freeze({
  android: 'ca-app-pub-3940256099942544/5224354917',
  ios: 'ca-app-pub-3940256099942544/1712485313',
});

function adMobBuildConfig(env = process.env) {
  // EAS CLI evaluates config locally with placeholders for worker-only builtins.
  // The profile's explicit env value makes that evaluation match the worker.
  const profile = env.ADMOB_BUILD_PROFILE ?? env.EAS_BUILD_PROFILE;
  const workerProfile = typeof env.EAS_BUILD_PROFILE === 'string' ? env.EAS_BUILD_PROFILE : profile;
  const test = (profile === 'development' || profile === 'preview') && profile === workerProfile;
  return {
    mode: test ? 'test' : 'disabled',
    profile: typeof profile === 'string' ? profile : null,
    // Real production units are prepared but NEVER requested in this release.
    rewardedUnits: test ? { ...TEST_REWARDED_UNITS } : {
      android: env.ADMOB_REWARDED_ANDROID_ID ?? null,
      ios: env.ADMOB_REWARDED_IOS_ID ?? null,
    },
  };
}

module.exports = { adMobBuildConfig, TEST_REWARDED_UNITS };
