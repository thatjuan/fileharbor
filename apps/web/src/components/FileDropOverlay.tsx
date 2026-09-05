import { UploadIcon } from './Icons.js';

interface FileDropOverlayProps {
  /** Usually `isDragging` from `useFileDropZone`. Renders nothing while false. */
  active: boolean;
  headline: string;
  /** Drag item count when the browser exposes it; 0 hides the caption. */
  itemCount?: number;
}

/**
 * Full-viewport sheet shown while files are dragged over the window: the
 * canvas dimmed and blurred behind a dashed accent frame, matching the
 * in-page `.dropzone` so the two read as the same affordance at two scales.
 *
 * `pointer-events: none` (in CSS) so the drop still reaches the `document`
 * listener underneath. `role="status"` announces the headline when it appears.
 */
export function FileDropOverlay({
  active,
  headline,
  itemCount = 0,
}: FileDropOverlayProps): JSX.Element | null {
  if (!active) return null;
  return (
    <div className="drop-overlay" role="status">
      <div className="drop-overlay-frame">
        <UploadIcon size={32} className="dropzone-icon" />
        <p className="drop-overlay-headline">{headline}</p>
        {itemCount > 0 && (
          <p className="drop-overlay-caption">
            {itemCount} {itemCount === 1 ? 'item' : 'items'}
          </p>
        )}
      </div>
    </div>
  );
}
