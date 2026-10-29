import { createContext } from 'react';

/**
 * The guest tabs' two ways out (로그인, 회원가입), provided by MainTabs with
 * the root stack's own navigation. Shared screens (Market, asset detail) can
 * offer them without importing navigation; absent outside guest browsing.
 */
export type GuestExit = { signIn: () => void; signUp: () => void };

export const GuestExitContext = createContext<GuestExit | null>(null);
