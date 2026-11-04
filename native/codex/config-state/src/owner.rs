//! One post-exit browser navigation hint. Never infer the original startup
//! thread, a newest thread, or account ownership from a shared history path.
use super::Result;
use codex_core::config::Config;
use codex_protocol::ThreadId;
use codex_protocol::protocol::SessionSource;
use codex_state::{SortDirection, SortKey, StateRuntime, ThreadFilterOptions};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Database {
    path: PathBuf,
    device: u64,
    inode: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub(super) cwd: PathBuf,
    pub(super) account_id: String,
    pub(super) source: SessionSource,
    pub(super) forked_from_id: Option<ThreadId>,
    pub(super) started_at: String,
    pub(super) ended_at: String,
    pub(super) database_files: Vec<Database>,
}

impl Request {
    pub(super) fn matches_databases(&self, config: &Config) -> bool {
        let paths = config.sqlite_config().runtime_db_paths();
        // Projection merges/sorts its inventory. Native's enumeration order
        // is not part of database identity.
        paths.len() == self.database_files.len() && paths.iter().all(|actual| {
            self.database_files.iter().find(|expected| actual.path == expected.path).is_some_and(|expected|
                std::fs::metadata(&actual.path).is_ok_and(|meta|
                    meta.is_file() && meta.dev() == expected.device && meta.ino() == expected.inode))
        })
    }
}

pub(super) async fn select(runtime: &StateRuntime, request: &Request) -> Result<Option<String>> {
    if !request.cwd.is_absolute() || request.account_id.is_empty()
        || !matches!(request.source, SessionSource::Cli | SessionSource::Exec) { return Err(()); }
    let start = chrono::DateTime::parse_from_rfc3339(&request.started_at).map_err(|_| ())?;
    let end = chrono::DateTime::parse_from_rfc3339(&request.ended_at).map_err(|_| ())?;
    if end < start { return Err(()); }
    let sources = vec![match request.source { SessionSource::Cli => "cli", _ => "exec" }.to_owned()];
    let cwds = vec![request.cwd.clone()];
    let mut selected = BTreeSet::new();
    for archived in [false, true] {
        let mut anchor = None;
        loop {
            let page = runtime.list_threads(100, ThreadFilterOptions {
                archived_only: archived, allowed_sources: &sources, model_providers: Some(&[]),
                cwd_filters: Some(&cwds), section: None, project_id: None,
                anchor: anchor.as_ref(), sort_key: SortKey::CreatedAt, sort_direction: SortDirection::Desc, search_term: None,
            }).await.map_err(|_| ())?;
            for candidate in page.items {
                if candidate.created_at < start || candidate.created_at > end || candidate.attached_thread_parent_id.is_some()
                    || candidate.creator_account_id.as_deref() != Some(request.account_id.as_str()) { continue; }
                // The DB's current rollout is authoritative after revert;
                // native lookup also recognizes its compressed counterpart.
                let path = codex_rollout::existing_rollout_path(&candidate.rollout_path).await.ok_or(())?;
                let meta = codex_rollout::read_session_meta_line(&path).await.map_err(|_| ())?.meta;
                if meta.id != candidate.id { return Err(()); }
                if meta.cwd != request.cwd || meta.source != request.source || meta.forked_from_id != request.forked_from_id
                    || meta.parent_thread_id.is_some() || meta.attached_thread || meta.session_id != meta.id.into()
                    || meta.creator_account_id.as_deref() != Some(request.account_id.as_str())
                    || chrono::DateTime::parse_from_rfc3339(&meta.timestamp).map_err(|_| ())? < start { continue; }
                selected.insert(meta.id.to_string());
                if selected.len() > 1 { return Ok(None); }
            }
            let Some(next) = page.next_anchor else { break; };
            if anchor.as_ref() == Some(&next) { return Err(()); }
            anchor = Some(next);
        }
    }
    Ok(selected.into_iter().next())
}
