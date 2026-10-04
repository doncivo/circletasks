import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DateChoice } from '../../../domain/dateInput';
import { addDays } from '../../../domain/localDate';
import { todayLocal } from '../../../domain/clock';
import type { QuickContext } from '../../../domain/quickInput';
import { defaultSpaceFor } from '../../../domain/spaceRules';
import type { LocalDate, SpaceId } from '../../../domain/types';
import { OcrError, type OcrEngine, type OcrService } from '../../../platform/ocr';
import { useAppContainer } from '../../app/AppContainerContext';
import { useAppStore } from '../../app/appStore';
import { currentQuickContext } from '../captureUseCases';
import { draftsFromProposals, type DateDefault, type ScanDraft } from './scanDrafts';
import { isUncertain, MAX_SCAN_LINES, scanLinesToProposals, type ScanProposal } from './scanLines';
import { checkImageFile, ImageUnreadableError, prepareImage, type ImageRefusal } from './prepareImage';
import { createScanTasks } from './scanUseCases';

export type ScanStep = 'checking' | 'unavailable' | 'source' | 'reading' | 'review' | 'empty' | 'error';
export type DateKind = 'today' | 'tomorrow' | 'someday' | 'pick';
export type RecheckState = 'idle' | 'running' | 'still-missing';

export interface UseScanOptions {
  readonly service: OcrService;
  /** Ferme l'écran (annulation, ou tâches créées). */
  readonly onClose: () => void;
}

/** Fichier ou photo de webcam à lire. */
export type ScanSource = Blob & { readonly name?: string };

/**
 * Parcours du scan de tâches (Q-04) : vérification du moteur au premier scan, choix de l'image, lecture, relecture, création en lot.
 * L'image n'est gardée nulle part : elle est réduite puis lue, seule la vignette `data:` reste pour la relecture.
 */
export function useScan({ service, onClose }: UseScanOptions) {
  const container = useAppContainer();
  const spaces = useAppStore((s) => s.spaces);
  const projects = useAppStore((s) => s.projects);
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const today: LocalDate = todayLocal(container.clock);

  // Sans moteur natif (iPhone, navigateur), le repli est le moteur : pas de vérification, on passe directement au choix de l'image.
  const [step, setStep] = useState<ScanStep>(() => (service.primary ? 'checking' : 'source'));
  const [engine, setEngine] = useState<OcrEngine | null>(() => (service.primary ? null : service.fallback));
  const [recheck, setRecheck] = useState<RecheckState>('idle');
  const [refusal, setRefusal] = useState<ImageRefusal | 'unreadable' | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [proposals, setProposals] = useState<readonly ScanProposal[]>([]);
  const [detected, setDetected] = useState(0);
  // Espace choisi par l'utilisateur ; sans choix, l'espace par défaut suit le filtre (ES-02).
  const [chosenSpace, setChosenSpace] = useState<SpaceId | null>(null);
  const spaceId = chosenSpace ?? defaultSpaceFor(spaceFilter, spaces);
  const [dateKind, setDateKind] = useState<DateKind>('today');
  const [picked, setPicked] = useState<DateChoice | null>(null);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
    };
  }, []);

  // Premier scan : le moteur du système est vérifié avant tout (pack de langue français, PRD section 10).
  useEffect(() => {
    let cancelled = false;
    const { primary } = service;
    if (!primary) return undefined;
    void primary.status().then((status) => {
      if (cancelled) return;
      if (status.available) {
        setEngine(primary);
        setStep('source');
      } else {
        setStep('unavailable');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [service]);

  const quickContext: QuickContext = useMemo(
    () => currentQuickContext(container),
    // Recalculé quand les espaces, projets ou le jour changent ; l'heure n'a pas besoin d'être exacte pour l'aperçu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [container, spaces, projects, spaceFilter, today],
  );

  const dateDefault: DateDefault = useMemo(() => {
    if (dateKind === 'pick') return picked?.date ? { kind: 'date', date: picked.date } : picked ? { kind: 'someday' } : { kind: 'today' };
    return { kind: dateKind };
  }, [dateKind, picked]);

  const drafts: readonly ScanDraft[] = useMemo(
    () => (spaceId ? draftsFromProposals(proposals, quickContext, { spaceId, date: dateDefault, today }) : []),
    [proposals, quickContext, spaceId, dateDefault, today],
  );

  const goToSource = useCallback(() => {
    setStep('source');
    setProposals([]);
    setThumbnail(null);
    setDirty(false);
    setCreateFailed(false);
  }, []);

  const recheckEngine = useCallback(async () => {
    const primary = service.primary;
    if (!primary) return;
    setRecheck('running');
    const status = await primary.status();
    if (!alive.current) return;
    if (status.available) {
      setEngine(primary);
      setRecheck('idle');
      setStep('source');
    } else {
      setRecheck('still-missing');
    }
  }, [service]);

  const chooseFallbackEngine = useCallback(() => {
    if (!service.fallback) return;
    setEngine(service.fallback);
    setRecheck('idle');
    setStep('source');
  }, [service]);

  const readImage = useCallback(
    async (source: ScanSource) => {
      setRefusal(null);
      const refused = checkImageFile({ type: source.type, size: source.size, ...(source.name ? { name: source.name } : {}) });
      if (refused) {
        setRefusal(refused);
        return;
      }
      const active = engine;
      if (!active) return;
      const run = ++generation.current;
      setStep('reading');
      try {
        const prepared = await prepareImage(source);
        if (!alive.current || run !== generation.current) return;
        setThumbnail(prepared.thumbnail);
        const result = await active.recognize(prepared.blob, { lang: 'fra' });
        if (!alive.current || run !== generation.current) return;
        const found = scanLinesToProposals(result.lines);
        setDetected(found.detected);
        setProposals(found.proposals);
        setDirty(false);
        setCreateFailed(false);
        setStep(found.proposals.length === 0 ? 'empty' : 'review');
      } catch (error) {
        if (!alive.current || run !== generation.current) return;
        if (error instanceof ImageUnreadableError) {
          setRefusal('unreadable');
          setStep('source');
        } else if (error instanceof OcrError && error.reason === 'language-missing' && active.id === 'windows') {
          setStep('unavailable');
        } else {
          setStep('error');
        }
      }
    },
    [engine],
  );

  const toggle = useCallback((id: string) => {
    setProposals((current) => current.map((line) => (line.id === id ? { ...line, checked: !line.checked } : line)));
    setDirty(true);
  }, []);

  const edit = useCallback((id: string, text: string) => {
    // Un texte corrigé n'est plus « incertain » que s'il est encore douteux (la confiance du moteur ne vaut plus pour lui).
    setProposals((current) => current.map((line) => (line.id === id ? { ...line, text, uncertain: isUncertain(text) } : line)));
    setDirty(true);
  }, []);

  const chooseSpace = useCallback((id: SpaceId) => {
    setChosenSpace(id);
    setDirty(true);
  }, []);

  const chooseDateKind = useCallback(
    (kind: DateKind) => {
      setDateKind(kind);
      if (kind === 'pick' && picked === null) setPicked({ date: addDays(today, 1), time: null });
      setDirty(true);
    },
    [picked, today],
  );

  const choosePicked = useCallback((choice: DateChoice | null) => {
    setPicked(choice);
    setDirty(true);
  }, []);

  const submit = useCallback(async () => {
    if (creating || drafts.length === 0) return;
    setCreating(true);
    setCreateFailed(false);
    const result = await createScanTasks(container, drafts);
    if (!alive.current) return;
    setCreating(false);
    if (result.ok) onClose();
    else setCreateFailed(true);
  }, [container, creating, drafts, onClose]);

  const requestClose = useCallback(() => {
    if (step === 'review' && dirty) setConfirmClose(true);
    else onClose();
  }, [step, dirty, onClose]);

  return {
    step,
    engine,
    recheck,
    refusal,
    thumbnail,
    proposals,
    detected,
    truncated: detected > MAX_SCAN_LINES,
    spaceId,
    dateKind,
    picked,
    drafts,
    today,
    quickContext,
    creating,
    createFailed,
    confirmClose,
    setConfirmClose,
    readImage,
    recheckEngine,
    chooseFallbackEngine,
    goToSource,
    toggle,
    edit,
    chooseSpace,
    chooseDateKind,
    choosePicked,
    submit,
    requestClose,
    canUseFallback: service.fallback !== null && service.primary !== null,
  };
}

export type Scan = ReturnType<typeof useScan>;
