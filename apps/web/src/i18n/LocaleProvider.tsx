import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { EN_CATALOG, type Catalog } from './locales/en.js';
import { ES_CATALOG } from './locales/es.js';
import { FR_CATALOG } from './locales/fr.js';
import { isLocale, resolveLocale, type Locale } from './resolveLocale.js';

const STORAGE_KEY = 'fh:public-locale';

const CATALOGS: Record<Locale, Catalog> = {
  en: EN_CATALOG,
  es: ES_CATALOG,
  fr: FR_CATALOG,
};

interface LocaleContextValue {
  locale: Locale;
  catalog: Catalog;
  setLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

interface LocaleProviderProps {
  children: ReactNode;
}

/**
 * Mounts only on public routes (`/r/:code`, `/s/:code`). On mount, resolves
 * the active locale from a `localStorage` override (if present) or the
 * browser's `navigator.languages`. Keeps `document.documentElement.lang` in
 * sync with the active locale and restores it to `en` on unmount so SPA
 * navigation into admin/login routes does not leak a stale `lang`.
 */
export function LocaleProvider({ children }: LocaleProviderProps): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = readStoredLocale();
    const navLanguages = typeof navigator !== 'undefined' ? navigator.languages : undefined;
    const navLang = typeof navigator !== 'undefined' ? navigator.language : undefined;
    return resolveLocale(navLanguages ?? (navLang ? [navLang] : []), stored);
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.documentElement.lang;
    document.documentElement.lang = locale;
    return () => {
      document.documentElement.lang = previous || 'en';
    };
  }, [locale]);

  const setLocale = useCallback((next: Locale): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable (private mode, quota). The in-memory
      // state still updates; the choice just won't survive a reload.
    }
    setLocaleState(next);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, catalog: CATALOGS[locale], setLocale }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocaleContext(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (ctx === null) {
    throw new Error('useLocaleContext must be used inside <LocaleProvider>.');
  }
  return ctx;
}

function readStoredLocale(): Locale | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}
