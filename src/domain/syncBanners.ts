// Chemins par `../domain/sync` : l'exception de couche d'ESLint (`**/domain/sync/**`, domaine pur) ne reconnaît pas `./sync`.
import type { DeviceState } from '../domain/sync/compat';
import type { SyncErrorCode } from '../domain/sync/format';
import type { DeviceId } from './types';

/**
 * Bandeaux A-09 de la synchronisation (critère 9, solde du lot Y4 ; décisions D1 à D5 de la fiche). Exigence d'Ali : **aucun échec
 * silencieux** ; tout échec ou état bloqué de la synchro a son bandeau depuis l'écran principal, tant qu'il dure.
 *
 * Module pur : il décide **quel** bandeau montrer ; les textes (ceux de la ligne de Réglages, D5) sont composés par l'interface
 * (`src/features/sync/startSync.ts`, `syncText.ts`).
 *
 * Phases : la liste `SYNC_PHASES` est la seule source de `SyncPhase` (`src/platform/sync/types.ts` en dérive). Une phase ajoutée
 * (Y-10 `forgotten`, Y-11 `reset-required`) fait échouer la compilation tant que `phaseBanner` n'a pas sa ligne (`switch` exhaustif).
 */

export const SYNC_PHASES = [
  'not-configured',
  'needs-pairing',
  'idle',
  'syncing',
  'waiting-icloud',
  'restore-choice',
  'update-required',
  'clock-ahead',
  'key-mismatch',
  'error',
] as const;

export type SyncPhase = (typeof SYNC_PHASES)[number];

/** Statuts d'appareil (`DeviceState` de `compat.ts`, même union que `DeviceSyncStatus`, vérifiée par test). */
export const DEVICE_STATES = ['active', 'expired', 'newer-major', 'clock-ahead', 'corrupt', 'foreign', 'rollback', 'forgotten'] as const satisfies readonly DeviceState[];

/** Phase qui produit un bandeau `syncTrouble` (texte : `statusLine`, D5). */
export type PhaseTroubleCode = 'needs-pairing' | 'key-mismatch' | 'restore-choice' | 'error' | 'clock-ahead';
/** Appareil nommé comme dans APPAREILS, avec son statut. */
export type DeviceTroubleCode = 'device-foreign' | 'device-corrupt' | 'device-rollback';
export type SyncTroubleCode = PhaseTroubleCode | 'join-failed' | DeviceTroubleCode;

/**
 * Ordre d'urgence (D4) : le premier état actif de cette liste est montré, les autres comptent dans « (+N) ».
 * Emplacements réservés (ajoutés par leur story après la fusion de A-09) : Y-10 `forgotten` et Y-11 `reset-required` en tête (appareil
 * oublié ou à réassocier) ; Y-11 réinitialisation en cours ou en échec après `join-failed` ; Y-10 oubli en attente ou en échec et Y-11
 * rappel des 30 jours à la fin.
 */
export const SYNC_TROUBLE_ORDER = [
  // Appareil à associer (Y-10 `forgotten`, Y-11 `reset-required` ici).
  'needs-pairing',
  // Clé différente.
  'key-mismatch',
  // Choix après restauration : toute synchro est suspendue jusqu'au choix (place non fixée par D4 : juste après la clé, même effet).
  'restore-choice',
  // Échec.
  'error',
  // Horloge en avance.
  'clock-ahead',
  // Arrivée d'un nouvel appareil en échec (Y-06). (Y-11 : réinitialisation en cours ou en échec ici.)
  'join-failed',
  // Appareils à réassocier ou illisibles. (Y-10 oubli en attente ou en échec, Y-11 rappel des 30 jours ici.)
  'device-foreign',
  'device-corrupt',
  'device-rollback',
] as const satisfies readonly SyncTroubleCode[];

/** Décision de bandeau d'une phase. `none` porte sa raison (critère 9 b : aucune phase sans décision explicite). */
export type PhaseBanner =
  | { readonly kind: 'trouble'; readonly code: PhaseTroubleCode }
  | { readonly kind: 'waitingIcloud' }
  | { readonly kind: 'syncing' }
  | { readonly kind: 'none'; readonly reason: 'normal' | 'not-configured' | 'update-required' };

/** Bandeau d'une phase (critères 9 b et 9 c). */
export function phaseBanner(phase: SyncPhase): PhaseBanner {
  switch (phase) {
    case 'idle':
      // À jour : rien à signaler.
      return { kind: 'none', reason: 'normal' };
    case 'not-configured':
      // Synchro jamais choisie (ou dossier oublié) : un choix de l'utilisateur, pas un échec ; état aussi d'avant le premier cycle.
      return { kind: 'none', reason: 'not-configured' };
    case 'update-required':
      // Lecture suspendue par une majeure supérieure : bandeau `updateRequired` (Y-07 critère 9), jamais deux bandeaux pour un état.
      return { kind: 'none', reason: 'update-required' };
    case 'syncing':
      return { kind: 'syncing' };
    case 'waiting-icloud':
      return { kind: 'waitingIcloud' };
    case 'needs-pairing':
    case 'key-mismatch':
    case 'restore-choice':
    case 'error':
    case 'clock-ahead':
      return { kind: 'trouble', code: phase };
    default:
      return unreachable(phase);
  }
}

/** Bandeau du statut d'un autre appareil (critère 9 f). */
export function deviceTrouble(status: DeviceState): DeviceTroubleCode | null {
  switch (status) {
    case 'foreign':
      return 'device-foreign';
    case 'corrupt':
      return 'device-corrupt';
    case 'rollback':
      return 'device-rollback';
    case 'active':
      return null;
    case 'expired':
      // Hors ligne plus de 180 jours : reprise automatique depuis l'instantané à son retour (Y-09), rien à faire.
      return null;
    case 'newer-major':
      // Couvert par `updateRequired` (Y-07).
      return null;
    case 'clock-ahead':
      // Couvert par la phase `clock-ahead` (texte qui nomme l'appareil).
      return null;
    case 'forgotten':
      // Un autre appareil oublié l'a été par un choix explicite (Y-10) : pas un échec. L'appareil local oublié est une phase de Y-10.
      return null;
    default:
      return unreachable(status);
  }
}

function unreachable(value: never): never {
  throw new Error(`cas de bandeau non décidé : ${String(value)}`);
}

export interface SyncBannerDevice {
  readonly deviceId: DeviceId;
  readonly self: boolean;
  readonly status: DeviceState;
}

/** Ce que la synchro expose (forme de `SyncStatus`). */
export interface SyncBannerStatus<D extends SyncBannerDevice = SyncBannerDevice> {
  readonly phase: SyncPhase;
  readonly errorCode?: SyncErrorCode | null | undefined;
  readonly devices: readonly D[];
}

/** Arrivée d'un nouvel appareil arrêtée par un échec (`sync_meta.join`, Y-06) : gardée par le moteur jusqu'à la réussite. */
export interface JoinFailureFact {
  readonly done: number;
  readonly total: number;
  readonly failure: string;
}

/** États persistés, lus dans la base locale au démarrage et après chaque cycle (critères 9 f et 9 i). */
export interface PersistedSyncFacts<D extends SyncBannerDevice = SyncBannerDevice> {
  readonly join: JoinFailureFact | null;
  /**
   * Appareils de `sync_state`, tant qu'aucun cycle n'a fini depuis le démarrage (l'état exposé ne les connaît pas encore) ; null ensuite :
   * l'état du dernier cycle fait foi.
   */
  readonly devices: readonly D[] | null;
}

export type SyncTrouble<D extends SyncBannerDevice = SyncBannerDevice> =
  | { readonly code: PhaseTroubleCode }
  | { readonly code: 'join-failed'; readonly join: JoinFailureFact }
  | { readonly code: DeviceTroubleCode; readonly device: D };

export interface SyncBanners<D extends SyncBannerDevice = SyncBannerDevice> {
  /** Du plus urgent au moins urgent (D4) ; vide : aucun `syncTrouble`. */
  readonly troubles: readonly SyncTrouble<D>[];
  /** Appareils retenus (nommage « iPhone » / « PC 1a2b » comme dans APPAREILS). */
  readonly devices: readonly D[];
  /** « En attente d'iCloud » ; `cause` : code qui explique l'attente (texte de la ligne de Réglages, critère 9 e), sinon null. */
  readonly waitingIcloud: { readonly cause: SyncErrorCode | null } | null;
  /** Cycle en cours (le bandeau n'est montré qu'après 1 s, critère 9 d : minuterie de l'appelant). */
  readonly syncing: boolean;
}

const rank = (code: SyncTroubleCode): number => (SYNC_TROUBLE_ORDER as readonly SyncTroubleCode[]).indexOf(code);

/**
 * Bandeaux à poser pour un état de la synchro.
 *
 * `settled` : dernier état hors cycle. Pendant un cycle (`syncing`), les bandeaux d'échec de la phase précédente restent affichés
 * jusqu'à ce que le cycle conclue (pas de clignotement toutes les 5 minutes, pas de disparition sans résolution).
 */
export function syncBannerFor<D extends SyncBannerDevice>(status: SyncBannerStatus<D>, persisted: PersistedSyncFacts<D>, settled: SyncBannerStatus<D> | null = null): SyncBanners<D> {
  const current = phaseBanner(status.phase);
  const shownPhase = current.kind === 'syncing' && settled ? phaseBanner(settled.phase) : current;
  const devices = persisted.devices ?? status.devices;
  const troubles: SyncTrouble<D>[] = [];
  let keyMismatch = shownPhase.kind === 'trouble' && shownPhase.code === 'key-mismatch';
  if (shownPhase.kind === 'trouble') troubles.push({ code: shownPhase.code });

  const others = devices.filter((d) => !d.self);
  // Avant le premier cycle : même règle que le moteur (tous les autres appareils d'une autre clé = cet appareil est à réassocier).
  if (persisted.devices !== null && !keyMismatch && others.length > 0 && others.every((d) => d.status === 'foreign')) {
    troubles.push({ code: 'key-mismatch' });
    keyMismatch = true;
  }
  if (persisted.join) troubles.push({ code: 'join-failed', join: persisted.join });
  for (const device of others) {
    const code = deviceTrouble(device.status);
    // « Clé différente » de chaque appareil quand la clé locale ne correspond à aucun : un seul état (`key-mismatch`), pas N + 1.
    if (code === null || (keyMismatch && code === 'device-foreign')) continue;
    troubles.push({ code, device });
  }
  troubles.sort((a, b) => rank(a.code) - rank(b.code));

  return {
    troubles,
    devices,
    waitingIcloud: current.kind === 'waitingIcloud' ? { cause: status.errorCode ?? null } : null,
    syncing: current.kind === 'syncing',
  };
}
