import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { listReceiveLinks, listSendLinks, type ReceiveLink, type SendLink } from '../lib/api.js';

/**
 * Both link inventories, loaded once for the whole admin shell.
 *
 * The rail needs the counts on every screen and the dashboard needs the rows,
 * so fetching in one place beats each surface fetching for itself. Detail
 * pages that mutate a link call `refresh()` so the rail counts don't drift.
 *
 * The two loads are independent: a failure on one axis leaves the other
 * populated rather than blanking the whole rail.
 */
interface LinksState {
  receive: ReceiveLink[] | null;
  send: SendLink[] | null;
  receiveError: string | null;
  sendError: string | null;
  refresh: () => void;
}

const LinksContext = createContext<LinksState | null>(null);

export function LinksProvider({ children }: { children: ReactNode }): JSX.Element {
  const [receive, setReceive] = useState<ReceiveLink[] | null>(null);
  const [send, setSend] = useState<SendLink[] | null>(null);
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    listReceiveLinks()
      .then((l) => {
        if (cancelled) return;
        setReceive(l);
        setReceiveError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setReceiveError(err instanceof Error ? err.message : 'Failed to load receive links.');
      });
    listSendLinks()
      .then((l) => {
        if (cancelled) return;
        setSend(l);
        setSendError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setSendError(err instanceof Error ? err.message : 'Failed to load send links.');
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return (
    <LinksContext.Provider value={{ receive, send, receiveError, sendError, refresh }}>
      {children}
    </LinksContext.Provider>
  );
}

/** Read the shared link inventories. Only valid inside `AdminShell`. */
export function useLinks(): LinksState {
  const ctx = useContext(LinksContext);
  if (ctx === null) throw new Error('useLinks must be used inside <LinksProvider>');
  return ctx;
}
