import type { Id, RecurrenceId, ReminderId, TaskId } from './types';

/**
 * T-TECH-01 (B8) : identifiants déterministes des occurrences de tâche récurrente et de leurs rappels recopiés. Deux appareils qui génèrent
 * la même occurrence avant de s'être lus écrivent la MÊME ligne (même identifiant), que la fusion par identifiant de ligne réunit ; un
 * identifiant aléatoire en ferait deux. UUID v5 (RFC 9562, SHA-1) : seul genre déterministe admis par la validation des identifiants de
 * `task` sans changer le format publié (`isId`).
 *
 * L'espace de noms est figé par un test de vecteur : le changer ferait régénérer des doublons avec les appareils qui ne l'ont pas encore.
 */
export const OCCURRENCE_ID_NAMESPACE = '6f1b7c34-5a2d-4e8f-9c61-3d0a4b7e2f15';

/**
 * UUID v5 de `name` dans l'espace `namespace` (SHA-1 par Web Crypto : WebView2, WKWebView, Node). Module autonome, chargé à la demande
 * (`import()` de `recurrenceUseCases.ts`) : aucun octet dans le bundle de départ.
 */
export async function uuidV5(namespace: string, name: string): Promise<Id> {
  const space = (namespace.replaceAll('-', '').match(/../g) ?? []).map((hex) => parseInt(hex, 16));
  const b = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', new Uint8Array([...space, ...new TextEncoder().encode(name)])), 0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50; // version 5
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variante RFC
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Id;
}

/** Identifiant de l'occurrence `seriesIndex` de la récurrence `recurrenceId`. */
export const occurrenceTaskId = (recurrenceId: RecurrenceId, seriesIndex: number): Promise<TaskId> =>
  uuidV5(OCCURRENCE_ID_NAMESPACE, `${recurrenceId}|${String(seriesIndex)}`) as Promise<TaskId>;

/** Identifiant du rappel d'avance `offsetMin` recopié sur l'occurrence `taskId`. */
export const occurrenceReminderId = (taskId: TaskId, offsetMin: number): Promise<ReminderId> =>
  uuidV5(OCCURRENCE_ID_NAMESPACE, `${taskId}|r${String(offsetMin)}`) as Promise<ReminderId>;
