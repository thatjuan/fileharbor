import type { Locale } from './resolveLocale.js';

/**
 * Pick a plural bucket for `n` in the given locale. Catalogs use only
 * `_one` and `_other` suffixes; for en/es/fr that covers every CLDR rule
 * we need (en: 1 vs other; es: 1 vs other; fr: 0/1 vs other).
 */
export function selectPlural(locale: Locale, n: number): 'one' | 'other' {
  return new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other';
}
