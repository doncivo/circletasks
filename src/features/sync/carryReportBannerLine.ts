import { t } from '../../i18n';
import { carryFailureCause, tCarry } from '../../i18n/syncCarryReportText';
import { logFailure } from '../../platform/desktop/log';
import { carryReportBannerFacts, carryReportElements, carryReportOthers } from '../../sync/epochCarryReportBanner';
import type { AppContainer } from '../app/container';
import { useNavigationStore } from '../app/navigation';
import { requestCarryReportOpen } from './carryReportOpen';
import { carryLines } from './syncRestoreState';

/**
 * Y-TECH-05 : texte et action du bandeau durable du compte rendu du changement d'époque (critères 14 et 16), composés hors du départ
 * (bloc à la demande, avec le catalogue `syncCarryReport`). « Changement d'époque : éléments rétablis : {n}. Voir le compte rendu » (lignes rétablies seulement) ou, quand aucune ne l'est, « … aucun élément supprimé rétabli, autres éléments nommés : {n}. … » ; en
 * cas d'échec d'enregistrement, « Le compte rendu du changement d'époque n'a pas pu être enregistré : {cause} ». « Voir » ouvre Réglages ›
 * Synchronisation › Détails, sur le dernier compte rendu non acquitté. Le résultat est posé dans `carryLines` (lu par `startSync.ts`) :
 * null quand plus rien n'est à montrer (acquitté).
 */
const appliers = new WeakMap<AppContainer, () => void>();

async function carryReportLine(container: AppContainer): Promise<{ readonly message: string; readonly onAction: () => void } | null> {
  const { failure, reports } = await carryReportBannerFacts(container.data.repos);
  const open = (id: number | null): (() => void) => {
    return () => {
      requestCarryReportOpen(id);
      useNavigationStore.getState().navigate({ tab: 'settings', screen: 'sync' });
    };
  };
  if (failure) return { message: tCarry('failed', { cause: carryFailureCause(failure.code) }), onAction: open(null) };
  if (reports.length === 0) return null;
  const restored = carryReportElements(reports);
  const message = restored > 0 ? tCarry('banner', { count: restored }) : tCarry('bannerNoRestored', { count: carryReportOthers(reports) });
  return { message, onAction: open(reports[0]?.id ?? null) };
}

/** Lit le compte rendu et pose la ligne du bandeau ; `apply` (une fois, par `startSync.ts`) recalcule les bandeaux de l'app. Rejette si la lecture échoue. */
export async function loadCarryLine(container: AppContainer, apply?: () => void): Promise<void> {
  if (apply) appliers.set(container, apply);
  const shown = carryLines.get(container) ?? null;
  const line = await carryReportLine(container);
  // Revue S1 : rien à montrer (acquitté) : l'entrée est **effacée**, jamais gardée à null. `startSync.ts` relit alors la ligne au prochain
  // changement d'état tant que le moteur garde `carry-report` levé : un compte rendu arrivé avant la fin du cycle suivant n'est jamais masqué.
  // Les bandeaux ne sont recalculés que si une ligne était montrée (sinon `startSync.ts` relirait à l'infini).
  if (line) carryLines.set(container, line);
  else carryLines.delete(container);
  if (line || shown) appliers.get(container)?.();
}

/**
 * Après « J'ai vu » : relit tout de suite (le bandeau disparaît sans attendre le cycle suivant). Une lecture en échec ne rend jamais le
 * bandeau muet : journalisée, et le texte générique des détails de la synchro est montré.
 */
export async function refreshCarryLine(container: AppContainer): Promise<void> {
  try {
    await loadCarryLine(container);
  } catch (error) {
    logFailure('sync', `carry-banner-failed ${JSON.stringify({ name: error instanceof Error ? error.name : typeof error })}`);
    carryLines.set(container, { message: t('sync.status.errorGeneric'), onAction: () => useNavigationStore.getState().navigate({ tab: 'settings', screen: 'sync' }) });
    appliers.get(container)?.();
  }
}
