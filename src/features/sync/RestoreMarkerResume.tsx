import { useState } from "react";
import { t } from "../../i18n";
import { tBackupRestore } from "../../i18n/backupRestoreText";
import { Button, ConfirmDialog } from "../../ui";
import { useAppContainer } from "../app/AppContainerContext";
import {
  writeRestoreMarker,
  type MarkerRetryOutcome,
} from "../../platform/backup/startupRecovery";
import { readMarkerFailed } from "../settings/restoreMemo";
import {
  markerResolved,
  restoreMarkerFailure,
  resumeSyncDespiteMarker,
} from "./syncRestoreControl";

/**
 * P-04-iOS critère 12 (ADR 0009 avenant lot F B6) : la restauration est faite mais le marqueur de la synchro n'a pas pu être écrit ; aucun
 * cycle ne part. Même message que le bandeau, avec le code, et « Reprendre la synchronisation » : choix explicite, confirmé (« Annuler » par
 * défaut), qui efface le mémo. Revue I2 : « Réessayer » réécrit le marqueur (sauvegarde du mémo) ; réussite : la synchro reprend et la
 * fenêtre de choix habituelle suit le marqueur ; échec : nouveau code affiché.
 */
export function RestoreMarkerResume({
  retry = writeRestoreMarker,
}: { retry?: (backup: string) => Promise<MarkerRetryOutcome> } = {}) {
  const container = useAppContainer();
  const [code, setCode] = useState(() => restoreMarkerFailure(container));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!code) return null;
  const retryMarker = (): void => {
    setBusy(true);
    void retry(readMarkerFailed()?.backup ?? "").then((outcome) => {
      setBusy(false);
      if (outcome.marker === "failed") {
        setCode(outcome.code);
        return;
      }
      markerResolved(container);
      setCode(null);
    });
  };
  return (
    <div className="ct-settings__row">
      <span className="ct-settings__stack" role="alert">
        {t("backup.markerFailed")}
        <span className="ct-settings__hint ct-settings__hint--missed">
          {t("backup.errorCode", { code })}
        </span>
      </span>
      <span className="ct-settings__actions">
        <Button
          variant="secondary"
          onClick={retryMarker}
          disabled={busy}
          className="ct-settings__link"
        >
          {tBackupRestore("retry")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="ct-settings__link"
        >
          {tBackupRestore("resumeSync")}
        </Button>
      </span>
      {confirming && (
        <ConfirmDialog
          title={tBackupRestore("resumeSyncTitle")}
          description={tBackupRestore("resumeSyncText")}
          confirmLabel={tBackupRestore("resumeSync")}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            resumeSyncDespiteMarker(container);
            setCode(null);
          }}
        />
      )}
    </div>
  );
}
