import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HASH = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILES = 512;

/** Shared immutable-file and approval checks. Provider-specific policy,
 * request inputs and runtime owners stay in their respective modules. */
export function createArtifactAdmission({ provider, runtimeRootDefault, privacyAbi, offsiteHostFile, requiredEntries, maintenanceEntries = () => [], hashInstalledFiles = true, maxTestAuthorizationMs = 7 * 24 * 60 * 60 * 1000 }) {
  class AdmissionError extends Error {
    constructor(reason) {
      super(`${provider} was not started: ${reason}. Run AIM's privacy status to inspect the selected and approved builds.`);
      this.name = `${provider}AdmissionError`;
      this.code = `AIMGR_${provider.toUpperCase()}_BUILD_NOT_APPROVED`;
    }
  }

  /** A diagnostic hint only. Reading an installation filename must never grant
   * approval, and --version would execute the very build admission may reject. */
  function installedVersionHint(command, fsImpl = fs) {
    try {
      if (!path.isAbsolute(command ?? "")) return null;
      const name = path.basename(fsImpl.realpathSync(command));
      return /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(name) ? name : null;
    } catch { return null; }
  }

  const fail = (reason) => { throw new AdmissionError(reason); };
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value) => typeof value === "string" && value.trim().length > 0;

  function relativeFile(value) {
    return text(value) && value.length <= 1024 && !value.includes("\\")
      && value.split("/").every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..");
  }

  function owned(stat, description) {
    // T02/T03: protecting the leaf is insufficient. A writable parent permits
    // replacement after hashing, and a group-writable approval permits self-
    // approval. Root tampering is excluded; runtime-user writes are not.
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink()) {
      fail(`${description} is not administrator-owned and protected against replacement`);
    }
  }

  function runtimeCannotWrite(file, fsImpl) {
    // T03: W_OK is NOT an ACL immutability test on Darwin. Directory add_file
    // without add_subdirectory, append-only access and writesecurity can all
    // change a supposedly protected package while W_OK fails. Inspect every ACL
    // before trusting uid/mode/access. The fixed OS tool avoids trusting a helper
    // from the artifact set that we have not admitted yet. Unknown ACL syntax
    // fails closed. Read-only grants and deny entries on system ancestors remain
    // supported; any mutation grant is rejected regardless of its principal.
    if (process.platform === "darwin") {
      if (/[\r\n]/.test(file)) fail("an artifact path cannot be inspected safely");
      const listing = execFileSync("/bin/ls", ["-ldeP", "--", file], {
        encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
        timeout: 5000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
      const entries = listing.trimEnd().split("\n").slice(1);
      const readOnly = new Set(["read", "list", "execute", "search", "readattr", "readextattr", "readsecurity", "synchronize",
        "inherited", "file_inherit", "directory_inherit", "limit_inherit", "only_inherit"]);
      for (const entry of entries) {
        const match = /^\s+\d+: .+ (allow|deny) ([a-z_,]+)$/.exec(entry);
        if (!match || (match[1] === "allow" && match[2].split(",").some(right => !readOnly.has(right)))) {
          fail("an artifact or its ancestor has an unsafe or unsupported access-control entry");
        }
      }
    }
    // Root deliberately changing a runtime is outside the threat model. Actual
    // runtime-user tests still exercise the effective-access branch below.
    if (process.getuid() === 0) return;
    try {
      fsImpl.accessSync(file, fs.constants.W_OK);
    } catch (error) {
      // macOS's sealed root returns EROFS even for unprivileged W_OK. Its ACL
      // was checked above; a read-only mount cannot make its children replaceable.
      if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) return;
      throw error;
    }
    fail("the runtime user can write an artifact or its containing directory");
  }

  function directoryChain(directory, fsImpl, checked = new Set()) {
    let current = directory;
    while (true) {
      if (checked.has(current)) return;
      const stat = fsImpl.lstatSync(current);
      owned(stat, "an artifact directory");
      if (!stat.isDirectory()) fail("an artifact ancestor is not a directory");
      runtimeCannotWrite(current, fsImpl);
      checked.add(current);
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }

  function openProtected(file, fsImpl) {
    const before = fsImpl.lstatSync(file);
    owned(before, "an artifact or approval file");
    if (!before.isFile() || before.nlink !== 1) fail("an artifact or approval file is not a private regular file");
    runtimeCannotWrite(file, fsImpl);
    const fd = fsImpl.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fsImpl.fstatSync(fd);
      owned(stat, "an open artifact or approval file");
      if (!stat.isFile() || stat.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino) {
        fail("an artifact or approval changed during admission");
      }
      return { fd, stat };
    } catch (error) {
      fsImpl.closeSync(fd);
      throw error;
    }
  }

  /** Check a fixed administrator-controlled input, including absent policy.
   * An absent leaf is safe only if its nearest existing parent and every
   * ancestor cannot be replaced by the runtime user. Do not equate ENOENT with
   * permission denial: Claude's native policy eligibility distinguishes them.
   * Kept beside artifact checks so Darwin ACL handling cannot drift between the
   * executable and the higher-precedence settings that control it (T02/T08).
   */
  function inspectAdministratorPath(file, { fsImpl = fs, readBytes = true } = {}) {
    if (!path.isAbsolute(file ?? "") || path.resolve(file) !== file) fail("a managed policy path is invalid");
    let stat;
    try { stat = fsImpl.lstatSync(file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      let parent = path.dirname(file);
      for (;;) {
        try { fsImpl.lstatSync(parent); break; }
        catch (parentError) {
          if (parentError.code !== "ENOENT" || parent === path.dirname(parent)) throw parentError;
          parent = path.dirname(parent);
        }
      }
      directoryChain(parent, fsImpl);
      return null;
    }
    if (stat.isSymbolicLink()) {
      // Native managed JSON accepts immutable leaf symlinks. The link's parent
      // and resolved target must both be protected; a root-owned link into a
      // user-writable directory is not administrator policy.
      if (stat.uid !== 0) fail("a managed policy symlink is not administrator-owned");
      directoryChain(path.dirname(file), fsImpl);
      const target = path.resolve(path.dirname(file), fsImpl.readlinkSync(file));
      if (fsImpl.realpathSync(target) !== target) fail("a managed policy has an indirect symlink target");
      return inspectAdministratorPath(target, { fsImpl, readBytes });
    }
    if (stat.isDirectory()) { directoryChain(file, fsImpl); return { kind: "directory", resolvedPath: file }; }
    directoryChain(path.dirname(file), fsImpl);
    const opened = openProtected(file, fsImpl);
    try {
      if (readBytes && opened.stat.size > 2 * 1024 * 1024) fail("a managed policy exceeds the native size limit");
      // Native bounds converted plist JSON, not binary/XML source bytes. The
      // plist reader requests metadata only and bounds plutil's actual output.
      return { kind: "file", resolvedPath: file, ...(readBytes ? { bytes: fsImpl.readFileSync(opened.fd) } : {}) };
    } finally { fsImpl.closeSync(opened.fd); }
  }

  function readRecord(file, fsImpl) {
    const { fd, stat } = openProtected(file, fsImpl);
    try {
      if (stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) fail("an approval record has an invalid size");
      const value = JSON.parse(fsImpl.readFileSync(fd, "utf8"));
      if (!object(value)) fail("an approval record is not an object");
      return value;
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  function authorizeOffsiteTest({ runtimeRoot, artifactSet, platform, arch, fsImpl, checked }) {
    // Test authorization is local administrator state, never an inherited flag.
    // Keep the host token OUTSIDE the copied artifact/runtime tree so moving a
    // test package cannot authorize a personal machine. Root tampering is outside
    // the threat model; this record grants no normal-use approval (T02/T21).
    directoryChain(path.dirname(offsiteHostFile), fsImpl, checked);
    const host = readRecord(offsiteHostFile, fsImpl);
    const authorization = readRecord(path.join(runtimeRoot, "offsite-test.json"), fsImpl);
    const issued = Date.parse(authorization.authorizedAt), expires = Date.parse(authorization.expiresAt);
    const now = Date.now();
    if (host.schema !== 1 || typeof host.token !== "string" || !HASH.test(host.token)
      || authorization.schema !== 1 || authorization.artifactSet !== artifactSet
      || authorization.platform !== platform || authorization.arch !== arch
      || authorization.normalUseApproved !== false || !text(authorization.reference)
      || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now
      || expires <= now || expires <= issued || expires - issued > maxTestAuthorizationMs
      || authorization.hostTokenSha256 !== crypto.createHash("sha256").update(host.token).digest("hex")) {
      fail("the offsite test authorization is absent, expired or belongs to another host/build");
    }
  }

  function fileDigest(fd, fsImpl) {
    // Streaming avoids allocating a complete ~300 MB native executable per
    // concurrent launch. Never execute --version to identify an unknown build.
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = fsImpl.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest("hex");
  }

  function artifactSetDigest(files) {
    if (!object(files) || Object.keys(files).length === 0 || Object.keys(files).length > MAX_FILES) {
      fail("the approved artifact inventory is invalid");
    }
    const inventory = Object.keys(files).sort().map((name) => {
      const value = files[name];
      if (!relativeFile(name) || !object(value) || !HASH.test(value.sha256)
        || !Number.isSafeInteger(value.size) || value.size < 0
        || typeof value.executable !== "boolean"
        || !["vendor", "launcher", "policy", "resource"].includes(value.role)) {
        fail("an approved artifact inventory entry is invalid");
      }
      return [name, value.sha256, value.size, value.executable, value.role];
    });
    return crypto.createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  }

  function enumerate(directory, fsImpl, ignored, prefix = "") {
    const result = [];
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (ignored.has(name)) continue;
      if (!relativeFile(name)) fail("an artifact directory contains an unsupported name");
      const absolute = path.join(directory, entry.name);
      const stat = fsImpl.lstatSync(absolute);
      owned(stat, "an artifact entry");
      runtimeCannotWrite(absolute, fsImpl);
      if (stat.isDirectory()) result.push(...enumerate(absolute, fsImpl, ignored, `${name}/`));
      else if (stat.isFile()) result.push(name);
      else fail("an artifact entry is not a regular file or directory");
      if (result.length > MAX_FILES) fail("the artifact directory exceeds its approved inventory");
    }
    return result.sort();
  }

  /**
   * Read-only admission; deliberately separate from installation and execution.
   *
   * T02/T03 require BOTH this integrity check and a platform exec boundary. This
   * function alone cannot stop a pinned client from executing a downloaded update.
   * The native launcher must enforce the matching immutable policy before exec.
   * Do not wire this into a normal/protected launch as a flags-only version lock.
   * No returned object is permission to run through a different mutable PATH.
   *
   * runtimeRoot/fsImpl are dependency injection for contract tests. Production
   * callers use the fixed root, not an inherited env/config/CLI override.
   */
  function admitArtifact({
    runtimeRoot = runtimeRootDefault,
    selectedCommand,
    pinnedArtifactSet,
    maintenance = false,
    platform = process.platform,
    arch = process.arch,
    fsImpl = fs,
  } = {}) {
    let approvedBuild = null;
    try {
      if (!["linux", "darwin"].includes(platform) || !path.isAbsolute(runtimeRoot)) {
        fail("the native platform or artifact root is unsupported");
      }
      // Reuse ancestor checks only within this synchronous admission. Each new
      // launch starts fresh; native privileged-entry checks remain independent.
      const checked = new Set();
      directoryChain(runtimeRoot, fsImpl, checked);
      const selector = readRecord(path.join(runtimeRoot, "active.json"), fsImpl);
      if (selector.schema !== 1 || typeof selector.artifactSet !== "string" || !HASH.test(selector.artifactSet)) fail("the active build selector is invalid");
      // A trusted nested launch defaults to its parent's still-approved set.
      // macOS's fixed no-sandbox entry names that immutable launcher; silently
      // switching it to a newly activated set would break nested execution.
      // The pin only chooses a record: every normal approval/ABI/integrity check
      // below still runs, including explicit PATH selection. It is not authority.
      if (pinnedArtifactSet !== undefined && (typeof pinnedArtifactSet !== "string" || !HASH.test(pinnedArtifactSet))) fail("the inherited approved build selection is invalid");
      const artifactSet = pinnedArtifactSet ?? selector.artifactSet;
      const root = path.join(runtimeRoot, "artifacts", artifactSet);
      directoryChain(root, fsImpl, checked);
      const manifest = readRecord(path.join(root, "approval.json"), fsImpl);
      if (manifest.schema !== 1 || manifest.platform !== platform || manifest.arch !== arch
        || manifest.privacyAbi !== privacyAbi || !text(manifest.version)) {
        fail("the selected build has no compatible approval");
      }
      const approval = manifest.approval;
      if (!object(approval) || !text(approval.reference)) fail("the selected build lacks explicit authorization");
      if (approval.kind === "normal-use") {
        if (!/^[a-f0-9]{40}$/.test(manifest.reviewedAimRevision) || !text(approval.approver) || !text(approval.reviewEvidence) || !text(approval.approvedAt)
          || !Number.isFinite(Date.parse(approval.approvedAt))) fail("the selected build lacks explicit normal-use approval");
      } else if (approval.kind === "offsite-test" && approval.normalUseApproved === false) {
        // Candidate testing is not a reviewed production revision. Bind its
        // source archive separately rather than inventing review signoff.
        if (!HASH.test(manifest.candidateSourceSha256 ?? "")) fail("the offsite candidate source is unidentified");
        authorizeOffsiteTest({ runtimeRoot, artifactSet, platform, arch, fsImpl, checked });
      } else fail("the selected build lacks explicit normal-use approval");
      // Display only an administrator-owned, compatible, authorized record.
      // This is explanatory context: remaining inventory/immutability checks
      // and the provider's content-verification policy still apply.
      approvedBuild = { version: /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)
        ? manifest.version : "version label unavailable", kind: approval.kind };
      if (artifactSetDigest(manifest.files) !== artifactSet) {
        fail("the approved artifact inventory does not match the selected build");
      }
      for (const [key, role] of [["entrypoint", "vendor"], ["launcher", "launcher"], ["policy", "policy"]]) {
        const name = manifest[key];
        if (!relativeFile(name) || manifest.files[name]?.role !== role
          || manifest.files[name].executable !== (key !== "policy")) {
          fail("the approved runtime has no valid vendor, launcher or policy entry");
        }
      }
      const conversion = maintenanceEntries(platform);
      const required = [...requiredEntries(platform), ...(maintenance ? conversion : [])];
      // These fixed conversion tools are never read or executed during normal
      // launch. Admit them only when the explicit maintenance command needs them.
      const runtimeFiles = new Set([manifest.entrypoint, manifest.launcher, manifest.policy, ...required.map(entry => entry.file)]);
      const ignored = new Set(maintenance ? [] : conversion.map(entry => entry.file).filter(name =>
        !runtimeFiles.has(name) && !["vendor", "resource"].includes(manifest.files[name]?.role)));
      const files = Object.entries(manifest.files).filter(([name]) => !ignored.has(name));
      for (const entry of required) {
        if ((entry.field && manifest[entry.field] !== entry.file) ||
          manifest.files[entry.file]?.role !== entry.role || manifest.files[entry.file]?.executable !== entry.executable) fail(entry.error);
      }
      const actual = enumerate(root, fsImpl, ignored).filter((name) => name !== "approval.json");
      if (JSON.stringify(actual) !== JSON.stringify(files.map(([name]) => name).sort())) {
        fail("the installed files do not match the complete approved inventory");
      }
      for (const [name, expected] of files) {
        const { fd, stat } = openProtected(path.join(root, name), fsImpl);
        try {
          // Linux's fixed native entry needs setuid solely to load AppArmor and
          // install the syscall boundary before dropping every root ID. This is
          // an ABI requirement on the one selected launcher, not permission for
          // arbitrary helpers or vendor images to gain privilege (T02/T03).
          const requiredPrivilege = platform === "linux" && name === manifest.launcher ? 0o4000 : 0;
          if (stat.size !== expected.size || Boolean(stat.mode & 0o111) !== expected.executable
            || (stat.mode & 0o6000) !== requiredPrivilege
            || (hashInstalledFiles && fileDigest(fd, fsImpl) !== expected.sha256)) {
            fail("a selected executable, helper, resource or privacy policy has changed");
          }
          // A root-only execute bit (0744), or an ACL denying execution, must
          // produce admission refusal rather than a later opaque spawn failure.
          if (expected.executable) fsImpl.accessSync(path.join(root, name), fs.constants.X_OK);
        } finally {
          fsImpl.closeSync(fd);
        }
      }
      if (selectedCommand !== undefined) {
        // PATH is a user selection, not permission to execute mutable code. A
        // normal ~/.local/bin symlink to the SAME reviewed native bytes is fine;
        // an updated binary, script wrapper or another build must refuse instead
        // of silently substituting whatever active.json happens to select.
        // Only the immutable admitted copy is ever returned for execution.
        if (typeof selectedCommand !== "string" || !path.isAbsolute(selectedCommand)) {
          fail(`the selected ${provider} executable is unavailable`);
        }
        const selected = fsImpl.realpathSync(selectedCommand);
        const expected = manifest.files[manifest.entrypoint];
        const verifiedInstalledEntry = !hashInstalledFiles && selected === path.join(root, manifest.entrypoint);
        const fd = fsImpl.openSync(selected, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = fsImpl.fstatSync(fd);
          if (!stat.isFile() || stat.size !== expected.size || !(stat.mode & 0o111)
            || (!verifiedInstalledEntry && fileDigest(fd, fsImpl) !== expected.sha256)) {
            fail(`the selected ${provider} executable differs from the approved build; review that update before running it`);
          }
          fsImpl.accessSync(selected, fs.constants.X_OK);
        } finally { fsImpl.closeSync(fd); }
      }
      // Resolve once. The administrator-owned ancestors close the runtime-user
      // rename race; the installer retains old immutable sets during activation.
      return Object.freeze({
        artifactSet,
        version: manifest.version,
        platform,
        arch,
        command: path.join(root, manifest.entrypoint),
        vendorSha256: manifest.files[manifest.entrypoint].sha256,
        launcher: path.join(root, manifest.launcher),
        policy: path.join(root, manifest.policy),
        ...Object.fromEntries(required.filter(entry => entry.field).map(entry => [entry.field, path.join(root, entry.file)])),
        // Vendor dependency reads need the exact reviewed resources too. Do not
        // grant the bundle directory: its approval can name a human reviewer.
        readPaths: Object.freeze(Object.entries(manifest.files)
          .filter(([, file]) => ["vendor", "resource"].includes(file.role))
          .map(([name]) => path.join(root, name))),
        privacyAbi: manifest.privacyAbi,
        reviewedAimRevision: manifest.reviewedAimRevision,
        approvalReference: approval.reference,
        approvalKind: approval.kind,
      });
    } catch (error) {
      // File paths, parse contents and file-descriptor errors can contain private
      // context. Status gets one actionable refusal, never raw state or secrets.
      const missing = error?.code === "ENOENT" && error?.path === runtimeRoot;
      const refusal = error instanceof AdmissionError ? error : new AdmissionError(missing
        ? "no approved runtime bundle is installed on this machine"
        : "the approved runtime or its records could not be read safely");
      const hint = installedVersionHint(selectedCommand, fsImpl);
      if (selectedCommand !== undefined) refusal.message += `\nSelected ${provider}: ${hint
        ? `${hint} (installation filename; not executed)` : "version unknown without executing it"}.`;
      refusal.message += `\nApproved ${provider} for this launch: ${approvedBuild
        ? `${approvedBuild.version} (${approvedBuild.kind})` : missing ? "none; runtime bundle missing" : "approval unavailable or invalid"}.`;
      if (missing) refusal.message += `\nInstall the reviewed runtime bundle before switching AIM to this release. Updating ${provider} alone will not fix this.`;
      throw refusal;
    }
  }

  return { AdmissionError, installedVersionHint, inspectAdministratorPath, artifactSetDigest, admitArtifact };
}
