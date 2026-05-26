/**
 * Footer rendered at the bottom of every admin page (inside `AdminShell`).
 * Parchment background with dense-link columns per DESIGN.md.
 */
export function AdminFooter(): JSX.Element {
  return (
    <footer className="admin-footer">
      <div className="admin-footer-inner">
        <div className="admin-footer-column">
          <h4>Product</h4>
          <ul className="list-reset">
            <li>
              <a href="/">Dashboard</a>
            </li>
            <li>
              <a href="/links/receive/new">New receive link</a>
            </li>
            <li>
              <a href="/links/send/new">New send link</a>
            </li>
            <li>
              <a href="/notifications">Notifications</a>
            </li>
          </ul>
        </div>
        <div className="admin-footer-column">
          <h4>Resources</h4>
          <ul className="list-reset">
            <li>
              <a href="https://github.com/thatjuan/fileharbor" target="_blank" rel="noreferrer">
                GitHub
              </a>
            </li>
            <li>
              <a
                href="https://github.com/thatjuan/fileharbor/issues"
                target="_blank"
                rel="noreferrer"
              >
                Report an issue
              </a>
            </li>
          </ul>
        </div>
        <div className="admin-footer-column">
          <h4>Operator</h4>
          <ul className="list-reset">
            <li>Self-hosted</li>
            <li>Storage-backend agnostic</li>
          </ul>
        </div>
        <div className="admin-footer-column">
          <h4>About</h4>
          <ul className="list-reset">
            <li>File Harbor — self-hosted file send / receive.</li>
          </ul>
        </div>
      </div>
      <div className="admin-footer-legal">
        File Harbor is open source software released under the MIT license.
      </div>
    </footer>
  );
}
