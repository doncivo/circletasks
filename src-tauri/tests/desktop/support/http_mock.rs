//! Serveur HTTP simulé en mémoire (boucle locale), partagé par les tests de connexion Google sur iPhone (K-TECH-01) : enregistre chaque
//! requête reçue et répond par un gestionnaire. Aucun réseau, aucun compte réel.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub target: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

pub fn reply(status: u16, body: &str) -> Reply {
    Reply { status, headers: vec![], body: body.to_owned() }
}

pub fn redirect(location: &str) -> Reply {
    Reply { status: 302, headers: vec![("Location".to_owned(), location.to_owned())], body: String::new() }
}

pub struct Mock {
    pub base: String,
    seen: Arc<Mutex<Vec<Recorded>>>,
}

impl Mock {
    pub fn requests(&self) -> Vec<Recorded> {
        self.seen.lock().unwrap().clone()
    }

    pub fn requests_to(&self, path: &str) -> Vec<Recorded> {
        self.requests().into_iter().filter(|request| request.target.split('?').next() == Some(path)).collect()
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        data.extend_from_slice(&chunk[..read]);
        if let Some(position) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let head = String::from_utf8_lossy(&data[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let (method, target) = (first.next()?.to_owned(), first.next()?.to_owned());
    let headers: BTreeMap<String, String> = lines.filter_map(|line| line.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned())).collect();
    let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    while data.len() < head_end + length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..read]);
    }
    let body = String::from_utf8_lossy(&data[head_end..]).to_string();
    Some(Recorded { method, target, headers, body })
}

pub fn start_mock(handler: impl Fn(&Recorded) -> Reply + Send + 'static) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_thread = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Some(request) = read_request(&mut stream) else { continue };
            seen_thread.lock().unwrap().push(request.clone());
            let answer = handler(&request);
            let mut text = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", answer.status, answer.body.len());
            for (name, value) in &answer.headers {
                text.push_str(&format!("{name}: {value}\r\n"));
            }
            text.push_str("\r\n");
            text.push_str(&answer.body);
            let _ = stream.write_all(text.as_bytes());
        }
    });
    Mock { base, seen }
}

/// « Navigateur » simulé : GET brut, rend l'en-tête `Location` de la réponse (la redirection vers le schéma de l'app).
pub fn raw_get_location(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).unwrap();
    let mut stream = TcpStream::connect((parsed.host_str().unwrap(), parsed.port().unwrap())).unwrap();
    let target = format!("{}{}", parsed.path(), parsed.query().map(|q| format!("?{q}")).unwrap_or_default());
    write!(stream, "GET {target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
    let mut text = String::new();
    let _ = stream.read_to_string(&mut text);
    text.lines().find_map(|line| line.strip_prefix("Location: ").or_else(|| line.strip_prefix("location: "))).map(str::to_owned)
}
