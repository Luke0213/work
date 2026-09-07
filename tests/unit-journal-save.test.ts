import test from "node:test";
import assert from "node:assert/strict";
import { saveUnitJournal } from "../lib/unit-journal-save.ts";
import { readFileSync } from "node:fs";

const entry = { id: "j1", content: "驗收內容", photos: [{ id: "p1", data: "unchanged" }], draft: true, createdBy: "", createdAt: "" };
test("draft and completion upsert one id and wait for durable workspace before removing recovery", async () => {
  let journals: typeof entry[] = [];
  const events: string[] = [];
  for (const draft of [true, true, false]) {
    const result = await saveUnitJournal({ entry, journals, draft, owner: "known-owner", now: "now",
      saveDraft: async () => { events.push("draft"); }, queue: async () => { events.push("queue"); },
      patch: async (next) => { events.push("patch"); journals = next; }, removeDraft: async () => { events.push("remove"); } });
    assert.equal(journals.length, 1); assert.equal(journals[0].draft, draft);
    assert.equal(result.createdBy, "known-owner"); assert.equal(result.photos, entry.photos);
  }
  assert.deepEqual(events, ["draft", "queue", "patch", "draft", "queue", "patch", "draft", "queue", "patch", "remove"]);
  assert.equal(entry.draft, true);
});

test("failure in any save step retains recovery and never reaches success", async () => {
  for (const failure of ["draft", "queue", "patch"]) {
    let removed = false, success = false;
    const step = async (name: string) => { if (name === failure) throw new Error(name); };
    await assert.rejects(async () => {
      await saveUnitJournal({ entry, journals: [], draft: false, owner: "owner", now: "now",
        saveDraft: () => step("draft"), queue: () => step("queue"), patch: () => step("patch"),
        removeDraft: async () => { removed = true; } });
      success = true;
    });
    assert.equal(removed, false); assert.equal(success, false); assert.equal(entry.content, "驗收內容");
  }
});

test("journal UI uses cached identity and forwards the durable callback", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const journal = source.slice(source.indexOf("function UnitJournalTab("), source.indexOf("function UnitJournalTab(") + 11000);
  const persist = journal.slice(journal.indexOf("const persist"), journal.indexOf("const startNew"));
  assert.doesNotMatch(persist, /getUser|getSession|queueRecordChange/);
  assert.match(persist, /patch\(\{ journals \}, \(error\)/);
  assert.match(persist, /catch \{\s*setSaved\(""\)/);
  assert.match(source, /function JournalPDFPreviewPhoto\(/);
  assert.doesNotMatch(source, /downloadWorkJournalDocx/);
});
