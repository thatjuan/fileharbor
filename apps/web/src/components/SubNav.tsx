import type { ReactNode } from 'react';

/**
 * `sub-nav-frosted` per DESIGN.md. Sticky strip below the global nav showing
 * the current section title in `tagline` typography on the left, with an
 * optional right-aligned action cluster. Parchment 80% with backdrop-blur
 * gives the floating-over-content effect.
 *
 * Used inside `AdminShell` and (optionally) on focused single-purpose pages.
 */
export function SubNav({
  title,
  actions,
}: {
  title: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="sub-nav">
      <div className="sub-nav-inner">
        <div className="sub-nav-title">{title}</div>
        {actions !== undefined && <div className="row end">{actions}</div>}
      </div>
    </div>
  );
}
