import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeInstructionImports, resolveClaudeInstructionReads } from "../../src/privacy/claude-instruction-inputs.js";

test("instruction import lexing preserves prose/list/heading imports and ignores examples and HTML", () => {
  const input = [
    "---", "description: '@./frontmatter.md'", "---", "@./plain.md#part @~/personal.md @./with\\ space.md",
    "", "# @./heading.md", "", "> @./quote.md", "", "- @./list.md", "", "@./setext.md", "---", "",
    "`@./inline-code.md`", "", "```md", "@./fenced-code.md", "```", "", "    @./indented-code.md", "",
    "<!-- @./comment.md -->", "", '<div data-file="@./attribute.md">@./html.md</div>', "",
    "ordinary@example.invalid @@./double-at.md @#fragment", "", "[@./link-label.md](https://example.invalid)",
    "", "![@~/private-image-label.md](image.png)",
  ].join("\n");
  assert.deepEqual(claudeInstructionImports(input, "/project/CLAUDE.md", "/home/test"), [
    "/project/plain.md", "/home/test/personal.md", "/project/with space.md", "/project/heading.md",
    "/project/quote.md", "/project/list.md", "/project/setext.md", "/project/link-label.md",
  ]);
});

test("frontmatter stripping follows the pinned native delimiter, including invalid YAML and BOM", () => {
  for (const prefix of ["", "\uFEFF"]) {
    assert.deepEqual(claudeInstructionImports(prefix + "---\n[ invalid @./hidden.md ---\n@./body.md", "/p/CLAUDE.md", "/h"), ["/p/body.md"]);
  }
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-instruction-inputs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return target; };
  return { root, write };
}

test("imports use the canonical containing file, skip nontext/oversized/directory inputs and stop at depth five", t => {
  const f = fixture(t), files = [f.write("outside/root.md", "@./one.md\n@./secret.png\n@./large.md\n@./directory\n")];
  f.write("outside/one.md", "@./two.md"); f.write("outside/two.md", "@./three.md");
  f.write("outside/three.md", "@./four.md"); f.write("outside/four.md", "@./five.md"); f.write("outside/five.md", "not reached");
  f.write("outside/secret.png", "text despite unsupported extension"); f.write("outside/large.md", "x".repeat(4 * 1024 * 1024 + 1));
  fs.mkdirSync(path.join(f.root, "outside/directory"));
  fs.symlinkSync(files[0], path.join(f.root, "CLAUDE.md"));
  const reads = resolveClaudeInstructionReads({ files: [path.join(f.root, "CLAUDE.md")], userHomeDir: f.root });
  assert.deepEqual(reads, ["root", "one", "two", "three", "four"].map(name => path.join(f.root, `outside/${name}.md`)));
});

test("a shallower later source and symlinked rule imports retain their descendants without granting parent directories", t => {
  const f = fixture(t);
  const a = f.write("a.md", "@./b.md"), b = f.write("b.md", "@./c.md"), c = f.write("c.md", "@./d.md");
  const d = f.write("d.md", "@./e.md"), e = f.write("e.md", "@./f.md"), last = f.write("f.md", "@./a.md");
  const rule = f.write("private/rule.md", "@./required.txt"), required = f.write("private/required.txt", "instruction");
  fs.mkdirSync(path.join(f.root, "rules")); fs.symlinkSync(rule, path.join(f.root, "rules/linked.md"));
  fs.symlinkSync(path.join(f.root, "rules"), path.join(f.root, "rules/cycle"));
  const reads = resolveClaudeInstructionReads({ files: [a, e], ruleDirectories: [path.join(f.root, "rules")], userHomeDir: f.root });
  assert.deepEqual(new Set(reads), new Set([a, b, c, d, e, last, rule, required]));
  assert.ok(!reads.includes(path.join(f.root, "private")));
});
