/**
 * Excursions voulues par l'app (I-03, ADR 0013 §2.4 et avenant, audit M1) : seule `system-settings` (Réglages iOS, l'app passe en
 * arrière-plan) dispense du délai de 30 s au retour. Le sélecteur de dossier, la caméra du scan et les demandes d'autorisation
 * s'affichent dans l'app : un VRAI passage en arrière-plan pendant l'une d'elles suit la règle des 30 s. L'excursion est notée AVANT l'appel et consommée une seule fois, au
 * premier retour au premier plan qui suit (`takeExcursion`) ; la politique (`shouldLock`) l'ignore après 5 min.
 *
 * Complément plus strict que l'ADR : une excursion terminée alors que le document est visible (sélecteur, caméra ou fenêtre
 * d'autorisation affichés dans l'app, sans passage en arrière-plan) est effacée aussitôt, pour qu'un passage en arrière-plan ultérieur
 * reste soumis aux 30 s. Sauf `system-settings`, gardée jusqu'au retour.
 */
export type ExcursionKind = 'folder-picker' | 'camera' | 'system-settings' | 'permission';

export interface Excursion {
  readonly kind: ExcursionKind;
  readonly startedAt: number;
  /** Horloge monotone (`performance.now()`) au départ : insensible à un changement de l'heure système (audit B1). */
  readonly startedMono: number;
}

let current: Excursion | null = null;
let now: () => number = () => Date.now();
let mono: () => number = () => performance.now();
let isVisible: () => boolean = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function withExcursion<T>(kind: ExcursionKind, run: () => Promise<T>): Promise<T> {
  const token: Excursion = { kind, startedAt: now(), startedMono: mono() };
  current = token;
  const settle = (): void => {
    // Réglages iOS : la promesse se résout AVANT le passage en arrière-plan ; l'excursion attend le retour (ou ses 5 min).
    if (kind !== 'system-settings' && current === token && isVisible()) current = null;
  };
  let pending: Promise<T>;
  try {
    pending = run();
  } catch (error) {
    settle();
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return pending.finally(settle);
}

/** Retour au premier plan : rend l'excursion en cours (ou null) et l'efface. */
export function takeExcursion(): Excursion | null {
  const taken = current;
  current = null;
  return taken;
}

/** Tests : horloge et visibilité injectées, état effacé. */
export function configureExcursions(options: { readonly now?: () => number; readonly mono?: () => number; readonly isVisible?: () => boolean } = {}): void {
  current = null;
  now = options.now ?? (() => Date.now());
  mono = options.mono ?? (() => performance.now());
  isVisible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
}

/** Excursion en cours (tests). */
export function currentExcursion(): { readonly kind: ExcursionKind; readonly startedAt: number } | null {
  return current;
}

/** « Ouvrir les réglages » de la caméra (Y-IOS-02) : Réglages iOS = excursion, gardée jusqu'au retour dans l'app. */
export function openCameraSettings(platform: { readonly key: { openCameraSettings?(): Promise<void> } }): Promise<void> {
  const key = platform.key;
  const open = key.openCameraSettings;
  if (!open) return Promise.resolve();
  return withExcursion('system-settings', () => open.call(key));
}
