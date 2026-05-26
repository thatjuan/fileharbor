# Execution Plan: i18n for Public Pages (issues #39–#42)

## Overview

Add a small, hand-rolled i18n layer to the public-facing UI (`/r/:code` and `/s/:code`) supporting English (default), Spanish, and French. Detect locale from `navigator.languages` with a `localStorage` override, sync `<html lang>`, render a language switcher on public pages, and keep admin UI untouched. Bundles infra + English baseline (#39), Spanish (#40), French (#41), and switcher (#42) into a single branch/PR.

## Goals

1. Hand-rolled i18n module in `apps/web/src/i18n/`. No new runtime deps.
2. Auto-detect locale from `navigator.languages` (first match of `^(es|fr)`), fallback `en`.
3. Persist visitor's manual choice in `localStorage` key `fh:public-locale`; override auto-detect when present.
4. Sync `document.documentElement.lang` to active locale on public routes; restore to `en` on unmount.
5. Extract every user-visible string on `PublicReceivePage`, `PublicSendPage`, and the upload-error surface (via a page-level mapping for `lib/upload.ts` thrown messages) into translation catalogs.
6. Provide English / Spanish / French catalogs with full key coverage (compile-time enforced).
7. Add a `LanguageSwitcher` component visible on both public pages — labels in each language (`English` / `Español` / `Français`).
8. Admin shell, login, setup, dashboard untouched.

## Architecture / Approach

### Library choice — hand-rolled

Two pages, ~60 strings, three locales. `react-i18next` (~30KB + plugin churn) and `lingui` (build pipeline) are both oversized for this footprint. Hand-rolled is ~150 lines, zero deps, and the project's existing convention is to keep `apps/web` dependencies minimal (only `react`, `react-router-dom`, `better-auth`).

### Module layout

```
apps/web/src/i18n/
  README.md                 # short note: detection, persistence, plural strategy, scope
  index.ts                  # public API barrel
  LocaleProvider.tsx        # Context + provider; html-lang lifecycle; override persistence
  useT.ts                   # hook returning translate fn
  Trans.tsx                 # component for strings with JSX slots
  resolveLocale.ts          # pure: (navigatorLanguages[], stored) → Locale
  plural.ts                 # Intl.PluralRules wrapper → 'one' | 'other' (sufficient for en/es/fr)
  LanguageSwitcher.tsx
  locales/
    en.ts                   # source of truth — exported as the canonical Catalog type
    es.ts
    fr.ts
```

### Catalog shape

- `en.ts` exports a deeply-nested const object. `Catalog = typeof EN_CATALOG`.
- `es.ts` and `fr.ts` are typed as `Catalog` so every missing key is a TS error. No runtime fallback to English — fail at build time instead.
- Keys grouped by surface: `receive.*`, `send.*`, `common.*`, `errors.*`, `switcher.*`.

Example skeleton:

```ts
// en.ts
export const EN_CATALOG = {
  common: {
    loading: 'Loading…',
    cancel: 'Cancel',
    tryAgain: 'Try again',
  },
  receive: {
    title: 'Upload a file',
    invitedTo: "You've been invited to upload to: {label}",
    password: 'Password',
    pickFile: 'Pick a file',
    preparing: 'Preparing upload…',
    confirming: 'Confirming with server…',
    cancelling: 'Cancelling…',
    cancelled: 'Upload cancelled.',
    cancelUpload: 'Cancel upload',
    uploadComplete: 'Upload complete: {name}',
    uploadAnother: 'Upload another file',
    lockedDefault: 'This link is no longer accepting uploads.',
    notAvailable: 'This upload link is not available. It may be incorrect, disabled, or expired.',
  },
  send: {
    title: 'Download',
    sentYou: "You've been sent: {label}",
    remaining_one: '{n} download remaining{ofMax}.',
    remaining_other: '{n} downloads remaining{ofMax}.',
    ofMax: ' (of {max})',
    unlock: 'Unlock',
    download: 'Download',
    preparing: 'Preparing…',
    noFilesYet: 'No files available yet. Try again in a moment.',
    notAvailable: 'This download link is not available. It may be incorrect, disabled, or expired.',
    downloadUnavailable: 'This download is no longer available.',
  },
  errors: {
    passwordRequiredReceive: 'A password is required to upload to this link.',
    passwordRequiredSend: 'A password is required to download from this link.',
    passwordWrong: 'Incorrect password. Please try again.',
    quotaExhaustedReceive: 'This link has reached its upload limit and is no longer accepting files.',
    quotaExhaustedSend: 'This link has reached its download limit.',
    expired: 'This link has expired.',
    disabled: 'This link is currently disabled.',
    uploadCancelled: 'Upload cancelled.',
    uploadFailedGeneric: 'Upload failed.',
    uploadFailedFinalize: 'Upload failed during finalization.',
    uploadFailedReason: 'Upload failed: {reason}',
    uploadRejectedReason: 'Upload rejected: {reason}',
    uploadObjectNotFound: 'The server could not verify your upload. Please try again.',
    downloadStartFailed: 'Failed to start download.',
  },
  switcher: {
    label: 'Language',
    en: 'English',
    es: 'Español',
    fr: 'Français',
  },
} as const;

export type Catalog = typeof EN_CATALOG;
```

### Translation function

`t(key: string, vars?: Record<string, string | number>): string`

- Key is a dotted path: `'receive.invitedTo'`.
- `{name}` placeholders are replaced literally. Unknown placeholders are left untouched.
- For strings carrying React nodes (`<strong>` etc.), pages use the `<Trans>` component instead.

### `<Trans>` component

```tsx
<Trans
  k="receive.invitedTo"
  components={{ label: <strong>{meta.label}</strong> }}
/>
```

Implementation: tokenises the translated string on `{name}` slots; renders text segments as plain strings and slot tokens as the matching component. ~25 lines. Falls back to plain string substitution if a slot is missing.

### Pluralization

Use `Intl.PluralRules` per active locale. Two keys per plural (e.g. `send.remaining_one` and `send.remaining_other`). Helper:

```ts
function tPlural(locale: Locale, baseKey: string, n: number, vars?): string {
  const rule = new Intl.PluralRules(locale).select(n); // 'one' | 'other' | 'few' | ...
  // For en/es/fr we only need 'one' and 'other'.
  const key = `${baseKey}_${rule === 'one' ? 'one' : 'other'}`;
  return t(key, { ...vars, n });
}
```

`Intl.PluralRules` is universal in evergreen browsers. Both Spanish and French map `1 → 'one'`, everything else (including `0`) → `'other'`, which matches natural copy.

### Detection + persistence

```ts
// resolveLocale.ts
export type Locale = 'en' | 'es' | 'fr';

export function resolveLocale(
  navLanguages: readonly string[],
  stored: string | null,
): Locale {
  if (stored === 'en' || stored === 'es' || stored === 'fr') return stored;
  for (const tag of navLanguages) {
    const primary = tag.toLowerCase().split('-')[0];
    if (primary === 'es' || primary === 'fr') return primary;
    if (primary === 'en') return 'en';
  }
  return 'en';
}
```

Provider on mount: `resolveLocale(navigator.languages ?? [navigator.language], localStorage.getItem('fh:public-locale'))`.

Switcher writes to `localStorage` and updates context state. Clearing the key returns the visitor to auto-detect on next mount.

### `<html lang>` lifecycle

`LocaleProvider` sets `document.documentElement.lang = locale` whenever locale changes, and resets to `'en'` on unmount so SPA navigations to admin/login don't leak `es`/`fr` into the rest of the app.

### Routing integration

Wrap public routes in `App.tsx` with `<LocaleProvider>`:

```tsx
<Route path="/r/:code" element={<LocaleProvider><PublicReceivePage /></LocaleProvider>} />
<Route path="/s/:code" element={<LocaleProvider><PublicSendPage /></LocaleProvider>} />
```

Admin routes get no provider — admin UI continues to render hardcoded English (out of scope).

### Upload error message translation

Reading `apps/web/src/lib/upload.ts`, only two surface paths feed error strings into the public pages' `setError`:

1. The `catch (err)` in `PublicReceivePage.onFileChange` — `setError(err instanceof Error ? err.message : 'Upload failed.')`.
2. The result branches setting messages like `'Upload failed: ${reason}'`, `'Upload rejected: ${reason}'`, `'The server could not verify your upload. Please try again.'`, `'Upload failed during finalization.'`.

To keep `lib/upload.ts` decoupled from i18n (and to minimize blast radius on the just-landed multipart PR), we **do not** refactor `upload.ts` to use codes. Instead:

- `upload.ts` continues throwing English `Error` instances with stable sentinel messages: `'Upload cancelled.'`, `'Upload aborted.'`, `'Missing ETag in response.'`, `'Unknown part-upload failure.'`.
- A new helper `apps/web/src/i18n/uploadErrorKey.ts` exports a function `mapUploadErrorMessage(msg: string): string` returning the appropriate translation key (or `'errors.uploadFailedGeneric'` for unknown).
- Pages call `t(mapUploadErrorMessage(err.message))` instead of `err.message`.
- Result branches in the pages translate their own keys (`errors.uploadObjectNotFound`, `errors.uploadFailedReason`, etc.).

### LanguageSwitcher

Small dropdown / button group rendered at the top of `PublicReceivePage` and `PublicSendPage`. Three options, each labelled in its own language (`English`, `Español`, `Français`). Selecting one calls `setLocale(loc)` from context, which:

1. Updates state (re-renders both pages).
2. Writes `loc` to `localStorage['fh:public-locale']`.
3. Updates `document.documentElement.lang`.

Visual style matches existing controls (`.muted`, `.small`, basic `<select>` or `<button>` row). No designer needed; uses primitives already in `styles.css`.

## Execution Steps

### Wave 1 — Infra + English baseline + html-lang lifecycle

#### Step 1.1 — Create i18n module

**Objective**: Land the i18n module with provider, hook, resolver, plural helper, Trans component, English catalog, and short README. Wire public routes.

**Details**:

Create these files under `apps/web/src/i18n/`:

- `resolveLocale.ts` — pure function per the spec above. Export `Locale` type.
- `plural.ts` — exports `selectPlural(locale: Locale, n: number): 'one' | 'other'` using `Intl.PluralRules`.
- `LocaleProvider.tsx` — Context exposing `{ locale, setLocale }`. Reads stored override + `navigator.languages` on mount. `useEffect` syncs `document.documentElement.lang` and restores `'en'` on unmount. Writes to `localStorage` on `setLocale`.
- `useT.ts` — `useT()` returns `(key: string, vars?) => string` reading current locale's catalog via `useContext`. Resolves dotted path. Throws in dev if key missing (helps catch typos); in prod returns the key itself.
- `Trans.tsx` — `<Trans k="..." components={{...}} vars={{...}} />`. Tokenises on `{name}` slots; emits `React.Fragment` of `string | components[name] | t-substituted value`.
- `locales/en.ts` — full English catalog per the skeleton in this plan. Include every string from `PublicReceivePage`, `PublicSendPage`, and the upload error surface enumerated above. Export `EN_CATALOG` and `type Catalog = typeof EN_CATALOG`.
- `locales/es.ts`, `locales/fr.ts` — stub files exporting an empty object cast as `Catalog` BUT with `// TODO: filled in wave 3` placeholders that still match the type. To keep type safety, populate these with English strings as a temporary value in wave 1 — wave 3 replaces every value with the real translation.
- `index.ts` — re-export the public API: `LocaleProvider`, `useT`, `Trans`, `LanguageSwitcher` (added wave 3), `Locale`, `resolveLocale`.
- `README.md` — ~30 lines covering: scope (public pages only), library choice rationale, detection rule (`navigator.languages` → `^(es|fr)` else `en`), persistence (`localStorage['fh:public-locale']`), html-lang lifecycle, Trans usage, plural strategy, and how to add a new locale.
- `uploadErrorKey.ts` — `mapUploadErrorMessage(msg: string): string` with explicit cases for `'Upload cancelled.'` → `'errors.uploadCancelled'`, `'Upload aborted.'` → `'errors.uploadCancelled'`, default → `'errors.uploadFailedGeneric'`.

Wire `LocaleProvider` around `<Route path="/r/:code">` and `<Route path="/s/:code">` in `App.tsx`. No other route changes.

**Inputs**: `apps/web/src/App.tsx`, plan skeleton, advisor notes.

**Outputs**: New files above; modified `App.tsx`.

**Quality Criteria**:
- `tsc -b` passes.
- `npm run build` (web) passes.
- Visiting `/r/:code` and `/s/:code` still renders identically (no extraction yet — provider is mounted but `t()` not called).
- `document.documentElement.lang` is `en` for a fresh visit with English browser, `es` with Spanish browser, `fr` with French browser.
- Navigating from `/r/:code` to `/login` (manually editing URL) restores `<html lang>` to `en`.

### Wave 2 — Extract strings on both public pages + map upload errors

#### Step 2.1 — Refactor PublicReceivePage to use catalogs

**Objective**: Replace every English string with `t()` / `<Trans>` calls. Visiting with English browser renders identical UI.

**Details**:

In `apps/web/src/pages/PublicReceivePage.tsx`:

- Add `const t = useT();` near the top of the component.
- Replace every JSX-embedded English string with a `t('key')` call, using keys from the catalog skeleton. Examples:
  - `<h1>Upload a file</h1>` → `<h1>{t('receive.title')}</h1>`
  - `Upload complete: <strong>{completedName}</strong>` → `<Trans k="receive.uploadComplete" components={{ name: <strong>{completedName}</strong> }} />`
  - `You've been invited to upload to: <strong>{meta.label}</strong>` → `<Trans k="receive.invitedTo" components={{ label: <strong>{meta.label}</strong> }} />`
  - `Loading…` → `t('common.loading')`
  - `Preparing upload…` → `t('receive.preparing')`
  - `Confirming with server…` → `t('receive.confirming')`
  - `Cancelling…` → `t('receive.cancelling')`
  - `Upload cancelled.` → `t('receive.cancelled')`
  - `Cancel upload` → `t('receive.cancelUpload')`
  - `Upload another file` → `t('receive.uploadAnother')`
  - `Pick a file` → `t('receive.pickFile')`
  - `Password` → `t('receive.password')`
  - `Try again` → `t('common.tryAgain')`
  - The four "This upload link is not available…" / "no longer accepting…" / "Try again" strings → corresponding keys.
- Replace the `handleRejection` switch cases to `setError(t('errors.passwordRequiredReceive'))` etc.
- Replace the `catch (err)` body to `setError(t(mapUploadErrorMessage(err instanceof Error ? err.message : '')))`.
- Replace the two inline failure-result branches: `Upload failed: ${reason}` → `t('errors.uploadFailedReason', { reason })`; `Upload rejected: ${reason}` → `t('errors.uploadRejectedReason', { reason })`; `The server could not verify…` → `t('errors.uploadObjectNotFound')`; `Upload failed during finalization.` → `t('errors.uploadFailedFinalize')`.
- The progress `{progress}%` literal stays as-is — numeric formatting, not localized copy.

**Inputs**: `apps/web/src/pages/PublicReceivePage.tsx`, English catalog from Wave 1.

**Outputs**: Modified `PublicReceivePage.tsx`. No new files.

**Quality Criteria**:
- `tsc -b` clean. Build passes.
- Visiting `/r/:code` with `navigator.language='en-US'` renders byte-identical UI to before this PR (verify by side-by-side: spin a tiny disposable receive link in dev and confirm copy is unchanged).
- All upload flows (single + multipart) still work end-to-end (password gate, cancel, retry, completion, failure surfaces).

#### Step 2.2 — Refactor PublicSendPage to use catalogs

**Objective**: Same as 2.1 for the send page; introduces plural handling for `remaining`.

**Details**:

In `apps/web/src/pages/PublicSendPage.tsx`:

- Add `const t = useT();` and import `selectPlural` from i18n module.
- Replace strings:
  - `<h1>Download</h1>` → `t('send.title')`.
  - `You've been sent: <strong>{meta.label}</strong>` → `<Trans k="send.sentYou" components={{ label: <strong>{meta.label}</strong> }} />`.
  - Remaining-downloads line — use `selectPlural`:
    ```tsx
    const n = meta.remainingDownloads;
    const ofMax = meta.maxDownloads !== null ? t('send.ofMax', { max: meta.maxDownloads }) : '';
    const key = `send.remaining_${selectPlural(locale, n)}`;
    <p className="muted small">{t(key, { n, ofMax })}</p>
    ```
    (Read `locale` from `useLocale()` helper exported from `LocaleProvider`.)
  - `Password` → `t('receive.password')` (reuse).
  - `Unlock` → `t('send.unlock')`.
  - `No files available yet. Try again in a moment.` → `t('send.noFilesYet')`.
  - `Download` → `t('send.download')`. `Preparing…` → `t('send.preparing')`.
  - `Failed to start download.` → `t('errors.downloadStartFailed')`.
  - `This download is no longer available.` → `t('send.downloadUnavailable')`.
  - `This download link is not available…` → `t('send.notAvailable')`.
  - `Loading…` → `t('common.loading')`.
  - `handleRejection` switch arms → `errors.passwordRequiredSend`, `errors.passwordWrong`, `errors.quotaExhaustedSend`, `errors.expired`, `errors.disabled`.
- `formatBytes` units (`B / KB / MB / GB`) — left as-is. These are standard SI units understood across en/es/fr; localizing them adds complexity for negligible benefit. Note this decision in `i18n/README.md`.

**Inputs**: `apps/web/src/pages/PublicSendPage.tsx`.

**Outputs**: Modified file.

**Quality Criteria**:
- Build clean.
- English visitor sees identical UI.
- Plural keys exist in `en.ts` for both `_one` and `_other`.
- Setting `localStorage['fh:public-locale']='es'` (manually in devtools) does not crash (will render English keys still, since es catalog is a stub in wave 1; wave 3 fills it).

### Wave 3 — Spanish + French catalogs + Language switcher

#### Step 3.1 — Spanish catalog

**Objective**: Fill `apps/web/src/i18n/locales/es.ts` with natural Spanish for every key.

**Details**: Replace every value in `es.ts` with a high-quality, general-audience Spanish translation. No region-specific dialect. Preserve `{placeholder}` tokens exactly. Plural keys: `remaining_one` covers `n === 1`, `remaining_other` covers everything else including `0`.

Reference translations to use (apply Spanish-language reading conventions — capitalization, ellipsis, inverted punctuation where natural):

- `common.loading` — `Cargando…`
- `common.cancel` — `Cancelar`
- `common.tryAgain` — `Volver a intentar`
- `receive.title` — `Subir un archivo`
- `receive.invitedTo` — `Se te ha invitado a subir a: {label}`
- `receive.password` — `Contraseña`
- `receive.pickFile` — `Elige un archivo`
- `receive.preparing` — `Preparando subida…`
- `receive.confirming` — `Confirmando con el servidor…`
- `receive.cancelling` — `Cancelando…`
- `receive.cancelled` — `Subida cancelada.`
- `receive.cancelUpload` — `Cancelar subida`
- `receive.uploadComplete` — `Subida completada: {name}`
- `receive.uploadAnother` — `Subir otro archivo`
- `receive.lockedDefault` — `Este enlace ya no acepta subidas.`
- `receive.notAvailable` — `Este enlace de subida no está disponible. Puede ser incorrecto, estar deshabilitado o haber expirado.`
- `send.title` — `Descargar`
- `send.sentYou` — `Se te ha enviado: {label}`
- `send.remaining_one` — `Queda {n} descarga{ofMax}.`
- `send.remaining_other` — `Quedan {n} descargas{ofMax}.`
- `send.ofMax` — ` (de {max})`
- `send.unlock` — `Desbloquear`
- `send.download` — `Descargar`
- `send.preparing` — `Preparando…`
- `send.noFilesYet` — `Todavía no hay archivos disponibles. Vuelve a intentarlo en un momento.`
- `send.notAvailable` — `Este enlace de descarga no está disponible. Puede ser incorrecto, estar deshabilitado o haber expirado.`
- `send.downloadUnavailable` — `Esta descarga ya no está disponible.`
- `errors.passwordRequiredReceive` — `Se requiere una contraseña para subir a este enlace.`
- `errors.passwordRequiredSend` — `Se requiere una contraseña para descargar desde este enlace.`
- `errors.passwordWrong` — `Contraseña incorrecta. Vuelve a intentarlo.`
- `errors.quotaExhaustedReceive` — `Este enlace ha alcanzado su límite de subidas y ya no acepta archivos.`
- `errors.quotaExhaustedSend` — `Este enlace ha alcanzado su límite de descargas.`
- `errors.expired` — `Este enlace ha expirado.`
- `errors.disabled` — `Este enlace está deshabilitado.`
- `errors.uploadCancelled` — `Subida cancelada.`
- `errors.uploadFailedGeneric` — `La subida falló.`
- `errors.uploadFailedFinalize` — `La subida falló durante la finalización.`
- `errors.uploadFailedReason` — `Subida fallida: {reason}`
- `errors.uploadRejectedReason` — `Subida rechazada: {reason}`
- `errors.uploadObjectNotFound` — `El servidor no pudo verificar tu subida. Vuelve a intentarlo.`
- `errors.downloadStartFailed` — `No se pudo iniciar la descarga.`
- `switcher.label` — `Idioma`
- `switcher.en` — `English`
- `switcher.es` — `Español`
- `switcher.fr` — `Français`

**Outputs**: Filled `es.ts`.

**Quality Criteria**:
- `tsc -b` passes (every key from `Catalog` present).
- Browser with `navigator.language='es'` (or `es-ES`, `es-MX`) lands on `/r/:code` → Spanish UI.
- `<html lang>` becomes `es`.
- Upload-flow errors render in Spanish.

#### Step 3.2 — French catalog

**Objective**: Same for French.

**Details**: Translation values:

- `common.loading` — `Chargement…`
- `common.cancel` — `Annuler`
- `common.tryAgain` — `Réessayer`
- `receive.title` — `Téléverser un fichier`
- `receive.invitedTo` — `Vous avez été invité·e à téléverser vers : {label}`
- `receive.password` — `Mot de passe`
- `receive.pickFile` — `Choisir un fichier`
- `receive.preparing` — `Préparation du téléversement…`
- `receive.confirming` — `Confirmation avec le serveur…`
- `receive.cancelling` — `Annulation…`
- `receive.cancelled` — `Téléversement annulé.`
- `receive.cancelUpload` — `Annuler le téléversement`
- `receive.uploadComplete` — `Téléversement terminé : {name}`
- `receive.uploadAnother` — `Téléverser un autre fichier`
- `receive.lockedDefault` — `Ce lien n'accepte plus de téléversements.`
- `receive.notAvailable` — `Ce lien de téléversement n'est pas disponible. Il peut être incorrect, désactivé ou expiré.`
- `send.title` — `Télécharger`
- `send.sentYou` — `On vous a envoyé : {label}`
- `send.remaining_one` — `{n} téléchargement restant{ofMax}.`
- `send.remaining_other` — `{n} téléchargements restants{ofMax}.`
- `send.ofMax` — ` (sur {max})`
- `send.unlock` — `Déverrouiller`
- `send.download` — `Télécharger`
- `send.preparing` — `Préparation…`
- `send.noFilesYet` — `Aucun fichier disponible pour le moment. Réessayez dans un instant.`
- `send.notAvailable` — `Ce lien de téléchargement n'est pas disponible. Il peut être incorrect, désactivé ou expiré.`
- `send.downloadUnavailable` — `Ce téléchargement n'est plus disponible.`
- `errors.passwordRequiredReceive` — `Un mot de passe est requis pour téléverser vers ce lien.`
- `errors.passwordRequiredSend` — `Un mot de passe est requis pour télécharger depuis ce lien.`
- `errors.passwordWrong` — `Mot de passe incorrect. Veuillez réessayer.`
- `errors.quotaExhaustedReceive` — `Ce lien a atteint sa limite de téléversements et n'accepte plus de fichiers.`
- `errors.quotaExhaustedSend` — `Ce lien a atteint sa limite de téléchargements.`
- `errors.expired` — `Ce lien a expiré.`
- `errors.disabled` — `Ce lien est actuellement désactivé.`
- `errors.uploadCancelled` — `Téléversement annulé.`
- `errors.uploadFailedGeneric` — `Échec du téléversement.`
- `errors.uploadFailedFinalize` — `Échec du téléversement lors de la finalisation.`
- `errors.uploadFailedReason` — `Échec du téléversement : {reason}`
- `errors.uploadRejectedReason` — `Téléversement rejeté : {reason}`
- `errors.uploadObjectNotFound` — `Le serveur n'a pas pu vérifier votre téléversement. Veuillez réessayer.`
- `errors.downloadStartFailed` — `Impossible de démarrer le téléchargement.`
- `switcher.label` — `Langue`
- `switcher.en` — `English`
- `switcher.es` — `Español`
- `switcher.fr` — `Français`

Note: French plural rule — `0` and `1` both map to `'one'` per CLDR. `Intl.PluralRules('fr').select(0) === 'one'`. Verify French copy reads naturally for `n=0` (`0 téléchargement restant` — valid French).

**Outputs**: Filled `fr.ts`.

**Quality Criteria**:
- `tsc -b` passes.
- `navigator.language='fr'` / `fr-FR` / `fr-CA` → French UI.
- `<html lang>` becomes `fr`.

#### Step 3.3 — Language switcher

**Objective**: Add `<LanguageSwitcher />` rendered at the top of both public pages.

**Details**:

- New file `apps/web/src/i18n/LanguageSwitcher.tsx`. Render a labelled `<select>` (most accessible, fits existing form-control style):

  ```tsx
  export function LanguageSwitcher(): JSX.Element {
    const { locale, setLocale } = useLocaleContext();
    const t = useT();
    return (
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <label className="small muted">
          {t('switcher.label')}{' '}
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
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
  ```

- Wire into `PublicReceivePage` and `PublicSendPage`: render `<LanguageSwitcher />` as the first child of `<main className="page">` on both pages (above the `<h1>`).
- `setLocale` (added to `LocaleProvider` context) writes `loc` to `localStorage['fh:public-locale']`, updates state, and the existing `useEffect` syncs `<html lang>`.
- Confirm clearing `localStorage` and reloading returns the user to auto-detect (already implicit from `resolveLocale`'s behaviour with `stored=null`).
- Confirm switcher is NOT rendered anywhere in `AdminShell` or admin routes (only public pages mount `LocaleProvider`, and the switcher is only imported from those two pages).

**Outputs**: New `LanguageSwitcher.tsx`; modified both public pages.

**Quality Criteria**:
- Build passes.
- Manual test: visit `/r/:code` with English browser, select Spanish in switcher → UI flips immediately, `<html lang>` becomes `es`, `localStorage['fh:public-locale']==='es'`.
- Reload → still Spanish (override sticky).
- Clear `localStorage` and reload → returns to browser auto-detect.
- Selecting French → French UI, `<html lang>` becomes `fr`.
- Admin pages unaffected (no switcher).

## Integration Points

- **`App.tsx` ↔ `LocaleProvider`**: provider wraps only the two public `<Route>`s. Admin tree continues to render without provider; `useT` outside provider must throw a clear error (helps catch accidental misuse).
- **Pages ↔ `lib/upload.ts`**: pages translate thrown error messages via `mapUploadErrorMessage`. `upload.ts` itself remains English and i18n-agnostic.
- **`<html lang>` lifecycle**: managed entirely by `LocaleProvider`. Unmount path resets to `en` so SPA navigation from `/r/:code` → `/login` does not leave a stale `lang` attribute.

## Quality Assurance

### Automated

- `npm run build` (from `apps/web/`) passes after each wave.
- `tsc -b` from repo root passes after each wave.
- `npm run lint` (if defined; check `eslint.config.js`) passes.
- `npm run test` (if defined in `package.json`s) passes.

### Manual verification (in dev server)

Run `npm --workspace @fileharbor/web run dev` and verify:

1. English browser (`navigator.language='en-US'`): both public pages render identical to the pre-PR baseline.
2. Spanish browser (open devtools → emulate, or set `navigator.languages` override): Spanish UI, `<html lang>=es`.
3. French browser: French UI, `<html lang>=fr`.
4. Browser with neither: falls back to English.
5. Switcher: visible on both pages, switches UI immediately, persists across reloads, sticky override beats `navigator.languages`.
6. Clearing `localStorage` returns to auto-detect.
7. Admin pages (`/`, `/login`, `/setup`, `/links/...`) unchanged.
8. Upload happy path on `/r/:code` in all three locales (use a tiny test file). Verify completion message + cancel + retry copy.
9. Download happy path on `/s/:code` in all three locales (mint a link from admin, copy URL, open in incognito with each language). Verify remaining-downloads pluralization (mint a 1-download and a 3-download link).
10. Wrong password / disabled / expired / quota states render in the active language.

## Risk Register

| Risk | Mitigation |
|---|---|
| Missing key at runtime crashes page | `Catalog` typing forces every key in every locale at compile time. Dev-mode `t()` throws on missing key for fast detection. |
| `upload.ts` future changes add new sentinel messages | `mapUploadErrorMessage` defaults to `errors.uploadFailedGeneric` — fail safe to English-equivalent generic copy. |
| `Intl.PluralRules` unsupported | Universal in browsers File Harbor supports (evergreen + recent Safari). Accept. |
| Switcher overlaps with future admin i18n | Switcher lives in `apps/web/src/i18n/LanguageSwitcher.tsx` but is only imported by public pages. Admin can add its own switcher later. |
| `<html lang>` not restored on browser back-navigation | `LocaleProvider` `useEffect` cleanup handles unmount; SPA route changes unmount the provider. Verify in manual test step 7. |
| Translation quality issues | Translations vetted against natural-audience standard. Future PR can refine without changing infra. |

## File Structure (after PR)

```
apps/web/src/
  i18n/                            # NEW
    README.md
    index.ts
    LocaleProvider.tsx
    Trans.tsx
    LanguageSwitcher.tsx
    useT.ts
    resolveLocale.ts
    plural.ts
    uploadErrorKey.ts
    locales/
      en.ts
      es.ts
      fr.ts
  pages/
    PublicReceivePage.tsx           # MODIFIED — strings → t()/<Trans>
    PublicSendPage.tsx              # MODIFIED — strings → t()/<Trans>
  App.tsx                           # MODIFIED — wrap public routes in <LocaleProvider>
  lib/
    upload.ts                       # UNCHANGED
```

No server-side changes. No new runtime deps.
