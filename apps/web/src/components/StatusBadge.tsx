import type { ReceiveLinkDisplayStatus } from '../lib/api.js';

/**
 * Colour-coded badge for a link's policy-derived status.
 *
 * The value comes from the server (`displayStatus`); this component is a pure
 * label-and-class lookup with no logic of its own. Using the same component in
 * the dashboard table and on both detail screens is what keeps "expired"
 * looking identical everywhere it appears.
 */
const LABELS: Record<ReceiveLinkDisplayStatus, string> = {
  active: 'Active',
  disabled: 'Disabled',
  expired: 'Expired',
  quota_exhausted: 'Quota exhausted',
};

export function StatusBadge({ status }: { status: ReceiveLinkDisplayStatus }): JSX.Element {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" aria-hidden />
      {LABELS[status]}
    </span>
  );
}
