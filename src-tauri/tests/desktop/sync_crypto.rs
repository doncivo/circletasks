//! Y-08 critères 1 à 5, 8 et 19 : chiffrement, bourrage, AAD, dérivations, clé de secours et QR ; vecteurs croisés partagés avec
//! Vitest (`tests/fixtures/sync/vectors.json`, codec de référence `tests/sim/syncCodec.ts`).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use circletasks_lib::sync::crypto::{
    aad_bytes, algorithm_shape, hex, key_from_recovery, pad, parse_line_prefix, parse_qr_text, qr_text_of, unpad, FileHeader, HeaderKind, MasterKey,
    OpenError, Place, RECOVERY_CHARS, SYNC_FORMAT_MAJOR,
};
use circletasks_lib::sync::limits::{
    encrypted_line_bytes, padded_plaintext_bytes, MAX_APPEND_CALL_BYTES, MAX_RECORD_LINE_BYTES, MAX_RECORD_PLAINTEXT_BYTES, SEGMENT_ROTATE_BYTES,
};
use serde_json::Value;

const VECTORS: &str = include_str!("../../../tests/fixtures/sync/vectors.json");
const LIMITS_TS: &str = include_str!("../../../src/domain/sync/limits.ts");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("vectors.json valide")
}

fn bytes_of_hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hexa")).collect()
}

fn key() -> MasterKey {
    MasterKey::from_bytes(&bytes_of_hex(vectors()["key"].as_str().unwrap())).unwrap()
}

/// Texte clair d'un vecteur : littéral, ou chaîne JSON `"aaa…"` de la longueur annoncée.
fn plaintext(spec: &Value) -> String {
    if let Some(json) = spec["json"].as_str() {
        return json.to_owned();
    }
    let n = spec["jsonStringBytes"].as_u64().unwrap() as usize;
    format!("\"{}\"", "a".repeat(n - 2))
}

/// Place d'un vecteur, avec des chaînes possédées.
struct OwnedPlace {
    kind: String,
    dev: String,
    epoch: String,
    a: u64,
    b: u64,
}

impl OwnedPlace {
    fn from(value: &Value) -> Self {
        let kind = value["kind"].as_str().unwrap().to_owned();
        let (a, b) = match kind.as_str() {
            "j" => (value["segment"].as_u64().unwrap(), value["index"].as_u64().unwrap()),
            "s" => (value["seq"].as_u64().unwrap(), value["index"].as_u64().unwrap()),
            _ => (value["stateSeq"].as_u64().unwrap(), 0),
        };
        Self { kind, dev: value["dev"].as_str().unwrap().to_owned(), epoch: value["epoch"].as_str().unwrap().to_owned(), a, b }
    }

    fn place(&self) -> Place<'_> {
        match self.kind.as_str() {
            "j" => Place::Journal { dev: &self.dev, epoch: &self.epoch, segment: self.a as u32, index: self.b },
            "s" => Place::Snapshot { dev: &self.dev, epoch: &self.epoch, seq: self.a as u32, index: self.b },
            _ => Place::State { dev: &self.dev, epoch: &self.epoch, state_seq: self.a },
        }
    }
}

fn sha256_hex(text: &str) -> String {
    hex(aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, text.as_bytes()).as_ref())
}

#[test]
fn y08_4_vectors_kid_record_key_and_recovery_key() {
    let v = vectors();
    let key = key();
    assert_eq!(key.kid(), v["kid"].as_str().unwrap());
    assert_eq!(key.recovery_key().as_str(), v["recoveryKey"].as_str().unwrap());
    for case in v["recoveryInputs"].as_array().unwrap() {
        let decoded = key_from_recovery(case["input"].as_str().unwrap());
        assert_eq!(decoded.is_some(), case["ok"].as_bool().unwrap(), "{}", case["input"]);
        if let Some(decoded) = decoded {
            assert!(decoded.same_as(&key));
        }
    }
}

#[test]
fn y08_4_vectors_aad_padding_headers() {
    let v = vectors();
    for case in v["aad"].as_array().unwrap() {
        let place = OwnedPlace::from(&case["place"]);
        let fields = place.place().aad_fields(case["sm"].as_u64().unwrap() as u32, case["sv"].as_u64().unwrap() as u32);
        assert_eq!(hex(&aad_bytes(&fields).unwrap()), case["hex"].as_str().unwrap());
    }
    for case in v["padding"].as_array().unwrap() {
        assert_eq!(padded_plaintext_bytes(case["jsonBytes"].as_u64().unwrap() as usize) as u64, case["paddedBytes"].as_u64().unwrap());
    }
    for case in v["headers"].as_array().unwrap() {
        let h = &case["header"];
        let kind = match h["f"].as_str().unwrap() {
            "ct-j" => HeaderKind::Journal,
            "ct-s" => HeaderKind::Snapshot,
            _ => HeaderKind::State,
        };
        let header = FileHeader::new(kind, h["kid"].as_str().unwrap(), h["dev"].as_str().unwrap(), h["e"].as_str().unwrap(), h["n"].as_u64().unwrap());
        assert_eq!(header.line(), case["line"].as_str().unwrap());
        assert_eq!(header.line().len() as u64 + 1, case["bytes"].as_u64().unwrap());
        assert_eq!(FileHeader::parse(case["line"].as_str().unwrap().as_bytes()), Some(header));
    }
}

#[test]
fn y08_4_vectors_lines_open_in_rust_and_rust_lines_have_the_same_length() {
    let v = vectors();
    let key = key();
    for case in v["records"].as_array().unwrap() {
        let place = OwnedPlace::from(&case["place"]);
        let (sm, sv) = (case["sm"].as_u64().unwrap() as u32, case["sv"].as_u64().unwrap() as u32);
        let json = plaintext(&case["plaintext"]);
        let line_bytes = case["lineBytes"].as_u64().unwrap() as usize;
        assert_eq!(encrypted_line_bytes(json.len(), sm, sv), line_bytes, "{}", case["name"]);
        // Ligne du codec TypeScript (nonce imposé) : Rust l'ouvre.
        if let Some(line) = case["line"].as_str() {
            let opened = key.open(&place.place(), line).unwrap_or_else(|_| panic!("ouverture {}", case["name"]));
            assert_eq!((opened.sm, opened.sv, opened.json.as_str()), (sm, sv, json.as_str()));
        }
        // Ligne de Rust (nonce de la bibliothèque) : même longueur, même contenu, nonce différent du vecteur.
        let sealed = key.seal(&place.place(), json.as_bytes(), sm, sv).unwrap();
        assert_eq!(sealed.len() + 1, line_bytes, "{}", case["name"]);
        assert_eq!(key.open(&place.place(), &sealed).ok().map(|o| o.json), Some(json.clone()));
        if let Some(digest) = case["lineSha256"].as_str() {
            assert_ne!(sha256_hex(&sealed), digest, "le nonce est tiré par la bibliothèque");
        }
    }
    // Lignes écrites une fois par Rust et gardées dans les vecteurs : Rust les relit (Vitest aussi).
    for case in v["rustSealed"].as_array().unwrap() {
        let place = OwnedPlace::from(&case["place"]);
        let opened = key.open(&place.place(), case["line"].as_str().unwrap()).expect("ligne Rust");
        assert_eq!(opened.json, case["json"].as_str().unwrap());
    }
}

#[test]
fn y08_4_limits_match_typescript_and_vectors() {
    // Mêmes valeurs que limits.ts (test croisé).
    let constant = |name: &str| -> u64 {
        let line = LIMITS_TS.lines().find(|l| l.starts_with(&format!("export const {name} = "))).unwrap_or_else(|| panic!("{name}"));
        let expr = line.split('=').nth(1).unwrap().trim().trim_end_matches(';').replace('_', "");
        expr.split('*').map(|part| match part.trim() {
            "KIB" => 1024,
            "MIB" => 1024 * 1024,
            "GIB" => 1024 * 1024 * 1024,
            n => n.parse::<u64>().unwrap_or_else(|_| panic!("{name} : {n}")),
        }).product()
    };
    assert_eq!(constant("MAX_RECORD_LINE_BYTES"), MAX_RECORD_LINE_BYTES as u64);
    assert_eq!(constant("MAX_RECORD_PLAINTEXT_BYTES"), MAX_RECORD_PLAINTEXT_BYTES as u64);
    assert_eq!(constant("SEGMENT_ROTATE_BYTES"), SEGMENT_ROTATE_BYTES);
    assert_eq!(constant("MAX_APPEND_CALL_BYTES"), MAX_APPEND_CALL_BYTES);
    assert_eq!(constant("MAX_SEGMENT_BYTES"), circletasks_lib::sync::limits::MAX_SEGMENT_BYTES);
    assert_eq!(constant("MAX_SNAPSHOT_BYTES"), circletasks_lib::sync::limits::MAX_SNAPSHOT_BYTES);
    assert_eq!(constant("MAX_DEVICE_FOLDERS"), circletasks_lib::sync::limits::MAX_DEVICE_FOLDERS as u64);
    assert_eq!(constant("MAX_SCAN_ENTRIES_PER_FOLDER"), circletasks_lib::sync::limits::MAX_SCAN_ENTRIES_PER_FOLDER as u64);
    assert_eq!(constant("FOLDER_STOP_BYTES"), circletasks_lib::sync::limits::FOLDER_STOP_BYTES);
    // Plafonds exacts : 1 Mio d'octets écrits (vecteurs croisés).
    let v = vectors();
    let group = |groups: &Value| -> u64 {
        groups.as_array().unwrap().iter().map(|g| g["count"].as_u64().unwrap() * encrypted_line_bytes(4096 * g["blocks"].as_u64().unwrap() as usize - 4, 1, g["sv"].as_u64().unwrap() as u32) as u64).sum()
    };
    assert_eq!(group(&v["limits"]["appendCall"]["accepted"]), MAX_APPEND_CALL_BYTES);
    assert_eq!(group(&v["limits"]["appendCall"]["refused"]), MAX_APPEND_CALL_BYTES + 1);
    let s = &v["limits"]["segment"];
    let prefix = s["headerBytes"].as_u64().unwrap() + group(&s["prefix"]);
    let last = |sv: &str| encrypted_line_bytes(4096 * s["last"]["blocks"].as_u64().unwrap() as usize - 4, 1, s["last"][sv].as_u64().unwrap() as u32) as u64;
    assert_eq!(prefix + last("acceptedSv"), SEGMENT_ROTATE_BYTES);
    assert_eq!(prefix + last("refusedSv"), SEGMENT_ROTATE_BYTES + 1);
}

#[test]
fn y08_1_two_seals_differ_and_open_to_the_same_text() {
    let key = MasterKey::generate().unwrap();
    let place = Place::Journal { dev: "3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", epoch: "e0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", segment: 1, index: 0 };
    let a = key.seal(&place, b"{\"title\":\"Pain\"}", 1, 14).unwrap();
    let b = key.seal(&place, b"{\"title\":\"Pain\"}", 1, 14).unwrap();
    assert_ne!(a, b);
    assert!(a.starts_with("1.14."));
    let payload = URL_SAFE_NO_PAD.decode(parse_line_prefix(&a).unwrap().payload).unwrap();
    assert_eq!(payload.len(), 12 + 4096 + 16, "nonce ‖ 4 Kio bourrés ‖ étiquette");
    assert_eq!(algorithm_shape(), (12, 16));
    assert_eq!(key.open(&place, &a).unwrap().json, "{\"title\":\"Pain\"}");
    assert_eq!(key.open(&place, &b).unwrap().json, "{\"title\":\"Pain\"}");
}

#[test]
fn y08_2_padding_hides_size_and_rejects_tampering() {
    for (json, padded) in [(1usize, 4096usize), (5_000, 8_192), (4_092, 4_096), (4_093, 8_192)] {
        let data = vec![b'x'; json];
        let p = pad(&data);
        assert_eq!(p.len(), padded);
        assert_eq!(unpad(&p), Some(&data[..]));
    }
    let mut dirty = pad(b"{}").to_vec();
    dirty[200] = 1;
    assert_eq!(unpad(&dirty), None, "bourrage non nul");
    let mut lying = pad(b"{}").to_vec();
    lying[2] = 0x0f;
    lying[3] = 0xfd;
    assert_eq!(unpad(&lying), None, "longueur annoncée hors du palier");
}

#[test]
fn y08_3_moved_reordered_copied_or_relabelled_records_do_not_open() {
    let key = MasterKey::generate().unwrap();
    let dev = "3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";
    let other = "7d4e1a2b-3c5f-4a6b-8d7e-9f0a1b2c3d4e";
    let e1 = "e0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";
    let e2 = "e0002-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";
    let place = Place::Journal { dev, epoch: e1, segment: 2, index: 5 };
    let line = key.seal(&place, b"{}", 1, 14).unwrap();
    for moved in [
        Place::Journal { dev, epoch: e1, segment: 3, index: 5 },
        Place::Journal { dev, epoch: e1, segment: 2, index: 4 },
        Place::Journal { dev: other, epoch: e1, segment: 2, index: 5 },
        Place::Journal { dev, epoch: e2, segment: 2, index: 5 },
        Place::Snapshot { dev, epoch: e1, seq: 2, index: 5 },
    ] {
        assert_eq!(key.open(&moved, &line).err(), Some(OpenError::Decrypt));
    }
    assert_eq!(key.open(&place, &line.replacen("1.14.", "1.15.", 1)).err(), Some(OpenError::Decrypt));
    assert_eq!(key.open(&place, &line.replacen("1.14.", "2.14.", 1)).err(), Some(OpenError::Decrypt));
    assert_eq!(key.open(&place, &line.replacen("1.14.", "01.14.", 1)).err(), Some(OpenError::Malformed));
    let other_key = MasterKey::generate().unwrap();
    assert_eq!(other_key.open(&place, &line).err(), Some(OpenError::Decrypt));
    // État : autre époque ou autre stateSeq.
    let state = Place::State { dev, epoch: e1, state_seq: 7 };
    let line = key.seal(&state, b"{}", 1, 14).unwrap();
    assert!(key.open(&state, &line).is_ok());
    assert!(key.open(&Place::State { dev, epoch: e1, state_seq: 8 }, &line).is_err());
    assert!(key.open(&Place::State { dev, epoch: e2, state_seq: 7 }, &line).is_err());
}

#[test]
fn y08_2_line_length_is_checked_before_base64() {
    let key = MasterKey::generate().unwrap();
    let place = Place::Journal { dev: "3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", epoch: "e0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", segment: 1, index: 0 };
    let long = format!("1.1.{}", "A".repeat(MAX_RECORD_LINE_BYTES));
    assert!(parse_line_prefix(&long).is_none());
    assert_eq!(key.open(&place, &long).err(), Some(OpenError::Malformed));
    assert_eq!(key.open(&place, "1.1.AAAA").err(), Some(OpenError::Malformed), "longueur incompatible avec un palier");
    assert!(key.seal(&place, &vec![b'a'; MAX_RECORD_PLAINTEXT_BYTES + 1], 1, 1).is_err());
    assert!(key.seal(&place, &vec![b'a'; MAX_RECORD_PLAINTEXT_BYTES], 1, 999_999).unwrap().len() < MAX_RECORD_LINE_BYTES);
}

#[test]
fn y08_5_kid_is_16_hex_and_reveals_nothing_of_the_key() {
    for _ in 0..8 {
        let key = MasterKey::generate().unwrap();
        assert_eq!(key.kid().len(), 16);
        assert!(key.kid().bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        let raw_hex = hex(&URL_SAFE_NO_PAD.decode(qr_key(&key)).unwrap());
        assert!(!raw_hex.contains(key.kid()));
    }
}

fn qr_key(key: &MasterKey) -> String {
    let text = qr_text_of(key, "3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60", None, 1);
    let json = URL_SAFE_NO_PAD.decode(text.strip_prefix("CTPAIR1.").unwrap()).unwrap();
    let value: Value = serde_json::from_slice(&json).unwrap();
    value["k"].as_str().unwrap().to_owned()
}

/// Le type de la clé n'implémente ni `Debug` ni `Serialize` (test de compilation : l'appel serait ambigu sinon).
#[test]
fn y08_5_key_types_have_no_debug_nor_serialize() {
    trait AmbiguousIfDebug<A> {
        fn some_item() {}
    }
    impl<T: ?Sized> AmbiguousIfDebug<()> for T {}
    impl<T: ?Sized + std::fmt::Debug> AmbiguousIfDebug<u8> for T {}
    trait AmbiguousIfSerialize<A> {
        fn some_item() {}
    }
    impl<T: ?Sized> AmbiguousIfSerialize<()> for T {}
    impl<T: ?Sized + serde::Serialize> AmbiguousIfSerialize<u8> for T {}
    trait AmbiguousIfClone<A> {
        fn some_item() {}
    }
    impl<T: ?Sized> AmbiguousIfClone<()> for T {}
    impl<T: Clone> AmbiguousIfClone<u8> for T {}
    <MasterKey as AmbiguousIfDebug<_>>::some_item();
    <MasterKey as AmbiguousIfSerialize<_>>::some_item();
    <MasterKey as AmbiguousIfClone<_>>::some_item();
    <circletasks_lib::sync::crypto::QrContent as AmbiguousIfDebug<_>>::some_item();
}

#[test]
fn y08_8_recovery_key_round_trip_tolerant_input_and_checksum() {
    let key = MasterKey::generate().unwrap();
    let recovery = key.recovery_key();
    assert!(recovery.starts_with("CT1-"));
    let body: String = recovery.chars().skip(4).filter(|c| *c != '-').collect();
    assert_eq!(body.len(), RECOVERY_CHARS);
    assert_eq!(RECOVERY_CHARS, 55);
    assert_eq!(recovery.split('-').skip(1).map(str::len).collect::<Vec<_>>(), vec![5; 11]);
    assert!(key_from_recovery(&recovery).unwrap().same_as(&key));
    let tolerant = recovery.to_lowercase().replace('-', " ").replace('0', "o").replace('1', "l");
    assert!(key_from_recovery(&tolerant).unwrap().same_as(&key));
    let mut wrong = body.clone();
    let last = wrong.pop().unwrap();
    wrong.push(if last == '0' { '4' } else { '0' });
    assert!(key_from_recovery(&wrong).is_none(), "somme de contrôle fausse");
    assert!(key_from_recovery("CT1-AAAAA").is_none());
    assert!(key_from_recovery(&"0".repeat(10_000)).is_none());
}

#[test]
fn y08_qr_text_round_trip_and_strictness() {
    let key = MasterKey::generate().unwrap();
    let dev = "3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";
    let epoch = "e0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";
    let text = qr_text_of(&key, dev, Some(epoch), 1_790_000_000_000);
    let parsed = parse_qr_text(&text).unwrap();
    assert!(parsed.key.same_as(&key));
    assert_eq!((parsed.device_id.as_str(), parsed.epoch.as_deref(), parsed.expires_at), (dev, Some(epoch), 1_790_000_000_000));
    // Vecteur du codec TypeScript.
    let v = vectors();
    let ts = parse_qr_text(v["qr"]["text"].as_str().unwrap()).unwrap();
    assert!(ts.key.same_as(&self::key()));
    let encode = |json: &str| format!("CTPAIR1.{}", URL_SAFE_NO_PAD.encode(json));
    let k = qr_key(&key);
    assert!(parse_qr_text(&encode(&format!(r#"{{"v":1,"k":"{k}","d":"{dev}","e":null,"x":1}}"#))).is_some());
    for bad in [
        format!(r#"{{"v":1,"k":"{k}","d":"{dev}","x":1}}"#),
        format!(r#"{{"v":1,"k":"{k}","d":"{dev}","e":null,"x":1,"z":0}}"#),
        format!(r#"{{"v":1,"k":"{k}","k":"{k}","d":"{dev}","e":null,"x":1}}"#),
        format!(r#"{{"v":2,"k":"{k}","d":"{dev}","e":null,"x":1}}"#),
        format!(r#"{{"v":1,"k":"{k}","d":"{dev}","e":null,"x":1.0}}"#),
        format!(r#"{{"v":1,"k":"AAAA","d":"{dev}","e":null,"x":1}}"#),
        format!(r#"{{"v":1,"k":"{k}","d":"not-a-uuid","e":null,"x":1}}"#),
    ] {
        assert!(parse_qr_text(&encode(&bad)).is_none(), "{bad}");
    }
    assert!(parse_qr_text(&text.replacen("CTPAIR1.", "CTPAIR2.", 1)).is_none());
    assert!(parse_qr_text(&format!("CTPAIR1.{}", "A".repeat(2000))).is_none());
}

#[test]
fn y08_header_is_strict() {
    let good = r#"{"f":"ct-j","sm":1,"kid":"0123456789abcdef","dev":"3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60","e":"e0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60","n":1}"#;
    assert!(FileHeader::parse(good.as_bytes()).is_some());
    for bad in [
        good.replace(r#""n":1"#, r#""n":1,"x":2"#),
        good.replace(r#""n":1"#, r#""n":0"#),
        good.replace(r#""n":1"#, r#""n":1.0"#),
        good.replace(r#""f":"ct-j""#, r#""f":"ct-x""#),
        good.replace("0123456789abcdef", "0123456789ABCDEF"),
        good.replace(r#""sm":1"#, r#""sm":1,"sm":1"#),
        format!("{}{}", good, " ".repeat(1100)),
    ] {
        assert!(FileHeader::parse(bad.as_bytes()).is_none(), "{bad}");
    }
    assert_eq!(SYNC_FORMAT_MAJOR, 1);
}

/// Écrit la section `rustSealed` des vecteurs (à lancer à la main : `cargo test --test desktop -- --ignored print_rust_sealed --nocapture`).
#[test]
#[ignore = "génération ponctuelle des vecteurs"]
fn print_rust_sealed() {
    let key = key();
    let dev = "3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";
    let epoch = "e0001-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60";
    let mut out = Vec::new();
    for (place, json, sv) in [
        (serde_json::json!({ "kind": "j", "dev": dev, "epoch": epoch, "segment": 1, "index": 0 }), "{\"k\":\"ops\",\"sv\":14,\"ops\":[]}", 14u32),
        (serde_json::json!({ "kind": "state", "dev": dev, "epoch": epoch, "stateSeq": 5 }), "{\"rust\":true}", 14u32),
    ] {
        let owned = OwnedPlace::from(&place);
        let line = key.seal(&owned.place(), json.as_bytes(), 1, sv).unwrap();
        out.push(serde_json::json!({ "place": place, "sm": 1, "sv": sv, "json": json, "line": line }));
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
