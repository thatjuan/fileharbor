export type ReceiveFileSelectionSource =
  | { kind: 'file'; file: File }
  | { kind: 'entry'; entry: FileSystemEntry };

function readFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function appendEntryFiles(entry: FileSystemEntry, files: File[]): Promise<void> {
  if (entry.isFile) {
    files.push(await readFile(entry as FileSystemFileEntry));
    return;
  }
  if (!entry.isDirectory) return;

  // Chromium may return large directories in multiple batches. Read until an
  // empty batch, recursing depth-first in the order supplied by the browser.
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  while (true) {
    const entries = await readDirectoryBatch(reader);
    if (entries.length === 0) return;
    for (const child of entries) await appendEntryFiles(child, files);
  }
}

/** Flattens files and directory entries without retaining their folder paths. */
export async function collectReceiveFiles(
  sources: readonly ReceiveFileSelectionSource[],
): Promise<File[]> {
  const files: File[] = [];
  for (const source of sources) {
    if (source.kind === 'file') files.push(source.file);
    else await appendEntryFiles(source.entry, files);
  }
  return files;
}
