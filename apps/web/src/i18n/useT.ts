import { useCallback } from 'react';

import { useLocaleContext } from './LocaleProvider.js';
import type { Catalog } from './locales/en.js';

export type TranslateVars = Record<string, string | number>;

/**
 * Hook returning a translate function for the active locale. Keys are dotted
 * paths into the catalog (`receive.title`, `errors.passwordWrong`). Unknown
 * keys throw in development and return the key string in production — that
 * way typo regressions surface immediately during dev but production never
 * shows blank UI.
 */
export function useT(): (key: string, vars?: TranslateVars) => string {
  const { catalog } = useLocaleContext();
  return useCallback((key, vars) => translate(catalog, key, vars), [catalog]);
}

export function translate(catalog: Catalog, key: string, vars?: TranslateVars): string {
  const value = resolveKey(catalog, key);
  if (value === null) {
    if (import.meta.env.DEV) {
      throw new Error(`i18n: missing key "${key}"`);
    }
    return key;
  }
  return vars ? interpolate(value, vars) : value;
}

function resolveKey(catalog: Catalog, key: string): string | null {
  const parts = key.split('.');
  let current: unknown = catalog;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : null;
}

function interpolate(template: string, vars: TranslateVars): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string): string => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      if (v === undefined) return match;
      return typeof v === 'number' ? String(v) : v;
    }
    return match;
  });
}
