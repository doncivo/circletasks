/**
 * Textes de `sync.version` (Y-07), en français : source de vérité. Bandeau A-09 « Mettez à jour l'app » et emplacement « version » de
 * Réglages › Synchronisation › Détails. Jamais de numéro de migration : seul le numéro d'application publié par l'autre appareil (D2).
 */
export const syncVersionFr = {
  banner: 'Mettez à jour l’app : un de vos appareils utilise une version plus récente',
  section: 'VERSION',
  newer: '{device} utilise une version plus récente de l’app',
  newerWithVersion: '{device} utilise une version plus récente de l’app ({version})',
  readSuspended: 'Lecture de ses données suspendue : mettez à jour l’app',
} as const;
