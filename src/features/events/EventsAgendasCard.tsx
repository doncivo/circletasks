import type { CalendarAccount, Space } from '../../domain/model';
import type { IsoDateTime } from '../../domain/types';
import { t } from '../../i18n';
import { spaceTextColor } from '../../ui';

export interface EventsAgendasCardProps {
  readonly accounts: readonly CalendarAccount[];
  readonly spaces: readonly Space[];
  /** Dernière actualisation (la plus récente des lignes lues) ; null : rien à dire. */
  readonly syncedAt: IsoDateTime | null;
  readonly nowMs: number;
  /** Ligne « Jours fériés France, Tunisie » (E-03) : texte déjà résolu, ou null si aucun calendrier de jours fériés n'est activé. */
  readonly holidaysLine: string | null;
  readonly onOpenSettings: () => void;
}

/** « Mis à jour il y a 6 min » ; « à l'instant » sous la minute, puis en heures et en jours. */
function updatedText(minutes: number): string {
  if (minutes < 1) return t('events.aside.updatedNow');
  if (minutes < 60) return t('events.aside.updated', { minutes });
  if (minutes < 1440) return t('events.aside.updatedHours', { hours: Math.floor(minutes / 60) });
  return t('events.aside.updatedDays', { days: Math.floor(minutes / 1440) });
}

interface AgendaLine {
  readonly key: string;
  readonly name: string;
  readonly space: Space | null;
}

/** Agendas connectés et affichés : « Google · Travail » (compte · agenda), avec leur espace. */
function agendaLines(accounts: readonly CalendarAccount[], spaces: readonly Space[]): AgendaLine[] {
  return accounts.flatMap((account) =>
    account.calendars
      .filter((calendar) => calendar.shown)
      .map((calendar) => ({
        key: `${account.id}:${calendar.id}`,
        name: calendar.name ? `${account.label} · ${calendar.name}` : account.label,
        space: spaces.find((space) => space.id === calendar.spaceId) ?? null,
      })),
  );
}

/**
 * Carte « AGENDAS AFFICHÉS » du volet droit PC (PC-Evenements.html, E-01 critère 9) : point, nom et espace de chaque agenda connecté,
 * la ligne des jours fériés (E-03) et « Mis à jour il y a N min ». Sans compte : « Aucun agenda connecté » et un lien vers Réglages.
 */
export function EventsAgendasCard({ accounts, spaces, syncedAt, nowMs, holidaysLine, onOpenSettings }: EventsAgendasCardProps) {
  const lines = agendaLines(accounts, spaces);
  const minutes = syncedAt === null ? null : Math.max(0, Math.floor((nowMs - Date.parse(syncedAt)) / 60_000));
  return (
    <section className="ct-events-agendas" aria-labelledby="ct-events-agendas-title">
      <h3 id="ct-events-agendas-title" className="ct-events-agendas__title">
        {t('events.aside.agendas')}
      </h3>
      {lines.length === 0 && (
        <p className="ct-events-agendas__empty">
          {t('events.aside.noAgenda')}{' '}
          <button type="button" className="ct-events-agendas__link" onClick={onOpenSettings}>
            {t('events.aside.settingsLink')}
          </button>
        </p>
      )}
      {lines.map((line) => (
        <div key={line.key} className="ct-events-agendas__line">
          <span className="ct-events-agendas__dot" style={{ background: line.space ? spaceTextColor(line.space.color) : 'var(--ct-color-event-text)' }} aria-hidden="true" />
          <span className="ct-events-agendas__name">{line.name}</span>
          {line.space && (
            <span className="ct-events-agendas__space" style={{ color: spaceTextColor(line.space.color) }}>
              {line.space.name}
            </span>
          )}
        </div>
      ))}
      {holidaysLine && (
        <div className="ct-events-agendas__line">
          <span className="ct-events-agendas__dot" style={{ background: 'var(--ct-color-achieved-text)' }} aria-hidden="true" />
          <span className="ct-events-agendas__name">{holidaysLine}</span>
        </div>
      )}
      {minutes !== null && lines.length > 0 && <span className="ct-events-agendas__updated">{updatedText(minutes)}</span>}
    </section>
  );
}
