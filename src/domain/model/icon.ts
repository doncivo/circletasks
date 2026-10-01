/**
 * Icône d'un élément (tâche, routine, objectif, événement) : un seul champ `icon`
 * par ligne (PRD section 6), qui contient soit une icône Lucide, soit un emoji (T-03).
 *
 * Forme en base (colonne TEXT) : 'lucide:<nom-kebab>' ou 'emoji:<caractères>'.
 * Le nom Lucide est celui du catalogue lucide (ex. 'file-text', 'glass-water') ;
 * la couleur de l'icône vient du thème, jamais de la base (pas de couleur par tâche).
 */
export type IconRef =
  | { readonly kind: 'lucide'; readonly name: string }
  | { readonly kind: 'emoji'; readonly value: string };

const LUCIDE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Un emoji composé (drapeau, famille, teinte) tient en quelques points de code. */
const EMOJI_MAX_LENGTH = 16;

export function isValidIconRef(icon: IconRef): boolean {
  if (icon.kind === 'lucide') return LUCIDE_NAME_RE.test(icon.name);
  return icon.value.trim().length > 0 && icon.value.length <= EMOJI_MAX_LENGTH && !/\s/.test(icon.value);
}

/** Sérialise pour la colonne `icon` ; lève une erreur si l'icône est invalide. */
export function encodeIcon(icon: IconRef): string {
  if (!isValidIconRef(icon)) throw new TypeError('Icône invalide');
  return icon.kind === 'lucide' ? `lucide:${icon.name}` : `emoji:${icon.value}`;
}

/** Lit la colonne `icon` ; `null` si vide ou illisible (valeur venue d'une version future). */
export function parseIcon(stored: string | null): IconRef | null {
  if (stored === null) return null;
  const sep = stored.indexOf(':');
  if (sep < 0) return null;
  const prefix = stored.slice(0, sep);
  const body = stored.slice(sep + 1);
  const icon: IconRef | null =
    prefix === 'lucide' ? { kind: 'lucide', name: body } : prefix === 'emoji' ? { kind: 'emoji', value: body } : null;
  return icon && isValidIconRef(icon) ? icon : null;
}
