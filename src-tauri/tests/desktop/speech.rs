//! CAP-IOS-01 (ADR 0015 §2) : commandes de dictée sur l'appareil jouées avec un faux transport qui parle exactement le JSON du contrat
//! (`tests/fixtures/capture/speech-contract.json`) : une seule écoute à la fois (critère 10), limite de 60 s tenue par Rust (le délai est
//! réduit dans les tests, jamais allongé), `speech_stop` sans écoute sans effet, codes d'erreur, plugin absent ou muet visible, aucun
//! texte reconnu ni état d'autorisation dans un message, aucune API de fichier ni de réseau.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use circletasks_lib::speech::{
    listen_code_of, listen_with, open_settings_with, permission_state, request_permissions_with, status_with, stop_with, Limits, SpeechState, SpeechTransport, PLUGIN_COMMANDS,
    PLUGIN_REJECT_CODES,
};
use serde_json::{json, Value};

const CONTRACT: &str = include_str!("../../../tests/fixtures/capture/speech-contract.json");
const SPEECH_RS: &str = include_str!("../../src/speech/mod.rs");
const SPEECH_IOS_RS: &str = include_str!("../../src/speech/ios.rs");

fn contract() -> Value {
    serde_json::from_str(CONTRACT).expect("contrat valide")
}

fn contract_keys(list: &Value) -> BTreeSet<String> {
    list.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

/// Comportement de `listen` du faux.
#[derive(Clone)]
enum Listen {
    /// Rend aussitôt ce texte (`stoppedBy: "user"`).
    Immediate(&'static str),
    /// Attend `stop`, puis rend le texte avec la cause reçue.
    WaitForStop(&'static str),
    /// Rejette ce code.
    Reject(&'static str),
    /// Ne répond qu'après ce temps (plugin muet).
    Hang(Duration),
}

struct FakeSpeech {
    listen: Mutex<Listen>,
    listening: AtomicBool,
    stop: Mutex<Option<String>>,
    wake: Condvar,
    calls: Mutex<Vec<(String, Value)>>,
    status: Mutex<Result<Value, String>>,
    permissions: Mutex<Result<Value, String>>,
    settings: Mutex<Result<Value, String>>,
}

impl FakeSpeech {
    fn new(listen: Listen) -> Arc<Self> {
        Arc::new(Self {
            listen: Mutex::new(listen),
            listening: AtomicBool::new(false),
            stop: Mutex::new(None),
            wake: Condvar::new(),
            calls: Mutex::new(Vec::new()),
            status: Mutex::new(Ok(json!({ "recognizer": true, "onDevice": true, "microphone": "granted", "speechRecognition": "granted" }))),
            permissions: Mutex::new(Ok(json!({ "microphone": "granted", "speechRecognition": "granted" }))),
            settings: Mutex::new(Ok(json!({ "opened": true }))),
        })
    }

    fn calls_of(&self, command: &str) -> Vec<Value> {
        self.calls.lock().unwrap().iter().filter(|(name, _)| name == command).map(|(_, args)| args.clone()).collect()
    }

    fn total_calls(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

struct Shared(Arc<FakeSpeech>);

impl SpeechTransport for Shared {
    fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        let fake = &self.0;
        let contract = contract();
        let spec = &contract["commands"][command];
        assert!(spec.is_object(), "commande hors contrat : {command}");
        let sent: BTreeSet<String> = args.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
        assert_eq!(sent, contract_keys(&spec["input"]), "{command} : champs d'entrée hors contrat");
        fake.calls.lock().unwrap().push((command.to_owned(), args.clone()));
        let response: Result<Value, String> = match command {
            "status" => fake.status.lock().unwrap().clone(),
            "requestPermissions" => fake.permissions.lock().unwrap().clone(),
            "openAppSettings" => fake.settings.lock().unwrap().clone(),
            "stop" => {
                let reason = args["reason"].as_str().unwrap().to_owned();
                assert!(contract_keys(&contract["stopReasons"]).contains(&reason), "cause d'arrêt hors contrat : {reason}");
                if fake.listening.load(Ordering::SeqCst) {
                    *fake.stop.lock().unwrap() = Some(reason);
                    fake.wake.notify_all();
                    Ok(json!({ "stopped": true }))
                } else {
                    Ok(json!({ "stopped": false }))
                }
            }
            "listen" => {
                assert_eq!(args["locale"], "fr-FR");
                assert!(args["maxDurationMs"].as_u64().unwrap() > 0);
                if fake.listening.swap(true, Ordering::SeqCst) {
                    return Err("busy".to_owned());
                }
                let behaviour = fake.listen.lock().unwrap().clone();
                let result = match behaviour {
                    Listen::Immediate(text) => Ok(json!({ "text": text, "stoppedBy": "user" })),
                    Listen::Reject(code) => Err(code.to_owned()),
                    Listen::Hang(duration) => {
                        std::thread::sleep(duration);
                        Ok(json!({ "text": "tard", "stoppedBy": "user" }))
                    }
                    Listen::WaitForStop(text) => {
                        let mut stop = fake.stop.lock().unwrap();
                        while stop.is_none() {
                            stop = fake.wake.wait(stop).unwrap();
                        }
                        Ok(json!({ "text": text, "stoppedBy": stop.take().unwrap() }))
                    }
                };
                fake.listening.store(false, Ordering::SeqCst);
                result
            }
            other => panic!("commande inconnue : {other}"),
        };
        if let Ok(value) = &response {
            let shapes = spec["output"].as_array().unwrap();
            let keys: BTreeSet<String> = value.as_object().unwrap().keys().cloned().collect();
            assert!(shapes.iter().any(|shape| contract_keys(shape) == keys), "{command} : forme de réponse hors contrat : {value}");
        }
        response
    }
}

fn transport(fake: &Arc<FakeSpeech>) -> Arc<dyn SpeechTransport> {
    Arc::new(Shared(fake.clone()))
}

fn quick() -> Limits {
    Limits { max_listen: Duration::from_secs(30), swift_cap: Duration::from_secs(35), listen_deadline: Duration::from_secs(40), ..Limits::default() }
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn wait_until(condition: impl Fn() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < Duration::from_secs(10), "condition jamais remplie");
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Écoute
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn cap_ios_01_10_listen_returns_the_text_and_releases_the_flag() {
    let fake = FakeSpeech::new(Listen::Immediate("Appeler le plombier demain 9 h"));
    let state = SpeechState::default();
    let outcome = run(listen_with(transport(&fake), &state, "fr-FR", quick())).expect("écoute");
    assert_eq!((outcome.text.as_str(), outcome.stopped_by), ("Appeler le plombier demain 9 h", "user"));
    assert!(!state.is_listening());
    assert_eq!(serde_json::to_value(&outcome).unwrap(), json!({ "text": "Appeler le plombier demain 9 h", "stoppedBy": "user" }));
    // Le plugin a reçu la langue et la butée de Swift (65 s par défaut ; ici 35 s).
    assert_eq!(fake.calls_of("listen"), [json!({ "locale": "fr-FR", "maxDurationMs": 35_000 })]);
}

#[test]
fn cap_ios_01_10_only_one_listen_at_a_time_and_the_second_is_refused_busy() {
    let fake = FakeSpeech::new(Listen::WaitForStop("bonjour"));
    let state = SpeechState::default();
    let first = {
        let (transport, state) = (transport(&fake), state.clone());
        tauri::async_runtime::spawn(async move { listen_with(transport, &state, "fr-FR", quick()).await })
    };
    wait_until(|| state.is_listening() && fake.total_calls() > 0);
    let second = run(listen_with(transport(&fake), &state, "fr-FR", quick())).expect_err("seconde écoute");
    assert_eq!(second.code, "speech-busy");
    assert_eq!(fake.calls_of("listen").len(), 1, "la seconde écoute n'atteint jamais le plugin");
    // « Terminer » : le texte déjà reconnu est rendu.
    let stopped = stop_with(&transport(&fake), &state, &Limits::default());
    assert!(stopped.stopped);
    assert_eq!(fake.calls_of("stop"), [json!({ "reason": "user" })]);
    let outcome = run(first).expect("tâche").expect("écoute");
    assert_eq!((outcome.text.as_str(), outcome.stopped_by), ("bonjour", "user"));
    wait_until(|| !state.is_listening());
}

#[test]
fn cap_ios_01_10_the_sixty_second_limit_is_enforced_by_rust_and_returns_the_text() {
    let fake = FakeSpeech::new(Listen::WaitForStop("texte déjà reconnu"));
    let state = SpeechState::default();
    // La limite est réduite pour le test (80 ms) : la logique est identique à celle de 60 s.
    let limits = Limits { max_listen: Duration::from_millis(80), ..quick() };
    let start = Instant::now();
    let outcome = run(listen_with(transport(&fake), &state, "fr-FR", limits)).expect("écoute");
    assert!(start.elapsed() < Duration::from_secs(5));
    assert_eq!((outcome.text.as_str(), outcome.stopped_by), ("texte déjà reconnu", "time-limit"));
    assert_eq!(fake.calls_of("stop"), [json!({ "reason": "time-limit" })]);
    assert_eq!(Limits::default().max_listen, Duration::from_secs(60));
    assert_eq!(Limits::default().swift_cap, Duration::from_secs(65));
    assert_eq!(Limits::default().listen_deadline, Duration::from_secs(70));
    wait_until(|| !state.is_listening());
}

#[test]
fn cap_ios_01_10_an_early_end_cancels_the_limit_timer() {
    let fake = FakeSpeech::new(Listen::Immediate("court"));
    let state = SpeechState::default();
    let limits = Limits { max_listen: Duration::from_millis(150), ..quick() };
    run(listen_with(transport(&fake), &state, "fr-FR", limits)).expect("écoute");
    std::thread::sleep(Duration::from_millis(400));
    assert!(fake.calls_of("stop").is_empty(), "le minuteur ne réveille pas une écoute terminée");
}

#[test]
fn cap_ios_01_10_stop_without_listening_has_no_effect_and_does_not_call_the_plugin() {
    let fake = FakeSpeech::new(Listen::Immediate("x"));
    let state = SpeechState::default();
    let outcome = stop_with(&transport(&fake), &state, &Limits::default());
    assert!(!outcome.stopped);
    assert_eq!(serde_json::to_value(outcome).unwrap(), json!({ "stopped": false }));
    assert_eq!(fake.total_calls(), 0);
}

#[test]
fn cap_ios_01_a_locale_other_than_french_is_refused_before_the_plugin() {
    let fake = FakeSpeech::new(Listen::Immediate("x"));
    let state = SpeechState::default();
    for locale in ["en-US", "fr-CA", "", "fr-FR "] {
        let error = run(listen_with(transport(&fake), &state, locale, quick())).expect_err(locale);
        assert_eq!(error.code, "speech-failed");
    }
    assert_eq!(fake.total_calls(), 0);
    assert!(!state.is_listening());
}

// ------------------------------------------------------------------------------------------------------------------------------
// Codes d'erreur et plugin muet
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn cap_ios_01_every_swift_code_maps_to_the_documented_rust_code() {
    let contract = contract();
    let swift_codes: BTreeSet<&str> = contract["rejectCodes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(swift_codes, PLUGIN_REJECT_CODES.iter().copied().collect::<BTreeSet<_>>(), "codes de speech/mod.rs = contrat");
    let commands: BTreeSet<&str> = contract["commands"].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(commands, PLUGIN_COMMANDS.iter().copied().collect::<BTreeSet<_>>(), "commandes de speech/mod.rs = contrat");
    let mapping = contract["swiftToRust"].as_object().unwrap();
    assert_eq!(mapping.keys().map(String::as_str).collect::<BTreeSet<_>>(), swift_codes);
    for (swift, rust) in mapping {
        assert_eq!(listen_code_of(swift), rust.as_str().unwrap(), "{swift}");
        let fake = FakeSpeech::new(Listen::Reject(Box::leak(swift.clone().into_boxed_str())));
        let error = run(listen_with(transport(&fake), &SpeechState::default(), "fr-FR", quick())).expect_err(swift);
        assert_eq!(error.code, rust.as_str().unwrap(), "{swift}");
        assert_eq!(error.message, *swift, "le message ne porte que le code du plugin");
    }
    assert_eq!(listen_code_of("unavailable"), "speech-unavailable");
    assert_eq!(listen_code_of("code-inconnu"), "speech-failed");
}

#[test]
fn cap_ios_01_12_without_the_offline_model_listen_is_refused_once_and_never_retried_online() {
    let fake = FakeSpeech::new(Listen::Reject("on-device-unavailable"));
    let state = SpeechState::default();
    let error = run(listen_with(transport(&fake), &state, "fr-FR", quick())).expect_err("refus");
    assert_eq!(error.code, "speech-on-device-unavailable");
    // Une seule tentative auprès du plugin, aucun arrêt, aucun autre appel : pas de repli.
    assert_eq!(fake.calls_of("listen").len(), 1);
    assert_eq!(fake.total_calls(), 1);
    assert!(!state.is_listening());
}

#[test]
fn cap_ios_01_10_error_messages_never_carry_recognized_text_or_system_text() {
    let fake = FakeSpeech::new(Listen::Reject("Erreur : Appeler le plombier /var/mobile"));
    let error = run(listen_with(transport(&fake), &SpeechState::default(), "fr-FR", quick())).expect_err("rejet");
    assert_eq!(error.code, "speech-failed");
    assert_eq!(error.message, "failed");
    let json = serde_json::to_string(&error).unwrap();
    assert!(!json.contains("plombier") && !json.contains("/var"), "{json}");
}

#[test]
fn cap_ios_01_17_a_silent_plugin_is_visible_not_frozen() {
    let fake = FakeSpeech::new(Listen::Hang(Duration::from_millis(700)));
    let state = SpeechState::default();
    let limits = Limits { listen_deadline: Duration::from_millis(60), ..quick() };
    let start = Instant::now();
    let error = run(listen_with(transport(&fake), &state, "fr-FR", limits)).expect_err("délai");
    assert!(start.elapsed() < Duration::from_millis(600), "l'appelant n'attend que le délai");
    assert_eq!(error.code, "speech-timeout");
    // Swift n'a pas fini : une seconde écoute est refusée `busy` (visible), puis le drapeau est rendu à la vraie fin de l'appel.
    assert!(state.is_listening());
    assert_eq!(run(listen_with(transport(&fake), &state, "fr-FR", quick())).expect_err("busy").code, "speech-busy");
    wait_until(|| !state.is_listening());
}

#[test]
fn cap_ios_01_17_status_of_an_absent_or_mute_plugin_is_unavailable_with_a_reason() {
    for failure in [Err("unavailable".to_owned()), Err("failed".to_owned())] {
        let fake = FakeSpeech::new(Listen::Immediate("x"));
        *fake.status.lock().unwrap() = failure;
        let status = status_with(&transport(&fake), &Limits::default());
        assert!(!status.available);
        assert_eq!(status.reason, Some("plugin-unavailable"));
        assert_eq!((status.microphone, status.speech_recognition), ("unknown", "unknown"));
    }
    // Pas de reconnaisseur français : indisponible avec une raison propre.
    let fake = FakeSpeech::new(Listen::Immediate("x"));
    *fake.status.lock().unwrap() = Ok(json!({ "recognizer": false, "onDevice": false, "microphone": "granted", "speechRecognition": "granted" }));
    let status = status_with(&transport(&fake), &Limits::default());
    assert!(!status.available);
    assert_eq!(status.reason, Some("recognizer-unavailable"));
    // Délai dépassé : même résultat visible, jamais un blocage.
    let hung = FakeSpeech::new(Listen::Immediate("x"));
    struct Slow(Arc<FakeSpeech>);
    impl SpeechTransport for Slow {
        fn call(&self, command: &str, args: Value) -> Result<Value, String> {
            std::thread::sleep(Duration::from_millis(400));
            Shared(self.0.clone()).call(command, args)
        }
    }
    let slow: Arc<dyn SpeechTransport> = Arc::new(Slow(hung));
    let limits = Limits { status: Duration::from_millis(40), ..Limits::default() };
    assert_eq!(status_with(&slow, &limits).reason, Some("plugin-unavailable"));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Autorisations (I-05)
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn i_05_status_reads_the_five_states_and_flags_anything_else_unknown() {
    let fake = FakeSpeech::new(Listen::Immediate("x"));
    for state in ["granted", "denied", "restricted", "prompt"] {
        *fake.status.lock().unwrap() = Ok(json!({ "recognizer": true, "onDevice": true, "microphone": state, "speechRecognition": state }));
        let status = status_with(&transport(&fake), &Limits::default());
        assert_eq!((status.microphone, status.speech_recognition), (state, state));
        assert!(status.available && status.on_device && status.reason.is_none());
    }
    *fake.status.lock().unwrap() = Ok(json!({ "recognizer": true, "onDevice": false, "microphone": "limited", "speechRecognition": 3 }));
    let status = status_with(&transport(&fake), &Limits::default());
    assert_eq!((status.microphone, status.speech_recognition), ("unknown", "unknown"));
    assert!(status.available && !status.on_device, "disponible mais hors ligne absent : le bouton reste affiché");
    assert_eq!(permission_state(None), "unknown");
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        json!({ "available": true, "onDevice": false, "microphone": "unknown", "speechRecognition": "unknown" }),
        "pas de `reason` quand le service est disponible"
    );
    // Lire l'état ne demande rien : aucune demande d'autorisation n'est émise par `status`.
    assert!(fake.calls_of("requestPermissions").is_empty());
}

#[test]
fn i_05_request_permissions_returns_both_states_read_afterwards() {
    let fake = FakeSpeech::new(Listen::Immediate("x"));
    *fake.permissions.lock().unwrap() = Ok(json!({ "microphone": "granted", "speechRecognition": "denied" }));
    let result = request_permissions_with(&transport(&fake), &Limits::default()).expect("demande");
    assert_eq!((result.microphone, result.speech_recognition), ("granted", "denied"));
    assert_eq!(serde_json::to_value(&result).unwrap(), json!({ "microphone": "granted", "speechRecognition": "denied" }));
    assert_eq!(fake.calls_of("requestPermissions").len(), 1);
    *fake.permissions.lock().unwrap() = Err("unavailable".to_owned());
    assert_eq!(request_permissions_with(&transport(&fake), &Limits::default()).expect_err("échec").code, "speech-unavailable");
}

#[test]
fn i_05_open_settings_reports_success_or_a_visible_failure() {
    let fake = FakeSpeech::new(Listen::Immediate("x"));
    assert!(open_settings_with(&transport(&fake), &Limits::default()).expect("ouverture").opened);
    *fake.settings.lock().unwrap() = Ok(json!({ "opened": false }));
    assert!(!open_settings_with(&transport(&fake), &Limits::default()).expect("réponse").opened, "refus d'iOS : `opened: false`, jamais un succès");
    *fake.settings.lock().unwrap() = Err("failed".to_owned());
    assert_eq!(open_settings_with(&transport(&fake), &Limits::default()).expect_err("rejet").code, "settings-open-failed");
    // Délai dépassé (le bouton ne reste jamais muet) : même code.
    struct Silent;
    impl SpeechTransport for Silent {
        fn call(&self, _command: &str, _args: Value) -> Result<Value, String> {
            std::thread::sleep(Duration::from_millis(300));
            Ok(json!({ "opened": true }))
        }
    }
    let silent: Arc<dyn SpeechTransport> = Arc::new(Silent);
    let limits = Limits { settings: Duration::from_millis(30), ..Limits::default() };
    assert_eq!(open_settings_with(&silent, &limits).expect_err("délai").code, "settings-open-failed");
}

// ------------------------------------------------------------------------------------------------------------------------------
// Aucun fichier, aucun réseau
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn cap_ios_01_10_the_modules_have_no_file_or_network_api() {
    // Aucune API de fichier ni de réseau dans le module : aucun scénario ne peut créer de fichier (le texte reconnu reste en mémoire).
    for (name, source) in [("speech/mod.rs", SPEECH_RS), ("speech/ios.rs", SPEECH_IOS_RS)] {
        let code: String = source.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        for forbidden in ["std::fs", "File::", "tempfile", "OpenOptions", "std::net", "TcpStream", "reqwest", "UdpSocket", "write_all"] {
            assert!(!code.contains(forbidden), "{name} : `{forbidden}` interdit");
        }
    }
}
