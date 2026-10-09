const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Code court d'un échec de fichier, affiché à l'utilisateur et inscrit au journal (FILES-IOS-01 critère 9, aucun échec silencieux) : le code
 * de Rust porté par la cause (`{ code }`, par exemple `io`, `unsafe-folder`) s'il a la forme d'un code, sinon la raison du contrat.
 */
export function fileErrorCode(error: unknown): string {
  const candidate = typeof error === 'object' && error !== null ? (error as { reason?: unknown; cause?: unknown }) : {};
  const cause = typeof candidate.cause === 'object' && candidate.cause !== null ? (candidate.cause as { code?: unknown }).code : undefined;
  if (typeof cause === 'string' && CODE_PATTERN.test(cause)) return cause;
  if (typeof candidate.reason === 'string' && CODE_PATTERN.test(candidate.reason)) return candidate.reason;
  return 'write-failed';
}
