//! Faux du plugin Swift web-auth (ADR 0008 §9.1 ; K-TECH-01) : il parle **exactement** le JSON du contrat
//! (`tests/fixtures/calendars/web-auth-contract.json`). Toute commande inconnue ou tout champ d'entrée différent de ceux du contrat fait
//! échouer le test (panique) ; toute réponse a la forme du contrat (`{ callbackUrl }`) ou est un code d'erreur du contrat.

#![allow(dead_code)]

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use circletasks_lib::calendars::web_auth::WebAuthTransport;
use serde_json::{json, Value};

pub const CONTRACT: &str = include_str!("../../../../tests/fixtures/calendars/web-auth-contract.json");

/// Ce que fait la feuille d'authentification simulée, avec l'URL d'autorisation et le schéma reçus : l'URL de retour, ou un code d'erreur.
pub type Behavior = Box<dyn Fn(&str, &str) -> Result<String, String> + Send + Sync>;

pub struct FakeWebAuth {
    behavior: Behavior,
    calls: Arc<Mutex<Vec<(String, String)>>>,
}

impl FakeWebAuth {
    pub fn new(behavior: impl Fn(&str, &str) -> Result<String, String> + Send + Sync + 'static) -> Self {
        Self { behavior: Box::new(behavior), calls: Arc::new(Mutex::new(Vec::new())) }
    }

    /// Appels reçus (URL d'autorisation, schéma), partageable avant de passer le faux à l'exécuteur.
    pub fn calls(&self) -> Arc<Mutex<Vec<(String, String)>>> {
        self.calls.clone()
    }
}

impl WebAuthTransport for FakeWebAuth {
    fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        let contract: Value = serde_json::from_str(CONTRACT).unwrap();
        let commands = contract["commands"].as_array().unwrap();
        let spec = commands.iter().find(|candidate| candidate["swiftMethod"] == command).unwrap_or_else(|| panic!("commande hors contrat : {command}"));
        let expected: BTreeSet<&str> = spec["input"].as_array().unwrap().iter().map(|field| field.as_str().unwrap()).collect();
        let given: BTreeSet<&str> = args.as_object().expect("arguments en objet").keys().map(String::as_str).collect();
        assert_eq!(given, expected, "champs d'entrée de {command}");
        let url = args["url"].as_str().expect("url en chaîne").to_owned();
        let scheme = args["callbackScheme"].as_str().expect("callbackScheme en chaîne").to_owned();
        self.calls.lock().unwrap().push((url.clone(), scheme.clone()));
        match (self.behavior)(&url, &scheme) {
            Ok(callback) => {
                let output: BTreeSet<&str> = spec["output"].as_array().unwrap().iter().map(|field| field.as_str().unwrap()).collect();
                let reply = json!({ "callbackUrl": callback });
                let keys: BTreeSet<&str> = reply.as_object().unwrap().keys().map(String::as_str).collect();
                assert_eq!(keys, output, "forme de la réponse");
                Ok(reply)
            }
            Err(code) => Err(code),
        }
    }
}
