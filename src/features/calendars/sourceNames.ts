import type { SourceNames } from '../../domain/externalEvents';
import { t } from '../../i18n';

/** Noms de source affichés d'un agenda externe (S-05, K-02 critère 8) : « Google Agenda », « iCloud » — et non l'adresse du compte. */
export function sourceNames(): SourceNames {
  return { google: t('calendars.providerGoogle'), icloud: t('calendars.providerIcloud') };
}

/** Noms courts de la carte « AGENDAS AFFICHÉS » (PC-Evenements.html : « Google · Travail », « iCloud · Famille »). */
export function shortSourceNames(): SourceNames {
  return { google: t('calendars.sourceGoogleShort'), icloud: t('calendars.sourceIcloudShort') };
}
