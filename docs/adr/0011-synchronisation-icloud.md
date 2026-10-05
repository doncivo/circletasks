# ADR 0011 — Synchronisation par iCloud Drive (M15, Y-01 à Y-09)

- Statut : accepté (contrat ; implémentation par sync-icloud, lots Y1 à Y3)
- Date : 2026-10-05
- Stories : Y-01 à Y-09 (M15, ordre 4) ; A-09 critère 9 (bandeaux) ; parcours 10 et 11 ; prépare l'ordre 5 (iPhone : plugin folder-bookmark, scan du QR, rappels recalculés après synchro)
- Complète : ADR 0001 (couches), 0002 (driver, migrations), 0005 (HLC), 0008 (coffre `keyring`), 0009 (avenant P-04), 0010 (restauration et synchronisation, 6 règles)

## Contexte

Deux appareils (PC Windows, iPhone à l'ordre 5) partagent leurs données sans serveur, par un dossier `iCloud Drive/CircleTasks` (PRD 7). Contraintes :

- aucune perte (PRD 8), aucun élément supprimé qui réapparaît (Y-09), conflits consultables et réversibles (Y-04) ;
- fichiers chiffrés de bout en bout, clé jamais dans iCloud (Y-08) ;
- iCloud pour Windows laisse des fichiers « dans le nuage » (fichiers à la demande, placeholders) et peut livrer un fichier en cours de transfert ; l'iPhone ne synchronise qu'au premier plan ;
- pas de Mac : tout ce qui est iOS est un contrat, vérifié par le build CI puis par Ali à l'ordre 5 ;
- la base locale ne porte qu'un `hlc` par ligne (ADR 0005), alors que la fusion se fait champ par champ ;
- l'ADR 0010 impose six règles liées à la restauration P-04 ;
- `docs/dettes.md` (ordre 4) liste dix points à trancher sur les données locales.

## Décision

### 0. Vue d'ensemble et couches

| Couche | Fichiers | Rôle |
| --- | --- | --- |
| Rust | `src-tauri/src/sync/` (`mod.rs`, `commands.rs`, `crypto.rs`, `names.rs`, `files.rs`, `folder.rs`, `cloud_windows.rs`, `pairing.rs`, `marker.rs`) ; `src-tauri/src/vault.rs` | Dossier choisi (jamais de chemin dans la WebView), hydratation des fichiers du nuage, lecture et écriture des fichiers, chiffrement et AAD, clé au coffre, QR et clé de secours, marqueur de restauration. **Aucune règle de fusion.** |
| platform | `src/platform/sync/` (`types.ts`, `tauriSync.ts`, `memory.ts`, `index.ts`) | Contrat `SyncPlatform` (section 11), seul code qui appelle les commandes `sync_*`. Implémentation mémoire pour le navigateur de dev, Vitest et Playwright. |
| domain | `src/domain/sync/` (`format.ts`, `syncTables.ts`, `merge.ts`, `retention.ts`, `epoch.ts`, `drift.ts`, `repairs.ts`, `naturalIds.ts`, `compat.ts`) | Règles pures : format des enregistrements, catalogue des tables et colonnes publiées, fusion et détection de conflit, rétention et purge, choix de l'époque, dérive d'horloge, réparations après fusion, identifiants déterministes, compatibilité de versions. Sans état ni I/O. |
| db | `src/db/migrations/0015_sync_tables.ts`, `0016_sync_natural_ids.ts` (premiers numéros libres au moment du lot : le registre fait foi) ; `src/db/repositories/syncRepository.ts` + `sql/sync*.ts` | Tables de synchro, déclencheurs de capture, application des opérations, curseurs, conflits, traces, instantanés paginés. Aucune règle métier. |
| sync | `src/sync/` (`engine.ts`, `reader.ts`, `publisher.ts`, `snapshot.ts`, `epochSwitch.ts`, `restoreChoice.ts`, `join.ts`, `scheduler.ts`, `status.ts`, `events.ts`, `index.ts`) | Orchestration du cycle (section 10.2) ; dépend de domain, db, platform (ADR 0001). |
| features | `src/features/sync/` | Réglages > Synchronisation, détails (état, appareils, conflits), appairage, choix après restauration, bandeaux A-09. |

La phrase de l'ADR 0001 « `src/sync` : journaux, hlc, fusion » est précisée : la fusion est une **règle pure** dans `src/domain/sync`, appliquée par `src/sync` (règle CLAUDE.md : règles métier dans `src/domain` uniquement).

**Pourquoi le chiffrement en Rust et pas en Web Crypto (écart au tableau du PRD 7, inscrit dans `docs/decisions.md`)** : la clé reste dans le processus Rust, comme les jetons des agendas (ADR 0008 : pas de `get` du coffre côté WebView) ; les fichiers sont de toute façon lus et écrits par Rust (hydratation Windows, accès coordonné iOS) ; la WebView ne voit que du texte clair déjà déchiffré, jamais la clé, sauf pendant l'affichage volontaire du QR et de la clé de secours (Y-06).

### 1. Format sur disque

#### 1.1 Arborescence

```
iCloud Drive/CircleTasks/
  devices/
    <device_id>/                       un dossier par appareil, écrit par lui seul
      state.ctx                        état publié de l'appareil (réécrit à chaque cycle)
      e0001-<device_id créateur>/      une époque (section 9)
        j-00000001.ctj                 segments de journal, ajout seul
        j-00000002.ctj
        s-00000001.cts                 instantanés écrits par cet appareil dans cette époque
```

- **Un seul écrivain par fichier** : un appareil n'écrit, ne renomme et ne supprime que dans `devices/<son device_id>/`. Il n'existe **aucun fichier partagé** à la racine, donc **aucun verrou** : iCloud ne peut pas produire de conflit d'écriture entre deux appareils. Rust refuse toute écriture hors du dossier de l'appareil lié par `sync_bind_device`.
- Noms stricts (`names.rs`, expressions exactes) : `device_id` UUID v4 en minuscules ; époque `e<4 chiffres>-<uuid>` ; segment `j-<8 chiffres>.ctj` ; instantané `s-<8 chiffres>.cts` ; `state.ctx`. Tout autre nom (copie de conflit d'iCloud « state 2.ctx », fichier temporaire `*.tmp`, fichier étranger) est **ignoré**, jamais lu ni supprimé, et signalé dans le journal technique.
- Écart assumé avec le PRD 7 (`changes-pc.jsonl`, `changes-iphone.jsonl`, `snapshot.json`) : même principe (un journal par appareil, instantané périodique), mais nommé par `device_id` (deux PC possibles, réinstallation) et découpé en segments pour pouvoir purger (Y-09). Le libellé affiché à l'utilisateur reste « journal du PC » / « journal de l'iPhone ».

#### 1.2 Lignes chiffrées

Chaque fichier est un texte UTF-8 en lignes terminées par `\n` :

- **ligne 1, en clair** : en-tête JSON `{"f":"ct-j"|"ct-s"|"ct-state","sm":1,"kid":"<16 hexa>","dev":"<uuid>","e":"e0001-<uuid>","n":<numéro de segment ou d'instantané, absent pour state>}` ;
- **lignes suivantes** : un enregistrement chiffré par ligne, `<sm>.<sv>.<base64url(nonce 12 octets ‖ texte chiffré ‖ étiquette 16 octets)>`.

`sm` = version **majeure** du format de synchro (`SYNC_FORMAT_MAJOR`, 1 au départ) ; `sv` = `schema_version` de l'écrivain = numéro de la dernière migration appliquée (14 aujourd'hui). Les deux sont en clair pour qu'un appareil sache **avant de déchiffrer** s'il peut lire (Y-07), et protégés par l'AAD.

Une ligne sans `\n` final, ou dont le déchiffrement échoue alors qu'elle est la dernière du fichier, est une **ligne incomplète** (iCloud en cours de transfert) : la lecture s'arrête avant elle, le curseur n'avance pas, elle sera relue au cycle suivant (PRD 10). Un échec de déchiffrement au milieu d'un fichier est une **corruption** : la lecture de cet appareil est suspendue (état `error`, détail dans le journal technique), rien n'est appliqué au-delà.

#### 1.3 Segments, rotation, tailles

- Un segment est en **ajout seul** : ouverture en ajout, écriture des lignes, `sync_all`. Il n'est jamais réécrit.
- Rotation : nouveau segment quand le segment courant dépasse **1 Mio**, à chaque nouvelle époque, et **à chaque démarrage de session de synchro après une restauration ou une reprise** (règle 1 de l'ADR 0010 : on n'ajoute jamais à un segment dont l'état publié pourrait être plus récent que la base locale).
- Enregistrement : au plus **256 Kio** de texte clair (lot d'opérations, section 3). Un segment lu de plus de 8 Mio, un instantané de plus de 256 Mio sont refusés (`too-large`).
- `state.ctx` et les instantanés sont écrits dans `<nom>.tmp` du même dossier puis renommés (remplacement atomique) ; les lecteurs ignorent les `.tmp`.

#### 1.4 État publié (`state.ctx`)

Texte clair de l'unique enregistrement chiffré (type `PublishedDeviceState`, section 11) : identifiant, plateforme (`windows` / `ios`), version de l'app, `sm`, `sv`, époque courante, **tête publiée** (`segment`, `record` = nombre d'enregistrements, `hlc` maximal publié), **accusés de lecture** par appareil distant (époque, segment, enregistrement, plus grand hlc lu), dernier instantané écrit, `purgeHorizon` (plus grand hlc de suppression déjà purgé, section 5.4), `lastSyncHlc` (fin du dernier cycle complet), `pairedBy` (Y-06).

Ordre d'écriture d'un cycle : segments d'abord, `state.ctx` ensuite. Un lecteur ne considère comme publié que ce que la tête annonce ; si le segment local contient moins d'enregistrements que la tête, le fichier n'est pas encore arrivé : état « En attente d'iCloud ».

#### 1.5 Ce que voit un tiers qui accède au dossier

Il voit : le nombre d'appareils et leurs UUID, les numéros d'époque, de segment et d'instantané, la taille et la date de modification des fichiers (donc le rythme d'activité), `sm`, `sv` et l'identifiant de clé `kid` (dérivé, ne révèle rien de la clé). Il ne voit pas : titres, notes, dates, noms de tables, nombre d'éléments par type, noms des appareils. Il ne peut ni modifier, ni réordonner, ni déplacer un enregistrement d'un fichier ou d'une position à une autre sans être détecté (AAD) ; il peut **supprimer** des fichiers ou tronquer la fin d'un segment : la tête publiée le révèle (état « En attente d'iCloud » durable), sans perte locale.

### 2. Chiffrement (Y-08)

- **Clé maîtresse** `K` : 32 octets aléatoires (`aws_lc_rs::rand::SystemRandom`), créée une seule fois, sur le premier appareil associé au dossier (section 10.3).
- **Dérivation** : HKDF-SHA256 (`aws_lc_rs::hkdf`), sel `"circletasks"` ; `K_rec = HKDF(K, info="ct/1 records")` (32 octets) chiffre tous les fichiers, l'AAD distingue leur nature ; `kid = hex(HKDF(K, info="ct/1 kid")[0..8])`.
- **Algorithme** : AES-256-GCM (`aws_lc_rs::aead::AES_256_GCM`), **nonce aléatoire de 96 bits par enregistrement** (pas de nonce compteur : une base restaurée ou une réinstallation ne peut pas réutiliser un nonce). Volume attendu très inférieur à 2^32 enregistrements par clé.
- **AAD** (UTF-8) :
  - journal : `ct/1|j|<device_id>|<époque>|<segment>|<index de l'enregistrement>|<sm>|<sv>` ;
  - instantané : `ct/1|s|<device_id>|<époque>|<numéro>|<index>|<sm>|<sv>` ;
  - état : `ct/1|state|<device_id>|<sm>|<sv>`.
  Le lecteur reconstruit l'AAD depuis le chemin, l'en-tête et la position : un enregistrement déplacé, réordonné ou recopié dans un autre fichier ne se déchiffre pas.
- **Bibliothèque** : crate `aws-lc-rs` 1, **déjà compilée** sur Windows et iOS (fournisseur de `rustls` via `reqwest`, `cargo tree -i aws-lc-rs` sur les deux cibles) ; ajoutée en dépendance directe sans nouvelle entrée dans `Cargo.lock`, licence ISC / Apache-2.0, coût binaire négligeable. Écartées : `aes-gcm` + `hkdf` de RustCrypto (six crates nouvelles pour un service déjà présent) ; Web Crypto dans la WebView (clé exposée à la WebView, voir section 0). Les tests Vitest utilisent un **codec de référence TypeScript** (`tests/sim/syncCodec.ts`, Web Crypto de Node) qui doit produire et lire les mêmes vecteurs que Rust (`tests/fixtures/sync/vectors.json`, vérifiés par `cargo test` ET Vitest) ; ce codec n'est jamais embarqué.
- **Coffre** : `src-tauri/src/calendars/vault.rs` est déplacé en `src-tauri/src/vault.rs` (réexporté pour les agendas, sans changement de comportement) ; entrée `service = fr.circletasks.planner`, `account = circletasks.sync.key.v1`, valeur = `K` en base64. Windows : Gestionnaire d'identification (`keyring` `windows-native`, déjà présent) ; iOS (ordre 5) : Trousseau (`keyring` `apple-native`, déjà présent). **Jamais** dans SQLite, dans iCloud, dans les journaux techniques ni dans l'état de l'interface. La WebView n'a aucune commande qui renvoie `K`, sauf `sync_pairing_payload` (affichage volontaire, section 10.3).
- **Clé de secours** (imprimable) : `K` + 2 octets de contrôle (`SHA-256(K)[0..2]`), en base32 Crockford, groupes de 5 caractères préfixés `CT1-` (55 caractères utiles). Saisie tolérante (casse, espaces, tirets, `O`/`0`, `I`/`L`/`1`). Décodage et contrôle en Rust uniquement.
- **Clé différente** : un fichier dont le `kid` d'en-tête diffère du `kid` local n'est pas déchiffré ; état `key-mismatch` (« Ce dossier a été chiffré avec une autre clé : associez cet appareil »).
- **Rotation de clé** : seulement par **nouvelle époque** (section 9) avec une nouvelle `K`, quand un appareil sans clé valide doit repartir d'un dossier illisible (clé perdue sur tous les appareils, sans clé de secours). Il n'y a pas d'écran « Changer la clé » à l'ordre 4 (aucune story ne le demande, voir questions ouvertes). Les fichiers de l'ancienne clé deviennent illisibles et sont purgés par leurs écrivains ; les autres appareils doivent être réassociés par QR.

### 3. Contenu des journaux

#### 3.1 Enregistrement et opérations

```ts
/** Texte clair d'un enregistrement de journal (src/domain/sync/format.ts). */
interface JournalRecord {
  readonly k: 'ops';
  readonly sv: number;                       // schema_version de l'écrivain (redondant avec l'AAD, vérifié égal)
  readonly ops: readonly SyncOp[];           // ordre de publication ; parents avant enfants (section 3.3)
}
interface SyncOp {
  readonly t: SyncTableName | string;        // table ; chaîne libre pour une table inconnue (Y-07)
  readonly id: string;                       // id de la ligne ; pour settings, la clé du réglage
  readonly at: IsoDateTime;                  // updated_at de l'écriture la plus récente de l'opération
  readonly f: Readonly<Record<string, SyncField>>;
}
/** [valeur, hlc de la valeur, hlc de la valeur remplacée (base) ou null si inconnue]. */
type SyncField = readonly [value: SqlValue, hlc: Hlc, base: Hlc | null];
```

- **Upsert par champ, hlc par champ.** Une opération ne porte que les colonnes publiées modifiées (toutes à la création). Les colonnes techniques `updated_at`, `device_id`, `hlc` ne circulent pas comme champs : après fusion, `hlc` de la ligne = plus grand hlc de ses champs, `updated_at` et `device_id` = ceux de l'opération qui porte ce hlc. `created_at` est un champ ordinaire.
- **Suppression** = champ `deleted_at` (valeur non nulle) ; **restauration** = `deleted_at` à `null` avec un hlc plus récent. Pas d'opération « delete » : une trace de suppression est une ligne dont `deleted_at` gagne. La purge physique ne circule jamais (section 5.4).
- **Base** : hlc de la valeur que l'écrivain a remplacée, telle qu'il la connaissait avant sa première modification non publiée. Elle sert uniquement à détecter un conflit (section 4.2).

#### 3.2 Capture des écritures locales (file d'envoi)

Les repositories ne savent pas quels champs ont changé ; la capture est faite par **déclencheurs SQL** générés depuis le catalogue (`syncTables.ts`) dans la migration `0015_sync_tables` :

- `AFTER INSERT` : une entrée `(table, id, '*')` dans `sync_outbox` (« toutes les colonnes publiées »).
- `AFTER UPDATE` : pour chaque colonne publiée `c` telle que `OLD.c IS NOT NEW.c`, une entrée `(table, id, c)` dans `sync_outbox` et la mise à jour de l'horloge du champ dans `sync_field_clock` (`hlc = NEW.hlc` ; `base_hlc` = hlc précédent du champ, sauf si le champ est déjà en attente dans la file, auquel cas la base d'origine est gardée). Avant la première horloge de champ d'une ligne, une entrée `'*'` = `OLD.hlc` fige la valeur de repli des autres champs.
- Les déclencheurs ne s'exécutent pas quand une ligne existe dans `sync_guard` : la synchro, les migrations et la purge posent ce garde dans leur transaction (les écritures venues d'ailleurs ne repartent pas ; une migration est rejouée à l'identique sur chaque appareil).
- **Horloge d'un champ** = `sync_field_clock[(table, id, champ)]` sinon `sync_field_clock[(table, id, '*')]` sinon `hlc` de la ligne. Aucune reprise de données : une base de l'ordre 3 a déjà ses hlc de ligne.
- Les déclencheurs de recherche (migration 0011) ne sont pas gardés : ils s'exécutent aussi pour les écritures de la synchro (avenant RC-01 de l'ADR 0002).
- Les nouveaux déclencheurs sont ajoutés à `REFERENCE_TRIGGERS` (`src-tauri/src/backup_triggers.rs`, contrôle des bases restaurées, ADR 0009) et au test `triggers.test.ts`.

La file `sync_outbox` est la **file locale du hors ligne** (Y-05) : elle survit aux redémarrages et n'est vidée qu'après l'écriture et le `sync_all` du segment qui la publie (section 10.2).

#### 3.3 Ordre et idempotence

- Publication : les entrées de la file sont regroupées par ligne (une opération par ligne, champs fusionnés, valeur courante relue en base au moment de publier), ordonnées par **ordre topologique des tables** (`space`, `project`, `recurrence`, `goal`, `task`, `routine`, `routine_log`, `routine_pause`, `reminder`, `event`, `checklist`, `checklist_item`, `focus_session`, `calendar_account`, `holiday`, `settings`) puis par plus grand hlc. Le plus grand hlc d'un enregistrement est donc croissant dans le journal d'un appareil ; un accusé « plus grand hlc lu de l'appareil X » signifie « tout ce que X a écrit jusqu'à ce hlc est lu ».
- Application : un champ dont le hlc est **inférieur ou égal** à l'horloge locale du champ ne change rien. Rejouer un enregistrement, un segment ou un instantané déjà appliqué est sans effet. L'ordre entre appareils est indifférent (fusion commutative, section 4).
- Clés étrangères : application dans une transaction avec `PRAGMA defer_foreign_keys = ON`. Une opération dont le parent manque encore au moment du `COMMIT` (parent publié par un troisième appareil pas encore lu) est mise de côté dans `sync_parked` (opération complète, motif), retentée à chaque cycle, jamais perdue ; si son parent est une trace purgée (section 5.4), elle est abandonnée et journalisée.
- Valeur refusée par une contrainte locale (`CHECK` d'une version plus ancienne) : le champ est rangé dans `sync_unknown` comme un champ inconnu (Y-07, section 7.2), l'opération continue pour les autres champs.

#### 3.4 Curseurs de lecture

Table locale `sync_state`, une ligne par appareil (distant ou soi-même, `is_self`) :

| Colonne | Rôle |
| --- | --- |
| `device_id`, `platform`, `app_version` | Identité publiée (le nom affiché est dérivé de la plateforme : « PC », « iPhone », suivi des 4 premiers caractères de l'id si deux appareils ont la même plateforme) |
| `epoch` | Époque courante de l'appareil |
| `cursor_segment`, `cursor_record` | **Curseur de lecture** de cet appareil (le `last_cursor_other` du PRD) |
| `ack_hlc` | Plus grand hlc lu de cet appareil |
| `head_segment`, `head_record`, `head_hlc` | Dernière tête publiée vue |
| `last_seen_hlc`, `last_sync_at` | `lastSyncHlc` publié par l'appareil ; heure locale du dernier cycle réussi (soi-même) |
| `schema_version`, `format_major` | `sv` et `sm` publiés |
| `status` | `active`, `expired` (section 5.5), `newer-major` (Y-07), `clock-ahead` (section 4.4), `corrupt` |

Le curseur et les lignes appliquées sont écrits **dans la même transaction** : un arrêt brutal rejoue au pire le dernier lot, sans effet (idempotence). La colonne `folder_bookmark_ref` du PRD 6 n'existe pas : le dossier choisi est gardé par Rust (section 6.1).

### 4. Fusion et conflits (Y-04)

#### 4.1 Dernier hlc gagnant, par champ

Pour chaque champ reçu `(v_r, h_r, b_r)` et le champ local `(v_l, h_l)` : si `h_r > h_l`, la valeur distante est écrite et l'horloge du champ devient `h_r` ; sinon rien. Les hlc sont des chaînes de largeur fixe (ADR 0005) : comparaison de chaînes, l'UUID de l'appareil départage. La fusion est **par champ**, jamais par ligne : deux appareils qui modifient deux champs différents d'une même tâche gardent les deux modifications. Deux champs liés (date et heure) peuvent ainsi se combiner ; c'est la règle du PRD, assumée.

`routine_log` « s'additionne » (PRD 7) grâce à l'identifiant déterministe `(routine_id, date)` (section 8) : deux validations du même jour sont la même ligne, deux jours différents sont deux lignes ; décocher sur un appareil et cocher sur l'autre se départage par hlc sur `deleted_at`.

#### 4.2 Ce qui est un conflit

Il y a **conflit** quand deux appareils ont modifié **le même champ** sans avoir vu la modification de l'autre **et** avec des valeurs différentes :

- valeur distante gagnante (`h_r > h_l`) : conflit si `b_r ≠ h_l` et `v_r ≠ v_l` (l'autre appareil a écrasé une valeur qu'il ne connaissait pas) ;
- valeur locale gagnante (`h_r < h_l`) : conflit si `base_local ≠ h_r` et `v_r ≠ v_l` (`base_local` = `sync_field_clock.base_hlc` du champ local).

Une modification qui succède à une valeur connue (`base = h` de la valeur remplacée) n'est jamais un conflit. Les deux appareils détectent le même conflit et l'inscrivent chacun dans leur `conflict_log` local (même valeur gardée, même valeur écartée) : la propriété est testée (section 12).

Cas particulier, **modification d'un élément supprimé ailleurs** : la suppression gagne si son hlc est le plus élevé (règle ordinaire sur `deleted_at`), les autres champs modifiés sont quand même fusionnés dans la ligne supprimée (rien n'est perdu : visible dans la corbeille pendant 30 jours) et un conflit est inscrit sur le champ `deleted_at` (valeur gardée « supprimé », valeur écartée « modifié ») ; « Restaurer » = restaurer l'élément (`deleted_at = null`, nouveau hlc).

Champs **non montrés** dans le journal des conflits (fusionnés par hlc, mais un conflit sur eux n'apprend rien à l'utilisateur) : `sort_order`, `created_at`, `done_at` (suit `status`), `fire_at`, `delivered`, `paused_sec`, `paused_at`, `series_template`. La liste vit dans le catalogue (`syncTables.ts`, drapeau `conflictVisible`) ; toute modification passe par l'architecte.

#### 4.3 Conservation de la valeur perdue et restauration

`conflict_log` (table locale) : `id`, `table_name`, `row_id`, `field`, `kept_value`, `discarded_value` (JSON), `kept_device`, `discarded_device`, `kept_hlc`, `discarded_hlc`, `detected_at`, `resolved_at` (NULL), `restored` (0/1). L'écran lit le titre de l'élément au moment de l'affichage (élément supprimé ou purgé : « Élément supprimé »), le champ par une clé i18n (`sync.field.<table>.<colonne>`), la date et l'appareil de chaque valeur depuis son hlc (heure locale, format 24 h ou P-03).

« Restaurer » (un clic) = **nouvelle écriture locale** de la valeur écartée, par le `WriteStamper` (base = horloge courante du champ : l'autre appareil ne verra pas de nouveau conflit), dans une transaction qui pose `restored = 1` et `resolved_at`. Refusé avec message si la ligne a été purgée. La restauration est elle-même annulable (`UndoKind` `syncRestore`, ADR 0005). Conservation : 12 mois glissants, purge au démarrage.

#### 4.4 Dérive d'horloge

`HLC_MAX_DRIFT_MS = 3 600 000` (1 h), dans `src/domain/sync/drift.ts`. Un enregistrement distant dont un hlc dépasse `now + 1 h` (horloge locale) n'est **pas appliqué** : la lecture de cet appareil s'arrête avant lui (curseur inchangé), son `status` devient `clock-ahead` et l'écran de synchro affiche « L'horloge de {appareil} est en avance : vérifiez sa date et son heure ». La lecture reprend d'elle-même quand la condition n'est plus vraie. `HlcClock.receive()` n'est appelé qu'après ce contrôle : un hlc aberrant ne peut plus geler l'horloge locale (dette de l'ADR 0005 soldée). Rien ne bloque la publication locale.

### 5. Instantanés et rétention (Y-02, Y-09)

#### 5.1 Contenu

Un instantané `s-<n>.cts` est une suite d'enregistrements chiffrés (même ligne qu'un journal) :

- `{"k":"snap-rows","t":<table>,"rows":[…]}` (500 lignes au plus) : toutes les colonnes publiées de chaque ligne, **lignes supprimées comprises**, et ses horloges de champ (entrée `'*'` plus les exceptions) ;
- `{"k":"snap-unknown",…}` : champs inconnus conservés (Y-07) ;
- `{"k":"snap-tombstones","ids":[[table, id, hlc]…]}` : identifiants purgés (section 5.4) ;
- `{"k":"snap-end","count":N,"covers":{<device_id>:{segment,record,hlc}},"epoch":…,"sv":…}` en dernier. Sans enregistrement de fin valide, l'instantané est incomplet (en attente d'iCloud) et ignoré.

`covers` = position, pour chaque appareil, jusqu'à laquelle les journaux sont inclus.

#### 5.2 Quand et par qui

À la fin d'un cycle complet, un appareil écrit un instantané si **aucun instantané de l'époque courante n'a moins de 7 jours** (date tirée du hlc de fin) et qu'il a lu tous les appareils actifs jusqu'à leur tête. Deux appareils peuvent en écrire un en même temps : sans danger. Écriture par pages (`sync_snapshot_begin` / `append` / `commit`, fichier `.tmp` renommé à la fin). Un instantané est aussi écrit à l'ouverture d'une nouvelle époque (section 9). Chaque appareil garde ses **2 derniers** instantanés par époque.

#### 5.3 Purge des journaux

Un appareil supprime **ses propres** segments `j-n` quand les trois conditions sont vraies : un instantané de l'époque (de n'importe quel appareil) le couvre (`covers`) ; tous les appareils **actifs** ont accusé sa lecture ; son dernier enregistrement a plus de **30 jours**.

#### 5.4 Traces de suppression (Y-09)

- Une ligne dont `deleted_at` est posé reste en base (trace complète) tant que **tous les appareils actifs** n'ont pas lu la suppression (accusé `ack_hlc` de l'écrivain ≥ hlc de `deleted_at`), **puis 30 jours**. Alors seulement elle est purgée physiquement (garde posé), avec ses horloges de champ et ses entrées de file.
- À la purge, l'identifiant est inscrit dans `sync_tombstone (table_name, row_id, deleted_hlc, purged_at)`, **sans aucun contenu**, et gardé **sans limite de durée** (quelques dizaines d'octets par élément). Toute opération qui vise un identifiant de `sync_tombstone` est ignorée : aucun appareil en retard, aucune base restaurée ne peut ressusciter un élément purgé. La liste est incluse dans chaque instantané.
- `purgeHorizon` publié = plus grand `deleted_hlc` purgé par l'appareil (sert à la règle 4 de l'ADR 0010).
- **Purge de la corbeille (T-08)** : `TaskRepository.purgeDeletedBefore` (DELETE physique à 30 jours, `taskRepository.ts`) est conservé mais doit passer par la règle ci-dessus : le cas d'usage reçoit l'horizon de purge de la synchro (`+∞` si la synchro n'est pas configurée), la suppression physique s'exécute sous `sync_guard` et inscrit les identifiants dans `sync_tombstone` dans la même transaction. Le moteur purge de la même façon les autres tables (aujourd'hui, seules les tâches et leurs rappels sont purgés).

#### 5.5 Appareils inactifs, reprise depuis l'instantané

- Un appareil dont `lastSyncHlc` a plus de **180 jours** est `expired` : il ne compte plus dans les accusés (sa présence ne bloque plus aucune purge).
- Un appareil qui revient **repart de l'instantané** si son propre dernier cycle a plus de 180 jours ou si un segment dont il a besoin n'existe plus. Reprise (`snapshot.ts`, mode **fusion**) : il garde sa file d'envoi, remet ses curseurs à zéro, applique le dernier instantané de l'époque par la fusion ordinaire (section 4 ; les identifiants purgés retirent ses lignes), puis lit les journaux depuis `covers`, puis publie sa file. Les éléments supprimés ailleurs ne réapparaissent pas : leur trace ou leur identifiant purgé gagne.
- **Nouvel appareil** (Y-06) : même chemin depuis une base vide, avec progression affichée (enregistrements lus / total annoncé par `snap-end`, puis journaux).

### 6. Téléchargement forcé avant lecture

#### 6.1 Dossier (Y-01)

- PC : `sync_folder_choose` ouvre la boîte de choix de dossier **côté Rust** (`tauri-plugin-dialog`, déjà présent, aucune permission `dialog:` pour la WebView), dossier proposé `%USERPROFILE%\iCloudDrive\CircleTasks` (créé s'il n'existe pas et si l'utilisateur le valide). Chemin à lettre de lecteur seulement (`is_local_disk_path` de `export.rs`), pas de lien ni de point d'analyse (`is_plain_dir`).
- Le chemin est gardé par Rust dans `<dossier de configuration de l'app>/sync/folder.json` : **la WebView ne reçoit ni n'envoie jamais de chemin**, seulement un libellé (« iCloud Drive / CircleTasks », ou le nom du dossier). Choix mémorisé après redémarrage (critère Y-01). L'iPhone garde un signet de sécurité dans le plugin folder-bookmark (ordre 5).
- Détection iCloud : `CfGetSyncRootInfoByPath` ; si le dossier n'est pas sous une racine de synchronisation dont le fournisseur est iCloud, il est accepté (tests, dossier local) avec l'avertissement « Ce dossier n'est pas dans iCloud Drive : vos appareils ne le partageront pas ».
- **« Toujours conserver sur cet appareil »** : au choix du dossier puis à chaque cycle, `CfSetPinState(CF_PIN_STATE_PINNED, CF_SET_PIN_FLAG_RECURSE)` sur `CircleTasks` (sans effet hors iCloud). Un échec est journalisé, la lecture forcée ci-dessous reste la garantie.

#### 6.2 Windows (iCloud pour Windows, fichiers à la demande, cfapi)

Dans `cloud_windows.rs` (`#[cfg(windows)]`), crate `windows` déjà présente, fonctionnalités ajoutées `Win32_Storage_CloudFilters` et `Win32_Storage_FileSystem` :

1. **Détection** : `GetFileAttributesW` ; un fichier qui porte `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`, `FILE_ATTRIBUTE_RECALL_ON_OPEN` ou `FILE_ATTRIBUTE_OFFLINE` n'est pas sur le disque.
2. **Hydratation** : `CfHydratePlaceholder` (fichier entier) sur un fil bloquant (`spawn_blocking`), délai **60 s par fichier** et 3 minutes par cycle ; en repli, lecture ordinaire du fichier (qui déclenche le rappel des données).
3. **Erreurs** : délai dépassé ou réseau indisponible → `cloud-pending` ; fournisseur arrêté (`ERROR_CLOUD_FILE_PROVIDER_NOT_RUNNING`) → `cloud-provider-stopped` (« Ouvrez iCloud pour Windows ») ; autres erreurs cloud → `cloud-error`. Aucune n'est fatale : le cycle saute ce fichier, applique ce qui est lisible, et l'état « En attente d'iCloud » (A-09) liste les fichiers concernés (maquette Synchro.html).
4. Les dossiers sont énumérés normalement (l'énumération peuple les placeholders de dossier) ; un fichier qui n'est pas encore apparu dans l'espace de noms local est simplement absent (tête publiée non atteinte → « En attente d'iCloud »).

#### 6.3 iOS (ordre 5, contrat)

Plugin Swift `src-tauri/plugins/folder-bookmark/` : choix du dossier (`UIDocumentPickerViewController`, mode dossier), signet de sécurité persistant, et **toutes** les opérations de fichier (lister, lire à partir d'un octet, ajouter, écrire puis renommer, supprimer) sous `startAccessingSecurityScopedResource` et `NSFileCoordinator` ; avant lecture : `FileManager.startDownloadingUbiquitousItem(at:)` puis attente de `ubiquitousItemDownloadingStatus == .current` (même délai de 60 s, mêmes codes d'erreur). Rust appelle le plugin à travers le trait `SyncFs` (`files.rs`) : implémentation `StdFs` + `cloud_windows` sur PC, `BookmarkFs` sur iOS ; le chiffrement et les noms restent dans Rust, identiques sur les deux plateformes. Aucun entitlement iCloud (PRD 7).

#### 6.4 Partage Rust / TypeScript

Rust : chemin, hydratation, I/O, chiffrement, noms, coffre, QR, marqueur. TypeScript : tout le reste. La frontière est le contrat `SyncPlatform` (section 11) : du **texte clair JSON** circule par l'IPC (pages de 2 Mio au plus), jamais de clé ni de chemin.

### 7. Hors ligne et versions

#### 7.1 Hors ligne (Y-05)

Toute écriture locale reste dans `sync_outbox` jusqu'à sa publication ; un cycle qui échoue (dossier injoignable, iCloud arrêté, fichiers dans le nuage) ne vide rien. Sur PC le dossier est local : la publication réussit même sans réseau, iCloud envoie plus tard. Sur iPhone sans dossier joignable, la file attend. À la reprise, publication puis lecture ; « aucune perte » est vérifié par les propriétés de la section 12.

#### 7.2 Versions de schéma (Y-07)

- `sv` (numéro de migration) varie à chaque migration ; `sm` (majeure) ne change que si une migration **retire, renomme ou change le sens** d'une colonne ou d'une table publiée, ou si le format des fichiers change. Une migration additive (colonne, table, valeur d'énumération) garde `sm`. Un test (`syncCatalogue.test.ts`) compare le catalogue à `PRAGMA table_info` : retirer une colonne publiée sans changer `SYNC_FORMAT_MAJOR` échoue.
- Lecture d'un enregistrement de **même `sm`** et de `sv` plus grand : les champs et tables connus sont appliqués ; les champs inconnus (colonne absente, table absente, valeur refusée par une contrainte locale) vont dans `sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv)` avec la même règle de hlc : rien n'est effacé, ils repartent dans les instantanés de cet appareil. Bandeau « Mettez à jour l'app » (texte i18n) tant qu'un appareil actif publie un `sv` supérieur.
- Après la mise à jour de l'app, à la fin de `migrate()`, les champs de `sync_unknown` devenus connus sont réintégrés (sous garde, règle de hlc ordinaire) puis retirés de la table.
- Lecture d'un appareil de **`sm` supérieur** : lecture de cet appareil suspendue (curseur figé, `status = newer-major`), message « Mettez à jour l'app pour lire les données de {appareil} ». La publication locale continue. Un appareil plus récent lit toujours les majeures plus anciennes (obligation de compatibilité ascendante de chaque version).

### 8. Données exclues de la synchro et cas particuliers (dettes de l'ordre 4)

Catalogue `src/domain/sync/syncTables.ts` (seule source, utilisé par les déclencheurs, la publication, l'application et les instantanés). Tables **publiées** : `space`, `project`, `recurrence`, `goal`, `task`, `routine`, `routine_log`, `routine_pause`, `reminder`, `event`, `checklist`, `checklist_item`, `focus_session`, `calendar_account`, `holiday`, `settings` (réglages partagés seulement).

| Dette (docs/dettes.md, ordre 4) | Décision |
| --- | --- |
| `task.discarded` | **Colonne locale**, jamais publiée (avenant T-12). Conséquence acceptée : si une copie est publiée puis écartée dans les 5 s, l'autre appareil la voit dans sa corbeille (restaurable), jusqu'à la purge. |
| `external_event` (et `task.external_event_id`) | Table **locale** (sans colonnes de synchro), relue par chaque appareil depuis ses comptes. `task.external_event_id` est publié : l'identifiant est déterministe (ADR 0008) et se résout sur tout appareil connecté au même compte, sinon « Événement supprimé ». |
| Réglages locaux | Les clés de portée `local` de `SETTINGS_DEFINITIONS` ne sont **jamais** publiées (dont `device.id`, `onboarding.*`, `sample.ids`, `search.recent`, `spaces.filter`, `ui.*`, `view.compact`, `general.timeZone`, `desktop.*`, `shortcut.*`, `focus.*`). Les clés `shared` sont publiées (table `settings`, `id` = clé, un champ `value`). Une clé inconnue reçue d'une version plus récente est gardée telle quelle (elle ne peut être que partagée). |
| `calendar_account.token_ref` (constat de cet ADR) | **Colonne locale** : la référence du coffre est propre à l'appareil (K-01 D1). Publiée, elle écraserait celle de l'autre appareil. Une ligne reçue sans elle prend `''` (« à reconnecter »). |
| `sample.ids` | Reste **local**. Après association, seul l'appareil qui a créé les données d'exemple propose de les supprimer ; ailleurs elles se suppriment comme des éléments ordinaires. |
| `search_index`, `search_index_doc` | **Locales**, jamais publiées ; mises à jour par leurs déclencheurs pendant l'application des opérations (avenant RC-01 de l'ADR 0002), reconstruites si besoin (`SearchRepository.isStale`). |
| `series_index = -1` | Entier **ordinaire**, publié tel quel (avenant T-09 de l'ADR 0004) : l'occurrence annulée reste exclue de la corbeille sur tous les appareils. Aucune contrainte `CHECK (series_index >= 0)`. |
| `routine.paused` | **Colonne dérivée, non publiée.** Après chaque lot appliqué, `repairs.ts` recalcule `paused = existe une période ouverte et non supprimée dans routine_pause` ; seule `routine_pause` est fusionnée (avenant R-05). |
| `holiday` (fêtes lunaires) | **Identifiant déterministe** `holiday|<pays>|<année>|<clé>` (`naturalIds.ts`) ; `holidayUseCases.ts` cesse d'utiliser `newEntityId` ; migration `0016_sync_natural_ids` réécrit les identifiants existants en SQL pur. La règle E-03 reste vraie par la fusion : une saisie manuelle porte un hlc plus récent que la ligne de table ; `ensureHolidayTable` ne réécrit jamais une ligne `overridden`. |
| `routine_log` (constat de cet ADR) | **Identifiant déterministe** `rlog|<routine_id>|<date>` (même migration, même module) : sans lui, deux validations du même jour sur deux appareils violeraient `UNIQUE (routine_id, date)`. |
| Une seule session Focus active | Après chaque lot appliqué, si plusieurs `focus_session` non supprimées ont `ended_at IS NULL`, toutes sauf la plus récente (`started_at`, puis hlc) reçoivent `ended_at` = `started_at` de la plus récente, par une **écriture locale** (publiée). La valeur étant déterministe, deux appareils qui réparent en même temps écrivent la même valeur : pas de conflit. |
| Corbeille (`trashStore.ts`, copies hors `taskEntities`) | Le moteur émet `onRemoteChanges({ tables, ids })` après chaque lot (section 11) ; `trashStore` recharge si `task` est touchée, `taskEntities` reçoit les tâches relues (règle « un hlc inférieur n'écrase jamais », avenant T-04 de l'ADR 0004), les autres stores rechargent leurs listes. Les commandes d'annulation restent protégées par leur contrôle de hlc (`'stale'`). |
| Purge physique et traces | Section 5.4 : purge seulement quand tous les appareils actifs ont lu la suppression, puis 30 jours ; identifiant inscrit dans `sync_tombstone` dans la même transaction. |
| Limite de dérive du hlc | Section 4.4 : 1 h. |
| Bandeaux A-09 | `syncing` posé par le moteur pendant un cycle qui lit ou écrit (pas pendant un cycle vide de moins de 1 s) ; `waitingIcloud` posé tant qu'un fichier attendu est dans le nuage ou qu'une tête publiée n'est pas atteinte ; priorité existante (`APP_STATUS_PRIORITY`). |
| Restauration P-04 | Section 9. |

Les tables techniques de cet ADR (`sync_field_clock`, `sync_outbox`, `sync_guard`, `sync_state`, `sync_tombstone`, `sync_unknown`, `sync_parked`, `conflict_log`) sont **locales**.

### 9. Époques et règles de l'ADR 0010

Une **époque** est identifiée par `e<n>-<device_id qui l'ouvre>` (ordre : `n`, puis l'UUID). L'époque 1 est ouverte par le premier appareil associé. L'époque courante du dossier est la plus grande époque annoncée par un `state.ctx` et dotée d'un instantané complet. Les journaux des époques antérieures sont ignorés.

| Règle ADR 0010 | Application |
| --- | --- |
| 1. L'état publié fait foi | À chaque cycle, avant toute publication : lecture de son propre `state.ctx` (et, s'il manque, liste de ses segments) ; `HlcClock.receive(head.hlc publié)` (après le contrôle de dérive) ; le prochain segment est `max(local, publié) + 1` (section 1.3). Un numéro de segment ou d'enregistrement publié n'est jamais réutilisé. |
| 2. Marqueur durable | `restore_backup` (`backup.rs`) écrit, **après un échange abouti et seulement si un dossier de synchro est configuré**, `<dossier de configuration>/restore-marker.json` : `{ "v": 1, "backup": <nom>, "backupTakenAt": <ISO, d'après le nom ou l'heure du fichier>, "restoredAt": <ISO>, "schemaVersion": <n> }` (écriture `.tmp` + renommage). Lu par `sync_restore_marker_get`, supprimé par `sync_restore_marker_clear` **seulement après** que le choix de la règle 3 est entièrement appliqué. Une restauration interrompue puis récupérée au démarrage n'a pas de marqueur (ADR 0010). |
| 3. Pas de synchro automatique, choix explicite | Tant que le marqueur existe : aucun cycle (ni lecture ni publication), état `restore-choice`, fenêtre de choix (texte `src/i18n`, rattachée à Y-02) : **« Appliquer cette version sur tous mes appareils »** : règle 1, ouverture de l'époque `n+1` par cet appareil, file d'envoi vidée (l'instantané contient tout), instantané complet de la base restaurée, nouvel `state.ctx`. **« Garder les données synchronisées »** : curseurs remis à zéro et reprise depuis le dernier instantané en mode fusion (section 5.5) ; la copie `circletasks-pre-restore-…` reste disponible. |
| — Changement d'époque sur les autres appareils | En voyant une époque plus récente : (a) leur file d'envoi est **matérialisée** (valeurs, horloges et bases des champs en attente) ; (b) sous garde, les tables publiées, horloges de champ, `sync_tombstone` et `sync_unknown` sont **remplacées** par l'instantané de la nouvelle époque (pas de fusion : la version restaurée porte des hlc anciens et perdrait) ; (c) les écritures matérialisées sont réappliquées par la règle de hlc et remises dans la file ; (d) publication dans la nouvelle époque. Écart de formulation assumé avec l'ADR 0010 (« publient d'abord leurs écritures non publiées ») : publiées dans l'ancienne époque, elles seraient ignorées ; elles sont donc republiées dans la nouvelle, ce qui donne le résultat voulu. |
| 4. Âge de la version | Si `backupTakenAt` est antérieur au plus grand `purgeHorizon` publié par les appareils (une suppression postérieure à la version a déjà été purgée), seule l'option « Appliquer sur tous mes appareils » est proposée. |
| 5. Identité de l'appareil | Sans effet tant que P-04 ne restaure que le dossier `backups/` de l'appareil. Toute future restauration d'un fichier venu d'ailleurs créera un nouveau `device.id` avant toute écriture (avenant obligatoire). |
| 6. Données locales | Réglages locaux et `sync_state` sont restaurés avec la base ; la règle 1 les rend inoffensifs. `search_index` et `external_event` se reconstruisent comme d'habitude. |

Deux appareils qui ouvrent la même époque `n+1` en même temps : la plus grande (UUID) l'emporte, l'autre suit la procédure de changement d'époque comme un appareil ordinaire. Les dossiers d'époques antérieures sont supprimés par leur écrivain quand tous les appareils actifs annoncent la nouvelle époque, ou après 30 jours.

La feuille de restauration (P-04) affiche, quand un dossier est configuré, l'avertissement de l'ADR 0010 (« Cet appareil est associé : le choix vous sera demandé à la prochaine synchro »).

### 10. Déclenchement, appairage, état

#### 10.1 Déclenchement (Y-02, Y-03)

`scheduler.ts` : cycle à l'ouverture, toutes les **5 min** fenêtre visible (`visibilitychange`), au masquage de la fenêtre PC (fermeture vers la zone de notification) et avant « Quitter » (budget 5 s, puis sortie quoi qu'il arrive), au passage en arrière-plan sur iPhone (ordre 5) ; jamais en arrière-plan. Synchro manuelle : bouton « Synchroniser » (Réglages > Synchronisation, maquettes Reglages.html et Synchro.html) et entrée « Synchroniser maintenant » du menu de la zone de notification (libellé envoyé par `set_tray_labels`, événement `tray-sync-now`). Un seul cycle à la fois ; une demande pendant un cycle en programme un seul de plus.

#### 10.2 Cycle (`engine.ts`)

0. Préconditions : dossier configuré, clé présente, pas de marqueur de restauration (sinon état dédié, rien d'autre).
1. `scan()` : en-têtes, `state.ctx` des appareils (hydratés en premier), liste des fichiers et de leur état local / nuage.
2. Règle 1 (section 9).
3. Époque : changement d'époque si besoin (section 9).
4. Lecture : pour chaque appareil actif de l'époque dont la tête dépasse le curseur, pages d'enregistrements ; contrôle `sm`, dérive ; application par lots de 500 opérations au plus, une transaction par lot (fusion, conflits, curseur, puis réparations de la section 8 hors garde). Reprise depuis l'instantané si nécessaire (section 5.5).
5. Publication : file d'envoi → enregistrements → `appendJournal` (Rust chiffre, ajoute, `sync_all`) → retrait des entrées publiées de la file, dans une transaction. Un arrêt entre les deux republie les mêmes valeurs : sans effet chez les autres.
6. `writeState` (tête, accusés, époque, `purgeHorizon`, `lastSyncHlc`).
7. Entretien : instantané si dû, purge de ses segments et instantanés, purge des traces, purge du journal des conflits.
8. `onRemoteChanges` ; heure de dernière synchro ; à l'ordre 5, recalcul des rappels de l'iPhone (PRD 7).

Cibles : cycle sans changement < 300 ms hors hydratation ; nouvel appareil avec 5 000 tâches < 15 s sur PC (mesurées par des tests `@perf`).

#### 10.3 Appairage (Y-06)

- **Premier appareil** : au choix d'un dossier sans données CircleTasks, la clé est créée (`sync_key_create`) et l'époque 1 ouverte. Un dossier qui contient déjà des données chiffrées et un appareil sans clé : « Associez cet appareil » (QR ou clé de secours), jamais de nouvelle clé implicite.
- **PC, « Associer l'iPhone »** (maquette PC-Appairage.html) : `sync_pairing_payload` renvoie `qrText` = `CTPAIR1.<base64url(JSON { v:1, k:<clé base64url>, d:<device_id du PC>, e:<époque>, x:<expiration ms> })>`, la clé de secours et l'expiration (**5 minutes**, « Nouveau code »). QR dessiné par le paquet npm `qrcode` (PRD 7), **chargé à la demande** à l'ouverture de la fenêtre (hors démarrage, contrôlé par `test:bundle`). « Imprimer la clé de secours » : impression de la seule clé (`window.print` sur une vue dédiée). « En attente de l'iPhone… » : le PC rescanne le dossier toutes les 10 s pendant que la fenêtre est ouverte et annonce l'appareil dont `state.ctx` porte `pairedBy` = son id.
- Le QR contient la clé : ses 5 minutes sont une **durée d'affichage** et un contrôle à la réception (`sync_key_import` refuse si l'heure locale dépasse `x` de plus de 2 minutes), pas une protection cryptographique. L'avertissement de la maquette (« Ce code transmet la clé… ») est affiché.
- **iPhone, « Associer au PC »** (ordre 5, maquette Appairage.html) : scan (plugin barcode-scanner, ios-mobile), `sync_key_import({ qrText })`, choix du dossier, puis **nouvel appareil** (section 5.5) avec progression. Repli : saisie de la clé de secours (`sync_key_import({ recoveryKey })`), qui sert aussi à un second PC.
- **Appareil qui rejoint avec des données locales** (données d'exemple, usage avant association) : **fusion** (identifiants UUID distincts, espaces Pro / Perso aux identifiants fixes communs) ; rien n'est effacé.

#### 10.4 État affiché

`SyncStatus` (section 11) alimente : la ligne de Réglages (libellé du dossier, « À jour · il y a 2 min », appareil associé, nombre de conflits de la semaine) ; l'écran de détails (Synchro.html : état, « Synchroniser », « Associer », APPAREILS avec dernière lecture, fichiers en attente d'iCloud, JOURNAL DES CONFLITS) ; les bandeaux A-09 ; l'avertissement N-07 du PC (dernière synchro de l'iPhone, `sync_state.last_seen_hlc`).

### 11. Contrats

#### 11.1 Commandes Tauri (capability `src-tauri/capabilities/sync.json`, fenêtre `main`, Windows ; iOS ajouté à l'ordre 5)

Toutes rejettent `{ code, message }` (message sans chemin ni clé). Codes : `not-configured`, `folder-unreachable`, `not-local`, `cloud-pending`, `cloud-provider-stopped`, `cloud-error`, `vault-unavailable`, `key-missing`, `key-exists`, `key-mismatch`, `decrypt-failed`, `truncated`, `bad-name`, `too-large`, `newer-format`, `invalid-pairing`, `pairing-expired`, `not-bound`, `io`.

| Commande | Entrée | Sortie |
| --- | --- | --- |
| `sync_folder_info` | — | `SyncFolderInfo` |
| `sync_folder_choose` | — | `SyncFolderInfo` ou `null` (annulé) |
| `sync_folder_forget` | — | `null` |
| `sync_bind_device` | `deviceId` | `null` (fixe le seul dossier d'appareil où Rust accepte d'écrire) |
| `sync_key_status` | — | `{ present, kid }` |
| `sync_key_create` | — | `{ kid }` (`key-exists` si une clé existe) |
| `sync_pairing_payload` | — | `{ qrText, recoveryKey, expiresAt }` |
| `sync_key_import` | `{ qrText }` ou `{ recoveryKey }` | `{ kid, pairedBy, epoch }` |
| `sync_scan` | — | `FolderScan` |
| `sync_read_journal` | `{ deviceId, epoch, from, maxBytes }` | `ReadPage` |
| `sync_append_journal` | `{ epoch, segment, firstRecord, sv, records }` | `{ head }` |
| `sync_write_state` | `{ sv, state }` | `null` |
| `sync_snapshot_begin` / `sync_snapshot_append` / `sync_snapshot_commit` | `{ epoch, seq, sv }` / `{ handle, records }` / `{ handle }` | `{ handle }` / `null` / `null` |
| `sync_read_snapshot` | `{ deviceId, epoch, seq, fromRecord, maxBytes }` | `ReadPage` |
| `sync_delete_own` | `{ files: { epoch, kind: 'j' \| 's' \| 'epoch', n? }[] }` | `{ deleted }` |
| `sync_restore_marker_get` / `sync_restore_marker_clear` | — | `RestoreMarker` ou `null` / `null` |

#### 11.2 TypeScript

```ts
// src/domain/sync/format.ts
export const SYNC_FORMAT_MAJOR = 1;                       // égal à la constante Rust (test croisé)
export type EpochId = string & { readonly __brand: 'EpochId' }; // 'e0001-<uuid>'
export interface RecordCursor { readonly segment: number; readonly record: number }
export interface DeviceAck extends RecordCursor { readonly epoch: EpochId; readonly hlc: Hlc | null }
export interface PublishedDeviceState {
  readonly deviceId: DeviceId;
  readonly platform: 'windows' | 'ios';
  readonly appVersion: string;
  readonly sm: number;
  readonly sv: number;
  readonly epoch: EpochId;
  readonly head: DeviceAck;
  readonly acks: Readonly<Record<DeviceId, DeviceAck>>;
  readonly snapshot: { readonly seq: number; readonly endHlc: Hlc } | null;
  readonly purgeHorizon: Hlc | null;
  readonly lastSyncHlc: Hlc;
  readonly pairedBy?: DeviceId;
}
// + JournalRecord, SyncOp, SyncField (section 3.1), SnapshotRecord (section 5.1)

// src/platform/sync/types.ts
export type SyncErrorCode = /* codes de la section 11.1 */ string;
export class SyncPlatformError extends Error { readonly code: SyncErrorCode }
export interface SyncFolderInfo { readonly configured: boolean; readonly label: string | null; readonly kind: 'icloud' | 'local' | 'unknown'; readonly pinned: boolean }
export type FileAvailability = 'local' | 'cloud' | 'error';
export interface DeviceScan {
  readonly deviceId: DeviceId;
  readonly kid: string | null;
  readonly state: PublishedDeviceState | null;
  readonly stateStatus: 'ok' | 'missing' | 'cloud-pending' | 'key-mismatch' | 'corrupt' | 'newer-format';
  readonly epochs: readonly { readonly epoch: EpochId; readonly segments: readonly number[]; readonly snapshots: readonly number[] }[];
  readonly pending: readonly { readonly file: string; readonly availability: FileAvailability }[];
}
export interface FolderScan { readonly devices: readonly DeviceScan[]; readonly ignored: number }
export interface ReadPage { readonly records: readonly string[]; readonly next: RecordCursor; readonly status: 'complete' | 'more' | 'cloud-pending' | 'truncated' }
export interface RestoreMarker { readonly backup: string; readonly backupTakenAt: IsoDateTime; readonly restoredAt: IsoDateTime; readonly schemaVersion: number }
export interface SyncPlatform {
  available(): boolean;                                     // faux sur iOS jusqu'à l'ordre 5
  readonly folder: { info(): Promise<SyncFolderInfo>; choose(): Promise<SyncFolderInfo | null>; forget(): Promise<void> };
  readonly key: {
    status(): Promise<{ present: boolean; kid: string | null }>;
    create(): Promise<{ kid: string }>;
    pairingPayload(): Promise<{ qrText: string; recoveryKey: string; expiresAt: number }>;
    import(input: { qrText: string } | { recoveryKey: string }): Promise<{ kid: string; pairedBy: DeviceId | null; epoch: EpochId | null }>;
  };
  bindDevice(deviceId: DeviceId): Promise<void>;
  scan(): Promise<FolderScan>;
  readJournal(r: { deviceId: DeviceId; epoch: EpochId; from: RecordCursor; maxBytes?: number }): Promise<ReadPage>;
  appendJournal(r: { epoch: EpochId; segment: number; firstRecord: number; sv: number; records: readonly string[] }): Promise<{ head: RecordCursor }>;
  writeState(r: { sv: number; state: PublishedDeviceState }): Promise<void>;
  writeSnapshot(r: { epoch: EpochId; seq: number; sv: number; records: AsyncIterable<readonly string[]> }): Promise<void>;
  readSnapshot(r: { deviceId: DeviceId; epoch: EpochId; seq: number; fromRecord: number; maxBytes?: number }): Promise<ReadPage>;
  deleteOwn(files: readonly { epoch: EpochId; kind: 'j' | 's' | 'epoch'; n?: number }[]): Promise<number>;
  readonly restoreMarker: { get(): Promise<RestoreMarker | null>; clear(): Promise<void> };
}

// src/sync/status.ts
export type SyncPhase =
  | 'not-configured' | 'needs-pairing' | 'idle' | 'syncing' | 'waiting-icloud'
  | 'restore-choice' | 'update-required' | 'clock-ahead' | 'key-mismatch' | 'error';
export interface SyncStatus {
  readonly phase: SyncPhase;
  readonly lastSyncAt: IsoDateTime | null;
  readonly folderLabel: string | null;
  readonly devices: readonly { readonly deviceId: DeviceId; readonly platform: 'windows' | 'ios'; readonly self: boolean; readonly lastReadAt: IsoDateTime | null; readonly status: string }[];
  readonly pendingFiles: readonly string[];
  readonly conflictsThisWeek: number;
  readonly progress: { readonly done: number; readonly total: number } | null; // Y-06
}
export interface SyncService {                     // AppContainer.sync
  status(): SyncStatus;
  subscribe(listener: () => void): () => void;     // useSyncExternalStore
  syncNow(reason: 'open' | 'timer' | 'hide' | 'quit' | 'manual' | 'tray'): Promise<void>; // ne rejette jamais
  onRemoteChanges(listener: (c: { readonly tables: ReadonlySet<string>; readonly ids: ReadonlyMap<string, ReadonlySet<string>> }) => void): () => void;
  chooseRestoreOption(option: 'apply-everywhere' | 'keep-synced'): Promise<void>;
}
```

`SyncRepository` (`src/db/repositories/syncRepository.ts`, exposé par `Repositories.sync`) : `readOutbox(limit)`, `clearOutbox(uptoSeq)`, `materializeOutbox()`, `applyOps(ops, ctx)` (renvoie lignes touchées et conflits détectés par la règle pure), `fieldClocks(table, ids)`, `getStates()`, `saveCursor(...)`, `listConflicts(range)`, `restoreDiscarded(conflictId)`, `purgeDeleted(horizon)`, `tombstones()`, `unknownFields()`, `reintegrateUnknown()`, `exportSnapshotPage(table, after, limit)`, `replaceFromSnapshot(...)`, `parked()`. Chaque méthode annotée de l'ID de story ; aucune règle métier.

### 12. Tests

- **Rust (`cargo test`, `src-tauri/tests/desktop/sync_*.rs`)** : vecteurs de chiffrement partagés avec Vitest ; AAD (enregistrement déplacé, réordonné, changé de fichier ou de `sv` : refusé) ; ligne incomplète et fichier tronqué ; noms stricts (copies de conflit iCloud ignorées) ; écriture limitée au dossier lié ; `state.ctx` atomique ; clé de secours (aller-retour, saisie tolérante, somme de contrôle) ; QR expiré ; marqueur écrit après échange seulement et absent si pas de dossier (`backup.rs`) ; capability exacte (`config.rs`) ; `REFERENCE_TRIGGERS` égal aux migrations.
- **Domaine (Vitest)** : fusion par champ, base et conflit (les deux sens), suppression contre modification, dérive, compatibilité `sm` / `sv`, rétention (accusés, 30 jours, 180 jours), réparations (Focus, `routine.paused`), identifiants déterministes, catalogue contre `PRAGMA table_info`.
- **Propriétés (`fast-check`, devDependency)** sur `merge` et sur le moteur complet : convergence quel que soit l'ordre d'arrivée des lots et des appareils ; idempotence (relire = rien) ; aucune perte (chaque champ final = valeur au plus grand hlc parmi toutes les écritures) ; un élément supprimé et non restauré l'est partout, un identifiant purgé ne revient jamais ; hlc publiés strictement croissants par appareil, y compris après restauration (règle 1) ; symétrie des conflits ; instantané + journaux depuis `covers` = tous les journaux.
- **Simulation à deux dossiers (`tests/sim/syncCloudSim.ts`, `syncDevice.ts`)** : deux appareils dans le même processus, chacun avec sa base SQLite Wasm, son `HlcClock` sur horloge contrôlée (avance, recul, décalage de ±30 min, dérive > 1 h), son coffre en mémoire et **son propre dossier** ; un « iCloud » simulé recopie les fichiers de l'un vers l'autre sur ordre du test (`propagate({ partialLastLine, placeholder, delay, drop, conflictCopy })`) ; codec TypeScript de référence (vrai AES-GCM). Scénarios : hors ligne puis reprise, fichier partiel, fichier dans le nuage, appareil absent 200 jours, restauration (deux options, règle 4), deux époques concurrentes, version mineure et majeure plus récentes, clé différente, copie de conflit iCloud.
- **Parcours 10** (Y-02, Y-04, Y-05) : test d'intégration Vitest sur la simulation (cas d'usage réels des tâches), puis Playwright à deux pages du navigateur de dev reliées par un simulateur de dossier HTTP (`tests/sim/syncFolderSim.ts`, ports fixes dans `ports.ts`, `globalThis.__ctSync` en DEV seulement) : même tâche modifiée hors ligne des deux côtés, synchro, conflit dans le journal, « Restaurer ».
- **Parcours 11** (P-05, Y-01, Y-06, Y-08) : en simulation, à l'ordre 4 (« PC » et « second appareil » rejoint par `qrText`) : la tâche créée est illisible en clair dans le dossier (recherche du titre dans les octets : absente), puis lisible sur le second appareil. Partie iPhone (scan réel) à l'ordre 5.
- **Reste manuel (Ali)** : PC avec iCloud pour Windows réel (dossier épinglé, fichier mis volontairement « en ligne seulement » puis relu, iCloud arrêté, coupure réseau) ; puis, à l'ordre 5, iPhone (signet, `startDownloadingUbiquitousItem`, scan du QR, parcours 10 et 11 réels, Trousseau). Checklist dans `docs/stories/Y-0x.md`.

### 13. Découpage en lots

**Amorce (premier commit de Y1, avant de lancer Y2)** : `src/domain/sync/format.ts` et `src/platform/sync/types.ts` recopiés de la section 11.2, `src/platform/sync/memory.ts` minimal. Y2 part de ce commit.

| Lot | Stories | Fichiers et dossiers |
| --- | --- | --- |
| **Y1** | Y-08, Y-01 | `src-tauri/src/sync/**` (tous les modules de la section 0), `src-tauri/src/vault.rs` (déplacé de `calendars/vault.rs`), `src-tauri/src/lib.rs` (enregistrement), `src-tauri/capabilities/sync.json`, `src-tauri/Cargo.toml` (`aws-lc-rs` direct, fonctionnalités `windows`), `src-tauri/tests/desktop/sync_*.rs`, `config.rs` ; `src/platform/sync/**` ; `src/domain/sync/format.ts` ; `tests/fixtures/sync/vectors.json`, `tests/sim/syncCodec.ts` ; `src/features/sync/SyncSettingsSection.tsx` (ligne Réglages, choix du dossier, création de clé) et son insertion dans `src/features/settings/SettingsScreen.tsx` ; `src/i18n` (section `sync.folder`, `sync.key`) ; `docs/licences.md` |
| **Y2** | Y-02, Y-09, Y-05, Y-03 | `src/db/migrations/0015_sync_tables.ts`, `0016_sync_natural_ids.ts`, `index.ts` ; `src/db/repositories/syncRepository.ts`, `sql/sync*.ts`, `index.ts`, `sql/index.ts` ; `src/domain/sync/{syncTables,merge,retention,epoch,drift,repairs,naturalIds}.ts` ; `src/sync/**` ; `src/features/app/{container,bootstrap}.ts`, `App.tsx` (planificateur), émetteurs A-09 ; `src/features/sync/{syncStore.ts, SyncDetailsScreen.tsx, RestoreChoiceDialog.tsx}` ; `src/features/tasks/trashUseCases.ts`, `src/db/repositories/sql/taskRepository.ts` (purge) ; `src/features/events/holidayUseCases.ts`, use case de validation des routines (identifiants déterministes) ; `src/features/settings/BackupSheet.tsx` (avertissement) ; `src-tauri/src/backup.rs` (marqueur), `backup_triggers.rs`, `src/platform/backup/triggers.test.ts` ; `src-tauri/src/desktop.rs` (entrée de menu, événement) ; `tests/sim/{syncCloudSim,syncDevice}.ts`, `tests/unit/sync/**` ; `package.json` (`fast-check` en dev) ; `src/i18n` (section `sync.status`, `sync.restore`) |
| **Y3** | Y-04, Y-07, Y-06 | Y-04 : `src/features/sync/ConflictList.tsx`, `syncConflictUseCases.ts`, `src/db/repositories/sql/syncConflicts.ts`, `tests/e2e/parcours/J10*.spec.ts`, `tests/sim/syncFolderSim.ts`. Y-07 : `src/domain/sync/compat.ts`, `src/db/repositories/sql/syncUnknown.ts`, crochet de fin de `src/db/migrator.ts` (réintégration), bandeau « Mettez à jour l'app ». Y-06 : `src/features/sync/{PairingDialog,RecoveryKeyEntry,JoinProgress}.tsx`, `src/sync/join.ts`, `package.json` (`qrcode`), `tests/e2e/parcours/J11*.spec.ts`, `tests/bundle` (bloc à la demande). `src/i18n` (sections `sync.conflicts`, `sync.version`, `sync.pairing`) |

Parallélisme :
- **Y1 et Y2 en parallèle** (deux worktrees) après l'amorce : Y2 travaille sur l'implémentation mémoire de `SyncPlatform` et le codec de référence. Fichiers communs à surveiller : `src/i18n/fr.ts` et `en.ts` (sous-sections distinctes), `src-tauri/src/lib.rs` (Y1 seulement ; Y2 touche `desktop.rs` et `backup.rs`), `package.json` (Y2 seulement).
- **Y3 après la fusion de Y2** (il dépend du moteur et de `SyncRepository`) ; ses trois stories peuvent alors tourner **en parallèle** : chacune a ses propres fichiers de repository (`syncConflicts.ts`, `syncUnknown.ts`) et de feature ; `SyncDetailsScreen.tsx` expose des emplacements (conflits, version, appairage) remplis par chaque story. Le moteur (`engine.ts`) n'est touché que par Y-06 (`join.ts` appelé depuis le cycle) et Y-07 (contrôle `sm` déjà présent depuis Y2, seul le bandeau est ajouté).
- La fusion (`merge.ts`) détecte et renvoie les conflits **dès Y2** (le format porte la base dès le premier enregistrement publié) ; Y-04 n'ajoute que l'écran et la restauration. De même, `sync_unknown` est créée par la migration de Y2 : Y3 n'ajoute aucune migration.

## Conséquences

- **Dépendances** : cargo `aws-lc-rs` 1 en direct (déjà dans `Cargo.lock`, ISC / Apache-2.0, iOS compatible) ; crate `windows` : fonctionnalités `Win32_Storage_CloudFilters`, `Win32_Storage_FileSystem` ; npm `qrcode` (MIT, bloc à la demande, taille mesurée par `test:bundle` au lot Y3 ; repli `qrcode-generator`, MIT, sans dépendance, si le bloc dépasse 25 Ko gzip) ; npm dev `fast-check` (MIT, non embarqué). Aucune autre. `docs/licences.md` et le tableau de l'ADR 0001 sont complétés par les lots.
- **ADR modifiés par renvoi** : ADR 0001 (commandes `sync_*`, sous-dossier `src/domain/sync`), ADR 0005 (limite de dérive), ADR 0008 (`vault.rs` partagé), ADR 0009 (marqueur dans `backup.rs`), ADR 0010 (règles appliquées, précision sur la republication à l'époque nouvelle).
- **Dettes soldées par l'implémentation** : toutes celles de la section « Ordre 4 » de `docs/dettes.md` (réponses en section 8).
- **Écarts au PRD**, inscrits dans `docs/decisions.md` : chiffrement en Rust au lieu de Web Crypto ; noms de fichiers par appareil et par segment au lieu de `changes-pc.jsonl` / `snapshot.json` ; pas de colonne `folder_bookmark_ref` ; identifiants purgés gardés sans contenu au-delà des 30 jours.
- **Limites connues** : un tiers qui accède au dossier peut supprimer des fichiers (détecté, pas empêché) ; la clé de secours imprimée donne accès à toutes les données ; un appareil revenu après 180 jours voit ses modifications hors ligne fusionnées par hlc, donc perdre contre des modifications plus récentes (journalisées en conflits) ; le QR « valable 5 minutes » ne l'est que par affichage et contrôle d'heure.

## Maquettes manquantes (à demander, non inventées)

1. Réglages > Synchronisation sur **PC** (état, appareils, conflits) : seule la version iPhone existe (Synchro.html) ; PC-Appairage.html ne montre que l'appairage.
2. **Choix après restauration** (règle 3 de l'ADR 0010 : deux options, cas « une seule option » de la règle 4).
3. **Bandeaux A-09** « Synchro en cours » et « En attente d'iCloud » (aucune maquette de bandeau).
4. **« Mettez à jour l'app »** (Y-07) et lecture suspendue d'un appareil.
5. **Saisie de la clé de secours** (lien présent dans Appairage.html, écran absent) et **progression** du nouvel appareil (Y-06).
6. États d'erreur : clé différente, horloge en avance, dossier hors iCloud, iCloud pour Windows arrêté.
7. Choix du dossier sur PC (Y-01) : boîte système ; seule la ligne de Réglages.html existe (version iPhone).

En attendant, les lots composent ces écrans avec les composants existants (`ChoiceDialog`, `ConfirmDialog`, bandeau A-09, lignes de Réglages) et les textes de `src/i18n`, sans élément visuel nouveau.

## Questions ouvertes

1. Écran « Changer la clé de chiffrement » (rotation volontaire) : aucune story ; mécanisme prévu (nouvelle époque), pas d'interface.
2. Retirer un appareil associé (PC remplacé) : aucune story ; un appareil absent 180 jours cesse simplement de compter.
3. Champs liés (date et heure, statut et date de fin) fusionnés séparément : combinaison possible jamais choisie par un appareil ; option future de « groupes de champs ».
4. Réconciliation de `calendar_account.calendars` (JSON entier fusionné comme un seul champ : deux affectations d'agendas concurrentes donnent un conflit, pas une fusion fine).
5. Correction du PRD 6 et 7 par Ali (noms de fichiers, Web Crypto, `folder_bookmark_ref`), sans effet sur l'implémentation.
