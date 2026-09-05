import { Link, useLocation, useSearchParams } from 'react-router-dom';

import type { ReceiveLinkDisplayStatus } from '../lib/api.js';
import { DownloadIcon, PlusIcon, UploadIcon } from './Icons.js';
import { useLinks } from './LinksProvider.js';

/**
 * Left rail. Two jobs, and deliberately no others:
 *
 *   1. Tell the operator what the instance holds right now — total links,
 *      the receive/send split, and the count in each policy state.
 *   2. Filter the dashboard by that state.
 *
 * Every number here is derived from the link inventories the server already
 * returns. The rail shows nothing it cannot count (no storage totals, no
 * uptime, no host health) — a console that displays a number it invented is
 * worse than one that shows fewer numbers.
 *
 * The active filter lives in the URL (`/?status=expired`) rather than in
 * component state, so a filtered view is linkable and survives a reload.
 */
const STATUS_ROWS: ReadonlyArray<{
  status: ReceiveLinkDisplayStatus;
  label: string;
  tone: string;
}> = [
  { status: 'active', label: 'Active', tone: 'rail-row-value-accent' },
  { status: 'expired', label: 'Expired', tone: 'rail-row-value-danger' },
  { status: 'disabled', label: 'Disabled', tone: 'rail-row-value-neutral' },
  { status: 'quota_exhausted', label: 'Quota exhausted', tone: 'rail-row-value-warning' },
];

export function Rail(): JSX.Element {
  const { receive, send } = useLinks();
  const [params] = useSearchParams();
  const location = useLocation();

  // Counts read as "—" until both loads settle, so a half-loaded rail never
  // shows a number that is about to change.
  const loaded = receive !== null && send !== null;
  const all = [...(receive ?? []), ...(send ?? [])];
  const activeStatus = params.get('status');
  // Filters only apply to the dashboard; from a detail page they navigate back.
  const onDashboard = location.pathname === '/';

  const count = (n: number): string => (loaded ? String(n) : '—');
  const statusCount = (status: ReceiveLinkDisplayStatus): string =>
    count(all.filter((l) => l.displayStatus === status).length);

  return (
    <aside className="rail">
      <div className="rail-card">
        <div className="rail-card-head">Inventory</div>
        <div className="rail-card-body">
          <div className="rail-row">
            <span className="rail-row-label">Total links</span>
            <span className="rail-row-value">{count(all.length)}</span>
          </div>
          <div className="rail-row">
            <span className="rail-row-label">
              <DownloadIcon size={13} />
              Receive links
            </span>
            <span className="rail-row-value">{count(receive?.length ?? 0)}</span>
          </div>
          <div className="rail-row">
            <span className="rail-row-label">
              <UploadIcon size={13} />
              Send links
            </span>
            <span className="rail-row-value">{count(send?.length ?? 0)}</span>
          </div>
        </div>
      </div>

      <div className="rail-card">
        <div className="rail-card-head">Filter by status</div>
        <div className="rail-card-body">
          <Link
            to="/"
            className={`rail-row${onDashboard && activeStatus === null ? ' rail-row-active' : ''}`}
          >
            <span className="rail-row-label">All links</span>
            <span className="rail-row-value">{count(all.length)}</span>
          </Link>
          {STATUS_ROWS.map(({ status, label, tone }) => (
            <Link
              key={status}
              to={`/?status=${status}`}
              className={`rail-row${onDashboard && activeStatus === status ? ' rail-row-active' : ''}`}
            >
              <span className="rail-row-label">
                <span className={`status-dot status-${status}-dot`} />
                {label}
              </span>
              <span className={`rail-row-value ${tone}`}>{statusCount(status)}</span>
            </Link>
          ))}
        </div>
      </div>

      <div className="rail-heading">Create</div>
      <Link to="/links/receive/new" className="btn btn-ghost">
        <PlusIcon size={13} />
        New receive link
      </Link>
      <Link to="/links/send/new" className="btn btn-ghost">
        <PlusIcon size={13} />
        New send link
      </Link>
    </aside>
  );
}
