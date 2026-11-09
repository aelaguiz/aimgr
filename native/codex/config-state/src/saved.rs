//! Startup-only inventory for the unchanged native TUI's saved-session choices.
//! History stays in this process; only resulting config paths leave its pipe.
use super::{Result, load_variant};
use codex_core::config::{Config, ConfigOverrides};
use codex_config::{ConfigLayerSource, types::ResumeCwdMode};
use codex_protocol::{ThreadId, protocol::SessionSource};
use codex_rollout::{RolloutItem, StateDbHandle};
use codex_thread_store::{LocalThreadStore, LocalThreadStoreConfig, ThreadStore, ListThreadsParams,
    LoadThreadHistoryParams, SortDirection, ThreadSortKey, StoredThread};
use codex_utils_absolute_path::AbsolutePathBuf;
use serde::Deserialize;
use std::{collections::{BTreeMap, BTreeSet}, path::PathBuf};

#[derive(Default)]
pub(super) struct Inventory {
    pub(super) projection: Option<super::Projection>,
    pub(super) databases: BTreeMap<Vec<PathBuf>, Config>,
}

impl Inventory {
    async fn add(&mut self, config: Config, reads: BTreeSet<PathBuf>, initial: &Config) -> Result<()> {
        let mut projected = super::projection(&config, reads, false).await?;
        projected.project_cwds.insert(projected.cwd.clone());
        let paths = projected.database_files.clone();
        if let Some(output) = &mut self.projection {
            if !super::oss::privacy_compatible(output, &projected) { return Err(()); }
            output.extend_paths(projected);
        } else { self.projection = Some(projected); }
        let initial_paths: Vec<_> = initial.sqlite_config().runtime_db_paths().into_iter().map(|db| db.path).collect();
        if paths != initial_paths { self.databases.entry(paths).or_insert(config); }
        // Every branch is projected; retain a full config only for a distinct
        // database initialization after the current physical locks close.
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub(super) fork: bool,
    pub(super) selector: Option<String>,
    pub(super) last: bool,
    pub(super) all: bool,
    pub(super) include_non_interactive: bool,
    pub(super) explicit_cwd: bool,
}

fn direct(request: &super::Request, cwd: PathBuf) -> ConfigOverrides {
    ConfigOverrides {
        cwd: Some(cwd), model: request.harness.model.clone(), model_provider: request.harness.model_provider.clone(),
        sandbox_mode: request.harness.sandbox, approval_policy: request.harness.approval.clone(),
        additional_writable_roots: request.harness.additional_writable_roots.clone(),
        ephemeral: request.harness.ephemeral, bypass_hook_trust: request.harness.bypass_hook_trust,
        ..Default::default()
    }
}

async fn candidates(store: &LocalThreadStore, config: &Config, request: &Request) -> Result<Vec<StoredThread>> {
    if let Some(selector) = &request.selector {
        let selected = if let Ok(id) = ThreadId::from_string(selector) {
            super::source::read(store, id).await.map_err(|_| ())
        } else {
            super::source::lookup(store, config, &super::source::Request {
                selector: selector.clone(), headless: false, resume: !request.fork,
            }).await
        };
        // Native owns missing/ambiguous/stale selection diagnostics. None of
        // those cases needs permission to another saved project's inputs.
        return Ok(selected.into_iter().collect());
    }
    let mut found = Vec::new();
    let mut seen = BTreeSet::new();
    let mut sources = vec![SessionSource::Cli, SessionSource::VSCode];
    if !request.fork && request.include_non_interactive { sources.extend([SessionSource::Exec, SessionSource::Mcp]); }
    let providers = Some(if request.fork { vec![config.model_provider_id.clone()] } else { vec![] });
    let collections: &[bool] = if request.fork || request.last { &[false] } else { &[false, true] };
    for &archived in collections {
        // --last retries a complete native state-db miss with scan/repair.
        // The picker can page its whole reachable collection; no history cap.
        // CreatedAt DB paging includes the native UUID tie-breaker. Its
        // filesystem fallback does not, so scan-only enumeration can miss
        // same-second sessions that remain reachable in the native picker.
        let modes: &[bool] = if request.last { &[true, false] } else { &[false, true] };
        for &state_only in modes {
            let mut cursor = None;
            loop {
                let page = store.list_threads(ListThreadsParams {
                    page_size: if request.last { 1 } else { 100 }, cursor: cursor.clone(),
                    sort_key: if request.last { ThreadSortKey::UpdatedAt } else { ThreadSortKey::CreatedAt },
                    sort_direction: SortDirection::Desc, allowed_sources: sources.clone(), model_providers: providers.clone(),
                    cwd_filters: (request.last && !request.all).then(|| vec![config.cwd.to_path_buf()]),
                    section: None, project_id: None, archived, search_term: None, relation_filter: None,
                    use_state_db_only: state_only,
                }).await.map_err(|_| ())?;
                for thread in page.items {
                    if let Some(path) = &thread.rollout_path
                        && codex_rollout::existing_rollout_path(path).await.is_some()
                        // Scan metadata can retain the creation cwd while
                        // native DB picker rows carry a later continuation cwd.
                        && seen.insert((thread.thread_id.to_string(), thread.cwd.clone(), thread.model_provider.clone())) {
                        found.push(thread);
                        if request.last { return Ok(found); }
                    }
                }
                if request.last { break; }
                let Some(next) = page.next_cursor else { break; };
                if cursor.as_ref() == Some(&next) { return Err(()); }
                cursor = Some(next);
            }
        }
    }
    Ok(found)
}

pub(super) async fn resolve(request: &super::Request, initial: &Config, runtime: StateDbHandle)
    -> Result<Inventory> {
    let selected = request.saved.as_ref().ok_or(())?;
    // Exec supplies its current cwd/model/provider/permissions to resume and
    // fork explicitly. It has no saved-cwd prompt or TUI restore omissions.
    if request.headless { return Ok(Inventory::default()); }
    let store = LocalThreadStore::new(LocalThreadStoreConfig::from_config(initial), Some(runtime.clone()));
    let mut variants = Inventory::default();
    for thread in candidates(&store, initial, selected).await? {
        let mut cwds = BTreeSet::new();
        let mode = if selected.explicit_cwd { Some(ResumeCwdMode::Current) } else { initial.tui_resume_cwd };
        if !matches!(mode, Some(ResumeCwdMode::Session)) { cwds.insert(initial.cwd.to_path_buf()); }
        if !matches!(mode, Some(ResumeCwdMode::Current)) && thread.cwd.is_absolute() { cwds.insert(thread.cwd.clone()); }
        // Load current native lineage, including compressed/reverted segments.
        // Initialization locks do not freeze concurrent native history writes.
        let history = if selected.fork { None } else {
            match store.load_latest_model_context(LoadThreadHistoryParams {
                thread_id: thread.thread_id, include_archived: true,
            }).await { Ok(value) => Some(value), Err(_) => continue }
        };
        for cwd in cwds {
            let mut overrides = direct(request, cwd.clone());
            let Ok((current, current_reads)) = load_variant(request, false, false, Some(overrides.clone())).await else { continue; };
            if selected.fork { variants.add(current, current_reads, initial).await?; continue; }
            // Native validates the saved provider even with an explicit model
            // override. Rejecting that native branch grants no foreign assets.
            if !thread.model_provider.is_empty() && thread.model_provider != current.model_provider_id { continue; }
            let mut choices = direct(request, cwd.clone());
            if !selected.explicit_cwd { choices.cwd = None; }
            let permissions = super::resume_permissions::ResumePermissions::from_overrides(&current, &choices);
            let explicit_model = choices.model.is_some() || choices.model_provider.is_some()
                || current.config_layer_stack.layers_high_to_low().any(|layer|
                    matches!(&layer.name, ConfigLayerSource::SessionFlags | ConfigLayerSource::User { profile: Some(_), .. })
                    && ["model", "model_provider", "model_reasoning_effort"].iter().any(|key| layer.config.get(*key).is_some()));
            if !explicit_model {
                // Model metadata belongs to the native state DB, not whichever
                // model-bearing rollout record happened to be newest.
                if let Ok(Some(metadata)) = runtime.get_thread(thread.thread_id).await {
                    overrides.model = metadata.model;
                    overrides.model_provider = Some(metadata.model_provider);
                }
            }
            let history = &history.as_ref().ok_or(())?.items;
            if let Some(saved) = super::persisted_resume_settings::PersistedResumeSettings::from_history(history, thread.thread_id) {
                if !permissions.approval_policy { overrides.approval_policy = Some(saved.approval_policy); }
                if !permissions.approvals_reviewer { overrides.approvals_reviewer = saved.approvals_reviewer; }
                if !permissions.profile {
                    overrides.persisted_permission_profile_id = saved.active_permission_profile.map(|p| p.id);
                    overrides.persisted_permission_profile = saved.unnamed_permission_profile;
                }
            }
            if !permissions.workspace_roots {
                let owned = super::persisted_resume_settings::latest_owned_thread_settings(history, thread.thread_id);
                let saved_roots = match owned {
                    Some(settings) => settings.runtime_workspace_roots.as_ref().map(|roots|
                        (settings.cwd.as_path(), roots.iter().map(AbsolutePathBuf::as_path).collect::<Vec<_>>())),
                    None => history.first().and_then(|item| match item {
                        RolloutItem::SessionMeta(meta) if meta.meta.id == thread.thread_id =>
                            meta.meta.runtime_workspace_roots.as_ref().map(|roots|
                                (meta.meta.cwd.as_path(), roots.iter().map(PathBuf::as_path).collect())),
                        _ => None,
                    }),
                };
                if let Some((saved_cwd, roots)) = saved_roots {
                    let roots = codex_utils_path::replace_path_and_deduplicate(roots, saved_cwd, &cwd).into_iter()
                        .map(AbsolutePathBuf::from_absolute_path_checked).collect::<std::io::Result<Vec<_>>>();
                    let Ok(roots) = roots else { continue; };
                    overrides.workspace_roots = Some(roots);
                }
            }
            // A broken historical project remains a native selection error;
            // it must not make healthy entries in the same picker unusable.
            if let Ok((config, reads)) = load_variant(request, false, false, Some(overrides)).await {
                variants.add(config, reads, initial).await?;
            }
        }
    }
    Ok(variants)
}
