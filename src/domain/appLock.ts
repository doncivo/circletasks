/**
 * Politique de verrouillage de l'app (I-03, ADR 0013 §2.3) : fonction pure, sans horloge ni plateforme. Le verrou couvre l'interface,
 * jamais les données (base, synchro, notifications continuent). Échec fermé : tout doute verrouille.
 */

/** Délai de reverrouillage au retour au premier plan (D1 : fixe, sans réglage). */
export const APP_LOCK_RELOCK_MS = 30_000;
/** Durée maximale d'une excursion voulue par l'app (sélecteur de dossier, caméra, Réglages iOS, autorisation) : jamais de contournement durable. */
export const APP_LOCK_EXCURSION_MAX_MS = 5 * 60_000;

export interface AppLockInput {
  readonly enabled: boolean;
  readonly state: 'cold-start' | 'resume';
  /** Instant courant (ms, horloge murale). */
  readonly now: number;
  /** Instant du passage masqué (ms) ; null : inconnu. */
  readonly backgroundedAt: number | null;
  /** Excursion déclarée par l'app avant le passage masqué ; null : aucune. */
  readonly excursion: { readonly startedAt: number } | null;
}

/**
 * Vrai si l'app doit être verrouillée :
 * - désactivé : jamais ;
 * - lancement à froid : toujours ;
 * - retour : instant du passage masqué inconnu ou horloge qui recule → oui ; excursion couvrant le passage masqué et de moins de 5 min → non ;
 *   sinon oui à partir de 30 s passées en arrière-plan.
 */
export function shouldLock(input: AppLockInput): boolean {
  if (!input.enabled) return false;
  if (input.state === 'cold-start') return true;
  const { now, backgroundedAt, excursion } = input;
  if (!Number.isFinite(now)) return true;
  if (backgroundedAt === null || !Number.isFinite(backgroundedAt)) return true;
  if (now < backgroundedAt) return true;
  if (excursion !== null && Number.isFinite(excursion.startedAt)) {
    const { startedAt } = excursion;
    if (startedAt <= backgroundedAt && backgroundedAt <= now && now - startedAt < APP_LOCK_EXCURSION_MAX_MS) return false;
  }
  return now - backgroundedAt >= APP_LOCK_RELOCK_MS;
}

export interface AppLockSetting {
  readonly enabled: boolean;
  /** Valeur stockée illisible : lue comme activée (échec fermé) ; l'appelant journalise `setting-unreadable`. */
  readonly unreadable: boolean;
}

/**
 * Lecture du réglage local `security.appLock` (valeur brute) : booléen tel quel, toute autre valeur → activé et illisible (échec fermé).
 * Absent ou `null` → désactivé, sans être illisible : c'est l'état d'une installation neuve (aucune ligne en base, valeur par défaut
 * `false`) ou d'une réinstallation (le réglage local disparaît avec l'app, I-03 A5). Seule l'app écrit ce réglage, toujours un booléen :
 * un `null` ne résulte d'aucune écriture de l'app, et le verrou n'apporte rien sans réglage choisi par l'utilisateur.
 */
export function parseAppLockSetting(raw: unknown): AppLockSetting {
  if (raw === true || raw === false) return { enabled: raw, unreadable: false };
  if (raw === null || raw === undefined) return { enabled: false, unreadable: false };
  return { enabled: true, unreadable: true };
}
