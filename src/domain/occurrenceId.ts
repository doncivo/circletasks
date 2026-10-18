import { uuidFromBytes } from './id';
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

/** UUID v5 de `name` dans l'espace `namespace` (SHA-1 par Web Crypto : WebView2, WKWebView, Node). */
export async function uuidV5(namespace: string, name: string): Promise<Id> {
  const space = (namespace.replaceAll('-', '').match(/../g) ?? []).map((hex) => parseInt(hex, 16));
  const digest = await globalThis.crypto.subtle.digest('SHA-1', new Uint8Array([...space, ...new TextEncoder().encode(name)]));
  return uuidFromBytes(new Uint8Array(digest, 0, 16), 5);
}

/** Identifiant de l'occurrence `seriesIndex` de la récurrence `recurrenceId`. */
export const occurrenceTaskId = (recurrenceId: RecurrenceId, seriesIndex: number): Promise<TaskId> =>
  uuidV5(OCCURRENCE_ID_NAMESPACE, `${recurrenceId}|${String(seriesIndex)}`) as Promise<TaskId>;

/** Identifiant du rappel d'avance `offsetMin` recopié sur l'occurrence `taskId`. */
export const occurrenceReminderId = (taskId: TaskId, offsetMin: number): Promise<ReminderId> =>
  uuidV5(OCCURRENCE_ID_NAMESPACE, `${taskId}|r${String(offsetMin)}`) as Promise<ReminderId>;
