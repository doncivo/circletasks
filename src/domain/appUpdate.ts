/**
 * Premier lancement d'une nouvelle version (I-06, ADR 0007 avenant I-06 point 6) : règle pure, sans accès à la base ni à la plateforme.
 *
 * - `first-install` : aucune version mémorisée et aucune donnée antérieure (pas d'identité d'appareil) ;
 * - `updated` : version courante plus récente que la version mémorisée, ou version mémorisée absente alors que l'app a déjà tourné
 *   (première version qui mémorise le numéro : les installations existantes comptent comme une mise à jour), ou valeur mémorisée illisible ;
 * - `same` : même version ;
 * - `downgraded` : version courante plus ancienne (IPA plus ancienne réinstallée, base compatible) ;
 * - `unknown` : version courante illisible : rien n'est décidé ni mémorisé.
 */
export type LaunchKind = 'first-install' | 'same' | 'updated' | 'downgraded' | 'unknown';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Numéro X.Y.Z lisible ; `0.0.0` (ancien repli de l'iPhone) ne l'est pas. */
export function isAppVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value) && value !== '0.0.0';
}

/** Comparaison numérique composant par composant de deux numéros lisibles (négatif : `a` plus ancien). */
export function compareAppVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  if (!pa || !pb) throw new RangeError('numéro de version illisible');
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Classe le lancement. `hadPreviousRun` : l'app a déjà tourné sur cet appareil (identité `device.id` déjà présente) ; seul cas où une
 * version mémorisée absente compte comme une mise à jour.
 */
export function classifyLaunch(previous: unknown, current: string | null, hadPreviousRun = false): LaunchKind {
  if (!isAppVersion(current)) return 'unknown';
  if (previous === null || previous === undefined) return hadPreviousRun ? 'updated' : 'first-install';
  if (!isAppVersion(previous)) return 'updated';
  const order = compareAppVersions(current, previous);
  return order === 0 ? 'same' : order > 0 ? 'updated' : 'downgraded';
}

/** Faut-il mémoriser la version courante à la fin du démarrage ? Jamais pour `same` (rien à changer) ni `unknown` (version illisible). */
export function shouldRecordLaunch(kind: LaunchKind): boolean {
  return kind === 'first-install' || kind === 'updated' || kind === 'downgraded';
}
