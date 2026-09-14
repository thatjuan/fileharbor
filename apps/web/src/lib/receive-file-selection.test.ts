import assert from 'node:assert/strict';
import test from 'node:test';

import { collectReceiveFiles } from './receive-file-selection.js';

function fileEntry(file: File): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    fullPath: `/${file.name}`,
    file: (success) => success(file),
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(
  name: string,
  batches: readonly (readonly FileSystemEntry[])[],
): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    createReader: () => {
      let index = 0;
      return {
        readEntries: (success) => {
          success([...(batches[index] ?? [])]);
          index += 1;
        },
      } as FileSystemDirectoryReader;
    },
  } as unknown as FileSystemDirectoryEntry;
}

test('recursively flattens dropped folders in browser traversal order', async () => {
  const first = new File(['first'], 'first.txt');
  const nested = new File(['nested'], 'nested.txt');
  const last = new File(['last'], 'last.txt');
  const folder = directoryEntry('folder', [
    [fileEntry(first), directoryEntry('nested-folder', [[fileEntry(nested)], []])],
    [fileEntry(last)],
    [],
  ]);

  const files = await collectReceiveFiles([{ kind: 'entry', entry: folder }]);

  assert.deepEqual(
    files.map((file) => file.name),
    ['first.txt', 'nested.txt', 'last.txt'],
  );
});

test('preserves mixed top-level file and folder order', async () => {
  const before = new File(['before'], 'before.txt');
  const inside = new File(['inside'], 'inside.txt');
  const after = new File(['after'], 'after.txt');

  const files = await collectReceiveFiles([
    { kind: 'file', file: before },
    { kind: 'entry', entry: directoryEntry('folder', [[fileEntry(inside)], []]) },
    { kind: 'file', file: after },
  ]);

  assert.deepEqual(
    files.map((file) => file.name),
    ['before.txt', 'inside.txt', 'after.txt'],
  );
});
