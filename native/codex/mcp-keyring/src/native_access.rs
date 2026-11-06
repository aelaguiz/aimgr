//! Per-item macOS access for the admitted unchanged vendor and this helper.
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NativeAccess { executable: String, sha256: String }

impl NativeAccess {
    pub(super) fn intent(&self) -> String { format!("{}\0{}", self.executable, self.sha256) }

    pub(super) fn validate(&self) -> Result<(), &'static str> {
        #[cfg(not(target_os = "macos"))]
        return Err("native_access_platform");
        #[cfg(target_os = "macos")]
        {
            use std::{fs, io::Read, os::unix::fs::MetadataExt, path::Path};
            use sha2::{Digest, Sha256};
            let path = Path::new(&self.executable);
            if !path.is_absolute() || path.canonicalize().map_err(|_| "native_access_path")? != path
                || self.sha256.len() != 64 { return Err("native_access_path"); }
            for ancestor in path.ancestors() {
                let info = fs::symlink_metadata(ancestor).map_err(|_| "native_access_path")?;
                if info.uid() != 0 || info.mode() & 0o022 != 0 || info.file_type().is_symlink()
                    || (ancestor != path && !info.is_dir()) { return Err("native_access_owner"); }
            }
            let mut file = fs::File::open(path).map_err(|_| "native_access_path")?;
            let info = file.metadata().map_err(|_| "native_access_path")?;
            if !info.is_file() || info.mode() & 0o111 == 0 { return Err("native_access_path"); }
            let mut digest = Sha256::new();let mut buffer = [0; 65536];
            loop {
                let size = file.read(&mut buffer).map_err(|_| "native_access_digest")?;
                if size == 0 { break; }
                digest.update(&buffer[..size]);
            }
            if format!("{:x}", digest.finalize()) != self.sha256 { return Err("native_access_digest"); }
            Ok(())
        }
    }

    pub(super) fn create(&self, account: &str, value: &str) -> Result<(), &'static str> {
        #[cfg(not(target_os = "macos"))]
        { let _ = (account, value); Err("native_access_platform") }
        #[cfg(target_os = "macos")]
        {
            use std::ffi::CString;
            unsafe extern "C" {
                fn aim_mcp_create_native_access(account: *const libc::c_char, value: *const u8,
                    size: usize, vendor: *const libc::c_char) -> libc::c_int;
            }
            let account = CString::new(account).map_err(|_| "identity")?;
            let vendor = CString::new(self.executable.as_str()).map_err(|_| "native_access_path")?;
            match unsafe { aim_mcp_create_native_access(account.as_ptr(), value.as_ptr(), value.len(), vendor.as_ptr()) } {
                0 | 1 => Ok(()), // Duplicate is preserved and checked by readback.
                _ => Err("keyring_write"),
            }
        }
    }
}
