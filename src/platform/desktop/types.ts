/**
 * Contrat de l'intégration système du PC Windows (M16), ADR 0006. Seule src/platform connaît
 * Tauri ; les features reçoivent un `DesktopPlatform` via le conteneur (`null` hors PC :
 * navigateur de développement, Playwright, iPhone).
 */

/** Textes du menu de la zone de notification, tirés de src/i18n (clés `desktop.tray.*`). */
export interface TrayLabels {
  readonly open: string;
  readonly quickAdd: string;
  readonly sync: string;
  readonly quit: string;
  /**
   * Synchro configurée (Y-03) : « Synchroniser maintenant » lance un cycle silencieux ; sinon l'entrée affiche la fenêtre sur
   * Réglages › Synchronisation (D1). L'entrée n'est jamais grisée.
   */
  readonly syncEnabled: boolean;
}

/** Avancement du téléchargement d'une mise à jour. `totalBytes` est null si le serveur ne l'annonce pas. */
export interface UpdateProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
}

/** Cause d'un échec d'installation : `signature` = paquet refusé (clé autre, paquet modifié). */
export type UpdateFailureKind = 'signature' | 'other';

export class UpdateInstallError extends Error {
  readonly kind: UpdateFailureKind;
  constructor(kind: UpdateFailureKind, cause: unknown) {
    super(`Échec de l'installation de la mise à jour (${kind})`, { cause });
    this.name = 'UpdateInstallError';
    this.kind = kind;
  }
}

/** Mise à jour annoncée par `latest.json`, plus récente que la version installée. */
export interface PendingUpdate {
  readonly version: string;
  /** Notes de version (texte brut), null si le fichier n'en contient pas. */
  readonly notes: string | null;
  /**
   * Télécharge, vérifie la signature, installe, puis redémarre l'app (D-03, critère 4).
   * Rejette avec `UpdateInstallError` ; l'app actuelle continue alors de tourner.
   */
  install(onProgress: (progress: UpdateProgress) => void): Promise<void>;
  /** Libère la ressource côté Rust quand la mise à jour n'est pas installée. Ne rejette jamais. */
  dispose(): Promise<void>;
}

/** Cause d'un refus d'enregistrement d'un raccourci global (codes `shortcut-*` de src-tauri/src/shortcut.rs). */
export type GlobalShortcutFailure = 'syntax' | 'no-modifier' | 'windows-key' | 'reserved' | 'in-use' | 'unavailable';

export class GlobalShortcutError extends Error {
  readonly reason: GlobalShortcutFailure;
  constructor(reason: GlobalShortcutFailure, cause?: unknown) {
    super(`Raccourci global refusé (${reason})`, { cause });
    this.name = 'GlobalShortcutError';
    this.reason = reason;
  }
}

/**
 * Raccourci clavier global, actif même fenêtre réduite (D-04). Combinaison en notation du registre
 * (`Ctrl+Alt+Space`, src/features/app/shortcuts.ts). Une seule combinaison est enregistrée à la fois.
 */
export interface GlobalShortcuts {
  /**
   * Enregistre la combinaison auprès du système et remplace l'ancienne sans redémarrage. Rejette avec
   * `GlobalShortcutError` ; l'ancienne combinaison reste alors active.
   */
  register(chord: string): Promise<void>;
  /** Retire la combinaison enregistrée ; sans effet si aucune. */
  unregister(): Promise<void>;
  /** Vrai si cette combinaison est celle enregistrée auprès du système. */
  isRegistered(chord: string): Promise<boolean>;
}

export interface DesktopPlatform {
  /** Raccourci global de la capture rapide (D-04). */
  readonly globalShortcuts: GlobalShortcuts;
  /** Remplace le menu de la zone de notification par ces textes (D-01). */
  setTrayLabels(labels: TrayLabels): Promise<void>;
  /** Entrée « Ajout rapide » du menu (D-01, critère 5). Renvoie la fonction de désabonnement. */
  onQuickAdd(handler: () => void): Promise<() => void>;
  /** Entrée « Synchroniser maintenant » du menu (Y-03, événement `tray-sync-now`). Renvoie la fonction de désabonnement. */
  onTraySyncNow(handler: () => void): Promise<() => void>;
  /**
   * Appareil associé (Y-06, événement `sync-paired` émis par Rust vers `main`, sans clé) : import réussi dans la fenêtre `pairing`,
   * ou arrivée de l'appareil qui a scanné le QR. Renvoie la fonction de désabonnement.
   */
  onSyncPaired(handler: () => void): Promise<() => void>;
  /**
   * « Quitter » du menu (D-01, critère 7) : le gestionnaire termine les écritures en cours et le dernier cycle de synchro (Y-02) ;
   * la sortie attend sa fin (5 s au plus côté Rust, `QUIT_GRACE`), puis l'app se ferme. Un échec du handler n'empêche pas la sortie.
   */
  onQuitting(handler: () => Promise<void>): Promise<() => void>;
  /** État réel de l'entrée de démarrage Windows (D-02, critère 6), pas le réglage mémorisé. */
  getAutostart(): Promise<boolean>;
  /** Crée ou supprime l'entrée de démarrage de l'utilisateur courant, avec `--minimized` (D-02). */
  setAutostart(enabled: boolean): Promise<void>;
  /** Version installée (tauri.conf.json). */
  getVersion(): Promise<string>;
  /** Interroge `latest.json` ; null si la version publiée n'est pas plus récente. Rejette si injoignable. */
  checkForUpdate(): Promise<PendingUpdate | null>;
  /** Ouvre la page de la dernière version dans le navigateur (D-03, « À propos »). */
  openLatestRelease(): Promise<void>;
}
