/**
 * Mise au calme avant une restauration (P-04-iOS critère 6, revue I3) : drapeau de la page et travaux en cours. Pendant le calme, aucun
 * cycle de synchro ne part (service, menu de la zone de notification et minuteur d'association compris), ni rafraîchissement des agendas,
 * ni passage des Rappels Apple (K-05) ; la mise au calme attend les travaux déjà partis (`trackQuietWork`). Le rechargement (iPhone) ou
 * la relance (PC) qui suit la restauration repart d'une page neuve ; une restauration refusée relâche le calme.
 */
let quiet = false;
const inFlight = new Set<Promise<unknown>>();

export function setRestoreQuiet(on: boolean): void {
  quiet = on;
}

export function isRestoreQuiet(): boolean {
  return quiet;
}

/** Enregistre un travail qui écrit dans la base (passage des Rappels, rafraîchissement des agendas) : la mise au calme l'attend. */
export function trackQuietWork<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  void work.then(
    () => inFlight.delete(work),
    () => inFlight.delete(work),
  );
  return work;
}

/** Fin des travaux en cours, `timeoutMs` au plus ; faux si l'un d'eux n'a pas fini. */
export async function quietWorkSettled(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = Promise.allSettled([...inFlight]).then(() => true);
  const result = await Promise.race([done, new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)))]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}
