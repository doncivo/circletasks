import { t } from '../../i18n';
import { ConfirmDialog } from '../../ui';

/**
 * « Réinitialiser la synchronisation » (Y-11 critère 1, §14.3 et §14.1) : boîte de l'app, composée de `ConfirmDialog` (aucun élément
 * visuel nouveau, décision d'Ali du 2026-10-05), qui explique **avant tout envoi** : nouvelle clé et nouvelle clé de secours ; autres
 * appareils à associer de nouveau ou à oublier ; données de chaque appareil conservées et fusionnées ; l'ancienne clé de secours ne sert
 * plus ; l'ancienne clé ne lit plus ce qui sera écrit après, mais lit encore ce qui est déjà chiffré avec elle (copie d'un appareil perdu,
 * fichiers de l'ancienne clé au plus 30 jours dans « Supprimés récemment » d'iCloud). « Annuler » a le focus et Échap annule ; « Continuer »
 * mène à la confirmation native de Rust (« Annuler » par défaut).
 */
export function ResetSyncDialog({ onContinue, onCancel }: { readonly onContinue: () => void; readonly onCancel: () => void }) {
  return <ConfirmDialog title={t('sync.reset.dialogTitle')} description={t('sync.reset.dialogBody')} confirmLabel={t('sync.reset.continue')} onConfirm={onContinue} onCancel={onCancel} />;
}
