/**
 * Y-TECH-05 : demande d'ouverture d'un compte rendu, posée par le bandeau (« Voir ») et consommée par la ligne de Réglages ›
 * Synchronisation › Détails. Observable (contre-revue, point 2) : quand Détails est déjà affiché, `navigate` vers la même route ne remonte
 * rien, la ligne s'abonne donc et prend la demande dès qu'elle est posée ; sinon elle la prend à son affichage. Consommer = lire puis
 * effacer : une réouverture de Détails n'ouvre jamais un compte rendu tout seul. Bloc à la demande, jamais au départ.
 */
let requested: number | null = null;
const listeners = new Set<() => void>();

export function requestCarryReportOpen(id: number | null): void {
  requested = id;
  if (id !== null) for (const listener of [...listeners]) listener();
}

export function peekCarryReportOpen(): number | null {
  return requested;
}

/** Lit la demande et l'efface (null s'il n'y en a pas). */
export function takeCarryReportOpen(): number | null {
  const id = requested;
  requested = null;
  return id;
}

/** Abonnement aux demandes posées ; renvoie le désabonnement. */
export function subscribeCarryReportOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
