/**
 * Y-TECH-05 : demande d'ouverture d'un compte rendu, posée par le bandeau (« Voir ») et lue par la ligne de Réglages › Synchronisation ›
 * Détails à son affichage : le détail s'ouvre sur le compte rendu non acquitté. Lue sans être consommée (un rendu double ne la perd pas),
 * puis effacée une fois la ligne affichée.
 */
let requested: number | null = null;

export function requestCarryReportOpen(id: number | null): void {
  requested = id;
}

export function peekCarryReportOpen(): number | null {
  return requested;
}
