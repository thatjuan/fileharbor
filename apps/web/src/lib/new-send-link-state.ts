import type { DroppedFiles } from './useFileDropZone.js';

/**
 * Router state the dashboard hands to `/links/send/new` after a file drop.
 *
 * `File` objects survive `navigate(path, { state })` because react-router
 * keeps in-app pushes in memory for the current document. They do NOT
 * survive a reload or a back/forward restore: `history.state` is
 * structured-cloned and `File` is not cloneable there, so the page sees
 * `null` and simply starts empty. Don't try to persist this.
 */
export type NewSendLinkLocationState = DroppedFiles;

/** Narrows `useLocation().state` to the drop hand-off, or `null` for anything else. */
export function readNewSendLinkState(state: unknown): NewSendLinkLocationState | null {
  if (typeof state !== 'object' || state === null) return null;
  const { files, foldersSkipped } = state as Partial<Record<keyof DroppedFiles, unknown>>;
  if (!Array.isArray(files) || !files.every((f: unknown): f is File => f instanceof File)) {
    return null;
  }
  if (typeof foldersSkipped !== 'number') return null;
  return { files, foldersSkipped };
}
