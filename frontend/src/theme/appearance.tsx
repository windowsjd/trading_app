import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Appearance, Platform, StatusBar, useColorScheme, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FINANCIAL_COLOR_STORAGE_KEY, getFinancialColors, parseFinancialColorPreference, type FinancialColorPreference } from './financialColors';

export type AppearancePreference = 'system' | 'light' | 'dark';
export type AppearanceMode = 'light' | 'dark';

const STORAGE_KEY = 'trading-app:appearance';
// App surfaces, text and UI status. Financial meanings live in financialColors.ts.
// screen: page canvas; surface: major cards/sheets; raised/input: inset controls.
export const PALETTES = {
  light: {
    screen: '#fcfcfd', surface: '#ffffff', raised: '#f7f8fa',
    text: '#202a35', secondary: '#536170', muted: '#697583',
    border: '#e5e8eb', input: '#f7f8fa', selected: '#202a35',
    placeholder: '#7c8793', cursor: '#202a35', navigation: '#ffffff',
    navigationActive: '#202a35', navigationInactive: '#697583', pressed: '#202a3520',
    successSurface: '#eef7ee', errorSurface: '#fff0f0',
    success: '#166534', error: '#b32d2d', warning: '#725400',
    warningSurface: '#fff8e1', info: '#245b76', infoSurface: '#e3f2fd',
    onAccent: '#ffffff', infoAction: '#245b76',
  },
  dark: {
    screen: '#10151c', surface: '#1b2530', raised: '#273543',
    text: '#f2f5f7', secondary: '#c5d0da', muted: '#aebbc8',
    border: '#435364', input: '#273543', selected: '#344657',
    placeholder: '#aebbc8', cursor: '#f2f5f7', navigation: '#080a0d',
    navigationActive: '#ffffff', navigationInactive: '#9aa8b6', pressed: '#ffffff20',
    successSurface: '#1d392b', errorSurface: '#38232a',
    success: '#79d68b', error: '#ff8585', warning: '#e8bf69',
    warningSurface: '#3a3020', info: '#9acbe2', infoSurface: '#1c3045',
    onAccent: '#ffffff', infoAction: '#245b76',
  },
} as const;

export type AppearancePalette = typeof PALETTES.light | typeof PALETTES.dark;
export function resolveAppearance(preference: AppearancePreference, system: string | null): AppearanceMode {
  return preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;
}
export function parseAppearancePreference(value: string | null): AppearancePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

type AppearanceContextValue = {
  preference: AppearancePreference;
  mode: AppearanceMode;
  colors: AppearancePalette;
  setPreference: (value: AppearancePreference) => void;
  financialPreference: FinancialColorPreference;
  financialColors: ReturnType<typeof getFinancialColors>;
  setFinancialPreference: (value: FinancialColorPreference) => void;
};
const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<AppearancePreference>('system');
  const [ready, setReady] = useState(false);
  const revision = useRef(0);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const [financialPreference, setFinancialPreferenceState] = useState<FinancialColorPreference>('red_blue');
  const financialRevision = useRef(0);
  const financialWrites = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let active = true;
    const appearanceRead = AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => { if (active && revision.current === 0) setPreferenceState(parseAppearancePreference(value)); })
      .catch(() => { if (active && revision.current === 0) setPreferenceState('system'); });
    const financialRead = AsyncStorage.getItem(FINANCIAL_COLOR_STORAGE_KEY)
      .then((value) => { if (active && financialRevision.current === 0) setFinancialPreferenceState(parseFinancialColorPreference(value)); })
      .catch(() => { if (active && financialRevision.current === 0) setFinancialPreferenceState('red_blue'); });
    void Promise.all([appearanceRead, financialRead]).then(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  const setPreference = (value: AppearancePreference) => {
    const current = ++revision.current;
    setPreferenceState(value);
    writes.current = writes.current.catch(() => undefined).then(() => AsyncStorage.setItem(STORAGE_KEY, value))
      .catch(() => { if (revision.current === current) setPreferenceState('system'); });
  };
  const setFinancialPreference = (value: FinancialColorPreference) => {
    const current = ++financialRevision.current;
    setFinancialPreferenceState(value);
    financialWrites.current = financialWrites.current.catch(() => undefined)
      .then(() => AsyncStorage.setItem(FINANCIAL_COLOR_STORAGE_KEY, value))
      .catch(() => { if (financialRevision.current === current) setFinancialPreferenceState('red_blue'); });
  };
  const mode = resolveAppearance(preference, system);
  const colors = PALETTES[mode];
  const financialColors = useMemo(() => getFinancialColors(mode, financialPreference), [mode, financialPreference]);
  const context = useMemo(() => ({ preference, mode, colors, setPreference, financialPreference, financialColors, setFinancialPreference }), [preference, mode, colors, financialPreference, financialColors]);

  useEffect(() => {
    if (!ready) return;
    if (Platform.OS === 'web') {
      if (typeof document !== 'undefined') {
        document.documentElement.style.colorScheme = mode;
        document.documentElement.style.backgroundColor = colors.screen;
      }
    } else {
      Appearance.setColorScheme(preference === 'system' ? null : mode);
    }
  }, [ready, preference, mode, colors.screen]);

  // Wait for the device-local preference before mounting NavigationContainer.
  // This prevents a stored dark choice from briefly rendering light screens.
  if (!ready) return <View style={{ flex: 1, backgroundColor: system === 'dark' ? PALETTES.dark.screen : PALETTES.light.screen }} />;
  return (
    <AppearanceContext.Provider value={context}>
      <StatusBar barStyle={mode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={colors.screen} />
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('AppearanceProvider is required');
  return value;
}
