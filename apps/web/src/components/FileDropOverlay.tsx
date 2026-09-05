interface FileDropOverlayProps {
  /** Usually `isDragging` from `useFileDropZone`. Renders nothing while false. */
  active: boolean;
  headline: string;
  /** Drag item count when the browser exposes it; 0 hides the caption. */
  itemCount?: number;
}

/**
 * Full-viewport frosted-parchment sheet shown while files are dragged over
 * the window (DESIGN.md `sub-nav-frosted` treatment: parchment at 80% plus
 * backdrop blur, no borders or chrome). `pointer-events: none` so the drop
 * still reaches the `document` listener underneath. `role="status"` makes
 * the headline announce to screen readers when the sheet appears.
 */
export function FileDropOverlay({
  active,
  headline,
  itemCount = 0,
}: FileDropOverlayProps): JSX.Element | null {
  if (!active) return null;
  return (
    <div className="file-drop-overlay" role="status">
      <p className="file-drop-overlay-headline">{headline}</p>
      {itemCount > 0 && (
        <p className="file-drop-overlay-caption">
          {itemCount} {itemCount === 1 ? 'item' : 'items'}
        </p>
      )}
    </div>
  );
}
