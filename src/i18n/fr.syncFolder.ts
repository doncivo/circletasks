/**
 * Textes de Réglages › Synchronisation (Y-01, Y-08) : choix du dossier (`sync.folder`) et clé (`sync.key`), en français : source de
 * vérité ; `en.syncFolder.ts` suit la même forme. Les autres sous-sections de `sync` (état, restauration, conflits, appairage)
 * arrivent avec les lots Y2 et Y3. Les textes des boîtes natives ouvertes par Rust sont dans `native/fr.json`.
 */
export const syncFolderFr = {
  sectionTitle: 'SYNCHRONISATION',
  rowLabel: 'Dossier de synchro',
  /** Libellé d'un dossier iCloud Drive (Reglages.html) ; `{name}` : nom du dossier rendu par Rust. */
  icloudLabel: 'iCloud Drive / {name}',
  notConfigured: 'Non configurée',
  choose: 'Choisir le dossier',
  chooseLabel: 'Choisir le dossier de synchronisation',
  choosing: 'Choix du dossier…',
  chosen: 'Dossier choisi',
  notIcloud: 'Ce dossier n’est pas dans iCloud Drive : vos appareils ne le partageront pas',
  forget: 'Oublier',
  forgetLabel: 'Oublier le dossier de synchronisation',
  forgetTitle: 'Oublier le dossier de synchro ?',
  forgetDescription:
    'Cet appareil ne se synchronisera plus ; ses données restent sur l’appareil. La désinstallation de l’app n’efface pas la clé de synchronisation : choisissez « Oublier le dossier et la clé » avant de désinstaller.',
  forgetFolder: 'Oublier le dossier',
  forgetFolderAndKey: 'Oublier le dossier et la clé',
  errorUnsafe: 'Ce dossier ne peut pas servir à la synchronisation : choisissez-en un autre',
  // Y-IOS-02 (audit des impasses) : erreur du dossier lié relue à la demande.
  retry: 'Réessayer',
  retryLabel: 'Relire l’état du dossier de synchronisation',
  errorUnreachable: 'Le dossier de synchro est introuvable',
  errorUnreachableIos: 'Dossier iCloud Drive inaccessible : choisissez de nouveau le dossier iCloud Drive / CircleTasks',
  errorTooLarge: 'Le dossier de synchro est trop volumineux',
  errorProviderStopped: 'Ouvrez iCloud pour Windows',
  errorVault: 'Le coffre de Windows est indisponible',
  errorVaultIos: 'Le Trousseau de l’iPhone est indisponible : déverrouillez l’iPhone, la synchro reprendra',
  errorDenied: 'Action annulée',
  errorRateLimited: 'Trop de tentatives : réessayez dans quelques minutes',
  errorGeneric: 'La synchronisation a rencontré une erreur',
} as const;

export const syncKeyFr = {
  needsPairing: 'Ce dossier contient déjà des données chiffrées : associez cet appareil',
  mismatch: 'Ce dossier a été chiffré avec une autre clé : associez cet appareil',
} as const;
