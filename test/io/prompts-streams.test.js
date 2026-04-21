import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { formatMenuPromptSuffix, promptMenuChoice } from "../../src/io/prompts.js";
import { readTextFromStream } from "../../src/io/streams.js";

test("prompt menu suffixes and retry loop keep interactive choices bounded", async () => {
  assert.equal(formatMenuPromptSuffix([{ key: "1" }, { key: "2" }, { key: "3" }]), " (1-3)");
  assert.equal(formatMenuPromptSuffix([{ key: "1" }, { key: "3" }]), " (1/3)");
  assert.equal(formatMenuPromptSuffix([{ key: "yes" }, { key: "no" }]), " (yes/no)");

  const answers = ["bad", "2"];
  const output = [];
  const choice = await promptMenuChoice({
    title: "Actions",
    options: [
      { key: "1", label: "Cancel" },
      { key: "2", label: "Use profile", details: ["Profile: temp"] },
    ],
    prompt: "Pick:",
    promptLineImpl: async (message) => {
      output.push(`PROMPT ${message}`);
      return answers.shift();
    },
    writeImpl: (chunk) => output.push(chunk),
  });

  // Panel and browser wizards use this loop to guard state-changing actions.
  // Invalid input must not fall through to an action; it should re-prompt until a displayed key is chosen.
  assert.equal(choice, "2");
  assert.match(output.join(""), /Invalid choice: "bad"/);
  assert.match(output.join(""), /PROMPT Pick: \(1-2\)/);
  assert.match(output.join(""), /Profile: temp/);
});

test("readTextFromStream preserves streamed string and buffer payload chunks", async () => {
  const text = await readTextFromStream(Readable.from(["{\"a\":", Buffer.from("\"b\""), "}\n"]));

  // Remote authority promotion receivers read JSON from stdin. Mixed stream chunk types must join
  // into exactly the payload that validation will parse before any authority state write.
  assert.equal(text, "{\"a\":\"b\"}\n");
});
