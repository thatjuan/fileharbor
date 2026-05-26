# Public-page i18n

Small hand-rolled i18n layer for the public-facing pages (`/r/:code`, `/s/:code`). Supports `en`, `es`, `fr`. Admin UI is intentionally out of scope.

## Why hand-rolled

Two pages, ~60 strings, three locales. `react-i18next` and `lingui` are both oversized for this footprint. The whole module is a few hundred lines, zero runtime deps, and stays consistent with the project's minimal `apps/web` dependency list.

## Locale resolution

1. `localStorage['fh:public-locale']` — visitor's explicit choice via the switcher. Beats everything.
2. `navigator.languages` (or `navigator.language` fallback) — iterate the browser's ordered preference list and pick the first tag whose primary subtag (`en` / `es` / `fr`) is supported.
3. Default: `en`.

The resolver is a pure function in `resolveLocale.ts` so it can be unit-tested independently of React.

## Persistence + `<html lang>`

- `LocaleProvider` reads the override on mount, persists subsequent choices, and writes the active locale to `document.documentElement.lang`.
- On provider unmount (e.g. SPA navigation from `/r/:code` back to an admin route) the `lang` attribute is restored to the previous value (typically `en` from `index.html`) so the rest of the app does not inherit a stale locale.

## Catalogs

- `locales/en.ts` is the source of truth. `type Catalog` is derived from its shape with `string` value types, then `es.ts` / `fr.ts` are typed `Catalog` so missing keys fail at compile time. There is no runtime fallback to English — missing keys are a build error.
- Keys are grouped by surface: `common.*`, `receive.*`, `send.*`, `errors.*`, `switcher.*`.
- Adding a new locale = a new file in `locales/`, registered in `LocaleProvider.tsx#CATALOGS`, plus the primary subtag added to `resolveLocale.ts`.

## Pluralization

`selectPlural(locale, n)` wraps `Intl.PluralRules` and collapses CLDR's full set into `'one' | 'other'`. Catalog keys use the `_one` / `_other` suffix convention. For en/es/fr this covers every case (French maps `0` to `'one'`, which reads naturally — `0 téléchargement restant`).

## React-node interpolation

Plain text strings use `t('key', { name: 'value' })` with `{name}` placeholders. Strings that need to embed React nodes (e.g. `<strong>{label}</strong>`) use the `<Trans>` component:

```tsx
<Trans k="receive.invitedTo" components={{ label: <strong>{meta.label}</strong> }} />
```

The template is tokenised on `{name}` markers; matching `components[name]` are rendered as nodes, matching `vars[name]` as scalars, unknown markers are left literal.

## Upload-error translation

`lib/upload.ts` is i18n-agnostic; it continues to throw English `Error` instances with stable sentinel messages. Pages map these via `mapUploadErrorMessage(err.message)` to translation keys. New sentinels in `lib/upload.ts` must be added to `uploadErrorKey.ts`; unknown messages fall back to `errors.uploadFailedGeneric`.

## What's intentionally NOT localized

- Byte-size units in `formatBytes` (`B / KB / MB / GB`) — these are standard SI symbols recognised across en/es/fr in computing contexts. Localizing them adds complexity without meaningful clarity gain.
- Numeric progress percentages.
- Admin/login/setup UI — out of scope.
