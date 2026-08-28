import test from "node:test";
import assert from "node:assert/strict";
import { liveEntities, threeWayMerge, tombstoneEntity } from "../lib/three-way-merge.ts";

test("merges changes made to different records", () => {
  const base = { units: [{ id: "a", owner: "王", status: "待場勘" }, { id: "b", owner: "李", status: "待場勘" }] };
  const local = structuredClone(base); local.units[0].status = "可進場";
  const remote = structuredClone(base); remote.units[1].owner = "林";
  const result = threeWayMerge(base, local, remote);
  assert.equal(result.value.units[0].status, "可進場");
  assert.equal(result.value.units[1].owner, "林");
  assert.deepEqual(result.conflicts, []);
});

test("keeps local value and reports a same-field conflict", () => {
  const base = { units: [{ id: "a", status: "待場勘" }] };
  const local = { units: [{ id: "a", status: "可進場" }] };
  const remote = { units: [{ id: "a", status: "場勘待改善" }] };
  const result = threeWayMerge(base, local, remote);
  assert.equal(result.value.units[0].status, "可進場");
  assert.deepEqual(result.conflicts, ["units[a].status"]);
});

test("preserves a remotely edited record when it was locally deleted", () => {
  const base = { units: [{ id: "a", status: "待場勘" }] };
  const local = { units: [] as Array<{ id: string; status: string }> };
  const remote = { units: [{ id: "a", status: "可進場" }] };
  const result = threeWayMerge(base, local, remote);
  assert.equal(result.value.units[0].status, "可進場");
  assert.deepEqual(result.conflicts, ["units[a]"]);
});

const projectWith = (journals: unknown, unitCollections: Record<string, unknown> = {}) => ({
  projects: [{
    id: "p1",
    journals,
    units: [{ id: "u1", surveys: [], works: [], defects: [], acceptances: [], journals: [], events: [], ...unitCollections }],
  }],
});

test("stale empty project journals cannot silently delete committed history", () => {
  const j1 = { id: "j1", content: "history" };
  const result = threeWayMerge(projectWith([j1]), projectWith([]), projectWith([j1]));
  assert.deepEqual(result.value.projects[0].journals, [j1]);
});

test("remote-only and concurrent new history records are retained", () => {
  const j1 = { id: "j1", content: "local" }, j2 = { id: "j2", content: "remote" };
  assert.deepEqual(threeWayMerge(projectWith([]), projectWith([]), projectWith([j2])).value.projects[0].journals, [j2]);
  assert.deepEqual(threeWayMerge(projectWith([]), projectWith([j1]), projectWith([j2])).value.projects[0].journals, [j1, j2]);
});

test("same-id concurrent history edits retain normal field conflict semantics", () => {
  const base = projectWith([{ id: "j1", content: "old", note: "" }]);
  const local = projectWith([{ id: "j1", content: "local", note: "" }]);
  const remote = projectWith([{ id: "j1", content: "remote", note: "" }]);
  const result = threeWayMerge(base, local, remote);
  assert.equal(result.value.projects[0].journals[0].content, "local");
  assert.deepEqual(result.conflicts, ["projects[p1].journals[j1].content"]);
});

test("missing and null stale collections preserve remote history", () => {
  const j1 = { id: "j1", content: "remote" };
  const base = projectWith([j1]);
  const missing = structuredClone(base) as any; delete missing.projects[0].journals;
  const withNull = projectWith(null);
  assert.deepEqual(threeWayMerge(base, missing, projectWith([j1])).value.projects[0].journals, [j1]);
  assert.deepEqual(threeWayMerge(base, withNull, projectWith([j1])).value.projects[0].journals, [j1]);
});

test("all protected unit history collections resist omission deletion", () => {
  for (const collection of ["surveys", "works", "defects", "acceptances", "journals", "events"] as const) {
    const record = { id: `${collection}-1`, value: collection };
    const base = projectWith([], { [collection]: [record] });
    const local = projectWith([], { [collection]: [] });
    const remote = projectWith([], { [collection]: [record] });
    assert.deepEqual((threeWayMerge(base, local, remote).value.projects[0].units[0] as any)[collection], [record]);
  }
});

test("local and remote tombstones remain durable against unchanged and stale live records", () => {
  const j1 = { id: "j1", content: "old" };
  const deleted = tombstoneEntity(j1, "user-1", "2026-08-28T00:00:00.000Z");
  assert.deepEqual(threeWayMerge(projectWith([j1]), projectWith([deleted]), projectWith([j1])).value.projects[0].journals, [deleted]);
  assert.deepEqual(threeWayMerge(projectWith([j1]), projectWith([j1]), projectWith([deleted])).value.projects[0].journals, [deleted]);
  assert.deepEqual(threeWayMerge(projectWith([j1]), projectWith([{ ...j1, content: "stale edit" }]), projectWith([deleted])).value.projects[0].journals, [deleted]);
});

test("a persisted tombstone survives repeated stale-device merges", () => {
  const j1 = { id: "j1", content: "old" };
  const deleted = tombstoneEntity(j1, "user-1", "2026-08-28T00:00:00.000Z");
  const first = threeWayMerge(projectWith([j1]), projectWith([deleted]), projectWith([j1])).value;
  const second = threeWayMerge(projectWith([j1]), projectWith([j1]), first).value;
  const third = threeWayMerge(projectWith([j1]), projectWith([j1]), second).value;
  assert.deepEqual(first.projects[0].journals, [deleted]);
  assert.deepEqual(second.projects[0].journals, [deleted]);
  assert.deepEqual(third.projects[0].journals, [deleted]);
});

test("durable tombstones coexist with live remote records while live views hide them", () => {
  const j1 = { id: "j1", content: "delete me" }, j2 = { id: "j2", content: "remote" };
  const deleted = tombstoneEntity(j1, "user-1", "2026-08-28T00:00:00.000Z");
  const result = threeWayMerge(projectWith([j1]), projectWith([deleted]), projectWith([j1, j2]));
  assert.deepEqual(result.value.projects[0].journals, [deleted, j2]);
  assert.deepEqual(liveEntities(result.value.projects[0].journals), [j2]);
});

test("durable tombstones protect every unit history collection", () => {
  for (const collection of ["surveys", "works", "defects", "acceptances", "journals", "events"] as const) {
    const record = { id: `${collection}-1`, value: collection };
    const deleted = tombstoneEntity(record, "user-1", "2026-08-28T00:00:00.000Z");
    const result = threeWayMerge(
      projectWith([], { [collection]: [record] }),
      projectWith([], { [collection]: [record] }),
      projectWith([], { [collection]: [deleted] }),
    );
    assert.deepEqual((result.value.projects[0].units[0] as any)[collection], [deleted]);
  }
});

test("stale clients cannot erase project floor acceptances by omission, empty, or null", () => {
  const floor = { id: "floor-a-14", building: "A棟", floor: "14F", signatures: { office: { valid: true } } };
  const base = { projects: [{ id: "p1", floorAcceptances: [floor], units: [] }] };
  const missing = { projects: [{ id: "p1", units: [] }] };
  const empty = { projects: [{ id: "p1", floorAcceptances: [], units: [] }] };
  const withNull = { projects: [{ id: "p1", floorAcceptances: null, units: [] }] };
  assert.deepEqual((threeWayMerge(base, missing, base).value.projects[0] as any).floorAcceptances, [floor]);
  assert.deepEqual(threeWayMerge(base, empty, base).value.projects[0].floorAcceptances, [floor]);
  assert.deepEqual((threeWayMerge(base, withNull, base).value.projects[0] as any).floorAcceptances, [floor]);
});

test("different buildings retain independent same-floor signature records", () => {
  const a = { id: "a14", building: "A棟", floor: "14F", signatures: { office: { name: "A" } } };
  const b = { id: "b14", building: "B棟", floor: "14F", signatures: { office: { name: "B" } } };
  const base = { projects: [{ id: "p1", floorAcceptances: [], units: [] }] };
  const merged = threeWayMerge(base, { projects: [{ id: "p1", floorAcceptances: [a], units: [] }] }, { projects: [{ id: "p1", floorAcceptances: [b], units: [] }] });
  assert.deepEqual(merged.value.projects[0].floorAcceptances, [a, b]);
});
