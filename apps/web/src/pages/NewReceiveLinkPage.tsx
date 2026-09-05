import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ArrowLeftIcon } from '../components/Icons.js';
import { createReceiveLink } from '../lib/api.js';

/**
 * Form to create a new receive link.
 *
 * `label` is required; `password`, `maxUploads`, and `expiresAt` are each
 * independently optional — leaving them blank means "no password", "unlimited",
 * and "never expires" respectively (the same semantic the policy module uses
 * for `null`).
 *
 * The form is grouped into three cards — identity, access, limits — so the
 * operator reads the policy in the order the server enforces it. The send
 * form uses the same grouping; the two screens differ only in the fields
 * they actually have.
 *
 * Time handling: the `<input type="datetime-local">` returns a naive local-time
 * string (`YYYY-MM-DDTHH:mm`). `new Date(str)` parses that as local time, so
 * `.getTime() / 1000` is the correct UTC epoch-seconds value to send. The
 * server stores raw epoch seconds; the dashboard re-renders in viewer-local
 * time on read.
 */
export function NewReceiveLinkPage(): JSX.Element {
  const navigate = useNavigate();
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [maxUploads, setMaxUploads] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Each optional field collapses to `null` when blank so the API treats
      // it as "no constraint". Parsing happens here (not in the API helper) so
      // the form is the single place that turns user input into wire types.
      let parsedMaxUploads: number | null = null;
      if (maxUploads.trim().length > 0) {
        const n = Number(maxUploads);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error('Max uploads must be a positive whole number.');
        }
        parsedMaxUploads = n;
      }

      let parsedExpiresAt: number | null = null;
      if (expiresAt.length > 0) {
        const d = new Date(expiresAt);
        if (Number.isNaN(d.getTime())) {
          throw new Error('Expiry date is not a valid date/time.');
        }
        if (d.getTime() <= Date.now()) {
          throw new Error('Expiry date must be in the future.');
        }
        parsedExpiresAt = Math.floor(d.getTime() / 1000);
      }

      const link = await createReceiveLink({
        label: label.trim(),
        password: password.length > 0 ? password : null,
        maxUploads: parsedMaxUploads,
        expiresAt: parsedExpiresAt,
      });
      navigate(`/links/receive/${link.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create link.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Link to="/" className="back-link">
        <ArrowLeftIcon size={13} />
        Back to dashboard
      </Link>

      <div className="page-head">
        <div className="page-head-text">
          <h1>New receive link</h1>
          <p className="page-head-sub">
            A receive link lets someone upload files to you. Share the URL (and password, if you set
            one) out-of-band.
          </p>
        </div>
      </div>

      <section className="container-form">
        <form onSubmit={onSubmit} className="stack">
          <div className="card stack">
            <h4>Link details</h4>
            <label className="field">
              <span className="field-label">Label</span>
              <input
                type="text"
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Photos from Bob"
                required
                maxLength={256}
                autoFocus
              />
              <span className="field-hint">
                How this link appears on the dashboard. Only you see it.
              </span>
            </label>
          </div>

          <div className="card stack">
            <h4>Access</h4>
            <label className="field">
              <span className="field-label">
                Password <span className="faint">(optional)</span>
              </span>
              {/*
                Plain `text` input rather than `password`: this is the admin's
                own dashboard, and the operator wants to see what they're setting.
                They'll share the password out-of-band; obscuring it on entry
                invites typos that lock recipients out.
              */}
              <input
                type="text"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for no password"
                autoComplete="off"
              />
              <span className="field-hint">
                Visitors must enter this before they can upload. Shown in plain text so you can copy
                it accurately.
              </span>
            </label>
          </div>

          <div className="card stack">
            <h4>Limits</h4>
            <div className="field-row">
              <label className="field">
                <span className="field-label">
                  Max uploads <span className="faint">(optional)</span>
                </span>
                <input
                  type="number"
                  className="input"
                  value={maxUploads}
                  onChange={(e) => setMaxUploads(e.target.value)}
                  placeholder="Unlimited"
                  min={1}
                  step={1}
                />
                <span className="field-hint">Leave blank for unlimited uploads.</span>
              </label>

              <label className="field">
                <span className="field-label">
                  Expires at <span className="faint">(optional)</span>
                </span>
                <input
                  type="datetime-local"
                  className="input"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
                <span className="field-hint">
                  Your local time. Blank means the link never expires.
                </span>
              </label>
            </div>
          </div>

          {error !== null && (
            <p role="alert" className="notice notice-danger">
              {error}
            </p>
          )}

          <div className="row-end">
            <Link to="/" className="btn btn-ghost">
              Cancel
            </Link>
            <button
              type="submit"
              className="btn btn-accent"
              disabled={submitting || label.trim().length === 0}
            >
              {submitting ? 'Creating…' : 'Create link'}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
