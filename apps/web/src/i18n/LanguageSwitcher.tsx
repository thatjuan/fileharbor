import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useLocaleContext } from './LocaleProvider.js';
import { isLocale, SUPPORTED_LOCALES, type Locale } from './resolveLocale.js';
import { useT } from './useT.js';

/**
 * Visible on public pages only. Quiet icon trigger (globe glyph) that
 * reveals a small popover menu of supported locales. Selecting an item
 * updates the active locale via {@link useLocaleContext}.
 *
 * Accessibility:
 *   - Trigger advertises `aria-haspopup="menu"` + `aria-expanded`.
 *   - Menu has `role="menu"`; items are `role="menuitemradio"` with
 *     `aria-checked` reflecting the active locale.
 *   - Escape closes and restores focus to the trigger.
 *   - Outside `pointerdown` closes (registered only while open).
 *   - Active locale is signalled by an inline Action Blue check glyph
 *     (single-accent rule); no background fills.
 */
export function LanguageSwitcher(): JSX.Element {
  const { locale, setLocale } = useLocaleContext();
  const t = useT();
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

  const onSelect = (next: Locale): void => {
    if (isLocale(next)) setLocale(next);
    setOpen(false);
    // Return focus to the trigger so keyboard users keep their place.
    triggerRef.current?.focus();
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className="lang-switch" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="lang-trigger"
        aria-label={t('switcher.triggerAria')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={onTriggerKey}
      >
        <GlobeGlyph />
      </button>
      {open && (
        <ul className="lang-menu" role="menu" aria-label={t('switcher.label')}>
          {SUPPORTED_LOCALES.map((code) => {
            const active = code === locale;
            return (
              <li key={code} role="none">
                <button
                  type="button"
                  className="lang-menu-item"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => onSelect(code)}
                >
                  <span>{t(`switcher.${code}`)}</span>
                  <CheckGlyph />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function GlobeGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.8 3 4.2 6 4.2 9s-1.4 6-4.2 9c-2.8-3-4.2-6-4.2-9s1.4-6 4.2-9z" />
    </svg>
  );
}

function CheckGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12l5 5 9-11" />
    </svg>
  );
}
