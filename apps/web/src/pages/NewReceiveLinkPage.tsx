import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { createReceiveLink } from '../lib/api.js';

/**
 * Form to create a new receive link. Only field is `label` — quota, expiry,
 * and password land in #6. On success we redirect to the detail view so the
 * operator can copy the shareable URL immediately.
 */
export function NewReceiveLinkPage(): JSX.Element {
  const navigate = useNavigate();
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const link = await createReceiveLink(label.trim());
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
