/**
 * Cache de confidentialité JS (I-03 critère 8, ADR 0013 §2.4) : au passage masqué (`visibilitychange` puis aussi `pagehide`), une couche
 * opaque déjà présente dans `index.html` (`#ct-privacy-cover`) couvre `#root` par une écriture DOM directe (aucun rendu React), AVANT tout
 * autre traitement : écouteurs en phase de capture. Le cache natif (`privacy-shield`) couvre en plus l'app inactive (sélecteur d'apps).
 */

export const PRIVACY_COVER_ID = 'ct-privacy-cover';

function ensureCover(doc: Document): void {
  if (doc.getElementById(PRIVACY_COVER_ID) || !doc.body) return;
  const cover = doc.createElement('div');
  cover.id = PRIVACY_COVER_ID;
  cover.setAttribute('aria-hidden', 'true');
  doc.body.appendChild(cover);
}

export function setPrivacyCover(doc: Document, on: boolean): void {
  if (on) {
    ensureCover(doc);
    doc.documentElement.dataset['privacy'] = 'on';
  } else {
    delete doc.documentElement.dataset['privacy'];
  }
}

export function isPrivacyCoverOn(doc: Document): boolean {
  return doc.documentElement.dataset['privacy'] === 'on';
}

export interface PrivacyCoverOptions {
  readonly doc: Document;
  readonly win: Window;
  /** Verrou activé : sinon rien n'est posé. */
  readonly isEnabled: () => boolean;
  /** Passage masqué (après la pose du cache). */
  readonly onHidden: () => void;
  /** Retour au premier plan : l'appelant décide du verrou PUIS retire le cache. */
  readonly onVisible: () => void;
}

/** Pose les écouteurs ; rend leur retrait. */
export function installPrivacyCover(options: PrivacyCoverOptions): () => void {
  const { doc, win } = options;
  const hide = (): void => {
    if (!options.isEnabled()) return;
    setPrivacyCover(doc, true);
    options.onHidden();
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') hide();
    else options.onVisible();
  };
  doc.addEventListener('visibilitychange', onVisibility, true);
  win.addEventListener('pagehide', hide, true);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility, true);
    win.removeEventListener('pagehide', hide, true);
  };
}
