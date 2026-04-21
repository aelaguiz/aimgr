import path from "node:path";
import { writeJson } from "./files.js";

export function writeClaudeNativeBundle(
  home,
  {
    accessToken = "ACCESS_BOSS",
    refreshToken = "REFRESH_BOSS",
    expiresAtMs = Date.now() + 3600_000,
    subscriptionType = "max",
    rateLimitTier = "max_20x",
    scopes = ["user:profile", "user:inference", "user:sessions:claude_code"],
    oauthAccount = {},
    appState = {},
  } = {},
) {
  writeJson(path.join(home, ".claude", ".credentials.json"), {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt: expiresAtMs,
      subscriptionType,
      rateLimitTier,
      scopes,
    },
  });
  writeJson(path.join(home, ".claude.json"), {
    ...appState,
    oauthAccount: {
      accountUuid: "acct_boss",
      displayName: "Boss",
      emailAddress: "boss@example.com",
      organizationName: "Boss Org",
      organizationUuid: "org_boss",
      ...oauthAccount,
    },
  });
}

export function buildAnthropicClaudeCredential({
  access = "ACCESS_BOSS",
  refresh = "REFRESH_BOSS",
  expiresAtMs = Date.now() + 3600_000,
  subscriptionType = "max",
  rateLimitTier = "max_20x",
  scopes = ["user:profile", "user:inference", "user:sessions:claude_code"],
  emailAddress = "boss@example.com",
  organizationName = "Boss Org",
  organizationUuid = "org_boss",
} = {}) {
  return {
    access,
    refresh,
    expiresAt: new Date(expiresAtMs).toISOString(),
    subscriptionType,
    rateLimitTier,
    scopes,
    emailAddress,
    organizationName,
    organizationUuid,
    nativeClaudeBundle: {
      claudeAiOauth: {
        accessToken: access,
        refreshToken: refresh,
        expiresAt: expiresAtMs,
        subscriptionType,
        rateLimitTier,
        scopes,
      },
      oauthAccount: {
        accountUuid: "acct_boss",
        displayName: "Boss",
        emailAddress,
        organizationName,
        organizationUuid,
      },
    },
  };
}
