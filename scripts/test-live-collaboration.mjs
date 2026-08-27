import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const envText = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
  const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
}));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const publishable = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const service = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !publishable || !service) throw new Error("Missing Supabase test configuration");

const admin = createClient(url, service, { auth: { persistSession: false } });
const suffix = randomUUID().slice(0, 8);
const password = `Spc-Test-${randomUUID()}!`;
const emailA = `spc-concurrency-a-${suffix}@example.com`;
const emailB = `spc-concurrency-b-${suffix}@example.com`;
const projectId = `concurrency-project-${suffix}`;
const unitId = `concurrency-unit-${suffix}`;
let userA, userB;

const assert = (value, message) => { if (!value) throw new Error(message); };
const rpc = async (client, name, args) => {
  const result = await client.rpc(name, args);
  if (result.error) throw result.error;
  return result.data;
};
const save = (client, base, projects) => rpc(client, "spc_merge_workspace", {
  p_base_version: base.version,
  p_base_projects: base.projects,
  p_projects: projects,
  p_base_catalog: base.catalog,
  p_catalog: base.catalog,
});

try {
  const createdA = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true });
  if (createdA.error) throw createdA.error;
  userA = createdA.data.user;
  const createdB = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true });
  if (createdB.error) throw createdB.error;
  userB = createdB.data.user;
  assert(userA && userB, "Temporary users were not created");
  const roles = await admin.from("spc_user_roles").upsert([
    { user_id: userA.id, email: emailA, role: "shenyin", active: true },
    { user_id: userB.id, email: emailB, role: "shenyin", active: true },
  ]);
  if (roles.error) throw roles.error;
  const clientA = createClient(url, publishable, { auth: { persistSession: false } });
  const clientB = createClient(url, publishable, { auth: { persistSession: false } });
  for (const [client, email] of [[clientA, emailA], [clientB, emailB]]) {
    const login = await client.auth.signInWithPassword({ email, password });
    if (login.error) throw login.error;
  }

  const initial = await rpc(clientA, "spc_load_workspace");
  const seed = structuredClone(initial.projects);
  seed.push({ id: projectId, name: "多人並行自動測試", products: [], journals: [], units: [{
    id: unitId, number: "TEST-01", owner: "初始", estimated: 0,
    surveys: [], works: [], defects: [], acceptances: [], events: [],
  }] });
  await save(clientA, initial, seed);

  const [baseA, baseB] = await Promise.all([
    rpc(clientA, "spc_load_workspace"), rpc(clientB, "spc_load_workspace"),
  ]);
  const projectsA = structuredClone(baseA.projects);
  const projectsB = structuredClone(baseB.projects);
  projectsA.find((p) => p.id === projectId).units.find((u) => u.id === unitId).owner = "A帳號填寫";
  projectsB.find((p) => p.id === projectId).units.find((u) => u.id === unitId).estimated = 88;
  await Promise.all([save(clientA, baseA, projectsA), save(clientB, baseB, projectsB)]);

  const final = await rpc(clientA, "spc_load_workspace");
  const unit = final.projects.find((p) => p.id === projectId)?.units.find((u) => u.id === unitId);
  assert(unit?.owner === "A帳號填寫", "A account field was overwritten");
  assert(unit?.estimated === 88, "B account field was overwritten");
  const audit = await admin.from("spc_audit_logs").select("action,entity_type,entity_id,detail,created_at")
    .eq("entity_type", "unit").eq("entity_id", unitId).order("created_at", { ascending: true });
  if (audit.error) throw audit.error;
  const emails = new Set((audit.data || []).map((row) => row.detail?.user_email));
  assert(emails.has(emailA) && emails.has(emailB), "Audit trail does not distinguish both users");
  const activity = await admin.from("spc_entity_activity").select("updated_by_email,updated_at")
    .eq("entity_type", "unit").eq("entity_id", unitId).single();
  if (activity.error) throw activity.error;
  assert([emailA, emailB].includes(activity.data.updated_by_email), "Last editor was not recorded");
  assert(activity.data.updated_at, "Last modified time was not recorded");

  const cleanupBase = await rpc(clientA, "spc_load_workspace");
  await save(clientA, cleanupBase, cleanupBase.projects.filter((p) => p.id !== projectId));
  console.log(JSON.stringify({
    passed: true,
    sameProjectMerged: true,
    aValue: unit.owner,
    bValue: unit.estimated,
    auditUsers: [...emails].filter(Boolean).length,
    lastEditorRecorded: true,
    lastModifiedAt: activity.data.updated_at,
  }));
} finally {
  if (userA) await admin.auth.admin.deleteUser(userA.id);
  if (userB) await admin.auth.admin.deleteUser(userB.id);
}
