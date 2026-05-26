import { useLocaleContext } from './LocaleProvider.js';
import { isLocale } from './resolveLocale.js';
import { useT } from './useT.js';

/**
 * Visible on public pages only. Selecting an option updates the active
 * locale, persists the choice in `localStorage`, and (via `LocaleProvider`)
 * syncs `document.documentElement.lang`.
 */
export function LanguageSwitcher(): JSX.Element {
  const { locale, setLocale } = useLocaleContext();
  const t = useT();
  return (
    <div className="row" style={{ justifyContent: 'flex-end', marginBottom: '1rem' }}>
      <label className="small muted">
        {t('switcher.label')}{' '}
        <select
          value={locale}
          onChange={(e) => {
            const next = e.target.value;
            if (isLocale(next)) setLocale(next);
          }}
          aria-label={t('switcher.label')}
        >
          <option value="en">{t('switcher.en')}</option>
          <option value="es">{t('switcher.es')}</option>
          <option value="fr">{t('switcher.fr')}</option>
        </select>
      </label>
    </div>
  );
}
