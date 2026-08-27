import { NextRequest, NextResponse } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

type StaffRole = "admin" | "shenyin" | "client" | "crew" | "sales";
const roles = new Set<StaffRole>(["admin", "shenyin", "client", "crew", "sales"]);
type AdminAction =
  | { action: "create"; identity: string; role: StaffRole }
  | { action: "role"; userId: string; role: StaffRole }
  | { action: "active"; userId: string; active: boolean }
  | { action: "reset"; userId: string };

function parseIdentity(value: string) {
  const identity = value.trim();
  if (/^\S+@\S+\.\S+$/.test(identity)) return { kind: "email" as const, email: identity.toLowerCase() };
  const digits = identity.replace(/[\s-]/g, "");
  const phone = /^09\d{8}$/.test(digits) ? `886${digits.slice(1)}` : digits.replace(/^\+886/, "886");
  if (/^8869\d{8}$/.test(phone)) return { kind: "phone" as const, phone, email: `p${phone}@phone.spc.internal` };
  return null;
}

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
  const { data: role } = await admin.from("spc_user_roles").select("role, active").eq("user_id", user.id).maybeSingle();
  return role?.role === "admin" && role.active ? { user, admin } : null;
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
    const { data: staffRoles, error } = await access.admin.from("spc_user_roles").select("user_id, email, role, active, application_status");
    if (error) throw error;
    const roleMap = new Map((staffRoles || []).map((row) => [row.user_id, row]));
    return NextResponse.json({
      currentUserId: access.user.id,
      users: users.map((user) => {
        const record = roleMap.get(user.id);
        const isBanned = user.banned_until ? new Date(user.banned_until).getTime() > Date.now() : false;
        return {
          id: user.id,
          email: user.email?.endsWith("@phone.spc.internal") ? "" : user.email || record?.email || "",
          phone: String(user.user_metadata?.local_phone || user.phone || ""),
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
    return NextResponse.json({ error: error instanceof Error ? error.message : "UNKNOWN_ERROR" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const access = await requireAdmin(request);
    if (!access) return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403 });
    const body = (await request.json()) as AdminAction;
    if (body.action === "create") {
      const identity = parseIdentity(body.identity);
      if (!identity) return NextResponse.json({ error: "INVALID_IDENTITY" }, { status: 400 });
      if (!roles.has(body.role)) return NextResponse.json({ error: "INVALID_ROLE" }, { status: 400 });
      const { data, error } = await access.admin.auth.admin.createUser({
        email: identity.email,
        password: "1234qwer",
        email_confirm: true,
        user_metadata: { must_change_password: true, ...(identity.kind === "phone" ? { local_phone: identity.phone } : {}) },
      });
      if (error) throw error;
      const { error: roleError } = await access.admin.from("spc_user_roles").upsert({
        user_id: data.user.id,
        email: identity.kind === "email" ? identity.email : "",
        role: body.role,
        active: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (roleError) {
        await access.admin.auth.admin.deleteUser(data.user.id);
        throw roleError;
      }
      return NextResponse.json({ ok: true });
    }
    if (body.action === "reset") {
      const { data: existing } = await access.admin.auth.admin.getUserById(body.userId);
      const { error } = await access.admin.auth.admin.updateUserById(body.userId, {
        password: "1234qwer",
        user_metadata: { ...existing.user?.user_metadata, must_change_password: true },
      });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (body.userId === access.user.id && ((body.action === "active" && !body.active) || (body.action === "role" && body.role !== "admin"))) {
      return NextResponse.json({ error: "CANNOT_LOCK_SELF" }, { status: 400 });
    }
    if (body.action === "role") {
      if (!roles.has(body.role)) return NextResponse.json({ error: "INVALID_ROLE" }, { status: 400 });
      const { error } = await access.admin.from("spc_user_roles").update({ role: body.role, updated_at: new Date().toISOString() }).eq("user_id", body.userId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (body.action === "active") {
      const { error: authError } = await access.admin.auth.admin.updateUserById(body.userId, { ban_duration: body.active ? "none" : "876000h" });
      if (authError) throw authError;
      const { error } = await access.admin.from("spc_user_roles").update({
        active: body.active,
        ...(body.active ? { application_status: "approved" } : {}),
        updated_at: new Date().toISOString(),
      }).eq("user_id", body.userId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "UNKNOWN_ERROR" }, { status: 500 });
  }
}
