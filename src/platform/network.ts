/**
 * État du réseau de l'appareil (A-09) : `navigator.onLine` et événements `online` / `offline` de la fenêtre.
 * Point unique d'accès au navigateur pour cette information (les features passent par src/platform).
 * `onLine` vrai ne prouve pas qu'Internet joue : il signale seulement l'absence de réseau (« Hors ligne »).
 */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** Appelle `listener` à chaque changement ; renvoie la fonction qui retire les écouteurs. */
export function watchOnline(listener: (online: boolean) => void): () => void {
  const onOnline = (): void => listener(true);
  const onOffline = (): void => listener(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
