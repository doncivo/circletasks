/**
 * Exécute `task` au prochain moment d'inactivité du navigateur et rend l'annulation. WebKit (iPhone) n'active pas
 * `requestIdleCallback` par défaut : repli sur `setTimeout(fallbackDelayMs)` (ADR 0001, avenant PERF-02).
 */
export function whenIdle(task: () => void, fallbackDelayMs: number, timeoutMs = 2000): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, fallbackDelayMs);
  return () => window.clearTimeout(handle);
}
