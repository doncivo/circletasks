import { X } from 'lucide-react';
import { addDays } from '../domain/localDate';
import type { QuickParse, QuickSpace, QuickProject } from '../domain/quickInput';
import type { LocalDate } from '../domain/types';
import { t } from '../i18n';
import { formatDayLabel, formatTime } from '../i18n/format';
import { Icon } from './Icon';
import { spaceTextColor } from './spaceColor';

import './QuickInputField.css';

export interface QuickPreviewProps {
  readonly parse: QuickParse;
  readonly spaces: readonly QuickSpace[];
  readonly projects: readonly QuickProject[];
  /** Aujourd'hui (« aujourd'hui », « demain » plutôt que la date). */
  readonly today: LocalDate;
  /** Retire des marques : elles redeviennent du texte (clés `QuickToken.key`). */
  readonly onDismiss: (keys: readonly string[]) => void;
  readonly className?: string;
}

/** « demain », « aujourd'hui » ou « mer. 23 sept. ». */
function dayText(date: LocalDate, today: LocalDate): string {
  if (date === today) return t('capture.today');
  if (date === addDays(today, 1)) return t('capture.tomorrow');
  return formatDayLabel(date);
}

/**
 * Pastilles sous le champ (Q-06 critère 8, Q-02 critère 9) : « Pro · Mission » (couleur de l'espace) et « demain · 10:00 ». Chacune
 * se retire (croix ou Échap) : la marque redevient du texte. Annoncées aux lecteurs d'écran (« Espace Pro, projet Mission »).
 */
export function QuickPreview({ parse, spaces, projects, today, onDismiss, className }: QuickPreviewProps) {
  const spaceToken = parse.tokens.find((token) => token.kind === 'space');
  const projectToken = parse.tokens.find((token) => token.kind === 'project');
  const dateToken = parse.tokens.find((token) => token.kind === 'date');
  const space = parse.spaceId ? spaces.find((s) => s.id === parse.spaceId) : undefined;
  const project = parse.projectId ? projects.find((p) => p.id === parse.projectId) : undefined;
  const placement = spaceToken || projectToken ? [space?.name, project?.name].filter((name): name is string => Boolean(name)) : [];

  const pill = (key: string, text: string, keys: readonly string[], color: string | null, variant?: 'date') => (
    <span
      key={key}
      className={['ct-quick-preview__pill', variant ? `ct-quick-preview__pill--${variant}` : ''].filter(Boolean).join(' ')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onDismiss(keys);
        }
      }}
    >
      {color && <span className="ct-quick__dot" aria-hidden="true" style={{ background: spaceTextColor(color) }} />}
      <span>{text}</span>
      <button type="button" className="ct-quick-preview__remove" aria-label={t('capture.removeToken', { label: text })} onClick={() => onDismiss(keys)}>
        <Icon icon={X} size={14} />
      </button>
    </span>
  );

  const pills = [];
  const spoken: string[] = [];
  if (placement.length > 0) {
    const text = placement.length === 2 ? t('capture.spaceAndProject', { space: placement[0] ?? '', project: placement[1] ?? '' }) : (placement[0] ?? '');
    spoken.push(
      space && project
        ? t('capture.spaceProjectAnnounce', { space: space.name, project: project.name })
        : project
          ? t('capture.projectAnnounce', { project: project.name })
          : t('capture.spaceAnnounce', { space: space?.name ?? '' }),
    );
    const keys = [spaceToken?.key, projectToken?.key].filter((key): key is string => key !== undefined);
    pills.push(pill('placement', text, keys, space?.color ?? null));
  }
  if (dateToken && parse.date) {
    const day = dayText(parse.date, today);
    const text = parse.time ? t('capture.dateAndTime', { date: day, time: formatTime(parse.time) }) : day;
    spoken.push(t('capture.dateAnnounce', { label: text }));
    pills.push(pill('date', text, [dateToken.key], null, 'date'));
  }

  const unknownSpace = parse.unknownProject ? spaces.find((s) => s.id === parse.unknownProject?.spaceId)?.name : undefined;
  const empty = pills.length === 0 && !unknownSpace;
  return (
    <div className={['ct-quick-preview', empty ? 'ct-quick-preview--empty' : '', className].filter(Boolean).join(' ')}>
      {/* Annonce aux lecteurs d'écran à chaque changement (« Espace Pro, projet Mission »). */}
      <span aria-live="polite" className="ct-visually-hidden">
        {spoken.join('. ')}
        {unknownSpace ? t('capture.unknownProject', { space: unknownSpace }) : ''}
      </span>
      {pills.length > 0 && (
        <div role="group" aria-label={t('capture.previewLabel')} className="ct-quick-preview__group">
          {pills}
        </div>
      )}
      {unknownSpace && <span className="ct-quick-preview__note">{t('capture.unknownProject', { space: unknownSpace })}</span>}
    </div>
  );
}
