import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DateChoice } from '../../../domain/dateInput';
import { addDays } from '../../../domain/localDate';
import { todayLocal } from '../../../domain/clock';
import type { QuickContext } from '../../../domain/quickInput';
import { defaultSpaceFor } from '../../../domain/spaceRules';
import type { LocalDate, SpaceId } from '../../../domain/types';
import { logFailure } from '../../../platform';
import { OcrError, type OcrEngine, type OcrEngineId, type OcrFailure, type OcrService } from '../../../platform/ocr';
import { useAppContainer } from '../../app/AppContainerContext';
import { useAppStore } from '../../app/appStore';
import { useAbsoluteDateParser } from '../useAbsoluteDateParser';
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

/** Pourquoi le moteur natif de l'iPhone est indisponible (CAP-IOS-01) : code affiché et journalisé. */
export type UnavailableReason = 'plugin-unavailable' | 'language-missing';

/** Échec d'une lecture, gardé pour l'écran d'erreur persistant (code de la commande Rust, jamais un texte reconnu). */
export interface ScanFailure {
  readonly engine: OcrEngineId;
  readonly reason: OcrFailure;
  readonly code: string;
}

/** Moteur natif indisponible : sur l'iPhone la raison est gardée pour l'écran et journalisée (code seul) ; sur PC l'écran de Windows suffit. */
function markUnavailable(engine: OcrEngineId, reason: UnavailableReason, set: (reason: UnavailableReason | null) => void): void {
  if (engine !== 'vision') {
    set(null);
    return;
  }
  set(reason);
  logFailure('capture', `vision-${reason}`);
}

/** Code de commande Rust correspondant à une raison, quand l'erreur n'en porte pas (faux, repli). */
const DEFAULT_CODES: Readonly<Record<OcrFailure, string>> = {
  'language-missing': 'ocr-language-missing',
  'unsupported-format': 'ocr-unsupported-format',
  'too-large': 'ocr-too-large',
  dimensions: 'ocr-dimensions-too-large',
  unavailable: 'ocr-unavailable',
  timeout: 'ocr-timeout',
  busy: 'ocr-busy',
  failed: 'ocr-engine',
};

/** Erreurs passagères : « Réessayer » a un sens. Les autres tiennent à l'image (format, poids, dimensions) : seule une autre photo ou l'autre moteur aide. */
export function isTransientFailure(reason: OcrFailure): boolean {
  return reason === 'failed' || reason === 'unavailable' || reason === 'timeout' || reason === 'busy';
}

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
  const [unavailableReason, setUnavailableReason] = useState<UnavailableReason | null>(null);
  const [failure, setFailure] = useState<ScanFailure | null>(null);
  // Image préparée (réduite), gardée en mémoire le temps d'une lecture et d'un éventuel « Réessayer » ou « Lire avec le moteur intégré » ;
  // libérée dès que la lecture réussit, qu'on reprend une photo ou qu'on ferme l'écran. Jamais écrite ni envoyée.
  const prepared = useRef<Blob | null>(null);
  const [refusal, setRefusal] = useState<ImageRefusal | 'unreadable' | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [proposals, setProposals] = useState<readonly ScanProposal[]>([]);
  const [detected, setDetected] = useState(0);
  // Le moteur a transmis moins de lignes qu'il n'en a lu (Vision : 500 au plus) : dit en relecture.
  const [engineTruncated, setEngineTruncated] = useState(false);
  // La copie temporaire d'une photo précédente n'a pas pu être supprimée (Vision, iPhone) : dit, jamais silencieux.
  const [cleanupFailed, setCleanupFailed] = useState(false);
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
      prepared.current = null;
    };
  }, []);

  // Premier scan : le moteur du système est vérifié avant tout (pack de langue français, PRD section 10 ; iPhone : Vision).
  useEffect(() => {
    let cancelled = false;
    const { primary } = service;
    if (!primary) return undefined;
    primary.status().then(
      (status) => {
        if (cancelled) return;
        if (status.cleanupFailed === true) {
          logFailure('capture', 'vision-cleanup-failed');
          setCleanupFailed(true);
        }
        if (status.available) {
          setEngine(primary);
          setStep('source');
        } else {
          markUnavailable(primary.id, status.reason ?? 'plugin-unavailable', setUnavailableReason);
          setStep('unavailable');
        }
      },
      () => {
        // Un moteur qui ne répond pas est dit indisponible (jamais une vérification qui ne finit pas).
        if (cancelled) return;
        markUnavailable(primary.id, 'plugin-unavailable', setUnavailableReason);
        setStep('unavailable');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [service]);

  // PERF-02 : l'analyseur des dates écrites arrive à la demande ; les lignes déjà proposées sont relues à ce moment.
  const absoluteDates = useAbsoluteDateParser();
  const quickContext: QuickContext = useMemo(
    () => ({ ...currentQuickContext(container), absoluteDates }),
    // Recalculé quand les espaces, projets ou le jour changent ; l'heure n'a pas besoin d'être exacte pour l'aperçu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [container, spaces, projects, spaceFilter, today, absoluteDates],
  );

  const dateDefault: DateDefault = useMemo(() => {
    if (dateKind === 'pick') return picked?.date ? { kind: 'date', date: picked.date } : picked ? { kind: 'someday' } : { kind: 'today' };
    return { kind: dateKind };
  }, [dateKind, picked]);

  const drafts: readonly ScanDraft[] = useMemo(
    () => (spaceId ? draftsFromProposals(proposals, quickContext, { spaceId, date: dateDefault, today }) : []),
    [proposals, quickContext, spaceId, dateDefault, today],
  );

  /** Lecture de l'image préparée par `active` ; un échec devient l'écran « indisponible » (français absent) ou l'erreur persistante avec son code. */
  const recognizeWith = useCallback(async (active: OcrEngine, blob: Blob) => {
    const run = ++generation.current;
    try {
      const result = await active.recognize(blob, { lang: 'fra' });
      if (!alive.current || run !== generation.current) return;
      const found = scanLinesToProposals(result.lines);
      prepared.current = null;
      setDetected(found.detected);
      setEngineTruncated(result.truncated === true);
      setProposals(found.proposals);
      setDirty(false);
      setCreateFailed(false);
      setFailure(null);
      setStep(found.proposals.length === 0 ? 'empty' : 'review');
    } catch (error) {
      if (!alive.current || run !== generation.current) return;
      const reason: OcrFailure = error instanceof OcrError ? error.reason : 'failed';
      if (reason === 'language-missing' && (active.id === 'windows' || active.id === 'vision')) {
        markUnavailable(active.id, 'language-missing', setUnavailableReason);
        setStep('unavailable');
        return;
      }
      const code = (error instanceof OcrError ? error.code : undefined) ?? DEFAULT_CODES[reason];
      if (active.id === 'vision') logFailure('capture', `vision-${reason}`);
      setFailure({ engine: active.id, reason, code });
      setStep('error');
    }
  }, []);

  const goToSource = useCallback(() => {
    prepared.current = null;
    setStep('source');
    setProposals([]);
    setThumbnail(null);
    setDirty(false);
    setCreateFailed(false);
    setFailure(null);
  }, []);

  const recheckEngine = useCallback(async () => {
    const primary = service.primary;
    if (!primary) return;
    setRecheck('running');
    const status = await primary.status().catch(() => ({ available: false, languages: [], reason: 'plugin-unavailable' as const }));
    if (!alive.current) return;
    if (status.available) {
      setEngine(primary);
      setRecheck('idle');
      setUnavailableReason(null);
      setStep(prepared.current ? 'reading' : 'source');
      if (prepared.current) void recognizeWith(primary, prepared.current);
    } else {
      markUnavailable(primary.id, status.reason ?? 'plugin-unavailable', setUnavailableReason);
      setRecheck('still-missing');
    }
  }, [service, recognizeWith]);

  /** Choix EXPLICITE du repli (jamais automatique) : l'image déjà préparée, s'il y en a une, est lue aussitôt. */
  const chooseFallbackEngine = useCallback(() => {
    const fallback = service.fallback;
    if (!fallback) return;
    setEngine(fallback);
    setRecheck('idle');
    setFailure(null);
    if (prepared.current) {
      setStep('reading');
      void recognizeWith(fallback, prepared.current);
    } else {
      setStep('source');
    }
  }, [service, recognizeWith]);

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
      setFailure(null);
      try {
        const image = await prepareImage(source);
        if (!alive.current || run !== generation.current) return;
        setThumbnail(image.thumbnail);
        prepared.current = image.blob;
        await recognizeWith(active, image.blob);
      } catch (error) {
        if (!alive.current || run !== generation.current) return;
        if (error instanceof ImageUnreadableError) {
          setRefusal('unreadable');
          setStep('source');
        } else {
          setFailure({ engine: active.id, reason: 'failed', code: DEFAULT_CODES.failed });
          setStep('error');
        }
      }
    },
    [engine, recognizeWith],
  );

  /** « Réessayer » : la même image, le même moteur. */
  const retry = useCallback(() => {
    const active = engine;
    const blob = prepared.current;
    if (!active || !blob) {
      goToSource();
      return;
    }
    setFailure(null);
    setStep('reading');
    void recognizeWith(active, blob);
  }, [engine, goToSource, recognizeWith]);

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
    unavailableReason,
    failure,
    retry,
    refusal,
    thumbnail,
    proposals,
    detected,
    truncated: detected > MAX_SCAN_LINES,
    engineTruncated,
    cleanupFailed,
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
