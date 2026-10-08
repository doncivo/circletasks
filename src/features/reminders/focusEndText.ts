import { t } from '../../i18n';
import { formatFocusDuration } from '../../i18n/formatFocus';

/**
 * Texte de la notification de fin de session Focus (F-04 critère 14) : titre « Session terminée · 25 min », corps = titre de la tâche
 * (src/i18n). Séance libre ou durée inconnue : « 0 min » n'est jamais annoncé, la notification n'existe pas pour une session libre.
 */
export function composeFocusEndText(taskTitle: string, plannedMin: number | null): { readonly title: string; readonly body: string } {
  return { title: t('notifications.focusEnd.title', { duration: formatFocusDuration(plannedMin ?? 0) }), body: taskTitle };
}
