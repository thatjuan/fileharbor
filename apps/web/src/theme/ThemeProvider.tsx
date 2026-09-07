import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  applyResolvedTheme,
  readStoredPreference,
  resolveTheme,
  systemPrefersDark,
  writeStoredPreference,
  type ResolvedTheme,
  type ThemePreference,
} from './theme.js';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  children: ReactNode;
}

function initialPreference(): ThemePreference {
  return typeof window === 'undefined' ? 'system' : readStoredPreference();
}

function initialResolved(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return resolveTheme(readStoredPreference(), systemPrefersDark());
}

/**
 * Owns the operator's color-theme preference for the whole SPA.
 *
 * Default is `system`. An explicit light/dark choice is persisted under
 * `fh:theme` and survives reloads. While the preference is `system`, the
 * resolved theme tracks `prefers-color-scheme` live.
 *
 * Mount at the React root so the boot screen, auth, public, and admin
 * surfaces all share one preference.
 */
export function ThemeProvider({ children }: ThemeProviderProps): JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(initialResolved);

  useEffect(() => {
    const apply = (pref: ThemePreference, systemDark: boolean): void => {
      const next = resolveTheme(pref, systemDark);
      applyResolvedTheme(document.documentElement, next);
      setResolved(next);
    };

    apply(preference, systemPrefersDark());

    if (preference !== 'system') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => apply('system', media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference): void => {
    writeStoredPreference(next);
    setPreferenceState(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error('useTheme must be used inside <ThemeProvider>.');
  }
  return ctx;
}
