//! Same keyring crate/backends as the reviewed native Codex release. One
//! unprivileged operation over private pipes; no daemon, HTTP or primary auth.
use std::io::{self, Read};
mod receipt;
mod native_access;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: String,
    server_name: String,
    url: String,
    value: Option<String>,
    maintenance: Option<receipt::Maintenance>,
    native_access: Option<native_access::NativeAccess>,
}

// Struct serialization preserves the exact native package's payload order.
#[derive(Serialize)]
struct KeyPayload<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    url: &'a str,
    headers: std::collections::BTreeMap<String, String>,
}

fn account_key(name: &str, url: &str) -> Result<String, &'static str> {
    if name.is_empty() || name.len() > 4000 || url.len() > 1024 * 1024 { return Err("identity"); }
    let payload = serde_json::to_vec(&KeyPayload { kind: "http", url, headers: Default::default() })
        .map_err(|_| "identity")?;
    let digest = format!("{:x}", Sha256::digest(payload));
    // Ordinary native credential names escape reserved prefixes before key
    // derivation strips one local: prefix. The configured name survives intact.
    Ok(format!("{name}|{}", &digest[..16]))
}

fn validate_token(value: &str, request: &Request) -> Result<(), &'static str> {
    let document: Value = serde_json::from_str(value).map_err(|_| "value")?;
    let name = document.get("server_name").and_then(Value::as_str).ok_or("value")?;
    let escaped = ["executor:", "ema-idp:", "local:"].iter().any(|prefix| request.server_name.starts_with(prefix));
    if (name != request.server_name && !(escaped && name == format!("local:{}", request.server_name)))
        || document.get("url").and_then(Value::as_str) != Some(request.url.as_str())
        || document.get("client_id").and_then(Value::as_str).is_none()
        || document.get("token_response").and_then(Value::as_object).is_none() { return Err("value"); }
    Ok(())
}

fn run() -> Result<Value, &'static str> {
    let mut input = String::new();
    io::stdin().take(4 * 1024 * 1024 + 1).read_to_string(&mut input).map_err(|_| "input")?;
    if input.len() > 4 * 1024 * 1024 { return Err("input_size"); }
    let mut request: Request = serde_json::from_str(&input).map_err(|_| "input")?;
    if let Some(access) = &request.native_access {
        if request.operation != "insert-if-absent" { return Err("operation"); }
        access.validate()?;
    }
    let access_intent = request.native_access.as_ref().map(|access| access.intent());
    let mut receipt = match request.maintenance.take() {
        Some(context) if request.operation == "insert-if-absent" => Some(receipt::Receipt::open(
            context, &request.server_name, &request.url, request.value.as_deref().ok_or("value")?, access_intent.as_deref())?),
        Some(_) => return Err("operation"),
        None => None,
    };
    let account = account_key(&request.server_name, &request.url)?;
    let entry = Entry::new("Codex MCP Credentials", &account).map_err(|_| "keyring_unavailable")?;
    let existing = match entry.get_password() {
        Ok(value) => Some(value),
        Err(keyring::Error::NoEntry) => None,
        Err(_) => return Err("keyring_unavailable"),
    };
    if let Some(value) = existing.as_ref() { validate_token(value, &request)?; }
    match request.operation.as_str() {
        "load" if request.value.is_none() => Ok(json!({"value": existing})),
        "insert-if-absent" => {
            if let Some(value) = existing {
                if let Some(receipt) = &mut receipt {
                    if request.value.as_deref() != Some(value.as_str()) { return Err("maintenance_conflict"); }
                    receipt.record("verified")?;
                }
                return Ok(json!({"inserted": false, "value": value}));
            }
            let value = request.value.as_ref().ok_or("value")?;
            validate_token(value, &request)?;
            if let Some(receipt) = &mut receipt { receipt.record("dispatched")?; }
            if let Some(access) = &request.native_access { access.create(&account, value)?; }
            else { entry.set_password(value).map_err(|_| "keyring_write")?; }
            if let Some(receipt) = &mut receipt { receipt.record("acknowledged")?; }
            let verified = entry.get_password().map_err(|_| "keyring_readback")?;
            if &verified != value { return Err("keyring_readback"); }
            if let Some(receipt) = &mut receipt { receipt.record("verified")?; }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_keys_keep_configured_names_distinct() {
        let names = ["docs", "local:docs", "local:local:docs", "executor:x", "ema-idp:x", "local:executor:x"];
        let keys: Vec<_> = names.iter().map(|name| account_key(name, "https://example.test/mcp").unwrap()).collect();
        assert_eq!(keys.iter().collect::<std::collections::HashSet<_>>().len(), names.len());
        for (name, key) in names.iter().zip(keys) { assert!(key.starts_with(&format!("{name}|"))); }
    }

    #[test]
    fn callers_cannot_select_an_arbitrary_keyring_account() {
        assert!(serde_json::from_str::<Request>(r#"{"operation":"load","account":"ema-idp:managed|arbitrary","server_name":"docs","url":"https://example.test/mcp"}"#).is_err());
    }

    #[test]
    fn tokens_keep_the_native_legacy_or_escaped_identity_only() {
        let request = Request { operation: "insert-if-absent".into(), server_name: "local:docs".into(), url: "https://example.test/mcp".into(), value: None, maintenance: None, native_access: None };
        for (name, accepted) in [("local:docs", true), ("local:local:docs", true), ("docs", false), ("local:local:local:docs", false)] {
            let value = json!({"server_name":name,"url":request.url,"client_id":"synthetic","token_response":{}}).to_string();
            assert_eq!(validate_token(&value, &request).is_ok(), accepted);
        }
        let wrong_url = json!({"server_name":"local:docs","url":"https://other.test/mcp","client_id":"synthetic","token_response":{}}).to_string();
        assert!(validate_token(&wrong_url, &request).is_err());
    }
}
