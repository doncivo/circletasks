import type { CalendarAccount } from '../../domain/model';
import { t } from '../../i18n';

/**
 * Nom affiché d'un compte d'agenda (ADR 0011 section 8, audit M6) : pour iCloud, l'identifiant Apple **de cet appareil** (`username`,
 * colonne locale), sinon « Compte iCloud » (compte reçu d'un autre appareil, pas encore reconnecté) ; pour Google, le libellé publié.
 */
export function accountDisplayName(account: Pick<CalendarAccount, 'provider' | 'label' | 'username'>): string {
  if (account.provider === 'icloud') return account.username !== '' ? account.username : t('calendars.icloudDefaultLabel');
  return account.label;
}
