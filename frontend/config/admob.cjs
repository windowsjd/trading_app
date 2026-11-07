// Public identifiers, not credentials. Only EAS build profiles choose the mode.
// Google's official sample units (developers.google.com/admob/*/test-ads):
// development/preview builds may request only these.
const TEST_UNITS = Object.freeze({
  rewarded: Object.freeze({
    android: 'ca-app-pub-3940256099942544/5224354917',
    ios: 'ca-app-pub-3940256099942544/1712485313',
  }),
  // Anchored adaptive banner samples.
  banner: Object.freeze({
    android: 'ca-app-pub-3940256099942544/9214589741',
    ios: 'ca-app-pub-3940256099942544/2435281174',
  }),
});

// Trading Class's own units (confirmed 2026-11-07): requested ONLY by a
// production build. Rewarded and banner are separate units per platform and
// never interchangeable (a banner pays nothing; only the rewarded units carry
// the server-side verification callback).
const PRODUCTION_UNITS = Object.freeze({
  rewarded: Object.freeze({
    android: 'ca-app-pub-7899930948413451/3165650506',
    ios: 'ca-app-pub-7899930948413451/8170740188',
  }),
  banner: Object.freeze({
    android: 'ca-app-pub-7899930948413451/9868671521',
    ios: 'ca-app-pub-7899930948413451/1842841847',
  }),
});

function adMobBuildConfig(env = process.env) {
  // EAS CLI evaluates config locally with placeholders for worker-only builtins.
  // The profile's explicit env value makes that evaluation match the worker.
  const profile = env.ADMOB_BUILD_PROFILE ?? env.EAS_BUILD_PROFILE;
  const workerProfile = typeof env.EAS_BUILD_PROFILE === 'string' ? env.EAS_BUILD_PROFILE : profile;
  const known = typeof profile === 'string' && profile === workerProfile;
  // An unknown profile, a profile mismatch or a plain local run requests no ad at all.
  const mode = known && (profile === 'development' || profile === 'preview') ? 'test'
    : known && profile === 'production' ? 'production' : 'disabled';
  const units = mode === 'test' ? TEST_UNITS : mode === 'production' ? PRODUCTION_UNITS : null;
  return {
    mode,
    profile: typeof profile === 'string' ? profile : null,
    rewardedUnits: units ? { ...units.rewarded } : {},
    bannerUnits: units ? { ...units.banner } : {},
  };
}

module.exports = { adMobBuildConfig, TEST_UNITS, PRODUCTION_UNITS };
