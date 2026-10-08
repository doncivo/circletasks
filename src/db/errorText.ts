/** Étape de l'ouverture de la base qui a échoué (diagnostic affiché sous app.dbError). */
export type DbOpenStep = 'runtime' | 'load' | 'pragma' | 'schema' | 'backup' | 'migration' | 'afterApply' | 'other';

/** Nom de l'erreur (`Error.name`), ou sa forme quand ce n'est pas une Error (chaîne rejetée par Tauri, objet d'une commande Rust). */
export function errorName(error: unknown): string {
  if (error instanceof DbStepError && error.cause !== undefined) return errorName(error.cause);
  if (error instanceof Error) return error.name;
  return error === null ? 'null' : typeof error;
}

/** Erreur qui porte l'étape où elle s'est produite (posée par le driver, qui seul distingue Database.load des PRAGMA). */
export class DbStepError extends Error {
  override readonly name = 'DbStepError';
  constructor(
    readonly step: DbOpenStep,
    cause: unknown,
  ) {
    super(describeError(cause), { cause });
  }
}

/** Longueur maximale d'un message d'erreur conservé pour le diagnostic (assez pour une erreur sqlx ou Tauri complète). */
export const MAX_ERROR_TEXT = 4000;

/**
 * Texte exact d'une erreur, quelle que soit sa forme : `Error.message` (et sa cause), chaîne rejetée par Tauri, objet sérialisé par une
 * commande Rust (`{ code, message }`). Jamais « [object Object] » ; tronqué seulement au-delà de MAX_ERROR_TEXT caractères.
 */
export function describeError(error: unknown): string {
  const text = describe(error, 0);
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

function describe(error: unknown, depth: number): string {
  if (error instanceof Error) {
    const message = error.message || error.name;
    if (depth < 3 && error.cause !== undefined) {
      const cause = describe(error.cause, depth + 1);
      if (cause && !message.includes(cause)) return `${message} (cause : ${cause})`;
    }
    return message;
  }
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error as number | boolean | bigint);
}
