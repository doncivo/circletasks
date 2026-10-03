import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { t } from '../../i18n';
import { spaceTextColor } from '../../ui';
import { formatQuietSummary } from './quietText';

/**
 * Lignes « Silence <espace> » de Réglages › RAPPELS (Reglages.html : « Silence Pro — 19:00 – 08:00, week-end »), une par espace, nom
 * de l'espace dans sa couleur ; chaque ligne ouvre l'éditeur de plages (ES-07 critères 2 et 3).
 */
export function QuietHoursRows() {
  const spaces = useAppStore((s) => s.spaces);
  const navigate = useNavigationStore((s) => s.navigate);
  return (
    <>
      {spaces.map((space) => {
        const summary = formatQuietSummary(space.quietHours);
        return (
          <button
            key={space.id}
            type="button"
            className="ct-settings__row ct-settings__rowButton"
            aria-label={`${t('spaces.quietRowPrefix')} ${space.name} : ${summary}`}
            onClick={() => navigate({ tab: 'settings', screen: 'quiet', spaceId: space.id })}
          >
            <span>
              {t('spaces.quietRowPrefix')} <span style={{ color: spaceTextColor(space.color) }}>{space.name}</span>
            </span>
            <span className="ct-settings__value">{summary}</span>
          </button>
        );
      })}
    </>
  );
}
