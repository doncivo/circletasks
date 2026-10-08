import type { LogJournal } from '../logs/types';

/**
 * Journal technique de l'app (D-03, I-04, ADR 0014 §3). `logFailure` est le **seul point d'entrée** : copie sur la console (seul point
 * d'écriture console de l'app), puis entrée du journal persistant installé au démarrage (`installLogJournal`) ; avant l'installation, les
 * entrées attendent ici (500 au plus) et y sont versées dès qu'il existe. Les messages ne s'affichent jamais tels quels à l'utilisateur :
 * l'écran Logs (Réglages › À propos) montre le scope, le code et le détail assaini.
 *
 * Règle pour les appelants : ne passer que des codes, compteurs et identifiants techniques — jamais un titre, une note, un nom de projet,
 * une valeur de champ, un chemin, une clé ou un jeton.
 */
let journal: LogJournal | null = null;
const early: (readonly [string, unknown])[] = [];
const EARLY_MAX = 500;
let announce: ((journal: LogJournal) => void) | null = null;
const ready = new Promise<LogJournal>((resolve) => {
  announce = resolve;
});

export function logDesktopFailure(scope: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console -- journal technique unique, voir le commentaire du fichier
  console.warn(`[desktop:${scope}] ${detail}`);
  if (journal) {
    journal.record(scope, error);
    return;
  }
  early.push([scope, error]);
  if (early.length > EARLY_MAX) early.shift();
}

/** Même journal pour les échecs hors intégration PC (écrans, dates, catalogues) : même implémentation, nom neutre. */
export const logFailure = logDesktopFailure;

/** Installe le journal de la fenêtre (une fois, au démarrage) et y verse les entrées notées avant. */
export function installLogJournal(next: LogJournal): void {
  journal = next;
  for (const [scope, error] of early.splice(0)) next.record(scope, error);
  announce?.(next);
}

/** Journal installé, dès qu'il existe (écran Logs, ligne « Logs » de Réglages). */
export function whenLogJournal(): Promise<LogJournal> {
  return ready;
}

/** Journal installé, ou null avant l'installation. */
export function currentLogJournal(): LogJournal | null {
  return journal;
}
