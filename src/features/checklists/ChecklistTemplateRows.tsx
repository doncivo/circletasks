import { Copy } from 'lucide-react';
import { t } from '../../i18n';
import { Button, Icon, Switch } from '../../ui';

export interface ChecklistTemplateRowsProps {
  readonly isTemplate: boolean;
  /** Marque ou démarque le modèle (effet immédiat, comme la date). */
  readonly onTemplateChange: (isTemplate: boolean) => void;
  readonly onDuplicate: () => void;
}

/**
 * Lignes « Modèle réutilisable » (interrupteur) et « Dupliquer et réinitialiser » de la feuille « Modifier la checklist » (C-04,
 * décision D2). Pour un modèle, la duplication est le bouton principal ; elle reste disponible pour toute checklist.
 */
export function ChecklistTemplateRows({ isTemplate, onTemplateChange, onDuplicate }: ChecklistTemplateRowsProps) {
  return (
    <>
      <div className="ct-checklist-form__switchRow">
        <span className="ct-checklist-form__label">{t('checklists.template.label')}</span>
        <Switch checked={isTemplate} onChange={onTemplateChange} label={t('checklists.template.label')} />
      </div>
      <Button variant={isTemplate ? 'primary' : 'secondary'} fullWidth onClick={onDuplicate}>
        <span className="ct-checklist-form__duplicate">
          <Icon icon={Copy} size={18} />
          {t('checklists.template.duplicate')}
        </span>
      </Button>
    </>
  );
}
