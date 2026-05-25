/**
 * Browser-side direct-to-S3 upload via XHR.
 *
 * `fetch` doesn't expose upload progress, and `Request`'s ReadableStream
 * upload progress is still patchy across browsers. XHR `upload.onprogress`
 * is the only path that's reliable today, so this is the one place we drop
 * back to XHR — every other network call is `fetch`.
 *
 * The `Content-Type` header MUST match what the server signed into the
 * presigned PUT (we sign the claimed type in `upload-tickets.createForReceiveLink`).
 * Mismatch → bucket rejects with `SignatureDoesNotMatch`. That's by design:
 * a wrong-type upload should be a hard failure, not a silent record.
 */

export interface PresignedUploadInput {
  url: string;
  file: File;
  contentType: string;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface PresignedUploadResult {
  status: number;
  ok: boolean;
}

export function uploadFileWithProgress(
  input: PresignedUploadInput,
): Promise<PresignedUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', input.url, true);
    xhr.setRequestHeader('Content-Type', input.contentType);

    xhr.upload.onprogress = (e) => {
      if (input.onProgress && e.lengthComputable) {
        input.onProgress(e.loaded, e.total);
      }
    };

    xhr.onload = () => {
      // 2xx is success. The body is empty on success for S3 PUT; we ignore it.
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300 });
    };

    xhr.onerror = () => {
      reject(new Error(`Network error during upload (status=${xhr.status})`));
    };

    xhr.onabort = () => {
      reject(new DOMException('Upload aborted', 'AbortError'));
    };

    if (input.signal) {
      if (input.signal.aborted) {
        xhr.abort();
        return;
      }
      input.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(input.file);
  });
}
