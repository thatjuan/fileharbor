import type { Catalog } from './en.js';

export const FR_CATALOG: Catalog = {
  common: {
    loading: 'Chargement…',
    cancel: 'Annuler',
    tryAgain: 'Réessayer',
  },
  receive: {
    title: 'Téléverser un fichier',
    invitedTo: 'Vous avez été invité·e à téléverser vers : {label}',
    password: 'Mot de passe',
    pickFile: 'Choisir un fichier',
    dropHint: 'ou glissez-déposez ici',
    uploadingPhase: 'Téléversement',
    preparing: 'Préparation du téléversement…',
    confirming: 'Confirmation avec le serveur…',
    cancelling: 'Annulation…',
    cancelled: 'Téléversement annulé.',
    cancelUpload: 'Annuler le téléversement',
    uploadComplete: 'Téléversement terminé : {name}',
    uploadAnother: 'Téléverser un autre fichier',
    lockedDefault: "Ce lien n'accepte plus de téléversements.",
    notAvailable:
      "Ce lien de téléversement n'est pas disponible. Il peut être incorrect, désactivé ou expiré.",
  },
  send: {
    title: 'Télécharger',
    sentYou: 'On vous a envoyé : {label}',
    remaining_one: '{n} téléchargement restant{ofMax}.',
    remaining_other: '{n} téléchargements restants{ofMax}.',
    ofMax: ' (sur {max})',
    unlock: 'Déverrouiller',
    download: 'Télécharger',
    preparing: 'Préparation…',
    noFilesYet: 'Aucun fichier disponible pour le moment.',
    noFilesYetHint: 'Actualisez dans un instant.',
    notAvailable:
      "Ce lien de téléchargement n'est pas disponible. Il peut être incorrect, désactivé ou expiré.",
    downloadUnavailable: "Ce téléchargement n'est plus disponible.",
  },
  errors: {
    passwordRequiredReceive: 'Un mot de passe est requis pour téléverser vers ce lien.',
    passwordRequiredSend: 'Un mot de passe est requis pour télécharger depuis ce lien.',
    passwordWrong: 'Mot de passe incorrect. Veuillez réessayer.',
    quotaExhaustedReceive:
      "Ce lien a atteint sa limite de téléversements et n'accepte plus de fichiers.",
    quotaExhaustedSend: 'Ce lien a atteint sa limite de téléchargements.',
    expired: 'Ce lien a expiré.',
    disabled: 'Ce lien est actuellement désactivé.',
    uploadCancelled: 'Téléversement annulé.',
    uploadFailedGeneric: 'Échec du téléversement.',
    uploadFailedFinalize: 'Échec du téléversement lors de la finalisation.',
    uploadFailedReason: 'Échec du téléversement : {reason}',
    uploadRejectedReason: 'Téléversement rejeté : {reason}',
    uploadObjectNotFound: "Le serveur n'a pas pu vérifier votre téléversement. Veuillez réessayer.",
    downloadStartFailed: 'Impossible de démarrer le téléchargement.',
  },
  switcher: {
    label: 'Langue',
    triggerAria: 'Changer de langue',
    en: 'English',
    es: 'Español',
    fr: 'Français',
  },
  footer: {
    poweredBy: 'Propulsé par File Harbor',
  },
};
