import assert from "node:assert/strict";
import test from "node:test";
import { codexArguments } from "../../src/privacy/codex-arguments.js";
import { prepareCodexWorktree, finishCodexWorktree } from "../../src/privacy/codex-worktree.js";

const id = "11111111-2222-4333-8444-555555555555";
const checkout = { root: "/synthetic/worktrees/new", cwd: "/synthetic/worktrees/new/sub" };

test("worktree preparation uses the saved fork source, then fixes ID and destination before native launch", async () => {
  const calls = [];
  const parsedArgs = codexArguments(["fork", "named-thread", "--worktree", "--add-dir", "extra", "--", "prompt --worktree"], { cwd: "/synthetic/original" });
  const result = await prepareCodexWorktree({ parsedArgs, artifact: {}, prepared: {}, env: {}, managed: {},
    nativeInputs: async request => {
      calls.push(request);
      return { worktree_root: "/synthetic/worktrees", source_untrusted: false,
        fork_source: { thread_id: id, cwd: "/synthetic/saved/sub" } };
    },
    operate: async ({ request }) => {
      assert.deepEqual(request, { operation: "create", root: "/synthetic/worktrees", source_cwd: "/synthetic/saved/sub" });
      return { schema: 1, checkout };
    },
  });
  assert.equal(calls[0].operation, "fork_source");
  assert.equal(calls[1].parsedArgs.cwd, "/synthetic/saved/sub");
  assert.equal(result.parsedArgs.cwd, checkout.cwd);
  assert.equal(result.parsedArgs.processCwd, "/synthetic/original");
  assert.deepEqual(result.parsedArgs.directories, ["/synthetic/original/extra"]);
  assert.equal(result.parsedArgs.positionals[0], id);
  assert.equal(result.parsedArgs.worktree, false);
  assert.equal(result.parsedArgs.args.at(-1), "prompt --worktree");
});

test("explicit source cwd wins a fork's saved cwd; inspection and refused source create nothing", async () => {
  let creations = 0;
  const options = { artifact: {}, prepared: {}, env: {}, managed: {},
    nativeInputs: async () => ({ worktree_root: "/synthetic/worktrees", source_untrusted: false,
      fork_source: { thread_id: id, cwd: "/synthetic/saved" } }),
    operate: async ({ request }) => { creations++; assert.equal(request.source_cwd, "/synthetic/selected"); return { checkout }; },
  };
  await prepareCodexWorktree({ ...options, parsedArgs: codexArguments(["-C", "selected", "exec", "--worktree", "fork", id], { cwd: "/synthetic" }) });
  assert.equal(creations, 1);
  assert.equal(await prepareCodexWorktree({ ...options, parsedArgs: codexArguments(["--worktree", "--help"], { cwd: "/synthetic" }) }), null);
  await assert.rejects(prepareCodexWorktree({ ...options,
    parsedArgs: codexArguments(["--worktree"], { cwd: "/synthetic" }),
    nativeInputs: async () => ({ source_untrusted: true }),
  }), /untrusted/);
  assert.equal(creations, 1);
});

test("post-exit binding preserves account/time/lineage and missing or failed ownership stays informational", async () => {
  const notices = [], requests = [];
  let bind = 0;
  const base = { worktree: { checkout, root: "/synthetic/worktrees", source: "cli", forkId: id,
    operate: async ({ request }) => { bind++; assert.equal(request.checkout, checkout.root); return { bound: true }; } },
    prepared: { accountId: "synthetic-A" }, artifact: {}, parsedArgs: { processCwd: "/synthetic" }, env: {}, managed: {},
    databases: [], startedAt: "2026-11-04T12:00:00.000Z", endedAt: "2026-11-04T12:01:00.000Z",
    onNotice: text => notices.push(text),
  };
  for (const owner of [id, null]) await finishCodexWorktree({ ...base,
    nativeInputs: async request => { requests.push(request); return { owner_thread_id: owner }; },
  });
  assert.equal(bind, 1);
  assert.equal(requests[0].owner.account_id, "synthetic-A");
  assert.equal(requests[0].owner.cwd, checkout.cwd);
  assert.equal(requests[0].owner.ended_at, base.endedAt);
  assert.equal(requests[0].owner.forked_from_id, id);
  assert.equal(notices.length, 1);
  await finishCodexWorktree({ ...base, prepared: { accountId: "api-provider:deepseek" }, nativeInputs: async () => assert.fail("no account provenance") });
  assert.equal(notices.length, 2);
  assert.equal(bind, 1);
});

test("escaped fork selectors remain positionals while escaped flag words remain literal", () => {
  for (const args of [["fork", "--worktree", "--", "-named-session", "prompt --worktree"],
    ["exec", "--worktree", "fork", "--", "-named-session", "prompt --worktree"]]) {
    const parsed = codexArguments(args, { cwd: "/synthetic" });
    assert.equal(parsed.positionals.at(-2), "-named-session");
    assert.equal(parsed.positionals.at(-1), "prompt --worktree");
  }
  assert.equal(codexArguments(["-w"]).worktree, false, "the admitted native CLI has no -w alias");
  assert.equal(codexArguments(["exec", "--worktree", "--", "fork"]).execSubcommand, null);
  assert.equal(codexArguments(["exec", "--thread-source", "cli", "--cyber-access-program", "standard", "fork", id, "--worktree"]).execSubcommand, "fork");
});
