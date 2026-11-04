use super::Result;
use codex_core::config::Config;
use codex_protocol::MemoryVersion;
use codex_state::StateRuntime;
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::{Duration, Instant};

async fn lock(root: &Path, deadline: Instant) -> Result<File> {
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(root.join(".aimgr-codex-db-init.lock")).map_err(|_| ())?;
    let meta = file.metadata().map_err(|_| ())?;
    if !meta.is_file() || meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o077 != 0 || meta.nlink() != 1 { return Err(()); }
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 { return Ok(file); }
        let error = std::io::Error::last_os_error().raw_os_error();
        if !matches!(error, Some(libc::EWOULDBLOCK) | Some(libc::EINTR)) || Instant::now() >= deadline { return Err(()); }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[derive(Default)]
pub(super) struct Inventory {
    pub(super) owner: Option<String>, pub(super) source: Option<super::source::Source>,
    pub(super) saved: super::saved::Inventory,
}

pub(super) async fn initialize(config: &Config, owner: Option<&super::owner::Request>, source: Option<&super::source::Request>,
    saved: Option<&super::Request>) -> Result<Inventory> {
    let sqlite = config.sqlite_config().clone();
    let paths: Vec<_> = sqlite.runtime_db_paths().into_iter().map(|db| db.path).collect();
    // Canonical physical roots serialize aliases and a separate native logs
    // directory. Locks belong to this process, not to a heartbeat or its parent.
    let mut roots = BTreeSet::new();
    for path in &paths {
        let parent = path.parent().ok_or(())?;
        fs::create_dir_all(parent).map_err(|_| ())?;
        roots.insert(fs::canonicalize(parent).map_err(|_| ())?);
        // Existing file symlinks can point outside the configured directory.
        // Lock both the configured home and the actual SQLite destination;
        // hard links cannot supply one stable sidecar/locking identity.
        if fs::symlink_metadata(path).is_ok() {
            let physical=fs::canonicalize(path).map_err(|_| ())?;
            let meta=fs::metadata(&physical).map_err(|_| ())?;
            if !meta.is_file() || meta.nlink()!=1 { return Err(()); }
            roots.insert(physical.parent().ok_or(())?.to_path_buf());
        }
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut locks = Vec::new();
    for root in &roots { locks.push(lock(root, deadline).await?); }
    if owner.is_some_and(|owner| !owner.matches_databases(config)) { return Ok(Inventory::default()); }
    let runtime = if source.is_some() || saved.is_some() {
        codex_rollout::state_db::try_init(config).await.map_err(|_| ())?
    } else {
        StateRuntime::init(sqlite.clone(), config.model_provider_id.clone()).await.map_err(|_| ())?
    };
    let result: Result<Inventory> = async {
        runtime.memories_for_version(MemoryVersion::V2).await.map_err(|_| ())?;
        let history = codex_state::open_thread_history_db(&sqlite).await.map_err(|_| ())?;
        history.close().await;
        let mut result = Inventory::default();
        if let Some(owner) = owner { result.owner = super::owner::select(&runtime, owner).await?; }
        if let Some(source) = source { result.source = Some(super::source::select(config, runtime.clone(), source).await?); }
        if let Some(request) = saved { result.saved = super::saved::resolve(request, config, runtime.clone()).await?; }
        Ok(result)
    }.await;
    runtime.close().await;
    // Native migration state is the sole completion authority. Close every
    // pool before releasing the finite physical-root locks.
    drop(locks);
    result
}
