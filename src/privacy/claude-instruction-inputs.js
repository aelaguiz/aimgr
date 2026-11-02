import fs from "node:fs";
import path from "node:path";
import { Lexer, Tokenizer } from "marked";
import { ClaudePrivacySettingsError } from "./claude-settings.js";

const MAX_BYTES = 4 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(`md txt text json yaml yml toml xml csv html htm css scss sass less
js ts tsx jsx mjs cjs mts cts py pyi pyw rb erb rake go rs java kt kts scala c cpp cc cxx h hpp hxx
cs swift sh bash zsh fish ps1 bat cmd env ini cfg conf config properties sql graphql gql proto vue
svelte astro ejs hbs pug jade php pl pm lua r dart ex exs erl hrl clj cljs cljc edn hs lhs elm ml mli
f f90 f95 for cmake make makefile gradle sbt rst adoc asciidoc org tex latex lock log diff patch`.split(/\s+/));

// T14/T15: the reviewed client's Markdown lexer disables GFM and limits
// Setext-heading lookahead to paragraph-reachable lines. A regex over raw text
// would turn examples, code, HTML attributes and comments into file grants.
// Keep this adapter and its differential native tests with the version pin.
class InstructionTokenizer extends Tokenizer {
  contexts = [];
  lheading(source) {
    const context = this.contexts.at(-1);
    if (context && !context.reachable.has(source.length)
      && (context.text.at(-source.length - 1) ?? "\n") === "\n") return undefined;
    return super.lheading(source);
  }
}
class InstructionLexer extends Lexer {
  constructor() {
    const tokenizer = new InstructionTokenizer();
    super({ gfm: false, tokenizer });
    this.instructionTokenizer = tokenizer;
  }
  blockTokens(source, tokens = [], lastParagraphClipped = false) {
    const reachable = new Set();
    let end = /^ {0,3}(?:=+|-+) *$/m.test(source) ? source.length : -1, paragraph = false;
    while (end >= 0) {
      const begin = end === 0 ? 0 : source.lastIndexOf("\n", end - 1) + 1;
      const line = source.slice(begin, end);
      if (paragraph) reachable.add(source.length - begin);
      paragraph = /^ {0,3}(?:=+|-+) *$/.test(line) || paragraph
        && !/^(?:\s*$|(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}| {0,3}<[^\n>]+>$|.*[\u2028\u2029])/.test(line);
      end = begin - 1;
    }
    this.instructionTokenizer.contexts.push({ text: source, reachable });
    try { return super.blockTokens(source, tokens, lastParagraphClipped); }
    finally { this.instructionTokenizer.contexts.pop(); }
  }
}

function unavailablePath(file) {
  // No discovery mounts, device/process files or special Mac aliases in this
  // local instruction inventory. Check spelling before realpath/open too.
  return /^[\\/]{2}|^[\\/]\?\?[\\/]/.test(file)
    || /^\/(?:net|network|\.(?:vol|file|nofollow|resolve))(?:\/|$)/i.test(file)
    || /^\/dev\/(?:fd|stdin|stdout|stderr)(?:\/|$)/.test(file)
    || /^\/proc\/(?!version$)/.test(file)
    || file === "/home";
}

export function claudeInstructionImports(text, file, home) {
  // Native strips a leading BOM for FRONTMATTER matching only. Its closing
  // delimiter is deliberately not line-anchored; stricter YAML conventions
  // would produce a different import inventory from the accepted binary.
  const normalized = text.replace(/^\uFEFF/, "");
  const frontmatter = normalized.indexOf("---", 3) < 0 ? null : /^---\s*\n([\s\S]*?)---\s*\n?/.exec(normalized);
  const body = frontmatter ? normalized.slice(frontmatter[0].length) : text;
  if (!body.includes("@")) return [];
  const imports = new Set();
  const parse = value => {
    for (const match of value.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
      const raw = match[1].split("#", 1)[0].replaceAll("\\ ", " ");
      if (!raw || unavailablePath(raw)) continue;
      if (!(raw.startsWith("./") || raw.startsWith("~/") || raw.startsWith("/") && raw !== "/"
        || !raw.startsWith("@") && !/^[#%^&*()]+/.test(raw) && /^[a-zA-Z0-9._-]/.test(raw))) continue;
      imports.add(raw.startsWith("~/") ? path.resolve(home, raw.slice(2)) : path.resolve(path.dirname(file), raw));
    }
  };
  const walk = tokens => {
    for (const token of tokens) {
      // The pinned native lexer has no image-alt child tokens. Newer Marked
      // releases expose them; never turn an image label into an import.
      if (["code", "codespan", "image"].includes(token.type)) continue;
      if (token.type === "html") {
        const raw = token.raw ?? "";
        if (raw.trimStart().startsWith("<!--") && raw.includes("-->")) parse(raw.replace(/<!--[\s\S]*?-->/g, ""));
        continue;
      }
      if (token.type === "text") parse(token.text ?? "");
      if (token.tokens) walk(token.tokens);
      if (token.items) walk(token.items);
    }
  };
  walk(new InstructionLexer().lex(body));
  return [...imports];
}

/** Enumerate only explicitly referenced local instruction files. Native still
 * owns excludes, conditional rules and the external-include consent prompt.
 * Its first prompt PREVIEWS external imports, so requiring prior approval here
 * would prevent that existing workflow. This bounded exact-file superset does
 * not grant parent directories or make Claude inject an excluded instruction.
 * Do not recursively scan projects/homes: callers supply native source roots.
 */
export function resolveClaudeInstructionReads({ files = [], ruleDirectories = [], userHomeDir }) {
  const granted = new Set(), seenFiles = new Map(), seenDirectories = new Set();
  const fail = () => { throw new ClaudePrivacySettingsError("the instruction file inventory exceeds the bounded discovery capacity"); };
  const inspect = (file, depth = 0) => {
    if (depth >= 5 || unavailablePath(file)) return;
    const extension = path.extname(file).slice(1).toLowerCase();
    if (extension && !TEXT_EXTENSIONS.has(extension)) return;
    let resolved, fd;
    try {
      resolved = fs.realpathSync(file);
      if (unavailablePath(resolved) || (seenFiles.get(resolved) ?? Infinity) <= depth) return;
      // A file encountered at depth4 may later be a root/rule. Rescan at the
      // shallower depth so traversal order cannot hide its valid descendants.
      seenFiles.set(resolved, depth);
      fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) return;
      // Limit the read as well as the pre-read stat; concurrent live edits
      // cannot turn an instruction inventory into an unbounded allocation.
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0, count;
      while (size < bytes.length && (count = fs.readSync(fd, bytes, size, bytes.length - size, size)) > 0) size += count;
      if (size > MAX_BYTES) return;
      granted.add(resolved);
      // Discovery work and native policy roots are different quantities. A
      // project/rules directory may cover thousands of files with one grant.
      // The caller minimizes canonical roots before enforcing the native ABI
      // limit; keep only a separate finite traversal bound here.
      if (granted.size > 16384) fail();
      const text = bytes.subarray(0, size).toString("utf8");
      for (const imported of claudeInstructionImports(text, resolved, userHomeDir)) inspect(imported, depth + 1);
    } catch (error) {
      if (error instanceof ClaudePrivacySettingsError) throw error;
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const rules = directory => {
    if (unavailablePath(directory)) return;
    let resolved, entries;
    try {
      resolved = fs.realpathSync(directory);
      if (unavailablePath(resolved) || seenDirectories.has(resolved)) return;
      seenDirectories.add(resolved);
      if (seenDirectories.size > 4096) fail();
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(resolved, entry.name);
      let stat;
      try { stat = entry.isSymbolicLink() ? fs.statSync(file) : entry; }
      catch (error) { if (["ENOENT", "EACCES", "EPERM", "ELOOP"].includes(error.code)) continue; throw error; }
      if (stat.isDirectory()) rules(file);
      else if (stat.isFile() && entry.name.endsWith(".md")) inspect(file);
    }
  };
  for (const file of files) inspect(file);
  for (const directory of ruleDirectories) rules(directory);
  return Object.freeze([...granted]);
}
