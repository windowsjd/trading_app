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
