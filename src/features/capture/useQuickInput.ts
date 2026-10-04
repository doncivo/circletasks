import { useCallback, useMemo, useState } from 'react';
import { nowLocalTime, todayLocal } from '../../domain/clock';
import { parseQuickInput, type QuickContext, type QuickParse } from '../../domain/quickInput';
import type { LocalDate, LocalTime, ProjectId, SpaceId } from '../../domain/types';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useDefaultSpaceId } from '../spaces';

export interface UseQuickInputOptions {
  /** Faux : seules les marques # et @ sont lues (écran « Un jour », date réglée à la main). Défaut : vrai. */
  readonly dates?: boolean;
  /** Texte de départ (titre repris d'un autre segment de la feuille Ajout, E-01). */
  readonly initialText?: string;
}

/**
 * Ce que la création doit écrire (Q-06, Q-02) : espace et projet résolus (marques explicites d'abord, sinon l'espace par défaut
 * ES-02 et le filtre projet), date et heure détectées (null : rien de détecté, l'écran applique sa règle).
 */
export interface CaptureInput {
  readonly title: string;
  readonly spaceId: SpaceId | null;
  readonly projectId: ProjectId | null;
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  /** La date est écrite dans le texte ; faux : déduite d'une heure seule, un écran qui a son propre jour le garde. */
  readonly dateWritten: boolean;
}

/**
 * Applique les marques à l'espace par défaut et au filtre projet. Les marques explicites l'emportent sur le filtre d'affichage
 * (Q-06 D3) ; sans marque, l'espace par défaut et le projet du filtre actif s'appliquent. Un projet du filtre n'est gardé que
 * dans son espace (l'espace écrit n'est pas celui du filtre : pas de projet).
 */
export function captureInputFrom(parse: QuickParse, defaultSpaceId: SpaceId | null, projectFilter: ProjectId | null): CaptureInput {
  const spaceId = parse.spaceId ?? defaultSpaceId;
  const keepFilter = parse.projectId === null && (parse.spaceId === null || parse.spaceId === defaultSpaceId);
  return {
    title: parse.title,
    spaceId,
    projectId: parse.projectId ?? (keepFilter ? projectFilter : null),
    date: parse.date,
    time: parse.time,
    dateWritten: parse.dateWritten,
  };
}

/**
 * État d'un champ de saisie rapide : texte, marques retirées (la marque redevient du texte), analyse à chaque frappe et contexte des
 * suggestions. « Maintenant » vient de l'horloge du conteneur (fuseau de l'appareil) et le premier jour de semaine des réglages (P-03).
 */
export function useQuickInput(options: UseQuickInputOptions = {}) {
  const { clock } = useAppContainer();
  const spaces = useAppStore((s) => s.spaces);
  const projects = useAppStore((s) => s.projects);
  const defaultSpaceId = useDefaultSpaceId();
  const [text, setTextState] = useState(options.initialText ?? '');
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(new Set());
  const dates = options.dates !== false;

  /** Contexte des suggestions : sans horloge, il ne change pas à chaque minute. */
  const suggestionContext = useMemo<QuickContext>(() => ({ spaces, projects, defaultSpaceId, dates: false }), [spaces, projects, defaultSpaceId]);

  const buildContext = useCallback(
    (): QuickContext => ({
      spaces,
      projects,
      defaultSpaceId,
      dates,
      firstWeekday: getFirstWeekday(),
      now: { date: todayLocal(clock), time: nowLocalTime(clock) },
    }),
    [spaces, projects, defaultSpaceId, dates, clock],
  );

  const parse = useMemo(() => parseQuickInput(text, buildContext(), { ignored }), [text, ignored, buildContext]);
  /** Relit l'analyse avec l'heure d'aujourd'hui (au moment d'envoyer). */
  const parseNow = useCallback((raw: string = text): QuickParse => parseQuickInput(raw, buildContext(), { ignored }), [text, ignored, buildContext]);

  const setText = useCallback((next: string) => {
    setTextState(next);
    if (next === '') setIgnored(new Set());
  }, []);
  const dismiss = useCallback((keys: readonly string[]) => setIgnored((current) => new Set([...current, ...keys])), []);
  const reset = useCallback(() => {
    setTextState('');
    setIgnored(new Set());
  }, []);

  return { text, setText, parse, parseNow, dismiss, reset, spaces, projects, defaultSpaceId, suggestionContext, today: todayLocal(clock) };
}
