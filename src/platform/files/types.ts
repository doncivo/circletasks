/**
 * Export et fichiers (H-03 D4) : contrat commun à l'export de l'historique (H-03), à la copie d'une sauvegarde (P-04) et à l'import
 * CSV (P-07). Implémentations : Tauri PC (boîte « Enregistrer sous » système, écriture du seul fichier choisi), navigateur (téléchargement,
 * développement et tests), mémoire (faux des tests), indisponible (iPhone avant l'ordre 5).
 */

export interface SaveRequest {
  /** Nom proposé dans la boîte « Enregistrer sous ». */
  readonly suggestedName: string;
  readonly mime: string;
  readonly data: Uint8Array;
}

export interface SaveResult {
  /** Faux si l'utilisateur a annulé (ce n'est pas une erreur). */
  readonly saved: boolean;
  /** Chemin choisi, quand la plateforme le connaît (PC) : sert à « Afficher dans le dossier ». */
  readonly path?: string;
}

export type FileFailureReason = 'write-failed' | 'unavailable' | 'unsupported';

/** Échec d'enregistrement (disque plein, droits…) : aucun fichier partiel n'est laissé. */
export class FileExportError extends Error {
  override readonly name = 'FileExportError';
  readonly reason: FileFailureReason;

  constructor(reason: FileFailureReason, cause?: unknown) {
    super(`export de fichier : ${reason}`, cause === undefined ? undefined : { cause });
    this.reason = reason;
  }
}

export interface FileExporter {
  /** Cette plateforme sait-elle enregistrer un fichier ? Faux sur iPhone tant que le plugin Fichiers (ordre 5) n'existe pas. */
  canSave(): boolean;
  /** Propose l'enregistrement ; `{ saved: false }` si l'utilisateur annule ; `FileExportError` en cas d'échec. */
  save(request: SaveRequest): Promise<SaveResult>;
  /** Ouvre le dossier du fichier enregistré (PC) ; absent ailleurs. */
  reveal?(path: string): Promise<void>;
}

export interface PickedText {
  readonly name: string;
  readonly text: string;
}

export interface FilePicker {
  /** Fichier texte choisi par l'utilisateur (P-07) ; null s'il annule. */
  pickText(options: { readonly accept: readonly string[] }): Promise<PickedText | null>;
}

export interface FileService extends FileExporter, FilePicker {}
