//! Same keyring crate/backends as the reviewed native Codex release. One
//! unprivileged operation over private pipes; no daemon, HTTP or primary auth.
use std::io::{self, Read};

use keyring::Entry;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: String,
    account: String,
    value: Option<String>,
}

fn run() -> Result<Value, &'static str> {
    let mut input = String::new();
    io::stdin().take(4 * 1024 * 1024 + 1).read_to_string(&mut input).map_err(|_| "input")?;
    if input.len() > 4 * 1024 * 1024 { return Err("input_size"); }
    let request: Request = serde_json::from_str(&input).map_err(|_| "input")?;
    let (server, suffix) = request.account.rsplit_once('|').ok_or("account")?;
    if server.is_empty() || request.account.len() > 4096 || server.starts_with("executor:")
        || server.starts_with("ema-idp:") || suffix.len() != 16
        || !suffix.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("account");
    }
    let entry = Entry::new("Codex MCP Credentials", &request.account).map_err(|_| "keyring_unavailable")?;
    let existing = match entry.get_password() {
        Ok(value) => Some(value),
        Err(keyring::Error::NoEntry) => None,
        Err(_) => return Err("keyring_unavailable"),
    };
    match request.operation.as_str() {
        "load" if request.value.is_none() => Ok(json!({"value": existing})),
        "insert-if-absent" => {
            if let Some(value) = existing { return Ok(json!({"inserted": false, "value": value})); }
            let value = request.value.ok_or("value")?;
            let document: Value = serde_json::from_str(&value).map_err(|_| "value")?;
            let name = document.get("server_name").and_then(Value::as_str).ok_or("value")?;
            if name.starts_with("executor:") || name.starts_with("ema-idp:")
                || document.get("url").and_then(Value::as_str).is_none()
                || document.get("client_id").and_then(Value::as_str).is_none()
                || document.get("token_response").and_then(Value::as_object).is_none() { return Err("value"); }
            entry.set_password(&value).map_err(|_| "keyring_write")?;
            let verified = entry.get_password().map_err(|_| "keyring_readback")?;
            if verified != value { return Err("keyring_readback"); }
            Ok(json!({"inserted": true, "value": verified}))
        }
        _ => Err("operation"),
    }
}

fn main() {
    match run() {
        Ok(value) => println!("{value}"),
        Err(code) => {
            // Never format native keyring errors: some variants carry secrets.
            println!("{}", json!({"error": code}));
            std::process::exit(1);
        }
    }
}
