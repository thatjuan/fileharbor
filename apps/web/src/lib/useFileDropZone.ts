import { useEffect, useRef, useState } from 'react';

/** What a drop yields once folder entries have been filtered out. */
export interface DroppedFiles {
  files: File[];
  /** Number of folder entries the drop contained. Recursive walking is not supported (#65). */
  foldersSkipped: number;
}

export interface FileDropZoneOptions {
  onFiles: (dropped: DroppedFiles) => void;
  /** Ignore drags entirely, e.g. while an upload is in flight. */
  disabled?: boolean;
}

export interface FileDropZoneState {
  /** True while a file drag is over the window. Drive the overlay from this. */
  isDragging: boolean;
  /** Items in the drag, when the browser exposes it before drop (0 = unknown). */
  itemCount: number;
}

/**
 * Makes the whole window a drop target for files while the calling page is
 * mounted. Listeners go on `document` so a drop anywhere on the page lands
 * here instead of triggering the browser default (navigating to the file).
 * They are removed on unmount, so pages that don't call this hook keep the
 * browser's default drop behaviour.
 *
 * Only file drags count: text, link, or image drags from another tab never
 * flip `isDragging` and are never `preventDefault()`ed.
 *
 * `dragenter` / `dragleave` fire for every element the pointer crosses, so a
 * depth counter tracks how many nested enters are outstanding; the overlay
 * only clears when the pointer actually leaves the window.
 */
export function useFileDropZone({
  onFiles,
  disabled = false,
}: FileDropZoneOptions): FileDropZoneState {
  const [isDragging, setIsDragging] = useState(false);
  const [itemCount, setItemCount] = useState(0);
  // Ref so the effect below doesn't re-subscribe every render the caller
  // passes a fresh inline callback.
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (disabled) return;
    let depth = 0;

    const reset = (): void => {
      depth = 0;
      setIsDragging(false);
      setItemCount(0);
    };

    const onDragEnter = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      setItemCount(event.dataTransfer.items.length);
      setIsDragging(true);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer)) return;
      // Required, or the browser refuses the subsequent `drop`.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) reset();
    };
    const onDrop = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      // Collect synchronously: `dataTransfer.items` is emptied once the
      // event handler returns.
      const dropped = collectDroppedFiles(event.dataTransfer);
      reset();
      onFilesRef.current(dropped);
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      reset();
    };
  }, [disabled]);

  return { isDragging, itemCount };
}

/** Narrows `dataTransfer` to non-null and checks the drag carries files. */
function isFileDrag(dataTransfer: DataTransfer | null): dataTransfer is DataTransfer {
  return dataTransfer !== null && dataTransfer.types.includes('Files');
}

/**
 * Splits a drop into real files and folder entries. Folders show up in
 * `dataTransfer.files` as zero-byte, typeless `File`s, so `webkitGetAsEntry`
 * (supported by every current browser despite the prefix) is the reliable
 * way to tell them apart. Falls back to `files` if `items` is empty.
 */
function collectDroppedFiles(dataTransfer: DataTransfer): DroppedFiles {
  const items = Array.from(dataTransfer.items);
  if (items.length === 0) {
    return { files: Array.from(dataTransfer.files), foldersSkipped: 0 };
  }
  const files: File[] = [];
  let foldersSkipped = 0;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry()?.isDirectory) {
      foldersSkipped += 1;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, foldersSkipped };
}
