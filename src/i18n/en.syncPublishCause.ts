import type { syncPublishCauseFr } from './fr.syncPublishCause';

/** Named causes of the "this device's state is not published" warning (same keys as `fr.syncPublishCause.ts`). */
export const syncPublishCauseEn: Record<keyof typeof syncPublishCauseFr, string> = {
  'first-publication-state-refused': 'First publication interrupted: this device’s state could not be written. Retried on every sync.',
  'unexplained-files': 'Unknown file in this device’s folder: its state is not published while it remains.',
};
