import { normalizeMetaAppId } from './shareTargets.ts';

declare const process: { env: { EXPO_PUBLIC_META_APP_ID?: string } } | undefined;
// Static dot notation, so babel-preset-expo inlines it (see constants/env.ts).
const RAW_META_APP_ID = typeof process === 'undefined' ? undefined : process.env.EXPO_PUBLIC_META_APP_ID;

/**
 * The app's Meta (Facebook) App ID for Instagram Stories sharing — public by
 * design (it travels in every share intent). Registering the app with Meta is
 * the operator's step; until EAS sets this, 인스타그램 스토리 says it is not
 * ready instead of sending the user to Instagram's "doesn't support sharing
 * to Stories" error.
 */
export const META_APP_ID = normalizeMetaAppId(RAW_META_APP_ID);
