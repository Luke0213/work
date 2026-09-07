import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { containsWorkspaceChanges } from "../lib/workspace-persistence.ts";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const photo = (id: string, data: string) => ({ id, data, caption: "照片" });
const workspace = () => ({
  projects: [{
    id: "p1", name: "Project", note: "project note", units: [{
      id: "u1", name: "A", note: "A", surveys: [{ id: "s1", note: "old" }],
      works: [{ id: "w1", content: "old" }], acceptances: [{ id: "a1", note: "old", report: { amountText: "1" } }],
      journals: [{ id: "j1", note: "old" }], defects: [{ id: "d1", note: "old" }],
      events: [{ id: "e1", detail: "old" }], photos: [] as ReturnType<typeof photo>[],
    }],
  }],
  catalog: [{ id: "c1", name: "Product" }],
});

function verify(edit: (intended: ReturnType<typeof workspace>) => void, commit?: (committed: ReturnType<typeof workspace>) => void) {
  const base = workspace(), intended = clone(base), committed = clone(base);
  edit(intended);
  if (commit) commit(committed);
  return containsWorkspaceChanges(base, intended, committed);
}

test("unit general field missing from committed reload fails verification", () => {
  assert.equal(verify((value) => { value.projects[0].units[0].name = "B"; }), false);
});

test("unit general field present in committed reload passes verification", () => {
  assert.equal(verify(
    (value) => { value.projects[0].units[0].name = "B"; },
    (value) => { value.projects[0].units[0].name = "B"; },
  ), true);
});

test("unrelated concurrent field changes do not reject the intended delta", () => {
  assert.equal(verify(
    (value) => { value.projects[0].units[0].note = "B"; },
    (value) => { value.projects[0].units[0].note = "B"; value.projects[0].units[0].name = "remote"; },
  ), true);
});

test("project, event, and catalog changes are part of general verification", () => {
  for (const edit of [
    (value: ReturnType<typeof workspace>) => { value.projects[0].name = "edited"; },
    (value: ReturnType<typeof workspace>) => { value.projects[0].units[0].events[0].detail = "edited"; },
    (value: ReturnType<typeof workspace>) => { value.catalog[0].name = "edited"; },
  ]) assert.equal(verify(edit), false);
});

for (const [label, collection, field] of [
  ["survey", "surveys", "note"],
  ["work/construction", "works", "content"],
  ["acceptance general field", "acceptances", "note"],
  ["journal", "journals", "note"],
  ["defect", "defects", "note"],
] as const) {
  test(`${label} modification missing from committed reload fails verification`, () => {
    assert.equal(verify((value) => {
      (value.projects[0].units[0][collection][0] as Record<string, unknown>)[field] = "edited";
    }), false);
  });
}

test("a new or changed photo reference must exist after reload despite renewed signed URL tokens", () => {
  const intendedUrl = "https://example.supabase.co/storage/v1/object/sign/spc-photos/spc/new.jpg?token=first";
  const committedUrl = "https://example.supabase.co/storage/v1/object/sign/spc-photos/spc/new.jpg?token=renewed";
  assert.equal(verify((value) => { value.projects[0].units[0].photos.push(photo("photo-new", intendedUrl)); }), false);
  assert.equal(verify(
    (value) => { value.projects[0].units[0].photos.push(photo("photo-new", intendedUrl)); },
    (value) => { value.projects[0].units[0].photos.push(photo("photo-new", committedUrl)); },
  ), true);
});

test("a new entity must be present in committed workspace", () => {
  const added = { id: "u2", name: "new", note: "", surveys: [], works: [], acceptances: [], journals: [], defects: [], events: [], photos: [] };
  assert.equal(verify((value) => { value.projects[0].units.push(added); }), false);
});

test("a newly added survey must be present in committed workspace", () => {
  assert.equal(verify((value) => {
    value.projects[0].units[0].surveys.push({ id: "s2", note: "new" });
  }), false);
});

test("entity omission is not treated as deletion without an explicit tombstone", () => {
  assert.equal(verify((value) => { value.projects[0].units = []; }), true);
});

test("removal from a normal id array must be reflected after reload", () => {
  assert.equal(verify((value) => { value.catalog = []; }), false);
  assert.equal(verify(
    (value) => { value.catalog = []; },
    (value) => { value.catalog = []; },
  ), true);
});

test("a local tombstone must be reflected by committed workspace", () => {
  assert.equal(verify((value) => {
    Object.assign(value.projects[0].units[0], { _deleted: true, deletedAt: "2026-09-07", deletedBy: "user" });
  }), false);
  assert.equal(verify(
    (value) => { Object.assign(value.projects[0].units[0], { _deleted: true, deletedAt: "2026-09-07", deletedBy: "user" }); },
    (value) => { Object.assign(value.projects[0].units[0], { _deleted: true, deletedAt: "2026-09-07", deletedBy: "user" }); },
  ), true);
});

test("another user's new entity does not reject the intended delta", () => {
  assert.equal(verify(
    (value) => { value.projects[0].units[0].note = "B"; },
    (value) => {
      value.projects[0].units[0].note = "B";
      value.projects[0].units.push({ id: "remote", name: "remote", note: "", surveys: [], works: [], acceptances: [], journals: [], defects: [], events: [], photos: [] });
    },
  ), true);
});

test("entity array reorder is ignored when the intended id and field are committed", () => {
  const base = workspace();
  base.projects[0].units.push({ id: "u2", name: "second", note: "", surveys: [], works: [], acceptances: [], journals: [], defects: [], events: [], photos: [] });
  const intended = clone(base), committed = clone(base);
  intended.projects[0].units[0].note = "B";
  committed.projects[0].units[0].note = "B";
  committed.projects[0].units.reverse();
  assert.equal(containsWorkspaceChanges(base, intended, committed), true);
});

test("autosave wires general verification after reload and before acknowledgement", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const save = source.slice(source.indexOf("const saveState ="), source.indexOf("const refreshSharedData ="));
  assert.ok(save.indexOf("await loadWorkspace()") < save.indexOf("containsWorkspaceChanges("));
  assert.ok(save.indexOf("containsWorkspaceChanges(") < save.indexOf("baselineRef.current = structuredClone(shared)"));
  assert.ok(save.indexOf("containsWorkspaceChanges(") < save.indexOf("completeSyncedOutbox"));
  assert.match(save, /containsWorkspaceChanges\(saveBase, \{ projects: uploaded, catalog: saveState\.catalog \}, shared\)/);
});
