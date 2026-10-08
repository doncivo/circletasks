/**
 * Couche du verrou (I-03, ADR 0013 §2.4 et avenant) : masquage de `body` par écriture DOM directe, sans React ni plugin. Module léger,
 * importé directement par le démarrage (`appLockBoot`) et l'écran de verrou : il reste disponible même si le contrôleur ne se charge pas
 * (échec fermé, revue 3).
 */

export const LOCK_LAYER_ID = 'ct-lock-layer';
const LOCK_MARK = 'data-ct-lock-hidden';

/** Couche de l'écran de verrou, enfant direct de `body`, seule laissée visible pendant le verrou (créée au besoin). */
export function ensureLockLayer(doc: Document = document): HTMLElement {
  const existing = doc.getElementById(LOCK_LAYER_ID);
  if (existing) return existing;
  const layer = doc.createElement('div');
  layer.id = LOCK_LAYER_ID;
  doc.body.appendChild(layer);
  return layer;
}

const KEPT_IDS = new Set([LOCK_LAYER_ID, 'ct-privacy-cover']);
const KEPT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'NOSCRIPT']);

/** Masque un enfant direct de `body` (valeurs d'avant le verrou gardées pour le déverrouillage) ; couche du verrou et cache exclus. */
function hideChild(child: Element): void {
  if (KEPT_IDS.has(child.id) || KEPT_TAGS.has(child.tagName) || child.hasAttribute(LOCK_MARK)) return;
  child.setAttribute(LOCK_MARK, JSON.stringify([child.hasAttribute('hidden'), child.hasAttribute('inert'), child.getAttribute('aria-hidden')]));
  child.setAttribute('hidden', '');
  child.setAttribute('inert', '');
  child.setAttribute('aria-hidden', 'true');
}

/** Observateurs de `body` pendant le verrou : tout enfant ajouté après la pose (portail, fenêtre, bandeau) est masqué à son tour. */
const observers = new WeakMap<Document, MutationObserver>();

/** Débranche l'observateur de `body` (déverrouillage, ou arrêt du contrôleur au démontage de l'app). */
export function stopLockObserver(doc: Document): void {
  observers.get(doc)?.disconnect();
  observers.delete(doc);
}

/**
 * Masque (ou rend) tout le contenu de `body` sauf la couche du verrou et le cache : aucun rendu, rien pour VoiceOver, aucun focus.
 * Pendant le verrou, un `MutationObserver` masque aussi les enfants ajoutés ensuite (rappel en microtâche, avant toute peinture) ; la règle
 * CSS `html[data-app-lock='locked'] body > …` de security.css les cache en plus dès leur insertion. Débranché au déverrouillage.
 */
export function applyLockToDocument(doc: Document, locked: boolean): void {
  doc.documentElement.dataset['appLock'] = locked ? 'locked' : 'unlocked';
  if (!doc.body) return;
  if (locked) {
    ensureLockLayer(doc);
    for (const child of Array.from(doc.body.children)) hideChild(child);
    if (!observers.has(doc) && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver((records) => {
        for (const record of records) for (const node of Array.from(record.addedNodes)) if (node.parentNode === doc.body && node.nodeType === 1) hideChild(node as Element);
      });
      observer.observe(doc.body, { childList: true });
      observers.set(doc, observer);
    }
    return;
  }
  stopLockObserver(doc);
  for (const child of Array.from(doc.body.querySelectorAll(`:scope > [${LOCK_MARK}]`))) {
    let before: [boolean, boolean, string | null] = [false, false, null];
    try {
      before = JSON.parse(child.getAttribute(LOCK_MARK) ?? '') as [boolean, boolean, string | null];
    } catch {
      // Marque abîmée : attributs retirés (état visible ordinaire).
    }
    child.removeAttribute(LOCK_MARK);
    if (!before[0]) child.removeAttribute('hidden');
    if (!before[1]) child.removeAttribute('inert');
    if (before[2] === null) child.removeAttribute('aria-hidden');
    else child.setAttribute('aria-hidden', before[2]);
  }
}

/** Relance de l'app (écran de verrou dont le code n'a pas pu être chargé : un import échoué ne se réessaie pas). Remplaçable en test. */
export const appReload = {
  run: (): void => {
    window.location.reload();
  },
};
