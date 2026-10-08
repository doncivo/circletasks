//! Fuseau local de la boîte « Oublier cet appareil » (ADR 0011 §23 point 4 ; Y-IOS-02 critère 15) : `local_offset_minutes` rend None quand
//! le fuseau est illisible, et l'heure est alors affichée en UTC **en le disant** (jamais une heure locale fausse sans le dire). Les cas
//! `localtime_r` (iOS, Linux) sont sous `cfg(unix)` : exécutés par le runner Linux de `tests.yml` ; sous Windows, le fuseau du système.

use circletasks_lib::sync::forget::{forget_dialog_detail, local_offset_minutes};
use circletasks_lib::sync::state::PublishedState;
use serde_json::json;

const DEV: &str = "5c6d7e8f-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
/// 2026-07-15T08:00:00Z.
const SUMMER_MS: u64 = 1_784_102_400_000;

fn state_at(ms: u64) -> PublishedState {
    let hlc = format!("{ms:015}-0000-{DEV}");
    serde_json::from_value(json!({
        "deviceId": DEV, "platform": "windows", "appVersion": "0.1.1", "sm": 1, "sv": 14, "epoch": format!("e0001-{DEV}"), "stateSeq": 1,
        "head": { "epoch": format!("e0001-{DEV}"), "segment": 0, "record": 0, "hlc": null, "stateSeq": 1 },
        "acks": {}, "snapshot": null, "purgeHorizon": null, "lastSyncHlc": hlc, "forgotten": [], "reset": null
    }))
    .expect("état")
}

#[test]
fn y_ios_02_15_unknown_zone_shows_the_utc_time_and_says_so() {
    let state = state_at(SUMMER_MS);
    let unknown = forget_dialog_detail(DEV, Some(&state), None);
    assert!(unknown.ends_with("le 15/07/2026 à 08:00 UTC"), "{unknown}");
    let paris = forget_dialog_detail(DEV, Some(&state), Some(120));
    assert!(paris.ends_with("le 15/07/2026 à 10:00"), "{paris}");
    assert!(!paris.contains("UTC"));
}

#[test]
fn y_ios_02_15_system_zone_is_read_here() {
    let log = circletasks_lib::sync::log::capture();
    assert!(local_offset_minutes(SUMMER_MS).is_some());
    assert!(!log.lines().iter().any(|l| l.contains("tz-unknown")));
}

#[cfg(unix)]
mod unix {
    use super::*;

    /// 2026-01-15T08:00:00Z.
    const WINTER_MS: u64 = 1_768_464_000_000;
    /// Passage à l'heure d'été à Paris : 2026-03-29T01:00:00Z.
    const SPRING_MS: u64 = 1_774_746_000_000;

    fn with_tz<T>(tz: &str, run: impl FnOnce() -> T) -> T {
        let previous = std::env::var_os("TZ");
        std::env::set_var("TZ", tz);
        let out = run();
        match previous {
            Some(value) => std::env::set_var("TZ", value),
            None => std::env::remove_var("TZ"),
        }
        out
    }

    #[test]
    fn y_ios_02_15_summer_and_winter_offsets() {
        with_tz("Europe/Paris", || {
            assert_eq!(local_offset_minutes(SUMMER_MS), Some(120));
            assert_eq!(local_offset_minutes(WINTER_MS), Some(60));
        });
        with_tz("America/New_York", || {
            assert_eq!(local_offset_minutes(SUMMER_MS), Some(-240));
            assert_eq!(local_offset_minutes(WINTER_MS), Some(-300));
        });
    }

    #[test]
    fn y_ios_02_15_daylight_saving_switch() {
        with_tz("Europe/Paris", || {
            assert_eq!(local_offset_minutes(SPRING_MS - 1_000), Some(60));
            assert_eq!(local_offset_minutes(SPRING_MS), Some(120));
        });
    }

    #[test]
    fn y_ios_02_15_unreadable_time_gives_none_and_logs_the_code_only() {
        let log = circletasks_lib::sync::log::capture();
        // Instant hors de toute date représentable : `localtime_r` échoue.
        assert_eq!(local_offset_minutes(u64::MAX), None);
        assert!(log.lines().iter().any(|l| l == "sync:tz-unknown utc"));
        // Fuseau inconnu de la bibliothèque C : lu comme UTC (décalage 0), jamais une erreur.
        with_tz("Fuseau/Inexistant", || assert_eq!(local_offset_minutes(SUMMER_MS), Some(0)));
    }
}
