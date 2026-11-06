# Decision: organization-managed policy is an approved gap

**Resolved by Amir on November 4, 2026:** “you can mark organization owned policies an approved gap. I just won't do that. Proceed. No changes to codex for this one.”

Keep official, unmodified Codex. The privacy guarantee excludes organization-supplied remote requirements and transitions into that policy regime, including after native authentication refresh. Remove the temporary account-plan/config-server refusal: it was neither a reliable session-lifetime control nor an accepted account-tier restriction. No fork, native injection, remote-policy service, periodic account policing or additional user decision is needed for this gap.

Directory isolation, environment-local primary authentication, local managed privacy policy and ordinary-tool compatibility remain requirements. Forced local MDM values that conflict with the installed privacy controls still produce a concrete admission error. The exception does not waive unrelated implementation or test requirements.

The source finding remains valid: both the pinned official build and official 0.166.0 allow organization requirements to override local feedback, update-check, remote-control and explicit OTel requirements. Native refresh publishes policy in memory, so a cache restriction or startup-only inspection cannot enforce a lifetime ceiling. Local managed analytics consent and primary-auth constraints remain protected. The [interim cold review](CODEX_PRIVACY_M1_COLD_REVIEW_2026-11-04.md) contains the exact source references.

These are capability findings, not evidence of a private-data upload in testing. Feedback upload is explicitly invoked. AIM's remote-control environment marker suppresses saved-state startup but is not a permanent prohibition against later explicit enablement; the current remote-control owner does not automatically start relaying merely because refreshed configuration changes.

The earlier proposal to design a patched client is superseded and will not be implemented. Cold reviewers must use this approved exception when judging compliance. SQLite initialization, MCP maintenance conversion, effective input grants, both-platform tests and the final full review remain unfinished. Milestone 2 follows milestone 1 readiness.
