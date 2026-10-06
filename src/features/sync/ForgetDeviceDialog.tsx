import { t } from '../../i18n';
import { ConfirmDialog } from '../../ui';

/**
 * « Oublier cet appareil » (Y-10 critères 2 et 4, D1) : boîte de l'app, composée de `ConfirmDialog` (aucun élément visuel nouveau), qui
 * explique **avant tout envoi** : l'appareil ne sera plus lu au-delà d'un point commun à tous, ses fichiers seront supprimés d'iCloud
 * (récupérables 30 jours dans « Supprimés récemment »), l'oubli ne s'annule pas, et l'appareil oublié garde sa copie et sa clé (seule
 * « Réinitialiser la synchronisation » coupe son accès aux données futures). « Annuler » a le focus et Échap annule ; « Continuer »
 * mène à la confirmation native de Rust (courte, « Annuler » par défaut).
 */
export function ForgetDeviceDialog({ deviceName, onContinue, onCancel }: { readonly deviceName: string; readonly onContinue: () => void; readonly onCancel: () => void }) {
  return (
    <ConfirmDialog
      title={t('sync.forget.dialogTitle', { device: deviceName })}
      description={t('sync.forget.dialogBody', { device: deviceName })}
      confirmLabel={t('sync.forget.continue')}
      onConfirm={onContinue}
      onCancel={onCancel}
    />
  );
}
