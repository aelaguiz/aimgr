//! The explicitly requested Git operation, separate from the offline settings
//! helper. Calls the unmodified native allocator/binder; no config, auth or
//! telemetry owner. Ordinary Git/tool environment and access remain intact.
use codex_worktree::{CreateWorktree, WorktreeManager, WorktreeSettings};
use serde::Deserialize;
use serde_json::json;
use std::io::{Read, Write};
use std::path::PathBuf;

unsafe extern "C" { fn aim_config_channels() -> libc::c_int; }

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Create { root: PathBuf, source_cwd: PathBuf },
    Bind { root: PathBuf, checkout: PathBuf, thread_id: String },
}

fn run() -> Result<(), ()> {
    if unsafe { aim_config_channels() } != 0 { return Err(()); }
    let mut input = Vec::new();
    std::io::stdin().take(65537).read_to_end(&mut input).map_err(|_| ())?;
    if input.len() > 65536 { return Err(()); }
    let request: Request = serde_json::from_slice(&input).map_err(|_| ())?;
    input.fill(0);
    let root = match &request { Request::Create { root, .. } | Request::Bind { root, .. } => root };
    if !root.is_absolute() { return Err(()); }
    let manager = WorktreeManager::new(WorktreeSettings {
        root: root.clone(), auto_cleanup_enabled: false,
        keep_count: codex_worktree::DEFAULT_WORKTREE_KEEP_COUNT,
    });
    let output = match request {
        Request::Create { source_cwd, .. } => {
            if !source_cwd.is_absolute() { return Err(()); }
            let result = manager.create(&CreateWorktree { source_cwd, base: None }).map_err(|_| ())?;
            json!({ "schema": 1, "checkout": result })
        },
        Request::Bind { checkout, thread_id, .. } => {
            if !checkout.is_absolute() || codex_protocol::ThreadId::from_string(&thread_id).is_err() { return Err(()); }
            manager.bind_thread(&checkout, &thread_id).map_err(|_| ())?;
            json!({ "schema": 1, "bound": true })
        },
    };
    let bytes = serde_json::to_vec(&output).map_err(|_| ())?;
    std::io::stdout().write_all(&bytes).map_err(|_| ())
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    if run().is_err() {
        eprintln!("Codex worktree preparation failed; no Git configuration or credential details were logged.");
        std::process::exit(125);
    }
}
