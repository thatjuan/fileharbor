import { useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from '../components/Icons.js';
import { LocaleContext } from '../i18n/LocaleProvider.js';
import { translate } from '../i18n/useT.js';
import { THEME_PREFERENCES, type ThemePreference } from './theme.js';
import { useTheme } from './ThemeProvider.js';

interface ThemeCopy {
  triggerAria: string;
  menu: string;
  system: string;
  light: string;
  dark: string;
}

const EN_COPY: ThemeCopy = {
  triggerAria: 'Color theme',
  menu: 'Color theme',
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Compact icon trigger that opens a three-item menu: System, Light, Dark.
 *
 * Lives in admin chrome, public nav, and auth pages. Copy is English by
 * default (admin is English-only); on public routes it picks up the active
 * catalog via the optional locale context.
 *
 * Interaction matches the language switcher: Escape and outside click close,
 * focus returns to the trigger, the active item is a radio with a check glyph.
 */
export function ThemeSwitcher(): JSX.Element {
  const { preference, setPreference } = useTheme();
  const copy = useThemeCopy();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      const root = containerRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onSelect = (next: ThemePreference): void => {
    setPreference(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className="chrome-switch" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn-icon"
        aria-label={copy.triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={onTriggerKey}
      >
        <PreferenceIcon preference={preference} />
      </button>
      {open && (
        <ul className="chrome-menu" role="menu" aria-label={copy.menu}>
          {THEME_PREFERENCES.map((value) => {
            const active = value === preference;
            return (
              <li key={value} role="none">
                <button
                  type="button"
                  className="chrome-menu-item"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => onSelect(value)}
                >
                  <span className="chrome-menu-item-label">
                    <PreferenceIcon preference={value} />
                    {copy[value]}
                  </span>
                  {active && <CheckIcon size={12} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PreferenceIcon({ preference }: { preference: ThemePreference }): JSX.Element {
  if (preference === 'light') return <SunIcon size={16} />;
  if (preference === 'dark') return <MoonIcon size={16} />;
  return <MonitorIcon size={16} />;
}

function useThemeCopy(): ThemeCopy {
  const locale = useContext(LocaleContext);
  if (locale === null) return EN_COPY;
  return {
    triggerAria: translate(locale.catalog, 'theme.triggerAria'),
    menu: translate(locale.catalog, 'theme.menu'),
    system: translate(locale.catalog, 'theme.system'),
    light: translate(locale.catalog, 'theme.light'),
    dark: translate(locale.catalog, 'theme.dark'),
  };
}
