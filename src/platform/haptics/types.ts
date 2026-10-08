/**
 * Retour haptique (A-07, ADR 0013 §1.2) : cosmétique. Aucune méthode ne rejette ni n'attend ; un échec n'est jamais affiché, seulement
 * journalisé (`haptics-failed:{commande}`, une fois par commande et par processus).
 */
export type ImpactStyle = 'light' | 'medium' | 'heavy';
export type FeedbackKind = 'success' | 'warning' | 'error';

export interface Haptics {
  impact(style: ImpactStyle): void;
  notification(kind: FeedbackKind): void;
  selection(): void;
}

export type HapticsCommand = 'impact_feedback' | 'notification_feedback' | 'selection_feedback';
