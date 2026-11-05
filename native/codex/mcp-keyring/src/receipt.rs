//! A finite maintenance write receipt, held with the parent's inherited locks.
//! No credentials enter receipts; immutable intent hashes bind their contents.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::PathBuf;

unsafe extern "C" { fn aim_mcp_private_acl(fd: libc::c_int) -> libc::c_int; }
fn private_acl(file: &File) -> Result<(), &'static str> {
    if unsafe { aim_mcp_private_acl(file.as_raw_fd()) } != 0 { Err("maintenance_acl") } else { Ok(()) }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Maintenance {
    operation_id: String,
    intent_sha256: String,
    boot_id: String,
    lock_fds: Vec<i32>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Outcome {
    schema: u32,
    operation_id: String,
    intent_sha256: String,
    boot_id: String,
    phase: String,
}

pub(super) struct Receipt { directory: PathBuf, outcome: Outcome, _locks: Vec<File> }

fn hexadecimal(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn canonical_boot_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_digit() || (b'a'..=b'f').contains(&b) }
    })
}

fn boot_id() -> Result<String, &'static str> {
    #[cfg(target_os = "linux")]
    let value = fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|_| "maintenance_boot")?;
    #[cfg(target_os = "macos")]
    let value = {
        let output = std::process::Command::new("/usr/sbin/sysctl").args(["-n", "kern.bootsessionuuid"])
            .output().map_err(|_| "maintenance_boot")?;
        if !output.status.success() { return Err("maintenance_boot"); }
        String::from_utf8(output.stdout).map_err(|_| "maintenance_boot")?
    };
    let value = value.trim().to_ascii_lowercase();
    if !canonical_boot_id(&value) { return Err("maintenance_boot"); }
    Ok(value)
}

impl Receipt {
    pub(super) fn open(input: Maintenance, name: &str, url: &str, value: &str, access: Option<&str>) -> Result<Self, &'static str> {
        let uid = unsafe { libc::getuid() };
        if uid == 0 || uid != unsafe { libc::geteuid() }
            || !hexadecimal(&input.operation_id, 32) || !hexadecimal(&input.intent_sha256, 64)
            || input.boot_id != boot_id()? || !(2..=128).contains(&input.lock_fds.len()) { return Err("maintenance_input"); }
        let mut digest = Sha256::new();
        for field in [name, url, value] { digest.update((field.len() as u64).to_be_bytes()); digest.update(field.as_bytes()); }
        if let Some(field) = access { digest.update((field.len() as u64).to_be_bytes()); digest.update(field.as_bytes()); }
        if format!("{:x}", digest.finalize()) != input.intent_sha256 { return Err("maintenance_intent"); }
        let mut identities = std::collections::HashSet::new();
        // Validate the original descriptor set before opening anything: a
        // duplicate must not fill a missing later descriptor in the request.
        let minimum_duplicate = input.lock_fds.iter().max().copied().ok_or("maintenance_lock")?
            .checked_add(1).ok_or("maintenance_lock")?;
        for &fd in &input.lock_fds {
            if fd < 3 { return Err("maintenance_lock"); }
            let mut meta = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe { libc::fstat(fd, meta.as_mut_ptr()) } != 0 { return Err("maintenance_lock"); }
            let meta = unsafe { meta.assume_init() };
            if meta.st_mode & libc::S_IFMT != libc::S_IFREG || meta.st_uid != uid || meta.st_nlink != 1
                || meta.st_mode & 0o022 != 0 || !identities.insert((meta.st_dev, meta.st_ino)) { return Err("maintenance_lock"); }
        }
        let mut locks = Vec::new();
        for fd in input.lock_fds {
            let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, minimum_duplicate) };
            if duplicate < 0 { return Err("maintenance_lock"); }
            let file = unsafe { File::from_raw_fd(duplicate) };
            let meta = file.metadata().map_err(|_| "maintenance_lock")?;
            private_acl(&file)?;
            if !meta.is_file() || meta.uid() != uid || meta.nlink() != 1 || meta.mode() & 0o022 != 0
                || unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err("maintenance_lock"); }
            locks.push(file);
        }
        let base = PathBuf::from(format!("/opt/aimgr-codex-runtime/users/{uid}/maintenance"));
        let private_directory = |path: &std::path::Path| -> Result<(), &'static str> {
            let file = OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW).open(path)
                .map_err(|_| "maintenance_directory")?;
            let meta = file.metadata().map_err(|_| "maintenance_directory")?;
            if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 { return Err("maintenance_directory"); }
            private_acl(&file)?;
            Ok(())
        };
        private_directory(&base)?;
        if !base.join("pending.json").is_file() { return Err("maintenance_pending"); }
        let directory = base.join("receipts");
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => File::open(&base).and_then(|f| f.sync_all()).map_err(|_| "maintenance_receipt")?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(_) => return Err("maintenance_directory"),
        }
        private_directory(&directory)?;
        let target = directory.join(format!("{}.json", input.operation_id));
        let mut previous_phase = None;
        match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&target) {
            Ok(file) => {
                let meta = file.metadata().map_err(|_| "maintenance_receipt")?;
                private_acl(&file)?;
                if !meta.is_file() || meta.uid()!=uid || meta.nlink()!=1 || meta.mode()&0o077!=0 || meta.len()>4096 { return Err("maintenance_receipt"); }
                let old: Outcome = serde_json::from_reader(file).map_err(|_| "maintenance_receipt")?;
                if old.schema != 1 || old.operation_id != input.operation_id || old.intent_sha256 != input.intent_sha256 { return Err("maintenance_intent"); }
                if !canonical_boot_id(&old.boot_id) { return Err("maintenance_boot"); }
                if !["not_dispatched", "dispatched", "acknowledged", "verified"].contains(&old.phase.as_str()) { return Err("maintenance_receipt"); }
                previous_phase = Some(old.phase);
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("maintenance_receipt"),
        }
        // Preserve an existing receipt through read errors or conflicts. Only
        // explicit maintenance retries an absent destination, with the same
        // immutable intent and native locks. Secret Service provides no portable
        // crash-drain guarantee; boot identity is provenance, not a retry gate.
        let fresh = previous_phase.is_none();
        let mut receipt = Self { directory, _locks: locks, outcome: Outcome { schema: 1,
            operation_id: input.operation_id, intent_sha256: input.intent_sha256,
            boot_id: input.boot_id, phase: previous_phase.unwrap_or_else(|| "not_dispatched".to_owned()) } };
        if fresh { receipt.record("not_dispatched")?; }
        Ok(receipt)
    }

    pub(super) fn record(&mut self, phase: &str) -> Result<(), &'static str> {
        self.outcome.phase = phase.to_owned();
        let bytes = serde_json::to_vec(&self.outcome).map_err(|_| "maintenance_receipt")?;
        // A unique private temporary entry; an interrupted predecessor never
        // gets overwritten or interpreted as a completed receipt.
        for suffix in 0..100 {
            let temporary = self.directory.join(format!(".{}-{}-{suffix}", self.outcome.operation_id, std::process::id()));
            let mut file = match OpenOptions::new().create_new(true).write(true).mode(0o600).open(&temporary) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("maintenance_receipt"),
            };
            private_acl(&file)?;
            file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "maintenance_receipt")?;
            fs::rename(temporary, self.directory.join(format!("{}.json", self.outcome.operation_id))).map_err(|_| "maintenance_receipt")?;
            return File::open(&self.directory).and_then(|f| f.sync_all()).map_err(|_| "maintenance_receipt");
        }
        Err("maintenance_receipt")
    }
}
