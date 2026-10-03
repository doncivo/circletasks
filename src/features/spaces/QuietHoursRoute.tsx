import { useEffect } from 'react';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { QuietHoursScreen } from './QuietHoursScreen';

/** Écran des plages silencieuses de l'espace désigné par la route ; un espace inconnu ramène à Réglages. */
export function QuietHoursRoute() {
  const route = useNavigationStore((s) => s.route);
  const navigate = useNavigationStore((s) => s.navigate);
  const spaces = useAppStore((s) => s.spaces);
  const spaceId = route.tab === 'settings' && route.screen === 'quiet' ? route.spaceId : null;
  const space = spaces.find((candidate) => candidate.id === spaceId);
  useEffect(() => {
    if (!space) navigate({ tab: 'settings', screen: 'home' });
  }, [space, navigate]);
  // `key` : changer d'espace repart du réglage de cet espace.
  return space ? <QuietHoursScreen key={space.id} space={space} /> : null;
}
