import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Noyau du test de contraste par règles CSS réelles (UI-FIX-01) : lecteur de feuilles de style (analyse statique, sans dépendance), résolution
 * des jetons `var(--x, repli)` dans les deux thèmes, formule de contraste WCAG. Les tests (`src/ui/theme/contrast.test.ts` et `contrastCss.test.ts`)
 * l'importent. Ce fichier est un outil de test (il lit le disque) : il vit sous `tests/`, hors de `src/` et de la couverture.
 *
 * ANGLES MORTS (assumés, renvoyés au balayage en navigateur réel après la 1.0, décision d'Ali du 2026-10-18) : l'analyse compare le texte d'une
 * règle à SON PROPRE fond, rien d'autre. Ne sont donc jamais vus : le texte hérité d'un parent et le texte posé sur un fond que porte un
 * parent ou une règle voisine (270 règles avec texte sans fond propre, 104 avec fond `transparent` ou `none`) ; les règles qui posent un fond
 * sans texte (case cochée, FAB, rail d'onglets...) ; les couleurs posées dans le TSX (`style={{ ... }}`) ; l'opacité des ancêtres ; les états
 * (`:hover`, `:focus`) qui changent le fond sans changer le texte. Portée des jetons : un jeton local à un composant (`.ct-ios-pair { --x }`) est
 * versé dans le thème entier et écrase celui de `:root` du même nom ; un jeton de `:root` placé dans un `@media` (autre que le bloc
 * `prefers-color-scheme` traité à part) est ignoré. Aucun des deux cas n'existe aujourd'hui : `tokenScopeIssues` le vérifie et fait échouer
 * le test dès qu'une collision (même nom, portées et valeurs différentes) ou un jeton ignoré apparaît. Les relations par sélecteur et par jetons de `contrastCss.test.ts` n'en
 * couvrent que quelques-uns, désignés à la main.
 */

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

/* ------------------------------------------------------------------ couleurs */

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminanceOf(color: Color): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

/** Rapport de contraste WCAG ((L1 + 0,05) / (L2 + 0,05)) de deux couleurs opaques. */
export function contrastOf(a: Color, b: Color): number {
  const [x, y] = [luminanceOf(a), luminanceOf(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

export function parseHex(hex: string): Color {
  let h = hex.trim().replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) throw new Error(`couleur hexadécimale invalide : ${hex}`);
  const byte = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) / 255 : 1 };
}

export const toHex = (c: Color): string => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Contraste de deux couleurs hexadécimales opaques (signature historique de `contrast.test.ts`). */
export const contrast = (a: string, b: string): number => contrastOf(parseHex(a), parseHex(b));

/** Couleur `fg` d'opacité `alpha` posée sur le fond opaque `bg` (opacité d'un bouton composée sur la surface). */
export function compose(fg: Color, alpha: number, bg: Color): Color {
  const a = fg.a * alpha;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

/* ---------------------------------------------------------------- lecteur CSS */

export interface CssRule {
  /** Chemin relatif à `src/`, séparateurs `/`. */
  file: string;
  /** Un seul sélecteur (les listes séparées par des virgules sont éclatées), espaces normalisés, guillemets simples. */
  selector: string;
  /** Préludes des at-rules englobants (`@media (...)`), aplatis. */
  media: string[];
  decls: Record<string, string>;
}

function scan(src: string, from: number, stops: string): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (depth === 0 && stops.includes(ch)) return i;
  }
  return src.length;
}

function splitTop(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let at = scan(value, 0, separator); at < value.length; at = scan(value, start, separator)) {
    parts.push(value.slice(start, at));
    start = at + 1;
  }
  parts.push(value.slice(start));
  return parts;
}

const normalizeSelector = (s: string): string => s.replace(/\s+/g, ' ').replace(/"/g, "'").trim();

function parseDeclarations(body: string): Record<string, string> {
  const decls: Record<string, string> = {};
  for (const part of splitTop(body, ';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (prop) decls[prop] = part.slice(colon + 1).replace(/\s+/g, ' ').trim();
  }
  return decls;
}

const GROUPING = new Set(['media', 'supports', 'container', 'layer']);

/** Règles à plat d'une feuille (commentaires retirés, `@media` aplatis, `@keyframes` et `@font-face` ignorés). CSS imbriqué : erreur. */
export function parseCss(text: string, file: string): CssRule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: CssRule[] = [];
  const block = (start: number, media: string[], nested: boolean): number => {
    let i = start;
    while (i < src.length) {
      while (i < src.length && /\s/.test(src[i] as string)) i += 1;
      if (i >= src.length) break;
      if (src[i] === '}') {
        if (!nested) throw new Error(`${file} : accolade fermante en trop`);
        return i + 1;
      }
      const end = scan(src, i, '{;}');
      const prelude = src.slice(i, end).trim();
      const stop = src[end];
      if (stop !== '{') {
        i = stop === '}' ? end : end + 1; // @import ... ; ou déclaration orpheline
        continue;
      }
      if (prelude.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1] ?? '';
        if (GROUPING.has(name)) i = block(end + 1, [...media, prelude.replace(/\s+/g, ' ')], true);
        else i = skipBlock(end + 1);
        continue;
      }
      const close = scan(src, end + 1, '{}');
      if (src[close] === '{') throw new Error(`${file} : CSS imbriqué non pris en charge près de « ${prelude} »`);
      const decls = parseDeclarations(src.slice(end + 1, close));
      for (const selector of splitTop(prelude, ',')) out.push({ file, selector: normalizeSelector(selector), media, decls });
      i = close + 1;
    }
    if (nested) throw new Error(`${file} : accolade fermante manquante`);
    return i;
  };
  const skipBlock = (start: number): number => {
    let depth = 1;
    for (let i = start; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    throw new Error(`${file} : bloc non fermé`);
  };
  block(0, [], false);
  return out;
}

export const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src');

function cssFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return cssFiles(path);
      return name.endsWith('.css') ? [path] : [];
    });
}

/** Tous les fichiers `src/**\/*.css`, relus à chaque appel (ordre alphabétique, donc stable). */
export function readAllCss(): { file: string; text: string }[] {
  return cssFiles(SRC_DIR).map((path) => ({ file: relative(SRC_DIR, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));
}

export function loadRules(): CssRule[] {
  return readAllCss().flatMap(({ file, text }) => parseCss(text, file));
}

/* ------------------------------------------------------------- thèmes, jetons */

const ROOT_LIGHT = ":root[data-theme='light']";
const ROOT_DARK = ":root[data-theme='dark']";
const ROOT_SYSTEM = ":root:not([data-theme='light'])";

const isDarkMedia = (rule: CssRule): boolean => rule.media.some((m) => /prefers-color-scheme:\s*dark/.test(m));

/** La règle joue-t-elle dans ce thème ? `@media print` jamais ; `prefers-color-scheme: dark` et sélecteurs `data-theme` ciblés. */
export function appliesTo(rule: CssRule, theme: Theme): boolean {
  if (rule.media.some((m) => /\bprint\b/.test(m))) return false;
  if (rule.media.some((m) => /prefers-color-scheme:\s*light/.test(m))) return theme === 'light';
  if (isDarkMedia(rule)) return theme === 'dark';
  if (rule.selector.includes("[data-theme='dark']")) return theme === 'dark';
  if (rule.selector.includes("[data-theme='light']")) return theme === 'light';
  return true;
}

const isGlobalTokenScope = (selector: string): boolean => [':root', ROOT_LIGHT, ROOT_DARK, ROOT_SYSTEM].includes(selector);

/**
 * Jetons d'un thème : `:root` seul, puis le bloc ciblé du thème (`:root[data-theme=…]`), puis les jetons locaux à un composant
 * (`.ct-ios-pair { --ct-ios-pair-bg }`, redéfinis par thème). Clair = `:root` + `:root[data-theme='light']`, sombre = `:root` + `:root[data-theme='dark']`
 * (le bloc `prefers-color-scheme` doit porter les mêmes valeurs : voir `systemDarkMismatches`).
 */
export function themeTokens(rules: readonly CssRule[], theme: Theme): Record<string, string> {
  const tokens: Record<string, string> = {};
  const take = (rule: CssRule): void => {
    for (const [prop, value] of Object.entries(rule.decls)) if (prop.startsWith('--')) tokens[prop] = value;
  };
  const wanted = theme === 'light' ? ROOT_LIGHT : ROOT_DARK;
  for (const rule of rules) if (rule.selector === ':root' && rule.media.length === 0) take(rule);
  for (const rule of rules) if (rule.selector === wanted) take(rule);
  for (const rule of rules) if (!isGlobalTokenScope(rule.selector) && appliesTo(rule, theme)) take(rule);
  return tokens;
}

/**
 * Collisions de portée que `themeTokens` ne sait pas arbitrer : même nom de jeton défini dans deux portées différentes (`:root` et un composant,
 * ou deux composants) avec des valeurs différentes ; jeton de `:root` dans un `@media` (ignoré). La redéfinition par thème d'une même portée
 * (`.x` puis `:root[data-theme='dark'] .x`) est le mécanisme normal et n'est pas une collision.
 */
export function tokenScopeIssues(rules: readonly CssRule[]): string[] {
  const issues: string[] = [];
  for (const rule of rules) {
    const hasToken = Object.keys(rule.decls).some((k) => k.startsWith('--'));
    if (hasToken && rule.selector === ':root' && rule.media.length > 0) issues.push(`${rule.file} : jeton de :root dans ${rule.media.join(' ')} (ignoré)`);
  }
  for (const theme of THEMES) {
    const wanted = theme === 'light' ? ROOT_LIGHT : ROOT_DARK;
    const byName = new Map<string, Map<string, string>>();
    for (const rule of rules) {
      const global = (rule.selector === ':root' && rule.media.length === 0) || rule.selector === wanted;
      const local = !isGlobalTokenScope(rule.selector) && appliesTo(rule, theme);
      if (!global && !local) continue;
      const scope = global ? ':root' : rule.selector.replace(/^:root(\[data-theme='(light|dark)'\]|:not\(\[data-theme='light'\]\))\s*/, '');
      for (const [prop, value] of Object.entries(rule.decls)) {
        if (!prop.startsWith('--')) continue;
        const scopes = byName.get(prop) ?? new Map<string, string>();
        scopes.set(scope, value);
        byName.set(prop, scopes);
      }
    }
    for (const [name, scopes] of byName) {
      if (new Set(scopes.values()).size > 1 && scopes.size > 1) {
        issues.push(`${name} (${theme}) : ${[...scopes].map(([s, v]) => `${s} = ${v}`).join(' ; ')}`);
      }
    }
  }
  return [...new Set(issues)];
}

/** Jetons du bloc `prefers-color-scheme: dark` face à `:root[data-theme='dark']`, par fichier : toute différence est un écart. */
export function systemDarkMismatches(rules: readonly CssRule[]): string[] {
  const issues: string[] = [];
  const files = [...new Set(rules.map((r) => r.file))];
  for (const file of files) {
    const own = rules.filter((r) => r.file === file);
    const collect = (selector: string, system: boolean): Record<string, string> =>
      Object.assign(
        {},
        ...own.filter((r) => r.selector === selector && isDarkMedia(r) === system).map((r) => Object.fromEntries(Object.entries(r.decls).filter(([k]) => k.startsWith('--')))),
      ) as Record<string, string>;
    const media = collect(ROOT_SYSTEM, true);
    const chosen = collect(ROOT_DARK, false);
    for (const key of new Set([...Object.keys(media), ...Object.keys(chosen)])) {
      if (media[key] !== chosen[key]) issues.push(`${file} : ${key} (système ${media[key] ?? 'absent'}, choix ${chosen[key] ?? 'absent'})`);
    }
  }
  return issues;
}

/* ---------------------------------------------------------------- résolution */

export type Resolved = { ok: true; color: Color; tokens: string[] } | { ok: false; why: string; tokens: string[] };

const NAMED: Record<string, Color> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

function parseFunctionalColor(value: string): Color | null {
  const m = /^(rgba?)\((.*)\)$/.exec(value);
  if (!m) return null;
  const parts = (m[2] ?? '').replace('/', ' ').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p: string): number => (p.endsWith('%') ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p));
  const alphaRaw = parts[3];
  const a = alphaRaw === undefined ? 1 : alphaRaw.endsWith('%') ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
  const [r, g, b] = [channel(parts[0] as string), channel(parts[1] as string), channel(parts[2] as string)];
  return [r, g, b, a].some(Number.isNaN) ? null : { r, g, b, a };
}

/** Résout `var(--x, repli)` imbriqués, hexadécimal 3/4/6/8, `rgb()`/`rgba()`, `white`/`black`/`transparent`. Le reste est « non résolu » avec une raison. */
export function resolveColor(raw: string, tokens: Record<string, string>, seen: readonly string[] = []): Resolved {
  const value = raw.replace(/\s*!important$/, '').trim().toLowerCase();
  const visited: string[] = [];
  const fail = (why: string): Resolved => ({ ok: false, why, tokens: visited });
  if (splitTop(value, ' ').filter(Boolean).length > 1) return fail('fond composé : image ou plusieurs couches, non résolu');
  if (value.startsWith('var(') && value.endsWith(')')) {
    const inner = value.slice(4, -1);
    const [name, ...rest] = splitTop(inner, ',');
    const token = (name ?? '').trim();
    visited.push(token);
    const fallback = rest.join(',').trim();
    const own = tokens[token];
    if (own !== undefined && !seen.includes(token)) {
      const sub = resolveColor(own, tokens, [...seen, token]);
      return { ...sub, tokens: [token, ...sub.tokens] } as Resolved;
    }
    if (fallback) {
      const sub = resolveColor(fallback, tokens, seen);
      return { ...sub, tokens: [token, ...sub.tokens] } as Resolved;
    }
    return fail(seen.includes(token) ? `référence circulaire ${token}` : `jeton ${token} non défini`);
  }
  if (/^#[0-9a-f]{3,8}$/.test(value)) {
    try {
      return { ok: true, color: parseHex(value), tokens: visited };
    } catch {
      return fail(`hexadécimal invalide ${value}`);
    }
  }
  const named = NAMED[value];
  if (named) return { ok: true, color: named, tokens: visited };
  const fn = parseFunctionalColor(value);
  if (fn) return { ok: true, color: fn, tokens: visited };
  if (value.includes('gradient')) return fail('dégradé');
  if (value.includes('url(')) return fail('image');
  if (value.includes('color-mix')) return fail('color-mix');
  if (value === 'inherit' || value === 'currentcolor' || value === 'unset' || value === 'initial') return fail(value);
  return fail(`valeur non reconnue « ${value} »`);
}

/** Dernière couleur d'un raccourci (`outline: 2px solid var(--x)`, `border: 1px solid #fff`). */
export function colorOfShorthand(value: string): string | null {
  const parts = splitTop(value.trim().replace(/\s+/g, ' '), ' ').filter(Boolean);
  const hit = parts.filter((p) => p.startsWith('var(') || p.startsWith('#') || /^rgba?\(/.test(p) || p in NAMED);
  return hit.at(-1) ?? null;
}

/* ------------------------------------------------------------ paires de règles */

export interface Pair {
  /** `fichier :: sélecteur`. */
  id: string;
  theme: Theme;
  fg: string;
  bg: string;
  ratio: number;
  tokens: string[];
}

export interface Unresolved {
  id: string;
  theme: Theme;
  why: string;
}

export interface Analysis {
  pairs: Pair[];
  unresolved: Unresolved[];
  /** Règles exclues du seuil (état désactivé ou opacité <= 0,5, que WCAG exempte). */
  excluded: string[];
}

export const ruleId = (rule: CssRule): string => `${rule.file} :: ${rule.selector}`;

const NO_OWN_BACKGROUND = new Set(['transparent', 'none', 'inherit', 'initial', 'unset']);

/** Valeur de fond propre d'une règle : `background-color`, ou `background` si c'est une couleur seule (sinon la valeur brute). */
function backgroundOf(rule: CssRule): string | null {
  const value = rule.decls['background-color'] ?? rule.decls['background'];
  return value === undefined ? null : value.replace(/\s*!important$/, '').trim();
}

const isDisabledRule = (rule: CssRule): boolean => /:disabled|\[disabled\]|\[aria-disabled/.test(rule.selector) || Number.parseFloat(rule.decls['opacity'] ?? '1') <= 0.5;

/** Toute règle qui déclare un texte (`color`) ET un fond propre : résolue dans le thème, sinon listée comme non résolue (jamais ignorée). */
export function analyzeRules(rules: readonly CssRule[], theme: Theme): Analysis {
  const tokens = themeTokens(rules, theme);
  const result: Analysis = { pairs: [], unresolved: [], excluded: [] };
  for (const rule of rules) {
    if (!appliesTo(rule, theme)) continue;
    const text = rule.decls['color'];
    const back = backgroundOf(rule);
    if (text === undefined || back === null) continue;
    if (NO_OWN_BACKGROUND.has(back.toLowerCase())) continue; // pas de fond propre : le texte se pose sur celui du parent ; `currentcolor` reste « non résolu »
    const id = ruleId(rule);
    if (isDisabledRule(rule)) {
      result.excluded.push(id);
      continue;
    }
    const fg = resolveColor(text, tokens);
    const bg = resolveColor(back, tokens);
    if (!fg.ok || !bg.ok) {
      const reasons = [!fg.ok ? `texte : ${fg.why}` : '', !bg.ok ? `fond : ${bg.why}` : ''].filter(Boolean).join(' ; ');
      result.unresolved.push({ id, theme, why: reasons });
      continue;
    }
    if (fg.color.a < 1 || bg.color.a < 1) {
      result.unresolved.push({ id, theme, why: 'alpha sur fond inconnu' });
      continue;
    }
    result.pairs.push({
      id,
      theme,
      fg: toHex(fg.color),
      bg: toHex(bg.color),
      ratio: contrastOf(fg.color, bg.color),
      tokens: [...fg.tokens, ...bg.tokens],
    });
  }
  return result;
}

/* ------------------------------------------------- relations par sélecteur */

/**
 * Déclaration `prop` de la règle désignée par `selector` exact (fusion de toutes les règles de ce sélecteur dans l'ordre des fichiers,
 * hors `@media print`). Erreur si la règle n'existe pas : une relation ne peut pas passer à vide.
 */
export function declOf(rules: readonly CssRule[], selector: string, prop: string, theme: Theme): string {
  const wanted = normalizeSelector(selector);
  const matching = rules.filter((r) => r.selector === wanted && appliesTo(r, theme));
  if (matching.length === 0) throw new Error(`aucune règle « ${wanted} »`);
  const values = matching.map((r) => r.decls[prop]).filter((v): v is string => v !== undefined);
  const value = values.at(-1);
  if (value === undefined) throw new Error(`la règle « ${wanted} » ne déclare pas ${prop}`);
  return value;
}

export function hasDecl(rules: readonly CssRule[], selector: string, prop: string, theme: Theme): boolean {
  const wanted = normalizeSelector(selector);
  return rules.some((r) => r.selector === wanted && appliesTo(r, theme) && r.decls[prop] !== undefined);
}

/** Couleur opaque d'une propriété (`background`, `color`) ou d'un raccourci (`outline`, `border`) d'une règle désignée, dans un thème. */
export function colorOfDecl(rules: readonly CssRule[], selector: string, prop: string, theme: Theme): { color: Color; tokens: string[] } {
  const tokens = themeTokens(rules, theme);
  const raw = declOf(rules, selector, prop, theme);
  const value = prop === 'outline' || prop === 'border' ? colorOfShorthand(raw) : raw;
  if (value === null) throw new Error(`« ${selector} » ${prop} : aucune couleur dans « ${raw} »`);
  const resolved = resolveColor(value, tokens);
  if (!resolved.ok) throw new Error(`« ${selector} » ${prop} non résolu : ${resolved.why}`);
  if (resolved.color.a < 1) throw new Error(`« ${selector} » ${prop} : couleur translucide`);
  return { color: resolved.color, tokens: resolved.tokens };
}

/* ------------------------------------------------------- inventaire des jetons */

/** Valeur qui a la forme d'une couleur (même si le lecteur ne sait pas la résoudre) : un tel jeton doit être classé, jamais ignoré. */
const LOOKS_LIKE_COLOR = /^(#[0-9a-f]{3,8}\b|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\()/i;

/** Jetons `--ct-*` dont la valeur se résout en couleur, ou en a la forme sans pouvoir être résolue, dans au moins un thème. */
export function colorTokens(rules: readonly CssRule[]): string[] {
  const names = new Set<string>();
  for (const theme of THEMES) {
    const tokens = themeTokens(rules, theme);
    for (const [name, value] of Object.entries(tokens)) {
      if (!name.startsWith('--ct-')) continue;
      if (resolveColor(`var(${name})`, tokens).ok || LOOKS_LIKE_COLOR.test(value.trim())) names.add(name);
    }
  }
  return [...names].sort();
}

/** Couleur d'une propriété selon la cascade réelle : la dernière règle de la liste (priorité croissante) qui la déclare l'emporte. */
export function cascadeColor(rules: readonly CssRule[], selectors: readonly string[], prop: string, theme: Theme): { color: Color; tokens: string[] } {
  for (const selector of [...selectors].reverse()) if (hasDecl(rules, selector, prop, theme)) return colorOfDecl(rules, selector, prop, theme);
  throw new Error(`aucune règle de ${selectors.join(' | ')} ne déclare ${prop}`);
}

/* ------------------------------------------- paires de jetons (contrast.test.ts) */

export type TokenPair = readonly [string, string];

/** Paires de jetons du test historique (P-02 critère 5) : texte 4,5:1. */
export const TOKEN_PAIRS: readonly TokenPair[] = [
  ['--ct-color-text', '--ct-color-bg'],
  ['--ct-color-text', '--ct-color-surface-input'],
  ['--ct-color-text-secondary', '--ct-color-bg'],
  ['--ct-color-accent', '--ct-color-bg'],
  ['--ct-color-accent-on', '--ct-color-accent'],
  ['--ct-color-danger', '--ct-color-danger-bg'],
  ['--ct-color-achieved-text', '--ct-color-achieved-bg'],
  ['--ct-color-missed-text', '--ct-color-missed-bg'],
  ['--ct-color-event-text', '--ct-color-event-bg'],
  ['--ct-color-event-local-text', '--ct-color-event-local-bg'],
  ['--ct-color-today-badge', '--ct-color-bg'],
  ['--ct-color-warning-text', '--ct-color-warning-bg'],
  ['--ct-color-on-nav', '--ct-color-nav-bg'],
  // UI-REFONTE-02 : agenda du jour iPhone (colonne d'heures, passé atténué, retard).
  ['--ct-color-agenda-hour', '--ct-color-bg'],
  ['--ct-color-agenda-past', '--ct-color-bg'],
  ['--ct-color-agenda-late', '--ct-color-bg'],
];

/** Éléments graphiques : 3:1 (WCAG 1.4.11). */
export const GRAPHIC_TOKEN_PAIRS: readonly TokenPair[] = [
  ['--ct-color-goal', '--ct-color-bg'],
  ['--ct-color-switch-on', '--ct-color-bg'],
  ['--ct-color-switch-on-thumb', '--ct-color-switch-on'],
  // UI-REFONTE-02 : rond d'événement et trait « maintenant » de l'agenda.
  ['--ct-color-agenda-event', '--ct-color-bg'],
];

/** Écran Focus (F-01 critère 13) : texte 4,5:1. */
export const FOCUS_TOKEN_PAIRS: readonly TokenPair[] = [
  ['--ct-focus-on', '--ct-focus-bg'],
  ['--ct-focus-muted', '--ct-focus-bg'],
  ['--ct-focus-space', '--ct-focus-bg'],
  ['--ct-focus-ink', '--ct-focus-arc'],
  ['--ct-focus-ink', '--ct-focus-on'],
  ['--ct-focus-on', '--ct-focus-launch-bg'],
];
