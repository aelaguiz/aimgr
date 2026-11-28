# Antigravity in AI Manager

Run `aim agy status` to see which accounts can launch on this machine. Start a
conversation in a project directory with the label shown in status.

```sh
aim agy run work
```

AI Manager opens a terminal conversation with Google's official Antigravity CLI
using the Agent Client Protocol. You can ask follow-up questions, select a model
and answer tool permission requests. Starting in your home directory gives the
account a persistent project at `~/workspace/antigravity/<label>`. Starting in a
project uses that directory.

| Command | What it does |
| --- | --- |
| `aim agy login work` | Enroll a Google account on this machine. |
| `aim agy run work -- --print "Summarize the project"` | Print a single response and exit. |
| `aim agy resume work <conversation-id> -- --print "Continue"` | Continue the exact conversation using the same account and machine. |
| `aim agy status work` | Show the local grant, launch availability and Google's most recent quota reading. |
| `aim agy privacy status` | Verify the selected local runtime offline. |
| `aim agy refresh work` | Request a fresh quota reading. |
| `aim cluster status` | See which machines have each account and its latest quota. |
| `aim agy logout work` | Ask the native CLI to sign the account out on this machine. |

To enroll, choose a new label and enter the Google email when prompted. Open the
URL in that account’s existing browser profile, verify the address in Google's
chooser, and paste the one-time code into the originating terminal. Enter the
address that Antigravity displays to finish. Additional machines use the same
label and a fresh Google sign-in. Each machine retains its own grant. Running login again on a signed-in label
reuses that grant. After logout, signing in under the same label starts a fresh
local history. AI Manager prints the private archive path for the previous
signed-out home, so the new login never inherits another identity’s history.

The supported runtimes are macOS arm64 and Linux x64. The release installer
activates the matching reviewed bundle from `~/.local/share/aimgr/runtime-bundles/`.
Current bundles use `agy-privacy-v2` in their approval manifest. The CLI uses a separate local
home for each account. The shared account roster holds labels. Google supplies
the model catalog, entitlement and quota windows.

[Google's Antigravity CLI documentation](https://antigravity.google/docs/cli/reference/)
