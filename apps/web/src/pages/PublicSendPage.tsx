import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

import {
  AnchorIcon,
  ClockIcon,
  DownloadIcon,
  FileIcon,
  LinkIcon,
  LockIcon,
} from '../components/Icons.js';
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
 *
 * Visually this is a public surface: the console skin without any operator
 * affordance — no rail, no counts, no admin nav. One centred column under a
 * nav that carries only the wordmark and the locale picker.
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
      <PublicShell>
        <div className="public-header">
          <h1>{t('send.title')}</h1>
        </div>
        <p role="alert" className="notice notice-danger">
          {t('send.notAvailable')}
        </p>
      </PublicShell>
    );
  }

  if (!meta) {
    return (
      <PublicShell>
        <p className="muted">{t('common.loading')}</p>
      </PublicShell>
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
    <PublicShell>
      <div className="public-header">
        <h1>{meta.label}</h1>
        <p className="muted">
          <Trans k="send.sentYou" components={{ label: <strong>{meta.label}</strong> }} />
        </p>
      </div>

      {/* Only the fields the public endpoint actually returns: the route the
          recipient is on, whether a password stands in front of it, expiry,
          the remaining-download budget, and the file count. */}
      <div className="meta-strip">
        <div className="meta-item">
          <span className="meta-label">
            <LinkIcon size={11} />
            {t('meta.link')}
          </span>
          <span className="meta-value">/s/{code}</span>
        </div>

        {meta.passwordRequired && (
          <div className="meta-item">
            <span className="meta-label">
              <LockIcon size={11} />
              {t('meta.password')}
            </span>
            <span className="meta-value">{t('receive.password')}</span>
          </div>
        )}

        {meta.expiresAt !== null && (
          <div className="meta-item">
            <span className="meta-label">
              <ClockIcon size={11} />
              {t('meta.expires')}
            </span>
            <span className="meta-value">{formatDateTime(meta.expiresAt, locale)}</span>
          </div>
        )}

        {remainingLine !== null && (
          <div className="meta-item">
            <span className="meta-label">
              <DownloadIcon size={11} />
              {t('meta.downloads')}
            </span>
            <span className="meta-value">
              {meta.remainingDownloads}
              {meta.maxDownloads !== null ? ` / ${meta.maxDownloads}` : ''}
            </span>
            <span className="meta-sub">{remainingLine}</span>
          </div>
        )}

        <div className="meta-item">
          <span className="meta-label">
            <FileIcon size={11} />
            {t('meta.files')}
          </span>
          <span className="meta-value">{meta.files.length}</span>
        </div>
      </div>

      {passwordGate ? (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            // Soft-unlock: hand the typed password to subsequent download
            // mints. The real validation happens server-side on each call.
            if (password.length > 0) setUnlockedPassword(password);
          }}
        >
          <label className="field">
            <span className="field-label">{t('receive.password')}</span>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </label>
          {error && (
            <p role="alert" className="notice notice-danger">
              {error}
            </p>
          )}
          <div className="row-end">
            <button type="submit" className="btn btn-accent" disabled={password.length === 0}>
              <LockIcon size={13} />
              {t('send.unlock')}
            </button>
          </div>
        </form>
      ) : meta.files.length === 0 ? (
        // The link exists but the admin's upload hasn't finalized yet.
        // Soft empty state with a hint to refresh.
        <div className="panel">
          <div className="empty">
            <ClockIcon size={30} className="empty-icon" />
            <p className="empty-title">{t('send.noFilesYet')}</p>
            <p className="empty-hint">{t('send.noFilesYetHint')}</p>
          </div>
        </div>
      ) : (
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">
              {t('send.download')}
              <span className="panel-count">{meta.files.length}</span>
            </span>
          </div>
          <ul className="list-reset">
            {meta.files.map((file) => (
              <li key={file.id} className="file-row">
                <div className="row">
                  <FileIcon size={16} className="faint" />
                  <div className="file-row-main">
                    <span className="file-name">{file.filename}</span>
                    <span className="file-meta">
                      {formatBytes(file.size)} · {file.contentType}
                    </span>
                  </div>
                </div>
                <div className="file-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void onDownload(file.id)}
                    disabled={busyFileId !== null}
                  >
                    <DownloadIcon size={13} />
                    {busyFileId === file.id ? t('send.preparing') : t('send.download')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!passwordGate && error && (
        <p role="alert" className="notice notice-danger">
          {error}
        </p>
      )}
    </PublicShell>
  );
}

/**
 * The public chrome: wordmark + locale picker over one centred column, and
 * the quiet brand line at the foot so the page never ends on the action.
 */
function PublicShell({ children }: { children: ReactNode }): JSX.Element {
  const t = useT();
  return (
    <div className="public-page">
      <nav className="public-nav">
        <div className="public-nav-inner">
          <span className="top-nav-brand">
            <AnchorIcon size={16} className="top-nav-brand-mark" />
            File Harbor
          </span>
          <LanguageSwitcher />
        </div>
      </nav>
      <main className="public-main">
        <div className="public-column">{children}</div>
      </main>
      <div className="public-footer">{t('footer.poweredBy')}</div>
    </div>
  );
}

/** Expiry is the one date a recipient acts on, so it carries the time too. */
function formatDateTime(epochSeconds: number, locale: string): string {
  return new Date(epochSeconds * 1000).toLocaleString(locale, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
