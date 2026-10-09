/**
 * Polices du rapport exporté (PDF, image) : texte d'essai et déclarations CSS à charger avant de dessiner sur le canvas. Les fichiers de
 * police sont servis à la demande (unicode-range) : le premier export les télécharge, ce qui peut prendre plusieurs secondes sur une
 * machine chargée. Module sans dépendance, partagé avec les e2e (`waitForReportFonts`).
 */
export const REPORT_FONT_SAMPLE = 'Septembre 0123456789 éèêàçù % — · / ÉÈ';

export const REPORT_FONT_FACES: readonly string[] = [
  '700 44px "Fraunces Variable"',
  '400 12px "DM Sans Variable"',
  '600 14px "DM Sans Variable"',
  '700 12px "DM Sans Variable"',
];
