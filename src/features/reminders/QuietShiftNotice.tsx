import type { QuietHours } from '../../domain/model';
import { quietShift } from '../../domain/quietShift';
import type { LocalDateTime, SpaceId } from '../../domain/types';
import { quietShiftFormText } from '../../i18n/quietShiftText';
import { useAppStore } from '../app/appStore';
import './IphoneReminderWarning.css';

const NO_QUIET_HOURS: readonly QuietHours[] = [];

export interface QuietShiftNoticeProps {
  /** Espace de l'élément (ses plages décalent le rappel) ; null : pas encore choisi, rien à dire. */
  readonly spaceId: SpaceId | null;
  /** Échéances d'origine des rappels choisis (une par avance), telles que le planificateur les calculera. */
  readonly fireAts: readonly LocalDateTime[];
}

/**
 * N-FIX-04 : au moment du choix, une ligne par rappel qui tombe dans une plage silencieuse de l'espace : « Rappel décalé au lundi 08:00 —
 * aucun rappel Pro après 19:00 ». Une phrase, une cause ; deux rappels décalés de la même façon ne donnent qu'une ligne. Rien quand aucun
 * rappel n'est décalé. Même style que l'avertissement N-07 ; sur PC comme sur iPhone, en création comme en modification.
 */
export function QuietShiftNotice({ spaceId, fireAts }: QuietShiftNoticeProps) {
  const space = useAppStore((state) => (spaceId === null ? undefined : state.spaces.find((candidate) => candidate.id === spaceId)));
  const quietHours = space?.quietHours ?? NO_QUIET_HOURS;
  if (space === undefined || quietHours.length === 0 || fireAts.length === 0) return null;
  const lines = [...new Set(fireAts.flatMap((fireAt) => {
    const shift = quietShift(fireAt, quietHours);
    return shift === null ? [] : [quietShiftFormText(shift, space.name)];
  }))];
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <p key={line} className="ct-reminder-warning" role="status" data-warning="quiet-shift">
          {line}
        </p>
      ))}
    </>
  );
}
