export type Locale = 'en' | 'es' | 'fr';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'es', 'fr'];

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'es' || value === 'fr';
}

/**
 * Pure locale resolution. Stored override wins; otherwise iterate the
 * browser's preference list and pick the first tag whose primary subtag is
 * one of the supported locales. Falls back to English.
 */
export function resolveLocale(navLanguages: readonly string[], stored: string | null): Locale {
  if (isLocale(stored)) return stored;
  for (const tag of navLanguages) {
    const primary = tag.toLowerCase().split('-')[0];
    if (primary === 'es' || primary === 'fr' || primary === 'en') {
      return primary;
    }
  }
  return 'en';
}
