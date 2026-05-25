import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { createReceiveLink } from '../lib/api.js';

/**
 * Form to create a new receive link.
 *
 * `label` is required; `password`, `maxUploads`, and `expiresAt` are each
 * independently optional — leaving them blank means "no password", "unlimited",
 * and "never expires" respectively (the same semantic the policy module uses
 * for `null`).
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
    <main className="page">
      <header className="row between">
        <h1>New receive link</h1>
        <Link to="/">Back</Link>
      </header>
      <form onSubmit={onSubmit} className="stack">
        <label>
          Label
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Photos from Bob"
            required
            maxLength={256}
            autoFocus
          />
        </label>

        <label>
          Password <span className="muted small">(optional)</span>
          {/*
            Plain `text` input rather than `password`: this is the admin's
            own dashboard, and the operator wants to see what they're setting.
            They'll share the password out-of-band; obscuring it on entry
            invites typos that lock recipients out.
          */}
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave blank for no password"
            autoComplete="off"
          />
        </label>

        <label>
          Max uploads <span className="muted small">(optional)</span>
          <input
            type="number"
            value={maxUploads}
            onChange={(e) => setMaxUploads(e.target.value)}
            placeholder="Leave blank for unlimited"
            min={1}
            step={1}
          />
        </label>

        <label>
          Expires at <span className="muted small">(optional, local time)</span>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting || label.trim().length === 0}>
          {submitting ? 'Creating…' : 'Create link'}
        </button>
      </form>
    </main>
  );
}
