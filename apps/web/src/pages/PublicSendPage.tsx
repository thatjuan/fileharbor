import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { LanguageSwitcher, Trans, selectPlural, useLocaleContext, useT } from '../i18n/index.js';
import {
  confirmDownloadTicket,
  createDownloadTicket,
  getPublicSendLink,
  type PolicyRejection,
  type PublicSendLink,
} from '../lib/api.js';

/**
 * Public download page (`/s/:code`). Unauthenticated. Lists the files in the
 * send link and, on Download, mints a presigned GET server-side and triggers
 * the browser to navigate to it. The file lands directly from S3 (with
 * Content-Disposition: attachment) — File Harbor never touches the bytes.
 *
 * #11 widens the surface:
 *
 *   - If `passwordRequired` is true, the recipient must type the password
 *     before any download mint is attempted. The password is sent with each
 *     mint request (the server re-validates on every call — we never trust
 *     the client's "I'm authed" state).
 *   - Each file in the bundle gets its own Download button. Clicking mints
 *     a fresh download ticket and triggers a navigation to the presigned URL.
 *   - After kicking off the navigation, we fire-and-forget a `confirm` call
 *     so the server can burn one quota slot. If the user navigates away
 *     before this completes, `fetch(..., { keepalive: true })` still gets the
 *     request out, and the eventual-expiry sweep (#10) is the safety net.
 *   - Quota / expiry / password verdicts are all surfaced with distinct
 *     copy. `quota_exhausted` returns a 403 with `error: 'quota_exhausted'`;
 *     the public listing GET keeps showing the link as "ok" until the cap
 *     is reached on a per-mint basis.
 */
export function PublicSendPage(): JSX.Element {
  const params = useParams<{ code: string }>();
  const code = params.code ?? '';
  const t = useT();
  const { locale } = useLocaleContext();

  const [meta, setMeta] = useState<PublicSendLink | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  // Once the recipient successfully mints a ticket with the password, we
  // remember it locally for subsequent file downloads in the same session.
  // Cleared on a `password_wrong` so the input goes back to empty.
  const [unlockedPassword, setUnlockedPassword] = useState<string | null>(null);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPublicSendLink(code)
      .then((m) => {
        if (!cancelled) {
          setMeta(m);
          // If the link has no password, treat the recipient as already
          // unlocked — keeps the download flow a single click.
          if (!m.passwordRequired) setUnlockedPassword('');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setMetaError(err instanceof Error ? err.message : t('send.notAvailable'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const onDownload = async (fileId: string): Promise<void> => {
    setError(null);
    setBusyFileId(fileId);
    try {
      const outcome = await createDownloadTicket(code, {
        fileId,
        password: unlockedPassword,
      });
      if (outcome.kind === 'ok') {
        // Best-effort confirm. Fired BEFORE the navigation so `keepalive`
        // has the freshest chance to land — but the navigation must
        // actually start, hence the synchronous `window.location.assign`
        // immediately after.
        void confirmDownloadTicket(outcome.value.ticketId, 'completed');
        // Navigating to the presigned URL is the simplest reliable trigger
        // for a download: S3 has signed `Content-Disposition: attachment` so
        // the browser saves rather than navigates-and-renders.
        window.location.assign(outcome.value.presignedGetUrl);
        return;
      }
      handleRejection(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.downloadStartFailed'));
    } finally {
      setBusyFileId(null);
    }
  };

  const handleRejection = (
    outcome:
      | { kind: 'policy_rejected'; reason: PolicyRejection }
      | { kind: 'not_found' }
      | { kind: 'error'; message: string },
  ): void => {
    if (outcome.kind === 'not_found') {
      setError(t('send.downloadUnavailable'));
      return;
    }
    if (outcome.kind === 'error') {
      setError(outcome.message);
      return;
    }
    switch (outcome.reason) {
      case 'password_required':
        // Server says we need a password but the input was empty. Don't blow
        // away `unlockedPassword` here — the user may just have skipped
        // typing it.
        setError(t('errors.passwordRequiredSend'));
        setUnlockedPassword(null);
        break;
      case 'password_wrong':
        setError(t('errors.passwordWrong'));
        setUnlockedPassword(null);
        break;
      case 'quota_exhausted':
        setError(t('errors.quotaExhaustedSend'));
        break;
      case 'expired':
        setError(t('errors.expired'));
        break;
      case 'disabled':
        setError(t('errors.disabled'));
        break;
    }
  };

  if (metaError) {
    return (
      <main className="public-main tile tile-parchment">
        <LanguageSwitcher />
        <div className="container-narrow public-hero">
          <h1>File Harbor</h1>
          <p role="alert" className="error">
            {t('send.notAvailable')}
          </p>
        </div>
        <PublicFooter />
      </main>
    );
  }

  if (!meta) {
    return (
      <main className="public-main tile tile-parchment">
        <LanguageSwitcher />
        <div className="container-narrow public-hero">
          <p className="muted">{t('common.loading')}</p>
        </div>
      </main>
    );
  }

  const passwordGate = meta.passwordRequired && unlockedPassword === null;

  const remainingLine = ((): string | null => {
    if (meta.remainingDownloads === null) return null;
    const n = meta.remainingDownloads;
    const ofMax = meta.maxDownloads !== null ? t('send.ofMax', { max: meta.maxDownloads }) : '';
    const key = `send.remaining_${selectPlural(locale, n)}`;
    return t(key, { n, ofMax });
  })();

  return (
    <main className="public-main tile tile-parchment">
      <LanguageSwitcher />
      <div className="container-narrow public-hero">
        <h1>{t('send.title')}</h1>
        <p className="lead">
          <Trans k="send.sentYou" components={{ label: <strong>{meta.label}</strong> }} />
        </p>

        {remainingLine !== null && <p className="muted small">{remainingLine}</p>}

        {passwordGate ? (
          <form
            className="public-action"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              // Soft-unlock: hand the typed password to subsequent download
              // mints. The real validation happens server-side on each call.
              if (password.length > 0) setUnlockedPassword(password);
            }}
          >
            <label className="input-label">
              {t('receive.password')}
              <input
                type="password"
                className="input-pill"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                required
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="row" style={{ justifyContent: 'center' }}>
              <button type="submit" className="btn-primary" disabled={password.length === 0}>
                {t('send.unlock')}
              </button>
            </div>
          </form>
        ) : meta.files.length === 0 ? (
          // The link exists but the admin's upload hasn't finalized yet.
          // Soft empty state with a hint to refresh.
          <div className="public-action">
            <div className="empty-state">
              <HourglassGlyph />
              <div className="empty-state-title">{t('send.noFilesYet')}</div>
              <div className="empty-state-hint">{t('send.noFilesYetHint')}</div>
            </div>
          </div>
        ) : (
          <div className="public-action">
            <ul className="list-reset stack">
              {meta.files.map((file) => (
                <li key={file.id} className="store-card-row">
                  <div className="file-row-meta">
                    <div className="file-row-name">{file.filename}</div>
                    <div className="file-row-sub">
                      {formatBytes(file.size)} · {file.contentType}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void onDownload(file.id)}
                    disabled={busyFileId !== null}
                  >
                    {busyFileId === file.id ? t('send.preparing') : t('send.download')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!passwordGate && error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <PublicFooter />
    </main>
  );
}

/** Tiny quiet brand line so the page doesn't end on the action. */
function PublicFooter(): JSX.Element {
  const t = useT();
  return <div className="public-footer">{t('footer.poweredBy')}</div>;
}

/** Small hour-glass for the "files not ready yet" empty state. */
function HourglassGlyph(): JSX.Element {
  return (
    <svg
      className="empty-state-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 3h10" />
      <path d="M7 21h10" />
      <path d="M7 3v3a5 5 0 0 0 10 0V3" />
      <path d="M7 21v-3a5 5 0 0 1 10 0v3" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
