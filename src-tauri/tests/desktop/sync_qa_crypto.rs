//! QA du lot Y1 (Y-08) : bornes, entrées hostiles, erreurs typées et clés. Complète `sync_crypto.rs`, `sync_key.rs` et `sync_pairing.rs`
//! sans les remplacer. Les tests `#[ignore]` documentent un défaut de production signalé au module (voir la fiche, « Défauts QA »).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use circletasks_lib::sync::crypto::{
    key_from_recovery, pad, parse_line_prefix, parse_qr_text, qr_text_of, unpad, FileHeader, MasterKey, OpenError, Place, RECOVERY_CHARS,
};
use circletasks_lib::sync::limits::{padded_plaintext_bytes, MAX_RECORD_LINE_BYTES, MAX_RECORD_PLAINTEXT_BYTES};
use circletasks_lib::sync::names::{is_app_version, is_epoch_id, is_kid, is_strict_hlc, is_uuid_v4, parse_file_name, EpochId, SyncFileName};
use serde_json::Value;

const DEV: &str = "3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";
const EPOCH: &str = "e0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";

fn fixed_key() -> MasterKey {
    let bytes: Vec<u8> = (0u8..32).map(|i| i.wrapping_mul(7).wrapping_add(3)).collect();
    MasterKey::from_bytes(&bytes).unwrap()
}

fn journal() -> Place<'static> {
    Place::Journal { dev: DEV, epoch: EPOCH, segment: 1, index: 0 }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 1 et 3 : lignes hostiles
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn y08_1_every_region_of_the_payload_is_authenticated() {
    let key = fixed_key();
    let line = key.seal(&journal(), b"{\"a\":1}", 1, 14).unwrap();
    let prefix = "1.14.";
    let payload = URL_SAFE_NO_PAD.decode(&line[prefix.len()..]).unwrap();
    // Un bit retourné dans le nonce, le premier et le dernier octet chiffré, l'étiquette : toujours `Decrypt`.
    for index in [0, 11, 12, 13, payload.len() / 2, payload.len() - 17, payload.len() - 16, payload.len() - 1] {
        let mut tampered = payload.clone();
        tampered[index] ^= 0x01;
        let text = format!("{prefix}{}", URL_SAFE_NO_PAD.encode(&tampered));
        assert_eq!(key.open(&journal(), &text).err(), Some(OpenError::Decrypt), "octet {index}");
    }
    // Étiquette tronquée ou allongée d'un octet : la longueur n'est plus un palier, donc forme invalide.
    for len in [payload.len() - 1, payload.len() + 1] {
        let mut changed = payload.clone();
        changed.resize(len, 0);
        let text = format!("{prefix}{}", URL_SAFE_NO_PAD.encode(&changed));
        assert_eq!(key.open(&journal(), &text).err(), Some(OpenError::Malformed), "longueur {len}");
    }
}

#[test]
fn y08_1_hostile_line_shapes_are_refused_without_panic() {
    let key = fixed_key();
    let line = key.seal(&journal(), b"{}", 1, 14).unwrap();
    let body = &line["1.14.".len()..];
    let cases: Vec<(String, &str)> = vec![
        (String::new(), "vide"),
        (".".into(), "un point"),
        ("..".into(), "deux points"),
        ("1.14".into(), "sans charge utile"),
        ("1.14.".into(), "charge utile vide"),
        (format!("{line}\n"), "retour à la ligne final"),
        (format!("{line}\r"), "retour chariot final"),
        (format!(" {line}"), "espace initial"),
        (format!("{line} "), "espace final"),
        (format!("{line}="), "remplissage base64"),
        (format!("1.14.{}", body.replace('-', "+")), "alphabet base64 standard"),
        (format!("1.14.{}é", &body[..body.len() - 1]), "non ASCII"),
        (format!("1.14.{}\u{0}", &body[..body.len() - 1]), "octet nul"),
        (format!("1.14.{}", &body[..body.len() - 4]), "tronquée"),
        (format!("1.14.{body}.extra"), "champ en trop"),
        (format!("1.14.1.{body}"), "préfixe en trop"),
        (format!("+1.14.{body}"), "signe"),
        (format!("1.+14.{body}"), "signe de sv"),
        (format!("1.014.{body}"), "zéro initial de sv"),
        (format!("0.14.{body}"), "sm nul"),
        (format!("1.0.{body}"), "sv nul"),
        (format!("1.-1.{body}"), "sv négatif"),
        (format!("1.1e1.{body}"), "notation scientifique"),
        (format!("1.１４.{body}"), "chiffres pleine chasse"),
        (format!("1234567.14.{body}"), "sm de 7 chiffres"),
        (format!("1.14.{}", "A".repeat(MAX_RECORD_LINE_BYTES + 1)), "ligne au-delà de la borne"),
    ];
    for (text, why) in &cases {
        assert_eq!(key.open(&journal(), text).err(), Some(OpenError::Malformed), "{why}");
    }
    assert!(key.open(&journal(), &line).is_ok());
}

#[test]
fn y08_1_base64_is_canonical_one_string_per_ciphertext() {
    // Les bits de fin du dernier caractère doivent être nuls : une seconde écriture du même octet est refusée (pas de malléabilité).
    let key = fixed_key();
    let line = key.seal(&journal(), b"{}", 1, 14).unwrap();
    let last = line.chars().last().unwrap();
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let at = alphabet.find(last).unwrap();
    let other = alphabet.chars().nth(at ^ 1).unwrap();
    let variant = format!("{}{other}", &line[..line.len() - 1]);
    assert_ne!(variant, line);
    assert!(key.open(&journal(), &variant).is_err(), "variante non canonique acceptée");
}

#[test]
fn y08_2_padding_boundaries_and_hostile_plaintext_frames() {
    // Bornes de palier : 0 octet -> 4 Kio ; 4 092 -> 4 Kio ; 4 093 -> 8 Kio ; 256 Kio -> 260 Kio (+ préfixe).
    assert_eq!(padded_plaintext_bytes(0), 4096);
    assert_eq!(padded_plaintext_bytes(4092), 4096);
    assert_eq!(padded_plaintext_bytes(4093), 8192);
    assert_eq!(padded_plaintext_bytes(MAX_RECORD_PLAINTEXT_BYTES), 266_240);
    assert_eq!(unpad(&pad(b"")), Some(&b""[..]));
    // Cadres hostiles : jamais de panique, toujours `None`.
    assert_eq!(unpad(&[]), None);
    assert_eq!(unpad(&[0, 0, 0]), None, "moins que le préfixe");
    assert_eq!(unpad(&[0; 4]), None, "pas un palier de 4 Kio");
    assert_eq!(unpad(&[0; 4095]), None);
    assert_eq!(unpad(&[0; 4097]), None);
    let mut frame = vec![0u8; 4096];
    frame[..4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(unpad(&frame), None, "longueur annoncée énorme");
    frame[..4].copy_from_slice(&4093u32.to_be_bytes());
    assert_eq!(unpad(&frame), None, "longueur annoncée de un octet au-delà");
    frame[..4].copy_from_slice(&4092u32.to_be_bytes());
    assert!(unpad(&frame).is_some(), "longueur annoncée exacte");
    // Palier trop grand pour la longueur annoncée (bourrage gonflé) : refusé.
    let mut fat = vec![0u8; 8192];
    fat[..4].copy_from_slice(&10u32.to_be_bytes());
    assert_eq!(unpad(&fat), None);
}

#[test]
fn y08_2_plaintext_size_boundaries_seal_and_open() {
    let key = fixed_key();
    for len in [0usize, 1, 4092, 4093, MAX_RECORD_PLAINTEXT_BYTES] {
        let json = vec![b'a'; len];
        let line = key.seal(&journal(), &json, 1, 14).unwrap();
        assert!(line.len() + 1 <= MAX_RECORD_LINE_BYTES, "{len}");
        let opened = key.open(&journal(), &line).unwrap();
        assert_eq!(opened.json.len(), len);
    }
    assert!(key.seal(&journal(), &vec![b'a'; MAX_RECORD_PLAINTEXT_BYTES + 1], 1, 14).is_err());
    // Taille masquée : 1 octet et 4 092 octets donnent des lignes de même longueur.
    let short = key.seal(&journal(), b"x", 1, 14).unwrap();
    let long = key.seal(&journal(), &vec![b'x'; 4092], 1, 14).unwrap();
    assert_eq!(short.len(), long.len());
}

#[test]
fn y08_2_a_non_utf8_plaintext_sealed_by_a_buggy_writer_is_refused_on_open() {
    // Le lecteur refuse un texte clair qui n'est pas de l'UTF-8 valide (octets forgés avec la bonne clé).
    let key = fixed_key();
    let line = key.seal(&journal(), &[0xff, 0xfe, 0xfd], 1, 14).unwrap();
    assert_eq!(key.open(&journal(), &line).err(), Some(OpenError::Decrypt));
}

#[test]
fn y08_3_nonces_are_never_repeated_over_many_seals() {
    let key = fixed_key();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..3000 {
        let line = key.seal(&journal(), b"{}", 1, 14).unwrap();
        let payload = URL_SAFE_NO_PAD.decode(&line["1.14.".len()..]).unwrap();
        assert!(seen.insert(payload[..12].to_vec()), "nonce répété");
    }
}

#[test]
fn y08_3_aad_separates_the_three_kinds_even_with_equal_numbers() {
    let key = fixed_key();
    let state = Place::State { dev: DEV, epoch: EPOCH, state_seq: 1 };
    let snap = Place::Snapshot { dev: DEV, epoch: EPOCH, seq: 1, index: 0 };
    let line = key.seal(&journal(), b"{}", 1, 14).unwrap();
    assert!(key.open(&state, &line).is_err());
    assert!(key.open(&snap, &line).is_err());
    let line = key.seal(&snap, b"{}", 1, 14).unwrap();
    assert!(key.open(&journal(), &line).is_err());
    assert!(key.open(&snap, &line).is_ok());
    // Numéros aux limites du format (8 chiffres, 4 chiffres d'époque) : AAD stable, aller-retour.
    let edge = Place::Journal { dev: DEV, epoch: "e9999-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", segment: 99_999_999, index: u64::from(u32::MAX) + 1 };
    let line = key.seal(&edge, b"{}", 1, 14).unwrap();
    assert!(key.open(&edge, &line).is_ok());
    let off_by_one = Place::Journal { dev: DEV, epoch: "e9999-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", segment: 99_999_999, index: u64::from(u32::MAX) };
    assert!(key.open(&off_by_one, &line).is_err());
}

/// Défaut QA-Y1-1 (faible) : `seal` accepte `sm` / `sv` de plus de 6 chiffres, mais `open` les refuse (`Malformed`) : une ligne scellée
/// avec `sv >= 1 000 000` serait écrite puis jamais relue. Attendu : `seal` refuse (`CryptoError`).
#[test]
#[ignore = "défaut QA-Y1-1 : seal accepte sv >= 1 000 000, ligne illisible ensuite"]
fn y08_1_seal_refuses_a_version_the_reader_cannot_parse() {
    let key = fixed_key();
    let sealed = key.seal(&journal(), b"{}", 1, 1_000_000);
    assert!(sealed.is_err() || key.open(&journal(), sealed.as_ref().unwrap()).is_ok());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 5 : clés et dérivées
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn y08_5_key_length_and_vault_value_edge_cases() {
    for len in [0usize, 1, 31, 33, 64] {
        assert!(MasterKey::from_bytes(&vec![7u8; len]).is_none(), "{len} octets");
    }
    let key = fixed_key();
    let value = key.to_vault_value();
    assert!(MasterKey::from_vault_value(&value).unwrap().same_as(&key));
    assert!(MasterKey::from_vault_value(&format!(" {} \n", *value)).unwrap().same_as(&key), "espaces tolérés autour de la valeur");
    for bad in ["", "AAAA", "!!!!", &"A".repeat(43), &"A".repeat(45), &value.replace('=', "")] {
        assert!(MasterKey::from_vault_value(bad).is_none(), "{bad:?}");
    }
    // Deux clés distinctes : `same_as` faux, `kid` différents ; la même clé : même `kid` à chaque lecture.
    let other = MasterKey::generate().unwrap();
    assert!(!key.same_as(&other));
    assert_ne!(key.kid(), other.kid());
    assert_eq!(MasterKey::from_vault_value(&value).unwrap().kid(), key.kid());
    // Clé presque identique (un bit) : `same_as` faux.
    let mut raw = (0u8..32).map(|i| i.wrapping_mul(7).wrapping_add(3)).collect::<Vec<_>>();
    raw[31] ^= 1;
    assert!(!key.same_as(&MasterKey::from_bytes(&raw).unwrap()));
}

#[test]
fn y08_5_generated_keys_are_distinct_and_not_degenerate() {
    let mut kids = std::collections::HashSet::new();
    for _ in 0..64 {
        let key = MasterKey::generate().unwrap();
        let recovery = key.recovery_key();
        let again = key_from_recovery(&recovery).unwrap();
        assert!(again.same_as(&key));
        assert!(kids.insert(key.kid().to_owned()), "kid répété");
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 8 : clé de secours
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn y08_8_recovery_key_detects_every_single_character_substitution_of_a_fixed_key() {
    let key = fixed_key();
    let recovery = key.recovery_key().to_string();
    let body: Vec<char> = recovery.chars().skip(4).filter(|c| *c != '-').collect();
    assert_eq!(body.len(), RECOVERY_CHARS);
    let alphabet: Vec<char> = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".chars().collect();
    let mut accepted = 0;
    for position in 0..body.len() {
        for &c in &alphabet {
            if c == body[position] {
                continue;
            }
            let mut changed = body.clone();
            changed[position] = c;
            let text: String = changed.into_iter().collect();
            if let Some(found) = key_from_recovery(&text) {
                // Une collision de la somme sur 16 bits est possible (2^-16) : la clé décodée ne doit alors pas être K.
                assert!(!found.same_as(&key), "position {position}");
                accepted += 1;
            }
        }
    }
    assert!(accepted <= 2, "{accepted} substitutions non détectées sur {}", body.len() * 31);
}

#[test]
fn y08_8_recovery_key_hostile_inputs_are_refused_without_panic() {
    let key = fixed_key();
    let recovery = key.recovery_key().to_string();
    let body: String = recovery.chars().skip(4).filter(|c| *c != '-').collect();
    for (input, why) in [
        (String::new(), "vide"),
        ("CT1-".to_owned(), "préfixe seul"),
        (format!("CT2-{body}"), "autre préfixe"),
        (format!("{body}0"), "un caractère de trop"),
        (body[..54].to_owned(), "un caractère de moins"),
        (format!("{body}{body}"), "doublée"),
        (body.replace(&body[..1], "U"), "caractère hors alphabet (U)"),
        (format!("{}é{}", &body[..10], &body[11..]), "non ASCII"),
        (format!("{}\u{0}{}", &body[..10], &body[11..]), "octet nul"),
        ("😀".repeat(20), "émojis"),
        (format!("{}{}", "\u{202e}", body), "contrôle bidirectionnel"),
        ("0".repeat(55), "tout à zéro (somme fausse)"),
    ] {
        assert!(key_from_recovery(&input).is_none(), "{why}");
    }
    assert!(key_from_recovery(&body).is_some(), "sans préfixe");
    assert!(key_from_recovery(&format!("ct1 {}", body.to_lowercase())).is_some(), "préfixe en minuscules");
    // Longueur plafonnée à 256 octets avant tout traitement (même avec des espaces).
    assert!(key_from_recovery(&format!("{}{}", " ".repeat(300), body)).is_none());
    assert!(key_from_recovery(&format!("{}{}", " ".repeat(150), body)).is_some());
}

#[test]
fn y08_8_recovery_key_nonzero_padding_bits_are_refused() {
    // 55 caractères = 275 bits pour 272 bits utiles : les trois derniers bits doivent être nuls (une seule écriture par clé).
    let key = fixed_key();
    let recovery = key.recovery_key().to_string();
    let body: Vec<char> = recovery.chars().skip(4).filter(|c| *c != '-').collect();
    let alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let last = alphabet.find(*body.last().unwrap()).unwrap();
    assert_eq!(last & 7, 0, "bits de bourrage nuls à l'émission");
    let mut variant = body.clone();
    *variant.last_mut().unwrap() = alphabet.chars().nth(last | 1).unwrap();
    assert!(key_from_recovery(&variant.into_iter().collect::<String>()).is_none());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Texte du QR (§10.3) : bornes
// ------------------------------------------------------------------------------------------------------------------------------

fn qr_json(key: &MasterKey, tweak: impl FnOnce(&mut Value)) -> String {
    let text = qr_text_of(key, DEV, Some(EPOCH), 1_790_000_000_000);
    let json = URL_SAFE_NO_PAD.decode(text.strip_prefix("CTPAIR1.").unwrap()).unwrap();
    let mut value: Value = serde_json::from_slice(&json).unwrap();
    tweak(&mut value);
    format!("CTPAIR1.{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap()))
}

#[test]
fn y08_14_qr_text_bounds_and_hostile_fields() {
    let key = fixed_key();
    let max = (1u64 << 53) - 1;
    assert!(parse_qr_text(&qr_json(&key, |v| v["x"] = max.into())).is_some());
    assert!(parse_qr_text(&qr_json(&key, |v| v["x"] = (max + 1).into())).is_none(), "x au-delà de 2^53 - 1");
    assert!(parse_qr_text(&qr_json(&key, |v| v["x"] = 0.into())).is_some());
    assert!(parse_qr_text(&qr_json(&key, |v| v["x"] = (-1).into())).is_none(), "x négatif");
    assert!(parse_qr_text(&qr_json(&key, |v| v["x"] = "1".into())).is_none(), "x texte");
    assert!(parse_qr_text(&qr_json(&key, |v| v["e"] = Value::Null)).is_some(), "époque absente (null)");
    assert!(parse_qr_text(&qr_json(&key, |v| v["e"] = "e0000-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60".into())).is_none(), "époque 0");
    assert!(parse_qr_text(&qr_json(&key, |v| v["e"] = 1.into())).is_none(), "époque numérique");
    assert!(parse_qr_text(&qr_json(&key, |v| v["d"] = DEV.to_uppercase().into())).is_none(), "appareil en majuscules");
    assert!(parse_qr_text(&qr_json(&key, |v| v["d"] = Value::Null)).is_none());
    assert!(parse_qr_text(&qr_json(&key, |v| v["v"] = 0.into())).is_none());
    for bad_k in [URL_SAFE_NO_PAD.encode([1u8; 31]), URL_SAFE_NO_PAD.encode([1u8; 33]), format!("{}=", URL_SAFE_NO_PAD.encode([1u8; 32])), String::new()] {
        assert!(parse_qr_text(&qr_json(&key, |v| v["k"] = bad_k.clone().into())).is_none(), "{bad_k}");
    }
    // Non-objets, texte brut, base64 invalide.
    for raw in ["null", "[]", "1", "\"x\"", "{}", "{"] {
        assert!(parse_qr_text(&format!("CTPAIR1.{}", URL_SAFE_NO_PAD.encode(raw))).is_none(), "{raw}");
    }
    assert!(parse_qr_text("CTPAIR1.").is_none());
    assert!(parse_qr_text("").is_none());
    assert!(parse_qr_text("ctpair1.AAAA").is_none(), "préfixe sensible à la casse");
    assert!(parse_qr_text(&format!(" {}", qr_json(&key, |_| {}))).is_none(), "espace initial");
    assert!(parse_qr_text(&format!("{}\n", qr_json(&key, |_| {}))).is_none(), "retour à la ligne final");
    // Taille : 1 024 octets au plus.
    let ok = qr_json(&key, |_| {});
    assert!(ok.len() < 1024);
    assert!(parse_qr_text(&format!("{ok}{}", "A".repeat(1024))).is_none());
}

// ------------------------------------------------------------------------------------------------------------------------------
// En-têtes (§1.2) : bornes
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn y08_header_numeric_bounds_and_hostile_documents() {
    let base = |f: &str, n: &str| {
        format!(r#"{{"f":"{f}","sm":1,"kid":"0123456789abcdef","dev":"{DEV}","e":"{EPOCH}","n":{n}}}"#)
    };
    // Journal et instantané : 1 à 99 999 999.
    for f in ["ct-j", "ct-s"] {
        assert!(FileHeader::parse(base(f, "1").as_bytes()).is_some());
        assert!(FileHeader::parse(base(f, "99999999").as_bytes()).is_some());
        assert!(FileHeader::parse(base(f, "100000000").as_bytes()).is_none());
        assert!(FileHeader::parse(base(f, "0").as_bytes()).is_none());
        assert!(FileHeader::parse(base(f, "-1").as_bytes()).is_none());
        assert!(FileHeader::parse(base(f, "\"1\"").as_bytes()).is_none());
        assert!(FileHeader::parse(base(f, "null").as_bytes()).is_none());
        assert!(FileHeader::parse(base(f, "1e0").as_bytes()).is_none());
    }
    // État : 1 à 2^53 - 1.
    assert!(FileHeader::parse(base("ct-state", "9007199254740991").as_bytes()).is_some());
    assert!(FileHeader::parse(base("ct-state", "9007199254740992").as_bytes()).is_none());
    assert!(FileHeader::parse(base("ct-state", "18446744073709551616").as_bytes()).is_none());
    // sm : 1 à u32.
    let sm = |s: &str| base("ct-j", "1").replace(r#""sm":1"#, &format!(r#""sm":{s}"#));
    assert!(FileHeader::parse(sm("4294967295").as_bytes()).is_some());
    assert!(FileHeader::parse(sm("4294967296").as_bytes()).is_none());
    assert!(FileHeader::parse(sm("0").as_bytes()).is_none());
    assert!(FileHeader::parse(sm("1.5").as_bytes()).is_none());
    // Taille : 1 024 octets au plus (en-tête rempli d'espaces, valide sinon).
    let good = base("ct-j", "1");
    assert!(FileHeader::parse(format!("{good}{}", " ".repeat(1024 - good.len())).as_bytes()).is_some());
    assert!(FileHeader::parse(format!("{good}{}", " ".repeat(1025 - good.len())).as_bytes()).is_none());
    // Documents hostiles.
    for raw in ["", "null", "[]", "{}", "\u{feff}", "{\"f\":\"ct-j\"", "\u{feff}{}"] {
        assert!(FileHeader::parse(raw.as_bytes()).is_none(), "{raw}");
    }
    assert!(FileHeader::parse(&[0xff, 0xfe]).is_none());
    assert!(FileHeader::parse(format!("\u{feff}{good}").as_bytes()).is_none(), "BOM");
    // Un `kid` ou un appareil mal formés, majuscules, longueur, époque 0 ou à 5 chiffres.
    for (from, to) in [
        ("0123456789abcdef", "0123456789abcde"),
        ("0123456789abcdef", "0123456789abcdeg"),
        (DEV, "3F2B8C1E-5A7D-4E9B-9C2A-1B2C3D4E5F60"),
        (DEV, "3f2b8c1e-5a7d-3e9b-9c2a-1b2c3d4e5f60"),
        (DEV, "3f2b8c1e-5a7d-4e9b-7c2a-1b2c3d4e5f60"),
        ("e0001-3f2b", "e0000-3f2b"),
        ("e0001-3f2b", "e00001-3f2b"),
    ] {
        assert!(FileHeader::parse(good.replace(from, to).as_bytes()).is_none(), "{to}");
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Y-01 critère 11 : noms stricts (names.rs)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn y01_11_strict_file_names_refuse_every_windows_and_icloud_variant() {
    assert_eq!(parse_file_name("state.ctx"), Some(SyncFileName::State));
    assert_eq!(parse_file_name("j-00000001.ctj"), Some(SyncFileName::Segment(1)));
    assert_eq!(parse_file_name("j-99999999.ctj"), Some(SyncFileName::Segment(99_999_999)));
    assert_eq!(parse_file_name("s-00000042.cts"), Some(SyncFileName::Snapshot(42)));
    for refused in [
        "",
        "state 2.ctx",
        "state (1).ctx",
        "state.ctx.tmp",
        "state.ctx.",
        "state.ctx ",
        " state.ctx",
        "State.ctx",
        "STATE.CTX",
        "state.CTX",
        "state.ctx:stream",
        "state.ctx::$DATA",
        "state.next.ctx",
        "state.ctx\0",
        "state.ctx\n",
        "../state.ctx",
        "..\\state.ctx",
        "a/state.ctx",
        "j-00000000.ctj",
        "j-100000000.ctj",
        "j-0000001.ctj",
        "j-000000001.ctj",
        "j-1.ctj",
        "j-0000000a.ctj",
        "j-００００００１.ctj",
        "j-+0000001.ctj",
        "j-00000001.ctj.",
        "j-00000001.ctj.tmp",
        "j-00000001 2.ctj",
        "j-00000001.CTJ",
        "J-00000001.ctj",
        "j-00000001.cts",
        "s-00000001.ctj",
        "j-00000001",
        "j-00000001.ctj\0.txt",
        "CON",
        "NUL.ctj",
        ".DS_Store",
        "desktop.ini",
        "Thumbs.db",
        "~$state.ctx",
        ".state.ctx.icloud",
    ] {
        assert_eq!(parse_file_name(refused), None, "{refused:?}");
    }
}

#[test]
fn y01_11_strict_identifiers_refuse_traversal_case_and_unicode() {
    assert!(is_uuid_v4(DEV));
    for refused in [
        "",
        &DEV.to_uppercase(),
        &format!("{DEV}\n"),
        &format!(" {DEV}"),
        &format!("{DEV}x"),
        &DEV[..35],
        "3f2b8c1e-5a7d-1e9b-9c2a-1b2c3d4e5f60",
        "3f2b8c1e-5a7d-4e9b-0c2a-1b2c3d4e5f60",
        "3f2b8c1e_5a7d_4e9b_9c2a_1b2c3d4e5f60",
        "3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f6é",
        "../../../../../../../../../../etc/passwd",
        "..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\Windows\\x",
        "{3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60}",
    ] {
        assert!(!is_uuid_v4(refused), "{refused:?}");
    }
    assert!(is_epoch_id(EPOCH));
    for refused in ["", "e0000-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", "e10000-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", "E0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", "e+001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", "e０００１-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", "e0001-", "e0001-../..", "e0001_3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60"] {
        assert!(!is_epoch_id(refused), "{refused:?}");
    }
    let low = EpochId::parse("e0002-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60").unwrap();
    let high = EpochId::parse("e0010-00000000-0000-4000-8000-000000000000").unwrap();
    assert!(low < high, "ordre numérique, pas lexical sur le texte");
    assert_eq!(low.name(), "e0002-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60");
    assert!(is_kid("0123456789abcdef") && !is_kid("0123456789ABCDEF") && !is_kid("0123456789abcde") && !is_kid("0123456789abcdef0"));
    let good_hlc = format!("000001790000000-00ff-{DEV}");
    assert!(is_strict_hlc(&good_hlc));
    for refused in ["", "1790000000-00ff-x", &good_hlc.replace("00ff", "00FF"), &good_hlc.replace("-00ff-", "-00fg-"), &format!("{good_hlc}\n"), &good_hlc[1..]] {
        assert!(!is_strict_hlc(refused), "{refused:?}");
    }
    assert!(is_app_version("0.1.1") && is_app_version("1.2.3-rc.1+build5") && is_app_version(&"a".repeat(64)));
    assert!(!is_app_version("") && !is_app_version(&"a".repeat(65)) && !is_app_version("1.0 beta") && !is_app_version("../1") && !is_app_version("é"));
}

#[test]
fn y08_1_line_prefix_exposes_nothing_beyond_the_sealed_payload() {
    let key = fixed_key();
    let line = key.seal(&journal(), b"{}", 12, 345).unwrap();
    let prefix = parse_line_prefix(&line).unwrap();
    assert_eq!((prefix.sm, prefix.sv), (12, 345));
    assert_eq!(prefix.payload.len(), line.len() - "12.345.".len());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Y-08 critères 9 et 14 : bornes d'import (service avec dossier simulé)
// ------------------------------------------------------------------------------------------------------------------------------

mod service {
    use std::path::Path;

    use circletasks_lib::sync::crypto::{qr_text_of, MasterKey};
    use circletasks_lib::sync::folder::FolderKind;
    use circletasks_lib::sync::limits::{PAIRING_CLOCK_TOLERANCE_MS, PAIRING_VALIDITY_MS};
    use circletasks_lib::sync::service::{KeyInput, SYNC_KEY_ACCOUNT};
    use circletasks_lib::sync::SyncCode;
    use circletasks_lib::vault::SecretVault;
    use zeroize::Zeroizing;

    use crate::sync_support::{device, epoch, hlc, Device, FakeBackend, DEV_A, DEV_B, FOLDER};

    fn code<T>(result: Result<T, circletasks_lib::sync::SyncError>) -> SyncCode {
        match result {
            Ok(_) => panic!("erreur attendue"),
            Err(error) => error.code,
        }
    }

    fn publish(d: &Device, dev: &str) {
        let state = serde_json::json!({
            "deviceId": dev, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": epoch(1, dev), "stateSeq": 1,
            "head": { "epoch": epoch(1, dev), "segment": 0, "record": 0, "hlc": null, "stateSeq": 1 },
            "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc(1_000, dev), "forgotten": [], "reset": null
        });
        d.core.write_state(14, state).expect("état");
    }

    fn pair() -> (Device, Device, std::sync::Arc<crate::sync_support::MemFs>) {
        let (a, fs) = device();
        a.setup(DEV_A);
        publish(&a, DEV_A);
        let b = Device::new(FakeBackend::with(FOLDER, FolderKind::Icloud, fs.clone()));
        b.core.choose_folder(Path::new(FOLDER)).unwrap();
        (a, b, fs)
    }

    #[test]
    fn y08_14_qr_expiry_tolerance_is_exactly_two_minutes() {
        let (a, b, _fs) = pair();
        let key = MasterKey::from_vault_value(&a.vault.get(SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap();
        let x = b.clock.now() + PAIRING_VALIDITY_MS;
        let qr = |x: u64| Zeroizing::new((*qr_text_of(&key, DEV_A, None, x)).clone());
        // `x` dépassé de 2 minutes pile : accepté ; de 2 minutes et 1 ms : refusé (borne incluse).
        b.clock.advance(PAIRING_VALIDITY_MS + PAIRING_CLOCK_TOLERANCE_MS + 1);
        assert_eq!(code(b.core.key_import(KeyInput::QrText(qr(x)), 1)), SyncCode::PairingExpired);
        b.clock.advance(10 * 60_000);
        let exact = b.clock.now() - PAIRING_CLOCK_TOLERANCE_MS;
        assert!(b.core.key_import(KeyInput::QrText(qr(exact)), 1).is_ok(), "x + 2 min exactement : accepté");
    }

    #[test]
    fn y08_14_a_refused_import_leaves_the_vault_and_state_untouched() {
        let (a, b, _fs) = pair();
        let stranger = MasterKey::generate().unwrap();
        let wrong = qr_text_of(&stranger, DEV_A, None, b.clock.now() + PAIRING_VALIDITY_MS);
        assert_eq!(code(b.core.key_import(KeyInput::QrText(wrong), 1)), SyncCode::KeyMismatch);
        assert_eq!(b.vault.get(SYNC_KEY_ACCOUNT).unwrap(), None);
        assert!(!b.core.key_status().unwrap().present);
        // Clé de secours d'une autre clé : même résultat, rien d'enregistré.
        let other = stranger.recovery_key();
        assert_eq!(code(b.core.key_import(KeyInput::RecoveryKey(Zeroizing::new((*other).clone())), 1)), SyncCode::KeyMismatch);
        assert_eq!(b.vault.get(SYNC_KEY_ACCOUNT).unwrap(), None);
        // Le QR désigne l'appareil qui l'a émis (`d`) : le `kid` est lu dans le `state.ctx` de cet appareil seulement ; un appareil
        // absent du dossier donne `cloud-pending` (jamais un enregistrement sur la foi d'un autre appareil).
        let key = MasterKey::from_vault_value(&a.vault.get(SYNC_KEY_ACCOUNT).unwrap().unwrap()).unwrap();
        let unknown_dev = qr_text_of(&key, DEV_B, None, b.clock.now() + PAIRING_VALIDITY_MS);
        assert_eq!(code(b.core.key_import(KeyInput::QrText(Zeroizing::new((*unknown_dev).clone())), 1)), SyncCode::CloudPending);
        assert_eq!(b.vault.get(SYNC_KEY_ACCOUNT).unwrap(), None);
    }

    #[test]
    fn y08_14_hostile_inputs_are_refused_before_any_folder_access() {
        let (_a, b, fs) = pair();
        let reads_before = fs.all_files().len();
        for text in ["", "CTPAIR1.", "CTPAIR1.AAAA", "x".repeat(5000).as_str(), "CTPAIR1.\u{0}", "CT1-ZZZZZ"] {
            let qr = code(b.core.key_import(KeyInput::QrText(Zeroizing::new(text.to_owned())), 1));
            assert_eq!(qr, SyncCode::InvalidPairing, "{text:.20}");
            b.clock.advance(3 * 60_000); // reste sous la limite de 5 appels par 10 minutes
        }
        assert_eq!(fs.all_files().len(), reads_before);
        assert_eq!(b.vault.get(SYNC_KEY_ACCOUNT).unwrap(), None);
    }
}
