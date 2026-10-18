import type { SyncScheduler } from '../../sync';
import type { AppContainer } from '../app/container';

/** Planificateur actif de chaque conteneur : « Quitter » (desktop.ts) passe par lui, jamais par un minuteur à part. */
export const schedulers = new WeakMap<AppContainer, SyncScheduler>();

/**
 * Y-TECH-05 : texte et action du bandeau du compte rendu du changement d'époque, composés par un bloc à la demande (`carryReportBannerLine`) ;
 * absent : à lire ; null : rien à montrer (en lecture, ou acquitté).
 */
export const carryLines = new WeakMap<AppContainer, { readonly message: string; readonly onAction: () => void } | null>();

/** Code du marqueur de restauration non écrit (P-04-iOS critère 12) : bandeau `syncTrouble` posé tant qu'il n'est pas résolu. */
export const markerFailures = new WeakMap<AppContainer, { readonly code: string; readonly refresh: () => void }>();

