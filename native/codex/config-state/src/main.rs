//! Finite AIM adapter for the admitted, unchanged upstream configuration/state
//! libraries. No auth manager, cloud loader, exporter, model, tool or MCP owner.
mod state;
mod owner;
mod source;
mod saved;
mod oss;
extern crate codex_core as legacy_core;
// Compile these pure selectors from the paired, unchanged upstream tree.
// They have no app-server, authentication or transport owner.
#[path = "../vendor/codex/codex-rs/tui/src/resume_permissions.rs"]
mod resume_permissions;
#[path = "../vendor/codex/codex-rs/app-server/src/request_processors/persisted_resume_settings.rs"]
mod persisted_resume_settings;

use codex_config::{ConfigLayerSource, LoaderOverrides, ProfileV2Name};
use codex_config::types::OtelExporterKind;
use codex_core::config::{Config, ConfigBuilder, ConfigOverrides, resolve_profile_v2_config_path};
use codex_protocol::config_types::SandboxMode;
use codex_protocol::permissions::{FileSystemAccessMode, FileSystemPath};
use codex_protocol::protocol::AskForApproval;
use codex_utils_cli::CliConfigOverrides;
use codex_utils_absolute_path::AbsolutePathBufGuard;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::PathBuf;

unsafe extern "C" {
    fn aim_config_channels() -> libc::c_int;
    fn aim_config_boundary(readonly: libc::c_int) -> libc::c_int;
}

type Result<T> = std::result::Result<T, ()>;
const REVISION: &str = "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856";

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Operation { Inputs, Initialize, WorktreeOwner, ForkSource, McpInputs }

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Harness {
    model: Option<String>,
    model_provider: Option<String>,
    sandbox: Option<SandboxMode>,
    approval: Option<AskForApproval>,
    #[serde(default)]
    additional_writable_roots: Vec<PathBuf>,
    ephemeral: Option<bool>,
    bypass_hook_trust: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: Operation,
    artifact_set: String,
    codex_home: PathBuf,
    cwd: PathBuf,
    profile: Option<String>,
    #[serde(default)]
    config: Vec<String>,
    #[serde(default)]
    harness: Harness,
    #[serde(default)]
    owned_app_server: bool,
    #[serde(default)]
    strict_config: bool,
    #[serde(default)]
    ignore_user_config: bool,
    #[serde(default)]
    ignore_rules: bool,
    #[serde(default)]
    headless: bool,
    #[serde(default)]
    yolo: bool,
    #[serde(default)]
    worktree: bool,
    owner: Option<owner::Request>,
    fork_source: Option<source::Request>,
    saved: Option<saved::Request>,
    #[serde(default)]
    oss: bool,
    local_provider: Option<String>,
    oss_choice: Option<oss::Choice>,
    #[serde(default)]
    explicit_cwd: bool,
    #[serde(skip)]
    selected_oss: Option<String>,
    #[serde(default)]
    mcp_values: Vec<String>,
    // Captured by the admitted CFPreferences forced-value reader. Both fields
    // are required on macOS, including explicit empty strings for absence.
    forced_config: Option<String>,
    forced_requirements: Option<String>,
}

#[derive(Serialize)]
struct McpInput { name: String, url: String, environment_id: String, ordinary_oauth: bool }

#[derive(Serialize)]
struct Projection {
    schema: u32,
    source_revision: &'static str,
    cwd: PathBuf,
    reads: BTreeSet<PathBuf>,
    writes: BTreeSet<PathBuf>,
    database_roots: BTreeSet<PathBuf>,
    database_files: Vec<PathBuf>,
    exporters_disabled: bool,
    analytics_disabled: bool,
    feedback_disabled: bool,
    updates_disabled: bool,
    used_defaults: bool,
    initialized: bool,
    source_untrusted: bool,
    worktree_root: Option<PathBuf>,
    owner_thread_id: Option<String>,
    fork_source: Option<source::Source>,
    oss_choice: Option<oss::Choice>,
    project_cwds: BTreeSet<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mcp_servers: Option<Vec<McpInput>>,
    mcp_store: codex_config::types::OAuthCredentialsStoreMode,
    mcp_keyring_backend: codex_config::types::AuthKeyringBackendKind,
}

impl Projection {
    fn extend_paths(&mut self, next: Self) {
        self.reads.extend(next.reads); self.writes.extend(next.writes);
        self.database_roots.extend(next.database_roots); self.database_files.extend(next.database_files);
        self.database_files.sort(); self.database_files.dedup();
        self.project_cwds.extend(next.project_cwds);
    }
}

fn insert_optional_read(reads: &mut BTreeSet<PathBuf>, file: PathBuf) {
    // Native discovery treats a missing optional file/directory, including a
    // dangling authored link, as absent. Required configured inputs keep their
    // separate strict inventory path below.
    if !matches!(std::fs::metadata(&file), Err(error) if error.kind() == std::io::ErrorKind::NotFound) {
        reads.insert(file);
    }
}

async fn projection(config: &Config, mut reads: BTreeSet<PathBuf>, used_defaults: bool) -> Result<Projection> {
    let mut writes = BTreeSet::new();
    // The native loader has already applied project trust, sanitization, profile
    // selection and mandatory local requirements. Disabled layers grant nothing.
    for layer in config.config_layer_stack.layers_low_to_high().filter(|l| l.disabled_reason.is_none()) {
        match &layer.name {
            ConfigLayerSource::PackagedDefaults { file } | ConfigLayerSource::System { file }
            | ConfigLayerSource::User { file, .. } | ConfigLayerSource::LegacyManagedConfigTomlFromFile { file } => {
                insert_optional_read(&mut reads, file.to_path_buf());
            },
            ConfigLayerSource::Project { dot_codex_folder } => { insert_optional_read(&mut reads, dot_codex_folder.join("config.toml").to_path_buf()); },
            _ => {},
        }
        if let Some(folder) = layer.config_folder() {
            insert_optional_read(&mut reads, folder.join("agents").to_path_buf());
        }
        if let Some(folder) = layer.hooks_config_folder() {
            // Linked worktrees substitute hook declarations from the matching
            // main-checkout config before reading hooks.json there.
            insert_optional_read(&mut reads, folder.join("config.toml").to_path_buf());
            insert_optional_read(&mut reads, folder.join("hooks.json").to_path_buf());
        }
        // Role loading reads every enabled layer before resolving name
        // collisions. Values here were already source-normalized natively.
        if let Some(agents) = layer.config.get("agents") {
            let folder = layer.config_folder();
            let _guard = folder.as_deref().map(AbsolutePathBufGuard::new);
            if let Ok(agents) = agents.clone().try_into::<codex_config::config_toml::AgentsToml>() {
                for role in agents.roles.values() {
                    if let Some(file) = &role.config_file { reads.insert(file.to_path_buf()); }
                }
            }
        }
    }
    for role in config.agent_roles.values() {
        if let Some(file) = &role.config_file { reads.insert(file.clone()); }
    }
    for root in codex_core_plugins::installed_marketplaces::installed_marketplace_roots_from_layer_stack(
        &config.config_layer_stack, &config.codex_home) {
        reads.insert(root.to_path_buf());
    }
    if let Some(auth) = &config.model_provider.auth { reads.insert(auth.cwd.to_path_buf()); }
    if let Some(file) = &config.model_provider.credential_file { reads.insert(file.clone()); }
    // Native skill discovery deliberately includes disabled config layers.
    // Only their fixed discovery directories are inputs; disabled settings
    // still do not grant arbitrary configured paths.
    for layer in config.config_layer_stack.all_layers_high_to_low() {
        if let Some(folder) = layer.config_folder() {
            match layer.name {
                ConfigLayerSource::Project { .. } | ConfigLayerSource::System { .. } => { insert_optional_read(&mut reads, folder.join("skills").to_path_buf()); },
                ConfigLayerSource::User { .. } => {
                    insert_optional_read(&mut reads, folder.join("skills").to_path_buf());
                    insert_optional_read(&mut reads, codex_skills::system_cache_root_dir(&folder).to_path_buf());
                    if let Some(home) = std::env::var_os("HOME") { insert_optional_read(&mut reads, PathBuf::from(home).join(".agents/skills")); }
                },
                _ => {},
            }
        }
    }
    // Reuse the native marker parser, merger and filesystem discovery. Project
    // layers cannot move the project boundary used by instructions or skills.
    let mut markers_config = toml::Value::Table(toml::map::Map::new());
    for layer in config.config_layer_stack.layers_low_to_high() {
        if !matches!(layer.name, ConfigLayerSource::Project { .. }) {
            codex_config::merge_toml_values(&mut markers_config, &layer.config);
        }
    }
    let markers = codex_config::project_root_markers_from_config(&markers_config).ok().flatten()
        .unwrap_or_else(codex_config::default_project_root_markers);
    let project_root = codex_file_system::find_nearest_native_ancestor_with_markers(
        codex_exec_server::LOCAL_FS.as_ref(), &config.cwd, markers,
        codex_file_system::FindUpErrorPolicy::Ignore, None).await.map_err(|_| ())?.unwrap_or_else(|| config.cwd.clone());
    let mut cursor = config.cwd.to_path_buf();
    loop {
        insert_optional_read(&mut reads, cursor.join(".agents/skills"));
        for name in ["AGENTS.override.md", "AGENTS.md"].into_iter().chain(config.project_doc_fallback_filenames.iter().map(String::as_str)) {
            if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) { continue; }
            let candidate = cursor.join(name);
            if candidate.is_file() { reads.insert(candidate); break; }
        }
        if cursor == project_root.as_path() || !cursor.pop() { break; }
    }
    for entry in config.permissions.file_system_sandbox_policy().entries {
        // :root/:minimal are tool-policy baselines, never permission to expose
        // the user's whole filesystem to vendor code. Runtime project roots
        // and session temp are supplied separately by the invocation owner.
        if let FileSystemPath::Path { path } = entry.path {
            if entry.access == FileSystemAccessMode::Write { writes.insert(path.to_path_buf()); }
            else if entry.access == FileSystemAccessMode::Read { reads.insert(path.to_path_buf()); }
        }
    }
    for root in config.permissions.profile_workspace_roots() { writes.insert(root.as_uri().to_path_buf()); }
    // Runtime workspace roots can come from an owned saved-session snapshot,
    // not only --add-dir. They are project inputs, never additional configs.
    let actual_home = std::env::var_os("HOME").map(PathBuf::from);
    for root in &config.workspace_roots {
        if root.as_path() != std::path::Path::new("/") && Some(root.as_path()) != actual_home.as_deref() {
            writes.insert(root.to_path_buf());
        }
    }
    writes.insert(config.log_dir.clone());
    let database_files: Vec<_> = config.sqlite_config().runtime_db_paths().into_iter().map(|db| db.path).collect();
    let database_roots = database_files.iter().filter_map(|p| p.parent().map(std::path::Path::to_path_buf)).collect();
    let exporters_disabled = [&config.otel.exporter, &config.otel.trace_exporter, &config.otel.metrics_exporter]
        .into_iter().all(|value| matches!(value, OtelExporterKind::None));
    // Read the native typed authored mode; this also avoids any development
    // build fallback being mistaken for the official release's selected store.
    let authored: codex_config::config_toml::ConfigToml = config.config_layer_stack.effective_config().try_into().map_err(|_| ())?;
    Ok(Projection { schema: 1, source_revision: REVISION, cwd: config.cwd.to_path_buf(), reads, writes,
        database_roots, database_files, exporters_disabled, analytics_disabled: config.analytics_enabled == Some(false),
        feedback_disabled: !config.feedback_enabled, updates_disabled: !config.check_for_update_on_startup,
        used_defaults, initialized: false, source_untrusted: config.active_project.is_untrusted(), worktree_root: None,
        owner_thread_id: None, fork_source: None, oss_choice: None, project_cwds: BTreeSet::new(), mcp_servers: None,
        mcp_store: authored.mcp_oauth_credentials_store.unwrap_or_default(),
        mcp_keyring_backend: config.auth_keyring_backend_kind() })
}

async fn load(request: &Request, fallback: bool, restore_reviewer: bool) -> std::io::Result<(Config, BTreeSet<PathBuf>)> {
    load_variant(request, fallback, restore_reviewer, None).await
}

fn loader_options(request: &Request) -> std::io::Result<LoaderOverrides> {
    let invalid = || std::io::Error::other("invalid helper input");
    let mut loader = LoaderOverrides::default();
    loader.ignore_user_config = request.ignore_user_config;
    // Exec gates worktree creation without project config. TUI deliberately
    // uses the full source config for its saved-thread DB/provider lookup.
    loader.ignore_project_config = request.worktree && request.headless;
    loader.ignore_user_and_project_exec_policy_rules = request.ignore_rules;
    if let Some(profile) = &request.profile {
        let profile: ProfileV2Name = profile.parse().map_err(|_| invalid())?;
        loader.user_config_path = Some(resolve_profile_v2_config_path(&request.codex_home, &profile));
        loader.user_config_profile = Some(profile);
    }
    #[cfg(target_os = "macos")]
    {
        loader.managed_preferences_base64 = Some(request.forced_config.clone().ok_or_else(invalid)?);
        loader.macos_managed_config_requirements_base64 = Some(request.forced_requirements.clone().ok_or_else(invalid)?);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (&request.forced_config, &request.forced_requirements);
    Ok(loader)
}

async fn load_variant(request: &Request, fallback: bool, restore_reviewer: bool,
    variant: Option<ConfigOverrides>) -> std::io::Result<(Config, BTreeSet<PathBuf>)> {
    let mut cli = CliConfigOverrides { raw_overrides: request.config.clone() }.parse_overrides()
        .map_err(|_| std::io::Error::other("invalid helper input"))?;
    let mut loader = loader_options(request)?;
    let mut overrides = ConfigOverrides::default();
    if fallback {
        // Exact native non-strict app-server fallback for invalid user/project
        // configuration. Never discard a failing local mandatory policy.
        loader.ignore_user_config = true;
        loader.ignore_project_config = true;
        overrides.cwd = Some(request.codex_home.clone());
    } else if request.worktree && request.headless {
        // Exec resolves its explicit fork/source against the pre-allocation
        // gate config before applying runtime model/permission/OSS flags.
        overrides.cwd = Some(request.cwd.clone());
    } else {
        overrides.cwd = Some(request.cwd.clone());
        overrides.model = request.harness.model.clone();
        overrides.model_provider = request.harness.model_provider.clone();
        overrides.sandbox_mode = request.harness.sandbox;
        overrides.approval_policy = if restore_reviewer { None } else { request.harness.approval.clone() };
        overrides.additional_writable_roots = request.harness.additional_writable_roots.clone();
        overrides.ephemeral = request.harness.ephemeral;
        overrides.bypass_hook_trust = request.harness.bypass_hook_trust;
    }
    let mut reads = BTreeSet::new();
    if let Some(variant) = variant { overrides = variant; }
    if let Some(provider) = &request.selected_oss {
        overrides.model_provider = Some(provider.clone());
        overrides.model = oss::model(provider, request.harness.model.as_deref());
        if !request.headless { cli.push(("model_provider".into(), toml::Value::String(provider.clone()))); }
    }
    let config = ConfigBuilder::default().codex_home(request.codex_home.clone()).cli_overrides(cli)
        .harness_overrides(overrides).loader_overrides(loader).strict_config(request.strict_config)
        .build_with_validation(|cfg, _, layers| {
            // This is the exact native snapshot, not a second config loader.
            let mut cfg = cfg.clone();
            layers.requirements_toml().apply_exact_to_config(&mut cfg);
            for file in [cfg.model_instructions_file, cfg.model_catalog_json, cfg.experimental_compact_prompt_file].into_iter().flatten() {
                reads.insert(file.to_path_buf());
            }
            Ok(())
        }).await?;
    Ok((config, reads))
}

async fn run(mut request: Request, phase: &mut &'static str) -> Result<Projection> {
    if !request.codex_home.is_absolute() || !request.cwd.is_absolute()
        || request.artifact_set.len() != 64 || !request.artifact_set.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(()); }
    *phase = "native OSS settings";
    let choice = oss::choice(&request).await?;
    if request.oss && !request.headless && !request.worktree
        && matches!(request.oss_choice, Some(oss::Choice::Picker)) {
        *phase = "OSS worktree provider";
        if !matches!(oss::configured(&request).await?, Some(oss::Choice::Picker)) { return Err(()); }
    }
    let choices = choice.as_ref().map_or_else(|| vec![None], oss::Choice::providers);
    let branching = choices.len() > 1;
    let mut output: Option<Projection> = None;
    for provider in choices {
        request.selected_oss = provider;
        let next = match run_selected(&request, phase).await {
            Ok(next) => next,
            Err(()) if branching && matches!(request.operation, Operation::ForkSource) => {
                *phase = "OSS worktree source"; return Err(());
            },
            // Native may reject one prospective provider's configuration. It
            // remains an error if selected; do not disable the other choice.
            Err(()) if branching && *phase == "native settings" => continue,
            Err(()) => return Err(()),
        };
        if let Some(output) = &mut output {
            if matches!(request.operation, Operation::ForkSource) && !oss::same_source(output, &next, request.explicit_cwd) {
                *phase = "OSS worktree source"; return Err(());
            }
            if !oss::privacy_compatible(output, &next) { return Err(()); }
            output.source_untrusted |= next.source_untrusted;
            output.initialized &= next.initialized;
            output.used_defaults |= next.used_defaults;
            if output.owner_thread_id != next.owner_thread_id { output.owner_thread_id = None; }
            output.extend_paths(next);
        } else { output = Some(next); }
    }
    let mut output = output.ok_or(())?;
    output.oss_choice = choice;
    output.database_files.sort(); output.database_files.dedup();
    Ok(output)
}

async fn run_selected(request: &Request, phase: &mut &'static str) -> Result<Projection> {
    *phase = "native settings";
    let initial = load(&request, false, false).await;
    let initial = if request.headless && !request.yolo && initial.as_ref().map_or(true, |(config, _)|
        config.approvals_reviewer == codex_config::types::ApprovalsReviewer::AutoReview) {
        match load(&request, false, true).await {
            Ok((config, reads)) if config.approvals_reviewer == codex_config::types::ApprovalsReviewer::AutoReview => Ok((config, reads)),
            _ => initial,
        }
    } else { initial };
    let (config, reads, fallback) = match initial {
        Ok((config, reads)) => (config, reads, false),
        Err(error) if request.owned_app_server && !request.strict_config && !error.get_ref().is_some_and(
            |error| error.is::<codex_core::config::UnsupportedUntrustedApprovalPolicyError>()) => {
            let (config, reads) = load(&request, true, false).await.map_err(|_| ())?;
            (config, reads, true)
        },
        Err(_) => return Err(()),
    };
    *phase = "native input inventory";
    let mut output = projection(&config, reads, fallback).await?;
    if matches!(request.operation, Operation::McpInputs) {
        // Verify values obtained through the native keyring backend using the
        // unchanged native reader's full type, without starting MCP or auth.
        for value in &request.mcp_values {
            serde_json::from_str::<codex_rmcp_client::StoredOAuthTokens>(value).map_err(|_| ())?;
        }
        // Explicit maintenance receives only configured HTTP identities. URLs
        // can contain secrets: this field stays on its private maintenance
        // pipe and is absent from ordinary invocation inventories.
        output.mcp_servers = Some(config.mcp_servers.get().iter().filter_map(|(name, server)| {
            if let codex_config::types::McpServerTransportConfig::StreamableHttp { url, .. } = &server.transport {
                Some(McpInput { name: name.clone(), url: url.clone(), environment_id: server.environment_id.clone(),
                    ordinary_oauth: matches!(server.auth, codex_config::types::McpServerAuth::OAuth) })
            } else { None }
        }).collect());
    }
    if request.worktree {
        // This only reads native environment selection; it neither builds an
        // environment manager nor connects to a remote execution service.
        if codex_exec_server::EnvironmentManager::prepare_from_codex_home(&request.codex_home)
            .await.map_err(|_| ())?.default_environment_is_remote() { return Err(()); }
        // Native CLI worktree allocation uses host bootstrap settings with no
        // cwd, selected profile, project or CLI overrides.
        #[allow(unused_mut)] // Only macOS supplies forced native preferences.
        let mut loader = LoaderOverrides::default();
        #[cfg(target_os = "macos")]
        {
            loader.managed_preferences_base64 = request.forced_config.clone();
            loader.macos_managed_config_requirements_base64 = request.forced_requirements.clone();
        }
        let host = codex_core::config::load_config_toml_with_layer_stack(&request.codex_home, None, vec![],
            codex_config::ConfigLoadOptions { loader_overrides: loader, strict_config: request.strict_config,
                cloud_config_bundle: Default::default() }).await.map_err(|_| ())?;
        output.worktree_root = Some(codex_worktree::WorktreeSettings::for_cli(
            &request.codex_home, host.config_toml.desktop.as_ref()).map_err(|_| ())?.root);
    }
    if !matches!(request.operation, Operation::Inputs) {
        // Admission precedes any native database mutation. Credential backend
        // authority is independently checked from native authored inputs.
        if !output.analytics_disabled || !output.feedback_disabled || !output.updates_disabled
            || !output.exporters_disabled { return Err(()); }
    }
    if matches!(request.operation, Operation::Initialize) {
        *phase = "native database initialization";
        let inventory = state::initialize(&config, None, None, request.saved.as_ref().map(|_| request)).await?;
        if let Some(projected) = inventory.saved.projection {
            if !oss::privacy_compatible(&output, &projected) { return Err(()); }
            output.extend_paths(projected);
        }
        for variant in inventory.saved.databases.into_values() {
            state::initialize(&variant, None, None, None).await?;
        }
        output.database_files.sort(); output.database_files.dedup();
        output.initialized = true;
    }
    if matches!(request.operation, Operation::WorktreeOwner) {
        let owner = request.owner.as_ref().ok_or(())?;
        // A settings edit may select another DB while the child is running.
        // That is not evidence about this invocation's saved thread.
        if owner.matches_databases(&config) {
            output.owner_thread_id = state::initialize(&config, Some(owner), None, None).await?.owner;
        }
    }
    if matches!(request.operation, Operation::ForkSource) {
        let source = request.fork_source.as_ref().ok_or(())?;
        output.fork_source = state::initialize(&config, None, Some(source), None).await?.source;
    }
    Ok(output)
}

fn main() {
    // No tracing subscriber, panic details or upstream errors reach the pipe:
    // parsing errors can embed the credential-bearing input or file contents.
    std::panic::set_hook(Box::new(|panic| {
        // Source location is static build metadata. Never print a panic's
        // payload, which may contain a parsed configuration or credential.
        if let Some(location) = panic.location() {
            let file = location.file().rsplit('/').next().unwrap_or("native");
            eprintln!("Codex input preparation stopped after a native library panic ({file}:{}).", location.line());
        }
    }));
    let mut phase = "private channels";
    let result = (|| -> Result<()> {
        if unsafe { aim_config_channels() } != 0 { return Err(()); }
        phase = "private request";
        let mut input = Vec::new();
        std::io::stdin().take(1024 * 1024 + 1).read_to_end(&mut input).map_err(|_| ())?;
        if input.len() > 1024 * 1024 { return Err(()); }
        let request: Request = serde_json::from_slice(&input).map_err(|_| ())?;
        input.fill(0);
        phase = "privacy boundary";
        if unsafe { aim_config_boundary(i32::from(matches!(request.operation, Operation::Inputs | Operation::McpInputs))) } != 0 { return Err(()); }
        // Native metadata backfill otherwise prints source paths directly when
        // no dispatcher exists. A no-op dispatcher emits no telemetry/logs.
        tracing::subscriber::set_global_default(tracing::subscriber::NoSubscriber::default()).map_err(|_| ())?;
        // Worker threads inherit the already-installed boundary.
        // Filesystem and SQLite work use blocking workers/channels; no network
        // or signal reactor is needed. enable_all would create a signal Unix
        // socketpair on Linux and violate this helper's no-socket boundary.
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_time().build().map_err(|_| ())?;
        let output = runtime.block_on(run(request, &mut phase))?;
        phase = "private response";
        let bytes = serde_json::to_vec(&output).map_err(|_| ())?;
        std::io::stdout().write_all(&bytes).map_err(|_| ())?;
        Ok(())
    })();
    if result.is_err() {
        eprintln!("Codex input preparation failed at {phase}; no native configuration or credential details were logged.");
        std::process::exit(125);
    }
}
