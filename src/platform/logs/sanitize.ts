/**
 * Assainissement du journal technique (I-04 critère 5, ADR 0014 §3) : première barrière, en TypeScript ; Rust applique les mêmes règles
 * (`applog::sanitize_detail`), vérifiées par les mêmes vecteurs (`tests/fixtures/logs/sanitize-vectors.json`).
 *
 * Règles : caractères de contrôle remplacés par une espace ; plus de 300 caractères -> `[masqué]` en entier ; sinon chaque mot (séparé par
 * des espaces) qui contient un chemin (Windows, UNC, POSIX, `~/`), `file:`, une URL avec requête, une adresse e-mail ou une séquence
 * hexadécimale de 32 caractères ou plus devient `[masqué]` ; `Bearer` et le mot suivant aussi. Un titre ne se reconnaît pas à sa forme :
 * les appelants ne passent que des codes (règle de `types.ts`), la preuve est le test de sentinelle.
 */

export const LOG_MASK = '[masqué]';
const MAX_DETAIL_CHARS = 300;

const isControl = (code: number): boolean => code <= 0x1f || (code >= 0x7f && code <= 0x9f);
const isAlnum = (char: string | undefined): boolean => char !== undefined && /^[\p{L}\p{N}]$/u.test(char);
const isAsciiAlpha = (char: string | undefined): boolean => char !== undefined && /^[A-Za-z]$/.test(char);

function hasHexRun(token: string): boolean {
  return /[0-9a-fA-F]{32,}/.test(token);
}

function hasDrivePath(chars: readonly string[]): boolean {
  return chars.some((char, i) => isAsciiAlpha(char) && (i === 0 || !isAlnum(chars[i - 1])) && chars[i + 1] === ':' && (chars[i + 2] === '\\' || chars[i + 2] === '/'));
}

function hasPosixPath(chars: readonly string[]): boolean {
  if (chars[0] === '~' && chars[1] === '/') return true;
  return chars.some((char, i) => {
    if (char !== '/') return false;
    const before = chars[i - 1];
    if (i > 0 && (isAlnum(before) || before === ':' || before === '/')) return false;
    const rest = chars.slice(i + 1);
    return rest[0] !== undefined && rest[0] !== '/' && rest.slice(1).includes('/');
  });
}

function hasEmail(chars: readonly string[]): boolean {
  return chars.some((char, at) => {
    if (at === 0 || char !== '@') return false;
    const domain = chars.slice(at + 1);
    return domain.some((c, dot) => dot >= 1 && c === '.' && isAsciiAlpha(domain[dot + 1]) && isAsciiAlpha(domain[dot + 2]));
  });
}

function hasUrlWithQuery(token: string): boolean {
  const start = token.indexOf('://');
  return start >= 0 && token.slice(start).includes('?');
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Audit du lot F (moyen) : jeton probable : suite de 24 caractères ou plus de `[A-Za-z0-9+/=_.-]` (sauf un identifiant UUID exact,
 * permis par l'ADR 0011 §2.3), JWT (`eyJ`), jeton Google (`ya29.`, `1//`), `token=`.
 */
function hasTokenLike(token: string): boolean {
  const lower = token.toLowerCase();
  if (token.includes('eyJ') || lower.includes('ya29.') || token.includes('1//') || lower.includes('token=')) return true;
  return (token.match(/[A-Za-z0-9+/=_.-]{24,}/g) ?? []).some((run) => !UUID.test(run));
}

function isSensitive(token: string): boolean {
  const chars = Array.from(token);
  return hasTokenLike(token) || token.toLowerCase().includes('file:') || token.includes('\\') || hasDrivePath(chars) || hasPosixPath(chars) || hasUrlWithQuery(token) || hasEmail(chars) || hasHexRun(token);
}

/** Détail assaini (voir l'en-tête du module). */
export function sanitizeLogDetail(raw: string): string {
  const cleaned = Array.from(raw, (char) => (isControl(char.codePointAt(0) ?? 0) ? ' ' : char)).join('');
  if (Array.from(cleaned).length > MAX_DETAIL_CHARS) return LOG_MASK;
  let maskNext = false;
  return cleaned
    .split(' ')
    .map((word) => {
      if (word === '') return word;
      if (maskNext) {
        maskNext = false;
        return LOG_MASK;
      }
      if (word.toLowerCase() === 'bearer') {
        maskNext = true;
        return LOG_MASK;
      }
      return isSensitive(word) ? LOG_MASK : word;
    })
    .join(' ');
}

const SCOPE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CODE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** Scope accepté tel quel s'il a la forme d'un scope, sinon `invalid` (même règle que Rust). */
export function normalizeScope(scope: string): string {
  return SCOPE.test(scope) ? scope : 'invalid';
}

/**
 * Jeton probable dans un code (revue du lot F) : un segment (entre `-` et `.`) de 24 caractères ou plus, hors UUID exact, ou `ya29.`. Même
 * règle que `has_code_token` de Rust ; vecteurs `codeVectors` partagés.
 */
function hasCodeToken(value: string): boolean {
  return value.includes('ya29.') || (!UUID.test(value) && value.split(/[-.]/).some((segment) => segment.length >= 24));
}

/** Valeur en forme de code (`too-large`, `sync-now`…), sans séquence hexadécimale de 32+ ni jeton probable (revue du lot F). */
export function isLogCode(value: unknown): value is string {
  return typeof value === 'string' && CODE.test(value) && !hasHexRun(value) && !hasCodeToken(value);
}

/**
 * Code et détail d'une erreur (ADR 0014 §3) : `code` = `error.code` s'il a la forme d'un code, sinon le premier mot du texte s'il en a la
 * forme, sinon `error.name`, sinon `unknown` ; `detail` = le reste, assaini.
 */
export function codeAndDetailOf(error: unknown): { readonly code: string; readonly detail: string } {
  const candidate = typeof error === 'object' && error !== null ? (error as { code?: unknown; name?: unknown; message?: unknown }) : null;
  const text = typeof error === 'string' ? error : typeof candidate?.message === 'string' ? candidate.message : '';
  if (isLogCode(candidate?.code)) return { code: candidate.code, detail: sanitizeLogDetail(text) };
  const trimmed = text.trim();
  const space = trimmed.indexOf(' ');
  const first = space < 0 ? trimmed : trimmed.slice(0, space);
  if (isLogCode(first)) return { code: first, detail: sanitizeLogDetail(space < 0 ? '' : trimmed.slice(space + 1)) };
  const name = typeof candidate?.name === 'string' ? candidate.name.toLowerCase() : '';
  return { code: isLogCode(name) ? name : 'unknown', detail: sanitizeLogDetail(trimmed) };
}
