import test from "node:test";
import assert from "node:assert/strict";
import { threeWayMerge } from "../lib/three-way-merge.ts";

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
