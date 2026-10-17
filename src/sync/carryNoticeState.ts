/**
 * Y-FIX-04 (ADR 0011 §28, critère 14) : la notice locale d'un report d'époque (`sync_meta.epochCarryNotice`) n'a pas pu être écrite depuis
 * le démarrage. Les données sont reportées quand même ; l'avertissement `carry-reattached` est levé (jamais muet). Module à part :
 * `epochSwitch.ts` est chargé à la demande, le moteur lit l'indicateur sans le charger.
 */
let noticeFailed = false;

export function markEpochCarryNoticeFailure(): void {
  noticeFailed = true;
}

export function epochCarryNoticeFailure(): boolean {
  return noticeFailed;
}

/** Tests, et « J'ai vu » : remet l'indicateur à zéro. */
export function clearEpochCarryNoticeFailure(): void {
  noticeFailed = false;
}
