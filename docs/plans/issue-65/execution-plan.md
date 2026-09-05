# Drag-and-drop files onto the dashboard to start a send link (Issue #65)

## Approach

The issue body prescribes the implementation, so it is the plan. Two
deliberate deviations, both in the direction of fewer code paths:

1. **Whole-window drop target on both pages.** The issue attaches the hook to
   `document` on the dashboard and to the form element on `/links/send/new`.
   The failure the issue guards against on the dashboard (a drop landing
   outside the listener makes the browser navigate to the file, losing the
   admin's place) applies equally on the send form, and the full-viewport
   overlay visually promises "drop anywhere" on both. So `useFileDropZone`
   only has the `document` mode, and there is no `bind` variant. Listeners
   are added on mount and removed on unmount, so pages that don't call the
   hook keep the browser's default drop behaviour.
2. **Folder count travels with the hand-off.** Router state is
   `{ files, foldersSkipped }` rather than a bare `File[]`, so a folder-only
   drop on the dashboard still lands on the form and shows the "Folders are
   not supported yet" caption instead of silently doing nothing.

## Files

| File | Change |
| --- | --- |
| `apps/web/src/lib/useFileDropZone.ts` | New. Document-scoped drop hook: file-only detection via `dataTransfer.types`, dragenter/dragleave depth counter, `preventDefault` on dragover/drop only for file drags, folder filtering via `webkitGetAsEntry`. Returns `{ isDragging, itemCount }`. |
| `apps/web/src/lib/new-send-link-state.ts` | New. `NewSendLinkLocationState` type plus `readNewSendLinkState` guard for `useLocation().state`. Documents why `File`s do not survive reload. |
| `apps/web/src/components/FileDropOverlay.tsx` | New. Fixed, `pointer-events: none`, `role="status"` sheet with a headline and optional item-count caption. |
| `apps/web/src/styles/polish-admin.css` | `.file-drop-overlay*` rules: parchment 80% + `saturate(180%) blur(20px)` (same recipe as `.sub-nav`), `display-md` headline, `caption` line, z-index 60 above the global nav. Dark mode comes from tokens. |
| `apps/web/src/pages/DashboardPage.tsx` | Calls the hook; on drop navigates to `/links/send/new` with the drop as state. Renders the overlay. |
| `apps/web/src/pages/NewSendLinkPage.tsx` | Seeds `filesPicked` from router state in a `useState` initializer, clears the history entry's state once on mount (`replace: true, state: null`), accepts further drops that append (ignored while `busy`), shows the folder caption. |

No server changes.

## Verification

- `npm run build:web`, `npm run lint`, `prettier --check` on touched files.
- Playwright (chromium) against the dev servers: synthetic `DragEvent`s with a
  `Files` DataTransfer on the dashboard and the form; text drags ignored;
  navigation with files in drop order and label focused; append on the form;
  remove works; reload yields an empty form with no console errors; end-to-end
  create redirects to `/links/send/:id`.
- Not covered by automation: real OS folder drops (synthetic `File`s have no
  `webkitGetAsEntry` entry), and the visual check of the overlay beyond
  screenshots.
