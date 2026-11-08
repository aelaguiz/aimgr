import fs from 'node:fs';
import path from 'node:path';
import { getRedisConfig } from '../config/aimgr-config.js';
import { ANTHROPIC_PROVIDER } from '../core/constants.js';
import { readClaudeEnvironment } from '../privacy/claude-environment.js';
import { loadLocalState } from '../state/local-state.js';
import { buildCoordinationView } from './snapshot.js';
import { readClaudeAccountMetadata } from './claude-metadata.js';
import { connectRedisStore, closeRedisStore, REDIS_CONNECTION_POLICY_ONE_SHOT } from './redis-store.js';
import { writeJsonFileIfChanged } from '../io/json-store.js';

export function readCachedClaudeAccountMetadata({homeDir,environment}) {
  const file=path.join(homeDir,'.aimgr','claude-account-metadata.json');
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile() || stat.nlink!==1 || stat.uid!==process.getuid() || stat.mode&0o077 || stat.size>1024*1024) throw new Error();
    const cached=JSON.parse(fs.readFileSync(fd,'utf8'));
    if(cached.schema!==1 || cached.environmentBinding!==environment.binding || !Array.isArray(cached.credentials)
      || cached.credentials.some(record=>record.provider!==ANTHROPIC_PROVIDER || Object.keys(record.credential ?? {}).length)) throw new Error();
    return cached.credentials;
  } catch { throw new Error('Claude coordination is offline and no verified local account metadata is available.'); }
  finally {if(fd!==undefined)fs.closeSync(fd);}
}

// Only the server-side allowlist reaches this cache. Never hydrate a legacy
// credential into a primary runtime, including when coordination is offline.
export async function loadClaudeRuntime({ homeDir, connectRedisStoreImpl = connectRedisStore,
  environment, readClaudeEnvironmentImpl = readClaudeEnvironment, allowOffline = false } = {}) {
  environment ??= readClaudeEnvironmentImpl();
  const { redis } = getRedisConfig({ homeDir });
  const cache = path.join(homeDir, '.aimgr', 'claude-account-metadata.json');
  let store, credentials, offline = false;
  try {
    store = await connectRedisStoreImpl({ ...redis, connectionPolicy: REDIS_CONNECTION_POLICY_ONE_SHOT });
    credentials = await readClaudeAccountMetadata(store);
    writeJsonFileIfChanged(cache, { schema: 1, environmentBinding: environment.binding, credentials }, { mode: 0o600 });
  } catch (error) {
    if (store) await closeRedisStore(store).catch(() => {});
    store = null;
    if (!allowOffline) throw error;
    credentials = readCachedClaudeAccountMetadata({homeDir,environment});
    offline = true;
  }
  const localState = loadLocalState({ homeDir });
  const snapshot = { credentials, observedAt: new Date().toISOString(), keyPrefix: store?.keyPrefix };
  const state = buildCoordinationView(snapshot, { localState, provider: ANTHROPIC_PROVIDER });
  return { redis, store, snapshot, state, localState, environment, offline, providerScope: ANTHROPIC_PROVIDER, updatedBy: 'aimgr-cli' };
}
