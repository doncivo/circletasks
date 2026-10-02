import { useEffect, useState } from 'react';
import type { ReminderOffsetMin } from '../../domain/model';
import { defaultSetting } from '../../domain/model';
import { useAppContainer } from '../app/AppContainerContext';

/** Avances cochées d'office quand on donne une heure à un nouvel élément (réglage `reminders.defaultOffsets`, QB-08) ; [0] tant que non lu. */
export function useDefaultReminderOffsets(): readonly ReminderOffsetMin[] {
  const container = useAppContainer();
  const [offsets, setOffsets] = useState<readonly ReminderOffsetMin[]>(defaultSetting('reminders.defaultOffsets'));
  useEffect(() => {
    let alive = true;
    container.data.repos.settings.get('reminders.defaultOffsets').then(
      (value) => alive && setOffsets(value),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [container]);
  return offsets;
}
