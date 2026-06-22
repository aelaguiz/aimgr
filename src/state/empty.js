import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER, SCHEMA_VERSION } from "../core/constants.js";

export function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    accounts: {},
    credentials: {
      [OPENAI_CODEX_PROVIDER]: {},
      [ANTHROPIC_PROVIDER]: {},
    },
    imports: {
      authority: {
        codex: {
          labels: [],
          labelsByName: {},
        },
        anthropic: {
          labels: [],
          labelsByName: {},
        },
      },
    },
    pool: {
      openaiCodex: {
        history: [],
        agentDemand: {},
      },
      anthropic: {
        history: [],
      },
    },
    targets: {
      openclaw: {
        assignments: {},
        exclusions: {},
      },
      codexCli: {},
      sakanaCodex: {},
      claudeCli: {},
      piCli: {},
    },
  };
}
