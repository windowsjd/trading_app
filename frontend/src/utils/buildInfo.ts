/**
 * The 앱 정보 line that names this build: the commit (and EAS profile) that
 * app.config.js stamps into EAS builds, so an installed APK can be matched to
 * its code. Anything else (Metro, web, a malformed stamp) is a 개발 빌드.
 */
export function describeBuild(build: unknown): string {
  const stamp = build && typeof build === 'object' ? (build as { commit?: unknown; profile?: unknown }) : null;
  const commit = typeof stamp?.commit === 'string' ? stamp.commit.trim() : '';
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return '개발 빌드';
  const profile = typeof stamp?.profile === 'string' ? stamp.profile.trim() : '';
  return `빌드 ${commit.slice(0, 8).toLowerCase()}${profile ? ` · ${profile}` : ''}`;
}

/**
 * 앱 정보's version line (2026-11-11): THIS installed build's version and build
 * number as the OS and the stores report them (expo-application's native
 * values — what the update notice compares), not app.json's, whose `version`
 * a native Android project does not take on its own. Not an installed app
 * (web) or unreadable: said so, never a made-up number (it read a fixed
 * "0.1.0" before).
 */
export function describeAppVersion(version: unknown, build: unknown): string {
  const name = typeof version === 'string' ? version.trim() : '';
  if (!/^\d{1,4}(\.\d{1,4}){0,3}$/.test(name)) return '앱 버전 확인 불가';
  const number = typeof build === 'string' ? build.trim() : '';
  return `앱 버전 ${name}${/^\d+(\.\d+){0,3}$/.test(number) ? ` (빌드 ${number})` : ''}`;
}
