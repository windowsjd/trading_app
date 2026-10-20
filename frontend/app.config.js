// Stamps each EAS build with the commit and build it came from (MY › 설정 ›
// 앱 정보 shows it), so an installed APK can be matched to its code: every
// preview APK reports the same version (1.0 / build 1), so nothing else on the
// device tells two builds apart. Outside EAS (Metro, web export) nothing is added.
const { adMobBuildConfig } = require('./config/admob.cjs');

module.exports = ({ config }) => {
  const commit = process.env.EAS_BUILD_GIT_COMMIT_HASH;
  return {
    ...config,
    extra: {
      ...config.extra,
      adMob: adMobBuildConfig(),
      ...(commit
        ? { build: { commit, profile: process.env.EAS_BUILD_PROFILE ?? '', id: process.env.EAS_BUILD_ID ?? '' } }
        : {}),
    },
  };
};
