import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { joinNextSteps, SAMPLE_COUNTS, type OnboardingStepId } from '../../domain/onboarding';
import { FIRST_WEEKDAYS, type FirstWeekday } from '../../domain/week';
import { t } from '../../i18n';
import type { PlainMessageKey } from '../../i18n';
import { Button, Icon, SegmentedControl, Switch, useFocusTrap, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { SpaceEditor } from '../spaces/SpaceEditor';
import { formatQuietSummary } from '../spaces/quietText';
import { spacesStore } from '../spaces/spacesStore';
import '../spaces/SpacesScreen.css';
import { onboardingStore } from './onboardingStore';
import { settingsStore } from './settingsStore';
import './OnboardingHost.css';

const WEEKDAY_KEY = { monday: 'appearance.monday', saturday: 'appearance.saturday', sunday: 'appearance.sunday' } as const satisfies Record<FirstWeekday, PlainMessageKey>;

// `pairing` (association PC / iPhone, ordre 4) et `notifications` (iPhone, ordre 5) ne sont jamais affichées à l'ordre 3 (`onboardingSteps` ne les
// liste pas) : leurs titres et leur contenu arrivent avec leurs stories ; le titre ci-dessous n'est qu'un repli pour garder la table exhaustive.
const TITLE_KEY: Record<OnboardingStepId, PlainMessageKey> = {
  language: 'onboarding.languageTitle',
  spaces: 'onboarding.spacesTitle',
  pairing: 'onboarding.sampleTitle',
  notifications: 'onboarding.sampleTitle',
  sample: 'onboarding.sampleTitle',
};

const STEP_NAME_KEY: Record<OnboardingStepId, PlainMessageKey> = {
  language: 'onboarding.stepNameLanguage',
  spaces: 'onboarding.stepNameSpaces',
  pairing: 'onboarding.stepNamePairing',
  notifications: 'onboarding.stepNameNotifications',
  sample: 'onboarding.stepNameSample',
};

/**
 * L'assistant ne s'ouvre que dans l'app installée (PC, iPhone). Le navigateur de développement et les tests de bout en bout partent d'une
 * base neuve à chaque chargement : sans cette garde, chaque test verrait l'assistant ; un test qui le vise pose `globalThis.__ctOnboarding`
 * (développement seulement, absent d'un build de production).
 */
export function onboardingEnabled(runtime: 'tauri' | 'web'): boolean {
  if (runtime === 'tauri') return true;
  return import.meta.env.DEV && (globalThis as { __ctOnboarding?: boolean }).__ctOnboarding === true;
}

function LanguageStep() {
  const firstWeekday = useFeatureStore(settingsStore, (s) => s.firstWeekday);
  const setFirstWeekday = useFeatureStore(settingsStore, (s) => s.setFirstWeekday);
  const load = useFeatureStore(settingsStore, (s) => s.load);
  const errorKey = useFeatureStore(settingsStore, (s) => s.errorKey);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <p className="ct-onboarding__text">{t('onboarding.languageText')}</p>
      <div className="ct-onboarding__row">
        <span>{t('onboarding.languageRow')}</span>
        <span className="ct-onboarding__value">{t('onboarding.languageValue')}</span>
      </div>
      <div className="ct-onboarding__field">
        <span className="ct-onboarding__label">{t('onboarding.firstDay')}</span>
        <SegmentedControl
          label={t('onboarding.firstDayLabel')}
          value={firstWeekday}
          onChange={(value) => void setFirstWeekday(value)}
          options={FIRST_WEEKDAYS.map((value) => ({ value, label: t(WEEKDAY_KEY[value]) }))}
        />
      </div>
      {errorKey && (
        <p className="ct-onboarding__error" role="alert">
          {t(errorKey)}
        </p>
      )}
    </>
  );
}

function SpacesStep() {
  const spaces = useAppStore((s) => s.spaces);
  const load = useFeatureStore(spacesStore, (s) => s.load);
  const renameSpace = useFeatureStore(spacesStore, (s) => s.renameSpace);
  const setSpaceColor = useFeatureStore(spacesStore, (s) => s.setSpaceColor);
  const errorKey = useFeatureStore(spacesStore, (s) => s.errorKey);
  const editQuietHours = useFeatureStore(onboardingStore, (s) => s.editQuietHours);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <p className="ct-onboarding__text">{t('onboarding.spacesText')}</p>
      {errorKey && (
        <p className="ct-onboarding__error" role="alert">
          {t(errorKey)}
        </p>
      )}
      {spaces.map((space) => (
        <SpaceEditor key={space.id} space={space} spaces={spaces} onRename={(raw) => renameSpace(space.id, raw)} onColor={(color) => setSpaceColor(space.id, color)}>
          <p className="ct-onboarding__quiet">
            {space.quietHours.length === 0 ? t('onboarding.quietNone') : t('onboarding.quietSummary', { summary: formatQuietSummary(space.quietHours) })}{' '}
            <button type="button" className="ct-onboarding__link" aria-label={t('onboarding.quietEditLabel', { name: space.name })} onClick={() => editQuietHours(space.id)}>
              ({t('onboarding.quietEdit')})
            </button>
          </p>
        </SpaceEditor>
      ))}
    </>
  );
}

function SampleStep() {
  const enabled = useFeatureStore(onboardingStore, (s) => s.sampleEnabled);
  const exists = useFeatureStore(onboardingStore, (s) => s.sampleExists);
  const setEnabled = useFeatureStore(onboardingStore, (s) => s.setSampleEnabled);
  return (
    <>
      <p className="ct-onboarding__text">{t('onboarding.sampleText')}</p>
      {exists ? (
        <p className="ct-onboarding__note">{t('onboarding.sampleExists')}</p>
      ) : (
        <>
          <div className="ct-onboarding__row">
            <span>{t('onboarding.sampleSwitch')}</span>
            <Switch checked={enabled} onChange={setEnabled} label={t('onboarding.sampleSwitch')} />
          </div>
          <p className="ct-onboarding__note">{t('onboarding.samplePreview', { tasks: SAMPLE_COUNTS.tasks, routines: SAMPLE_COUNTS.routines, checklists: SAMPLE_COUNTS.checklists })}</p>
        </>
      )}
    </>
  );
}

function Wizard() {
  const layout = useLayout();
  const steps = useFeatureStore(onboardingStore, (s) => s.steps);
  const stepIndex = useFeatureStore(onboardingStore, (s) => s.stepIndex);
  const busy = useFeatureStore(onboardingStore, (s) => s.busy);
  const errorKey = useFeatureStore(onboardingStore, (s) => s.errorKey);
  const next = useFeatureStore(onboardingStore, (s) => s.next);
  const back = useFeatureStore(onboardingStore, (s) => s.back);
  const skip = useFeatureStore(onboardingStore, (s) => s.skip);
  const finish = useFeatureStore(onboardingStore, (s) => s.finish);
  const pc = layout === 'pc';
  const ref = useFocusTrap<HTMLDivElement>({ active: true, ...(pc ? { onEscape: () => void skip() } : {}) });
  const titleRef = useRef<HTMLHeadingElement>(null);
  const step = steps[stepIndex];
  const total = steps.length;
  const last = stepIndex === total - 1;

  // Accessibilité (critère 12) : le titre de chaque étape reçoit le focus quand l'étape change (après le piège de focus, qui le pose sur le premier bouton).
  useEffect(() => {
    titleRef.current?.focus();
  }, [stepIndex]);

  if (!step) return null;
  const upcoming = steps.slice(stepIndex + 1).map((id) => t(STEP_NAME_KEY[id]));

  const inner: ReactNode = (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t('onboarding.dialogLabel')} tabIndex={-1} className="ct-onboarding__panel">
      <div className="ct-onboarding__top">
        <span className="ct-onboarding__step" aria-live="polite">
          {t('onboarding.stepLabel', { step: stepIndex + 1, total })}
        </span>
        <span className="ct-onboarding__topActions">
          <button type="button" className="ct-onboarding__link ct-onboarding__skip" aria-label={t('onboarding.skipLabel')} onClick={() => void skip()}>
            {t('onboarding.skip')}
          </button>
          {pc && (
            <button type="button" className="ct-onboarding__close" aria-label={t('onboarding.close')} onClick={() => void skip()}>
              <Icon icon={X} size={22} />
            </button>
          )}
        </span>
      </div>
      <div className="ct-onboarding__progress" role="progressbar" aria-label={t('onboarding.progressLabel')} aria-valuemin={1} aria-valuemax={total} aria-valuenow={stepIndex + 1} aria-valuetext={t('onboarding.stepLabel', { step: stepIndex + 1, total })}>
        {steps.map((id, index) => (
          <span key={id} className="ct-onboarding__segment" data-done={index <= stepIndex} />
        ))}
      </div>
      <h1 ref={titleRef} tabIndex={-1} className="ct-onboarding__title">
        {t(TITLE_KEY[step])}
      </h1>
      <div className="ct-onboarding__body">
        {step === 'language' && <LanguageStep />}
        {step === 'spaces' && <SpacesStep />}
        {step === 'sample' && <SampleStep />}
      </div>
      {errorKey && (
        <p className="ct-onboarding__error" role="alert">
          {t(errorKey)}
        </p>
      )}
      <div className="ct-onboarding__footer">
        {last ? (
          <Button onClick={() => void finish()} disabled={busy} className="ct-onboarding__primary">
            {t('onboarding.start')}
          </Button>
        ) : (
          <Button onClick={() => void next()} className="ct-onboarding__primary">
            {t('onboarding.continue')}
          </Button>
        )}
        {stepIndex > 0 && (
          <Button variant="secondary" onClick={() => void back()} disabled={busy}>
            {t('onboarding.back')}
          </Button>
        )}
        {upcoming.length > 0 && <span className="ct-onboarding__next">{t('onboarding.next', { steps: joinNextSteps(upcoming, { then: t('onboarding.nextThen'), and: t('onboarding.nextAnd') }) })}</span>}
      </div>
    </div>
  );

  return createPortal(
    <div className="ct-onboarding" data-layout={pc ? 'pc' : 'phone'}>
      {inner}
    </div>,
    document.body,
  );
}

/**
 * Assistant de premier lancement (P-05), monté une fois dans la coquille de l'app. Au lancement : base neuve et réglage absent, il s'ouvre
 * (PC : carte centrée de 640 px sur l'app ; iPhone : plein écran), à l'étape mémorisée s'il avait été interrompu ; base qui contient déjà
 * des données : `onboarding.completed` est posé sans rien montrer. Il se masque pendant l'édition du silence d'un espace (lien « modifiable »)
 * et se rouvre au retour dans Réglages.
 */
export function OnboardingHost() {
  const container = useAppContainer();
  const enabled = onboardingEnabled(container.platform.runtime);
  const open = useFeatureStore(onboardingStore, (s) => s.open);
  const suspended = useFeatureStore(onboardingStore, (s) => s.suspended);
  const start = useFeatureStore(onboardingStore, (s) => s.start);
  const resume = useFeatureStore(onboardingStore, (s) => s.resume);
  const route = useNavigationStore((s) => s.route);

  useEffect(() => {
    if (enabled) void start();
  }, [enabled, start]);

  // Retour de l'éditeur du silence (enregistré ou abandonné) : Réglages s'affiche, l'assistant se rouvre.
  useEffect(() => {
    if (suspended && route.tab === 'settings' && route.screen === 'home') resume();
  }, [suspended, route, resume]);

  if (!open || suspended) return null;
  return <Wizard />;
}
