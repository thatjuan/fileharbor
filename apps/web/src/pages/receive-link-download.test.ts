import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { FileRecord } from '../lib/api.js';
import { receiveLinkArchiveUrl } from '../lib/api.js';
import { ReceiveFilesDownloadAction } from './ReceiveLinkDetailPage.js';

const file: FileRecord = {
  id: 'file-1',
  s3Key: 'private/key',
  filename: 'hello.txt',
  contentType: 'text/plain',
  size: 5,
  createdAt: 1,
  receiveLinkId: 'link/id',
  sendLinkId: null,
};

function render(files: FileRecord[]): string {
  return renderToStaticMarkup(
    createElement(ReceiveFilesDownloadAction, {
      files,
      receiveLinkId: 'link/id',
      onDownloadFile: () => undefined,
    }),
  );
}

test('receive-link archive URL encodes the link id', () => {
  assert.equal(receiveLinkArchiveUrl('link/id ?'), '/api/receive-links/link%2Fid%20%3F/download');
});

test('zero, one, and many file states expose the intended download action', () => {
  assert.equal(render([]), '');

  const one = render([file]);
  assert.match(one, /<button[^>]*>.*Download file.*<\/button>/);
  assert.doesNotMatch(one, /Download all as ZIP/);

  const many = render([file, { ...file, id: 'file-2' }]);
  assert.match(many, /href="\/api\/receive-links\/link%2Fid\/download"/);
  assert.match(many, /target="_blank"/);
  assert.match(many, /rel="noopener"/);
  assert.match(many, /aria-label="[^"]*opens a new tab[^"]*"/);
  assert.match(many, /Download all as ZIP/);
});
