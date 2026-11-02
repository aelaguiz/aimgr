import path from "node:path";

/** Exact files selected by native TLS configuration (T14/T15). Native resolves
 * these environment paths from cwd, including paths supplied by settings; the
 * settings-file directory is not their base. This returns paths only. The
 * protected task-root resolver subsequently canonicalizes and bounds grants.
 */
export function resolveClaudeTlsReadPaths({ environments, cwd, userHomeDir }) {
  const paths = new Set();
  const expand = value => value.startsWith("~/") ? path.resolve(userHomeDir, value.slice(2)) : path.resolve(cwd, value);
  for (const env of environments) {
    for (const key of ["NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "SSL_CERT_FILE"]) {
      if (typeof env[key] === "string" && env[key]) paths.add(expand(env[key]));
    }
    if (typeof env.SSL_CERT_DIR === "string") {
      for (const directory of env.SSL_CERT_DIR.split(path.delimiter).filter(Boolean)) paths.add(expand(directory));
    }
  }
  return [...paths];
}
