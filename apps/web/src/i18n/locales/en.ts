export const EN_CATALOG = {
  common: {
    loading: 'Loading…',
    cancel: 'Cancel',
    tryAgain: 'Try again',
  },
  receive: {
    title: 'Upload a file',
    invitedTo: "You've been invited to upload to: {label}",
    password: 'Password',
    pickFile: 'Pick a file',
    preparing: 'Preparing upload…',
    confirming: 'Confirming with server…',
    cancelling: 'Cancelling…',
    cancelled: 'Upload cancelled.',
    cancelUpload: 'Cancel upload',
    uploadComplete: 'Upload complete: {name}',
    uploadAnother: 'Upload another file',
    lockedDefault: 'This link is no longer accepting uploads.',
    notAvailable: 'This upload link is not available. It may be incorrect, disabled, or expired.',
  },
  send: {
    title: 'Download',
    sentYou: "You've been sent: {label}",
    remaining_one: '{n} download remaining{ofMax}.',
    remaining_other: '{n} downloads remaining{ofMax}.',
    ofMax: ' (of {max})',
    unlock: 'Unlock',
    download: 'Download',
    preparing: 'Preparing…',
    noFilesYet: 'No files available yet. Try again in a moment.',
    notAvailable: 'This download link is not available. It may be incorrect, disabled, or expired.',
    downloadUnavailable: 'This download is no longer available.',
  },
  errors: {
    passwordRequiredReceive: 'A password is required to upload to this link.',
    passwordRequiredSend: 'A password is required to download from this link.',
    passwordWrong: 'Incorrect password. Please try again.',
    quotaExhaustedReceive:
      'This link has reached its upload limit and is no longer accepting files.',
    quotaExhaustedSend: 'This link has reached its download limit.',
    expired: 'This link has expired.',
    disabled: 'This link is currently disabled.',
    uploadCancelled: 'Upload cancelled.',
    uploadFailedGeneric: 'Upload failed.',
    uploadFailedFinalize: 'Upload failed during finalization.',
    uploadFailedReason: 'Upload failed: {reason}',
    uploadRejectedReason: 'Upload rejected: {reason}',
    uploadObjectNotFound: 'The server could not verify your upload. Please try again.',
    downloadStartFailed: 'Failed to start download.',
  },
  switcher: {
    label: 'Language',
    en: 'English',
    es: 'Español',
    fr: 'Français',
  },
} as const;

/**
 * Shape derived from the English catalog (the source of truth), but with
 * `string` value types so other-locale catalogs are not forced to use the
 * same literal English values — they need the same KEYS in the same shape.
 */
export type Catalog = {
  readonly [K in keyof typeof EN_CATALOG]: {
    readonly [J in keyof (typeof EN_CATALOG)[K]]: string;
  };
};
