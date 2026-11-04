use super::Result;
use codex_core::config::Config;
use codex_protocol::MemoryVersion;
use codex_state::StateRuntime;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize)]
struct Identity { path: PathBuf, device: u64, inode: u64, minimum_size: u64 }
#[derive(Serialize, Deserialize)]
struct Completion { artifact_set: String, files: Vec<Identity> }

fn identity(path: &Path) -> Result<Identity> {
    let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC).open(path).map_err(|_| ())?;
    let meta = file.metadata().map_err(|_| ())?;
    if !meta.is_file() || meta.nlink()!=1 || meta.len() < 4096 { return Err(()); }
    let mut magic = [0u8; 16];
    file.read_exact(&mut magic).map_err(|_| ())?;
    if &magic != b"SQLite format 3\0" { return Err(()); }
    Ok(Identity { path: fs::canonicalize(path).map_err(|_| ())?, device: meta.dev(), inode: meta.ino(), minimum_size: meta.len() })
}

fn completed(file: &Path, paths: &[PathBuf], artifact_set: &str) -> bool {
    let Ok(file) = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(file) else { return false; };
    let Ok(meta) = file.metadata() else { return false; };
    if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o077 != 0 || meta.len() > 65536 { return false; }
    let Ok(prior) = serde_json::from_reader::<_, Completion>(file.take(65537)) else { return false; };
    if prior.artifact_set != artifact_set || prior.files.len() != paths.len() { return false; }
    prior.files.iter().zip(paths).all(|(old, path)| identity(path).is_ok_and(|new| {
        old.path == new.path && old.device == new.device && old.inode == new.inode && new.minimum_size >= old.minimum_size
    }))
}

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

pub(super) async fn initialize(config: &Config, artifact_set: &str) -> Result<()> {
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
    let completion = sqlite.home().join(".aimgr-codex-db-initialized.json");
    if completed(&completion, &paths, artifact_set) { return Ok(()); }
    let runtime = StateRuntime::init(sqlite.clone(), config.model_provider_id.clone()).await.map_err(|_| ())?;
    let result: Result<()> = async {
        runtime.memories_for_version(MemoryVersion::V2).await.map_err(|_| ())?;
        let history = codex_state::open_thread_history_db(&sqlite).await.map_err(|_| ())?;
        history.close().await;
        Ok(())
    }.await;
    runtime.close().await;
    result?;
    // Publish only after native pools/workers close. No schema is copied into
    // AIM and no fake thread or user-visible event is created for lazy history.
    let files = paths.iter().map(|p| identity(p)).collect::<Result<Vec<_>>>()?;
    let bytes = serde_json::to_vec(&Completion { artifact_set: artifact_set.to_owned(), files }).map_err(|_| ())?;
    let mut file = tempfile::NamedTempFile::new_in(sqlite.home()).map_err(|_| ())?;
    file.write_all(&bytes).map_err(|_| ())?;
    file.as_file().sync_all().map_err(|_| ())?;
    file.persist(&completion).map_err(|_| ())?;
    let result = File::open(sqlite.home()).and_then(|f| f.sync_all()).map_err(|_| ());
    drop(locks);
    result
}
