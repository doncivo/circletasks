import type { ReactNode } from 'react';

/**
 * Ligne libellé / valeur de la fiche détail (PC-Aujourdhui.html `.fl` : libellé 120 px en gris, valeur en gras ; Detail.html :
 * libellé à gauche, valeur à droite). Le texte de la valeur est cliquable quand le champ s'édite sur place.
 */
export function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="ct-task-detail__row ct-task-detail__row--field">
      <span className="ct-task-detail__rowLabel">{label}</span>
      <span className="ct-task-detail__rowValue">{children}</span>
    </div>
  );
}
