//! Resolve an explicitly requested worktree fork through native local storage.
//! No app-server/auth owner is needed to read the saved thread and its cwd.
use super::Result;
use codex_core::config::Config;
use codex_protocol::{ThreadId, protocol::SessionSource};
use codex_rollout::{ReverseJsonlScanner, RolloutItem, ScanOutcome, StateDbHandle};
use codex_thread_store::{LocalThreadStore, LocalThreadStoreConfig, ThreadStore, ListThreadsParams,
    ReadThreadParams, SortDirection, ThreadSortKey, StoredThread, ThreadStoreError};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub(super) selector: String, pub(super) headless: bool,
    #[serde(default)] pub(super) resume: bool,
}

#[derive(Serialize)]
pub(super) struct Source { pub(super) thread_id: String, pub(super) cwd: PathBuf }

pub(super) async fn read(store: &LocalThreadStore, id: ThreadId) -> std::result::Result<StoredThread, ThreadStoreError> {
    store.read_thread(ReadThreadParams { thread_id: id, include_archived: true, include_history: false }).await
}

// Match the pinned TUI's stale metadata cases before erasing private errors.
// Other failures leave name uniqueness unknown and must stop selection.
fn stale(error: &ThreadStoreError, thread: &StoredThread) -> bool {
    match error {
        ThreadStoreError::ThreadNotFound { thread_id } => *thread_id == thread.thread_id,
        ThreadStoreError::InvalidRequest { message } =>
            message == &format!("no rollout found for thread id {}", thread.thread_id),
        ThreadStoreError::Internal { message } =>
            (message.starts_with("session metadata ") && message.contains(" belongs to thread ")
                && message.ends_with(&format!(", expected {}", thread.thread_id)))
            || thread.rollout_path.as_ref().is_some_and(|path|
                message.starts_with(&format!("failed to read session metadata {}: ", path.display()))),
        _ => false,
    }
}

pub(super) async fn select(config: &Config, runtime: StateDbHandle, request: &Request) -> Result<Source> {
    let store = LocalThreadStore::new(LocalThreadStoreConfig::from_config(config), Some(runtime.clone()));
    let selected = if let Ok(id) = ThreadId::from_string(&request.selector) {
        read(&store, id).await.map_err(|_| ())?
    } else if request.headless {
        // Exec's pinned name resolver prefers its newest exact DB title, then
        // the native session index, then the first exact listed name. Unlike
        // the TUI it does not impose displayed-label uniqueness.
        if let Some(thread) = runtime.find_thread_by_exact_title(&request.selector, &[], None, false, None).await.map_err(|_| ())? {
            read(&store, thread.id).await.map_err(|_| ())?
        } else if let Some((_, meta)) = codex_rollout::find_thread_meta_by_name_str(&config.codex_home,
            &request.selector, Some(runtime.as_ref())).await.map_err(|_| ())? {
            read(&store, meta.meta.id).await.map_err(|_| ())?
        } else {
            lookup(&store, config, request).await?
        }
    } else {
        lookup(&store, config, request).await?
    };
    let mut cwd = selected.cwd;
    if let Some(path) = selected.rollout_path {
        // Same current-rollout-only scan and fallback as native worktree
        // startup. Do not choose an older path left behind by a revert.
        let latest = tokio::task::spawn_blocking(move || {
            let reader = codex_rollout::open_rollout_seekable_reader(&path, || false).ok()?;
            let mut scanner = ReverseJsonlScanner::new(reader).ok()?;
            while let Some(outcome) = scanner.scan_next_rollout_line().ok()? {
                if let ScanOutcome::Parsed(line) = outcome {
                    if let RolloutItem::TurnContext(context) = line.item { return Some(context.cwd.into_path_buf()); }
                }
            }
            None
        }).await.map_err(|_| ())?;
        if let Some(latest) = latest { cwd = latest; }
    }
    if !cwd.is_absolute() { return Err(()); }
    Ok(Source { thread_id: selected.thread_id.to_string(), cwd })
}

pub(super) async fn lookup(store: &LocalThreadStore, config: &Config, request: &Request) -> Result<StoredThread> {
    if request.selector.trim().is_empty() { return Err(()); }
    let mut cursor = None;
    let mut found: Option<StoredThread> = None;
    loop {
        let page = store.list_threads(ListThreadsParams {
            page_size: 100, cursor: cursor.clone(), sort_key: if request.headless { ThreadSortKey::UpdatedAt } else { ThreadSortKey::CreatedAt },
            sort_direction: SortDirection::Desc,
            allowed_sources: if request.headless { vec![] } else { vec![SessionSource::Cli, SessionSource::VSCode] },
            model_providers: Some(if request.resume { vec![] } else { vec![config.model_provider_id.clone()] }),
            cwd_filters: None, section: None, project_id: None, archived: false,
            search_term: request.headless.then(|| request.selector.clone()), relation_filter: None, use_state_db_only: !request.headless,
        }).await.map_err(|_| ())?;
        for thread in page.items {
            // Exec's app-server source-kind list excludes Custom and Internal;
            // its preceding exact-title/session-index stages do not.
            if request.headless && !matches!(thread.source, SessionSource::Cli | SessionSource::VSCode
                | SessionSource::Exec | SessionSource::Mcp | SessionSource::SubAgent(_) | SessionSource::Unknown) { continue; }
            let label = thread.name.as_deref().map(str::trim).filter(|v| !v.is_empty()).unwrap_or(thread.preview.trim());
            if if request.headless { thread.name.as_deref() != Some(request.selector.as_str()) } else { label != request.selector } { continue; }
            if !request.headless && thread.rollout_path.as_ref().is_some_and(|path|
                !path.starts_with(config.codex_home.join(codex_rollout::SESSIONS_SUBDIR))) { continue; }
            // Native TUI re-reads labels to reject stale metadata and validates
            // the rollout belongs to the returned thread before choosing it.
            let current = match read(store, thread.thread_id).await {
                Ok(current) => current,
                Err(error) if !request.headless && stale(&error, &thread) => continue,
                Err(_) => return Err(()),
            };
            let label = current.name.as_deref().map(str::trim).filter(|v| !v.is_empty()).unwrap_or(current.preview.trim());
            if !request.headless && label != request.selector { continue; }
            if request.headless { return Ok(current); }
            if found.as_ref().is_some_and(|old| old.thread_id != current.thread_id) { return Err(()); }
            found = Some(current);
        }
        let Some(next) = page.next_cursor else { break; };
        if cursor.as_ref() == Some(&next) { return Err(()); }
        cursor = Some(next);
    }
    found.ok_or(())
}
