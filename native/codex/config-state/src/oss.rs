//! Pure OSS bootstrap choices. Official Codex alone detects local services,
//! presents its provider selector, or downloads a model.
use super::{Projection, Request, Result, loader_options};
use codex_core::config::{load_config_toml_with_layer_stack, resolve_oss_provider};
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_cli::CliConfigOverrides;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Choice { Provider(String), Picker }

impl Choice {
    pub(super) fn providers(&self) -> Vec<Option<String>> {
        match self {
            Self::Provider(provider) => vec![Some(provider.clone())],
            Self::Picker => vec![Some("lmstudio".into()), Some("ollama".into())],
        }
    }
}

// Exact constants from revision 6ff1e1ca3b30fc8b914720681fcf5fe62e95f856.
// Importing utils/oss just for this lookup pulls both service-readiness clients
// and their mock-server dependencies into this finite offline helper.
pub(super) fn model(provider: &str, explicit: Option<&str>) -> Option<String> {
    explicit.or(match provider {
        "lmstudio" => Some("openai/gpt-oss-20b"),
        "ollama" => Some("gpt-oss:20b"),
        _ => None,
    }).map(str::to_owned)
}

pub(super) async fn choice(request: &Request) -> Result<Option<Choice>> {
    if !request.oss || (request.worktree && request.headless) { return Ok(None); }
    // TUI chooses before worktree creation. Preserve that original choice
    // through source-cwd reloads and destination input preparation.
    if !request.headless && let Some(choice) = &request.oss_choice { return Ok(Some(choice.clone())); }
    configured(request).await
}

pub(super) async fn configured(request: &Request) -> Result<Option<Choice>> {
    let cli = CliConfigOverrides { raw_overrides: request.config.clone() }.parse_overrides().map_err(|_| ())?;
    let cwd = AbsolutePathBuf::from_absolute_path(request.cwd.clone()).map_err(|_| ())?;
    let bootstrap = load_config_toml_with_layer_stack(&request.codex_home, Some(&cwd), cli,
        codex_config::ConfigLoadOptions { loader_overrides: loader_options(request).map_err(|_| ())?,
            strict_config: request.strict_config, cloud_config_bundle: Default::default() }).await.map_err(|_| ())?;
    if let Some(provider) = resolve_oss_provider(request.local_provider.as_deref(), &bootstrap.config_toml) {
        return Ok(Some(Choice::Provider(provider)));
    }
    // Headless exec owns its native "no default OSS provider" diagnostic.
    if request.headless { return Ok(None); }
    Ok(Some(Choice::Picker))
}

pub(super) fn same_source(a: &Projection, b: &Projection, explicit_cwd: bool) -> bool {
    match (&a.fork_source, &b.fork_source) {
        (Some(a), Some(b)) => a.thread_id == b.thread_id && (explicit_cwd || a.cwd == b.cwd),
        _ => false,
    }
}

pub(super) fn privacy_compatible(a: &Projection, b: &Projection) -> bool {
    [a, b].into_iter().all(|p| p.analytics_disabled && p.feedback_disabled && p.updates_disabled
        && !p.collectors.iter().enumerate().any(|(i,c)| c.provider_destination && !(i==2 && c.kind=="statsig")))
        && a.mcp_store == b.mcp_store && a.mcp_keyring_backend == b.mcp_keyring_backend
        && a.worktree_root == b.worktree_root
}

#[cfg(test)]
mod tests {
    #[test]
    fn defaults_match_pinned_native_sources_and_explicit_model_wins() {
        for (provider, source) in [
            ("lmstudio", include_str!("../vendor/codex/codex-rs/lmstudio/src/lib.rs")),
            ("ollama", include_str!("../vendor/codex/codex-rs/ollama/src/lib.rs")),
        ] {
            let native = source.lines().find_map(|line| line.strip_prefix("pub const DEFAULT_OSS_MODEL: &str = "))
                .expect("pinned native constant").trim_end_matches(';').trim_matches('"');
            assert_eq!(super::model(provider, None).as_deref(), Some(native));
            assert_eq!(super::model(provider, Some("explicit-model")).as_deref(), Some("explicit-model"));
        }
        assert_eq!(super::model("unknown", None), None);
        assert_eq!(super::model("unknown", Some("explicit-model")).as_deref(), Some("explicit-model"));
    }
}
