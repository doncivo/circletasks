import { Check, TriangleAlert } from 'lucide-react';
import { memo, useId, useMemo } from 'react';
import type { QuickContext } from '../../../domain/quickInput';
import type { LocalDate } from '../../../domain/types';
import { t } from '../../../i18n';
import { formatDayLabel, formatTime } from '../../../i18n/format';
import { DatePicker, DropdownSelect, Icon, SpaceSegmented, type Layout } from '../../../ui';
import { useAppStore } from '../../app/appStore';
import { detectLine } from './scanDrafts';
import type { ScanProposal } from './scanLines';
import type { DateKind, Scan } from './useScan';

const DATE_OPTIONS: ReadonlyArray<{ readonly value: DateKind; readonly key: 'scan.dateChoice.today' | 'scan.dateChoice.tomorrow' | 'scan.dateChoice.someday' | 'scan.dateChoice.pick' }> = [
  { value: 'today', key: 'scan.dateChoice.today' },
  { value: 'tomorrow', key: 'scan.dateChoice.tomorrow' },
  { value: 'someday', key: 'scan.dateChoice.someday' },
  { value: 'pick', key: 'scan.dateChoice.pick' },
];

interface LineProps {
  readonly line: ScanProposal;
  readonly index: number;
  readonly context: QuickContext;
  readonly onToggle: (id: string) => void;
  readonly onEdit: (id: string, text: string) => void;
}

/** Une ligne proposée (Scan.html) : case de 26 px dans une zone de 44, champ de 40 px, date et espace détectés, incertitude. */
const ScanLine = memo(function ScanLine({ line, index, context, onToggle, onEdit }: LineProps) {
  const noteId = useId();
  const parse = useMemo(() => detectLine(line.text, context), [line.text, context]);
  const dateToken = parse.tokens.find((token) => token.kind === 'date');
  const dateText =
    dateToken && parse.date ? t('scan.review.dateDetected', { date: parse.time ? `${formatDayLabel(parse.date)} · ${formatTime(parse.time)}` : formatDayLabel(parse.date) }) : null;
  const space = parse.spaceId ? context.spaces.find((s) => s.id === parse.spaceId) : undefined;
  const project = parse.projectId ? context.projects.find((p) => p.id === parse.projectId) : undefined;
  const placement = parse.tokens.some((token) => token.kind === 'space' || token.kind === 'project') ? [space?.name, project?.name].filter(Boolean).join(' · ') : '';
  const hasNotes = dateText !== null || placement !== '' || line.uncertain;

  return (
    <li className="ct-scan__line" data-uncertain={line.uncertain ? 'true' : undefined}>
      <button
        type="button"
        className="ct-scan__check"
        aria-pressed={line.checked}
        aria-label={line.checked ? t('scan.review.create') : t('scan.review.skip')}
        onClick={() => onToggle(line.id)}
      >
        <span className="ct-scan__box" data-checked={line.checked ? 'true' : undefined}>
          {line.checked && <Icon icon={Check} size={14} strokeWidth={3.2} />}
        </span>
      </button>
      <input
        className="ct-scan__field"
        type="text"
        value={line.text}
        aria-label={t('scan.review.lineLabel', { n: index + 1 })}
        aria-describedby={hasNotes ? noteId : undefined}
        autoComplete="off"
        onChange={(event) => onEdit(line.id, event.target.value)}
      />
      {hasNotes && (
        <div id={noteId} className="ct-scan__notes">
          {dateText && <span className="ct-scan__date">{dateText}</span>}
          {placement !== '' && <span className="ct-scan__place">{t('scan.review.placementDetected', { placement })}</span>}
          {line.uncertain && (
            <span className="ct-scan__warn">
              <Icon icon={TriangleAlert} size={14} />
              {t('scan.review.uncertain')}
            </span>
          )}
        </div>
      )}
    </li>
  );
});

function countLabel(count: number): string {
  return count === 1 ? t('scan.review.detectedOne') : t('scan.review.detected', { count });
}

function createLabel(count: number): string {
  // Pluriel français : 0 et 1 au singulier (« Créer 1 tâche », « Créer 4 tâches »).
  return new Intl.PluralRules('fr').select(count) === 'one' ? t('scan.review.createCountOne', { count }) : t('scan.review.createCount', { count });
}

/**
 * Écran de relecture (Scan.html), partagé iPhone / PC (Q-04 critère 4) : vignette de la photo, « N lignes détectées », lignes à cocher et
 * éditables, espace, « Date des tâches sans date » et « Créer N tâches ». PC : fenêtre à deux colonnes (vignette, consignes et réglages
 * à gauche, lignes à droite, décision D5) ; aucune autre variante n'est dessinée.
 */
export function ScanReview({ scan, layout }: { readonly scan: Scan; readonly layout: Layout }) {
  const spaces = useAppStore((s) => s.spaces);
  const count = scan.drafts.length;
  const today: LocalDate = scan.today;

  const summary = (
    <div className="ct-scan__summary">
      <div
        className="ct-scan__photo"
        role="img"
        aria-label={t('scan.review.thumbnail')}
        {...(scan.thumbnail ? { style: { backgroundImage: `url(${scan.thumbnail})` } } : {})}
      />
      <div className="ct-scan__info">
        <span className="ct-scan__count" role="status">
          {countLabel(scan.proposals.length)}
        </span>
        <span className="ct-scan__lead">{t('scan.review.instructions')}</span>
        {scan.truncated && <span className="ct-scan__lead">{t('scan.review.truncated', { max: scan.proposals.length, count: scan.detected })}</span>}
        <button type="button" className="ct-scan__retake" onClick={scan.goToSource}>
          {t('scan.review.retake')}
        </button>
      </div>
    </div>
  );

  const settings = (
    <div className="ct-scan__settings">
      <div className="ct-scan__setting">
        <span className="ct-scan__settingLabel">{t('scan.review.space')}</span>
        <SpaceSegmented layout="compact" items={spaces} value={scan.spaceId} onChange={scan.chooseSpace} label={t('scan.review.space')} />
      </div>
      <div className="ct-scan__setting">
        <span className="ct-scan__settingLabel">{t('scan.review.defaultDate')}</span>
        <DropdownSelect
          variant="pill"
          label={t('scan.review.defaultDate')}
          value={scan.dateKind}
          options={DATE_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))}
          onChange={(value) => scan.chooseDateKind(value as DateKind)}
        />
      </div>
      {scan.dateKind === 'pick' && (
        <div className="ct-scan__setting ct-scan__setting--pick">
          <DatePicker value={scan.picked} today={today} onChange={scan.choosePicked} showTime={false} allowSomeday={false} label={t('scan.dateChoice.pickLabel')} placement="above" />
        </div>
      )}
    </div>
  );

  const lines = (
    <ul className="ct-scan__lines" aria-label={t('scan.review.lines')}>
      {scan.proposals.map((line, index) => (
        <ScanLine key={line.id} line={line} index={index} context={scan.quickContext} onToggle={scan.toggle} onEdit={scan.edit} />
      ))}
    </ul>
  );

  const create = (
    <>
      {scan.createFailed && (
        <p className="ct-scan__alert" role="alert">
          {t('scan.review.createFailed')}
        </p>
      )}
      <button type="button" className="ct-scan__create" disabled={count === 0 || scan.creating} onClick={() => void scan.submit()}>
        {createLabel(count)}
      </button>
    </>
  );

  return (
    <div className="ct-scan__step ct-scan__step--review" data-layout={layout}>
      <h1 className="ct-scan__title">{t('scan.review.title')}</h1>
      {layout === 'pc' ? (
        <div className="ct-scan__columns">
          <div className="ct-scan__side">
            {summary}
            {settings}
          </div>
          <div className="ct-scan__main">{lines}</div>
        </div>
      ) : (
        <>
          {summary}
          {lines}
          {settings}
        </>
      )}
      <div className="ct-scan__footer">{create}</div>
    </div>
  );
}
