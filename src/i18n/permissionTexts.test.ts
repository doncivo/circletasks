import { describe, expect, it } from 'vitest';
import { en } from './en';
import { fr } from './fr';

/** I-05 critère 9 : textes d'explication et de refus des autorisations, issus de src/i18n, en français, 3 phrases au plus. */
type Node = Record<string, unknown>;

interface Found {
  readonly path: string;
  readonly parent: Node;
  readonly key: string;
}

function walk(node: unknown, path: string[], visit: (found: Found) => void): void {
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node as Node)) {
    if (/explain$/i.test(key)) visit({ path: [...path, key].join('.'), parent: node as Node, key });
    walk(value, [...path, key], visit);
  }
}

const sentences = (text: string): number => text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '').length;
const texts = (value: unknown): string[] => (typeof value === 'string' ? [value] : typeof value === 'object' && value !== null ? Object.values(value as Node).flatMap(texts) : []);
const ENGLISH = /\b(the|your|you|and|is|are|not|to|for)\b/i;

/** N-01 : le texte de refus porte lui-même le chemin des Réglages (pas de bouton) ; Face ID : le repli est le code de l'iPhone. */
const NO_BUTTON = (path: string): boolean => path.endsWith('allowExplain');

describe('textes des autorisations (I-05 critère 9)', () => {
  const found: Found[] = [];
  walk(fr, [], (item) => found.push(item));

  it('les autorisations de l’app sont couvertes : notifications, caméra du QR, micro et reconnaissance vocale', () => {
    const paths = found.map((f) => f.path);
    expect(paths.some((p) => p.endsWith('allowExplain'))).toBe(true);
    expect(paths.some((p) => p.endsWith('cameraExplain'))).toBe(true);
    expect(paths).toContain('capture.dictation.explain');
  });

  it('chaque clé « explain » a sa clé « denied » dans le même objet, et le bouton « Ouvrir les réglages » (sauf N-01)', () => {
    for (const { path, parent, key } of found) {
      const base = key.replace(/explain$/i, '');
      const deniedKey = Object.keys(parent).find((k) => (base === '' ? /^denied$/i : new RegExp(`^${base}denied$|^permissionDenied$`, 'i')).test(k));
      expect(deniedKey, `${path} : clé denied`).toBeDefined();
      if (NO_BUTTON(path)) continue;
      const scope = base === '' ? [parent['denied'], parent] : [parent];
      const hasButton = scope.some((s) => typeof s === 'object' && s !== null && 'openSettings' in (s as Node));
      expect(hasButton, `${path} : bouton Ouvrir les réglages`).toBe(true);
    }
  });

  it('chaque texte d’explication est français, tient en 3 phrases au plus, et existe en anglais', () => {
    for (const { path, parent, key } of found) {
      for (const text of texts(parent[key])) {
        if (text.length < 40) continue; // libellés de boutons
        expect(text, path).not.toMatch(ENGLISH);
        expect(sentences(text), `${path} : ${text}`).toBeLessThanOrEqual(3);
      }
      let english: unknown = en;
      for (const part of path.split('.')) english = (english as Node)?.[part];
      expect(english, `${path} en anglais`).toBeDefined();
    }
  });

  it('textes de refus de la dictée : nomment l’autorisation, 3 phrases au plus', () => {
    const denied = (fr.capture.dictation as unknown as { denied: Record<string, string> }).denied;
    expect(denied['microphone']).toMatch(/^Le micro est refusé/);
    expect(denied['speechRecognition']).toMatch(/^La reconnaissance vocale est refusée/);
    for (const text of Object.values(denied)) expect(sentences(text)).toBeLessThanOrEqual(3);
    expect(fr.capture.dictation.explain.text).toBe(
      'CircleTasks écoute votre voix pour la transformer en texte, sur l’iPhone. Rien n’est enregistré ni envoyé. iOS vous demandera deux autorisations : le micro, puis la reconnaissance vocale.',
    );
  });

  it('indication de la caméra du scan : la phrase de la fiche, sans dépendre d’un état', () => {
    expect(fr.scan.cameraHint.text).toBe(
      'Pour photographier une liste, autorisez la caméra : iOS vous le demandera la première fois. Si rien ne se passe, ouvrez Réglages › CircleTasks › Caméra.',
    );
    expect(fr.scan.cameraHint.openSettings).toBe('Ouvrir les réglages');
  });
});
