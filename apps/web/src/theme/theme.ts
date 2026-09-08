/**
 * Color-theme preference and resolution.
 *
 * The stored preference is `system | light | dark`. `system` (the default)
 * follows `prefers-color-scheme`. The resolved value written to
 * `document.documentElement.dataset.theme` is always `light` or `dark`,
 * which is what `tokens.css` keys off.
 *
 * First paint is handled by `/theme-boot.js` (a static file, so it survives
 * CSP `script-src 'self'`). This module is the source of truth React uses
 * after mount; keep the two in lockstep.
 */

export const THEME_STORAGE_KEY = 'fh:theme';

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type ResolvedTheme = 'light' | 'dark';

/** Canvas hexes, used for `theme-color` and the first-paint fallback. */
export const THEME_CANVAS: Record<ResolvedTheme, string> = {
  dark: '#111413',
  light: '#fefdfd',
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Resolve a stored preference against the current OS color scheme.
 * Explicit light/dark always win; `system` follows `systemPrefersDark`.
 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemPrefersDark ? 'dark' : 'light';
}

export function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function writeStoredPreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private mode / quota. In-memory state still updates.
  }
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** Stamp the resolved theme on `<html>` so CSS and native controls agree. */
export function applyResolvedTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!(meta instanceof HTMLMetaElement)) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', THEME_CANVAS[resolved]);
}
