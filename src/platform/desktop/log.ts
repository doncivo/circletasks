/**
 * Journal technique de l'intégration PC (échecs de vérification de mise à jour, D-03 critère 6).
 * Seul point d'écriture console de l'app : les messages ne s'affichent jamais tels quels à
 * l'utilisateur. L'écran de logs de Réglages (M12) lira ce journal quand il existera.
 */
export function logDesktopFailure(scope: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console -- journal technique unique, voir le commentaire du fichier
  console.warn(`[desktop:${scope}] ${detail}`);
}
