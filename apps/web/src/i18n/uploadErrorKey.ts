/**
 * Maps known sentinel English error messages thrown by `lib/upload.ts` to
 * translation keys. Keeps `lib/upload.ts` free of any i18n dependency — the
 * page boundary is the only place that knows about translation.
 *
 * Unknown messages fall through to `errors.uploadFailedGeneric`. Sentinels
 * here must stay in sync with the strings thrown inside `lib/upload.ts`.
 */
export function mapUploadErrorMessage(message: string): string {
  switch (message) {
    case 'Upload cancelled.':
    case 'Upload aborted.':
      return 'errors.uploadCancelled';
    default:
      return 'errors.uploadFailedGeneric';
  }
}
