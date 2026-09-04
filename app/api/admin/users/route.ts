import { NextRequest, NextResponse } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";
import { parseRolePermissionMatrix, rolePermissionMatrixFromDatabaseRows, type RolePermissionMatrix } from "../../../../lib/role-permissions.ts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

type StaffRole = "admin" | "shenyin" | "client" | "crew" | "sales";
const roles = new Set<StaffRole>(["admin", "shenyin", "client", "crew", "sales"]);
type AdminAction =
  | { action: "role"; userId: string; role: StaffRole }
  | { action: "active"; userId: string; active: boolean }
  | { action: "reset"; userId: string }
  | { action: "displayName"; userId: string; displayName: string }
  | { action: "approve"; userId: string; role: StaffRole }
  | { action: "reject"; userId: string }
  | { action: "permissions"; permissions: RolePermissionMatrix };

function serviceClient() {
  if (!supabaseUrl || !serviceRoleKey) throw new Error("SERVER_AUTH_NOT_CONFIGURED");
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function requireAdmin(request: NextRequest) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !publishableKey) return null;
  const verifier = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error } = await verifier.auth.getUser(token);
  if (error || !user) return null;
  const admin = serviceClient();
  const { data: role } = await admin.from("spc_user_roles").select("role, active, application_status").eq("user_id", user.id).maybeSingle();
  return role?.role === "admin" && role.active && role.application_status === "approved" ? { user, admin, token } : null;
}

async function targetProfile(admin: ReturnType<typeof serviceClient>, userId: string) {
  const { data, error } = await admin.from("spc_user_roles")
    .select("user_id, role, active, application_status, display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function protectsLastActiveAdmin(admin: ReturnType<typeof serviceClient>, profile: Awaited<ReturnType<typeof targetProfile>>) {
  if (profile?.role !== "admin" || profile.active !== true || profile.application_status !== "approved") return false;
  const { count, error } = await admin.from("spc_user_roles")
    .select("user_id", { count: "exact", head: true })
    .eq("role", "admin").eq("active", true).eq("application_status", "approved");
  if (error) throw error;
  return (count || 0) <= 1;
}

async function allUsers(admin: ReturnType<typeof serviceClient>) {
  const users: User[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 100) break;
  }
  return users;
}

export async function GET(request: NextRequest) {
  try {
    const access = await requireAdmin(request);
    if (!access) return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403 });
    const users = await allUsers(access.admin);
    const { data: staffRoles, error } = await access.admin.from("spc_user_roles").select("user_id, email, display_name, role, active, application_status");
    if (error) throw error;
    const { data: permissionRows, error: permissionError } = await access.admin.from("spc_role_permissions")
      .select("role, edit_unit_master, use_survey, use_work, use_acceptance, use_acceptance_journal, use_defects, export_receivables, export_shipment_details")
      .in("role", ["crew", "client", "sales"]);
    if (permissionError) throw permissionError;
    const roleMap = new Map((staffRoles || []).map((row) => [row.user_id, row]));
    return NextResponse.json({
      currentUserId: access.user.id,
      rolePermissions: rolePermissionMatrixFromDatabaseRows(permissionRows),
      users: users.map((user) => {
        const record = roleMap.get(user.id);
        const isBanned = user.banned_until ? new Date(user.banned_until).getTime() > Date.now() : false;
        return {
          id: user.id,
          email: user.email?.endsWith("@phone.spc.internal") ? "" : user.email || record?.email || "",
          phone: String(user.user_metadata?.local_phone || user.phone || ""),
          displayName: String(record?.display_name || user.user_metadata?.display_name || "").trim(),
          role: roles.has(record?.role as StaffRole) ? record?.role : "client",
          active: record?.active !== false && !isBanned,
          createdAt: user.created_at,
          lastSignInAt: user.last_sign_in_at || null,
          confirmedAt: user.email_confirmed_at || user.phone_confirmed_at || null,
          applicationStatus: record?.application_status || "approved",
        };
      }),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "UNKNOWN_ERROR";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const access = await requireAdmin(request);
    if (!access) return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403 });
    const body = (await request.json()) as AdminAction;
    if (body.action === "permissions") {
      const permissions = parseRolePermissionMatrix(body.permissions);
      if (!permissions) return NextResponse.json({ error: "INVALID_PERMISSIONS" }, { status: 400 });
      const caller = createClient(supabaseUrl, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${access.token}` } },
      });
      const { error } = await caller.rpc("spc_admin_save_role_permissions", { p_permissions: permissions });
      if (error) throw error;
      return NextResponse.json({ ok: true, rolePermissions: permissions });
    }
    if (body.action === "reset") {
      const { data: existing, error: existingError } = await access.admin.auth.admin.getUserById(body.userId);
      if (existingError || !existing.user) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });
      const { error } = await access.admin.auth.admin.updateUserById(body.userId, {
        password: "1234qwer",
        user_metadata: { ...existing.user.user_metadata, must_change_password: true },
      });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    const target = await access.admin.auth.admin.getUserById(body.userId);
    if (target.error || !target.data.user) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });
    const profile = await targetProfile(access.admin, body.userId);
    if (!profile) return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });
    if (body.action === "displayName") {
      const displayName = body.displayName.trim();
      if (!displayName || displayName.length > 80) return NextResponse.json({ error: "INVALID_NAME" }, { status: 400 });
      const { error: metadataError } = await access.admin.auth.admin.updateUserById(body.userId, {
        user_metadata: { ...target.data.user.user_metadata, display_name: displayName },
      });
      if (metadataError) throw metadataError;
      const { error } = await access.admin.from("spc_user_roles").update({ display_name: displayName, updated_at: new Date().toISOString() }).eq("user_id", body.userId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (body.action === "approve") {
      if (!roles.has(body.role)) return NextResponse.json({ error: "INVALID_ROLE" }, { status: 400 });
      if (profile.active !== false || !["pending", "rejected"].includes(profile.application_status)) return NextResponse.json({ error: "APPROVE_NOT_ALLOWED" }, { status: 409 });
      const { error: authError } = await access.admin.auth.admin.updateUserById(body.userId, { ban_duration: "none" });
      if (authError) throw authError;
      const { error } = await access.admin.from("spc_user_roles").update({ role: body.role, active: true, application_status: "approved", updated_at: new Date().toISOString() }).eq("user_id", body.userId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (body.action === "reject") {
      if (profile.active !== false || profile.application_status !== "pending") return NextResponse.json({ error: "REJECT_NOT_ALLOWED" }, { status: 409 });
      const { error: authError } = await access.admin.auth.admin.updateUserById(body.userId, { ban_duration: "none" });
      if (authError) throw authError;
      const { error } = await access.admin.from("spc_user_roles").update({ active: false, application_status: "rejected", updated_at: new Date().toISOString() }).eq("user_id", body.userId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (body.userId === access.user.id && ((body.action === "active" && !body.active) || (body.action === "role" && body.role !== "admin"))) {
      return NextResponse.json({ error: "CANNOT_LOCK_SELF" }, { status: 400 });
    }
    if (body.action === "role") {
      if (!roles.has(body.role)) return NextResponse.json({ error: "INVALID_ROLE" }, { status: 400 });
      if (profile.application_status !== "approved" || profile.active !== true) return NextResponse.json({ error: "ROLE_CHANGE_NOT_ALLOWED" }, { status: 409 });
      if (body.role !== "admin" && await protectsLastActiveAdmin(access.admin, profile)) return NextResponse.json({ error: "LAST_ACTIVE_ADMIN" }, { status: 409 });
      const { error } = await access.admin.from("spc_user_roles").update({ role: body.role, updated_at: new Date().toISOString() }).eq("user_id", body.userId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (body.action === "active") {
      if (profile.application_status !== "approved") return NextResponse.json({ error: "ACTIVE_CHANGE_NOT_ALLOWED" }, { status: 409 });
      if (!body.active && await protectsLastActiveAdmin(access.admin, profile)) return NextResponse.json({ error: "LAST_ACTIVE_ADMIN" }, { status: 409 });
      const { error: authError } = await access.admin.auth.admin.updateUserById(body.userId, { ban_duration: body.active ? "none" : "876000h" });
      if (authError) throw authError;
      const { error } = await access.admin.from("spc_user_roles").update({
        active: body.active,
        updated_at: new Date().toISOString(),
      }).eq("user_id", body.userId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "UNKNOWN_ERROR";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
