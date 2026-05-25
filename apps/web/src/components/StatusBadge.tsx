import type { ReceiveLinkDisplayStatus } from '../lib/api.js';

/**
 * Render a colour-coded badge for a receive link's policy-derived status.
 *
 * The value comes from the server (`ReceiveLink.displayStatus`); the
 * component is pure and intentionally has no logic — just a label-and-class
 * lookup. Reusing the same component in the dashboard list and the link
 * detail view keeps the visual language consistent.
 */
const LABELS: Record<ReceiveLinkDisplayStatus, string> = {
  active: 'Active',
  disabled: 'Disabled',
  expired: 'Expired',
  quota_exhausted: 'Quota exhausted',
};

export function StatusBadge({ status }: { status: ReceiveLinkDisplayStatus }): JSX.Element {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}
