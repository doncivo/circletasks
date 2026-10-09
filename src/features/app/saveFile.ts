import { fileErrorCode, logFailure, type FileService, type SaveRequest } from '../../platform';
import { withExcursion } from '../security/excursion';

/** Issue d'un enregistrement : enregistré, annulé (aucun message), ou échoué (message persistant avec le code et « Réessayer »). */
export type SaveFileOutcome =
  | { readonly status: 'saved'; readonly path?: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly code: string; readonly tooLarge: boolean };

/**
 * Seul chemin des features vers `files.save` (FILES-IOS-01, ADR 0009 avenant lot F A4) : le sélecteur « Enregistrer dans Fichiers » de
 * l'iPhone est une excursion du verrou (`file-picker`, règle des 30 s) ; tout échec est inscrit au journal (`scope`, code) et rendu avec
 * son code pour le message visible (critère 9 : aucun échec silencieux). L'annulation n'est pas une erreur.
 */
export async function saveFile(files: FileService, request: SaveRequest, scope: string): Promise<SaveFileOutcome> {
  try {
    const result = await withExcursion('file-picker', () => files.save(request));
    if (!result.saved) return { status: 'cancelled' };
    return result.path === undefined ? { status: 'saved' } : { status: 'saved', path: result.path };
  } catch (error) {
    logFailure(scope, error);
    const code = fileErrorCode(error);
    return { status: 'failed', code, tooLarge: code === 'too-large' };
  }
}
