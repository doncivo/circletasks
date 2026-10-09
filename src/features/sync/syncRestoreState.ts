import type { SyncScheduler } from '../../sync';
import type { AppContainer } from '../app/container';

/** Planificateur actif de chaque conteneur : « Quitter » (desktop.ts) passe par lui, jamais par un minuteur à part. */
export const schedulers = new WeakMap<AppContainer, SyncScheduler>();

/** Code du marqueur de restauration non écrit (P-04-iOS critère 12) : bandeau `syncTrouble` posé tant qu'il n'est pas résolu. */
export const markerFailures = new WeakMap<AppContainer, { readonly code: string; readonly refresh: () => void }>();
