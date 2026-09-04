import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const applicationRoles = new Set(["shenyin", "client", "crew", "sales"]);
const recentRequests = new Map<string, number>();

function parseIdentity(value: string) {
  const identity = value.trim();
  if (/^\S+@\S+\.\S+$/.test(identity)) return { kind: "email" as const, email: identity.toLowerCase() };
  const digits = identity.replace(/[\s-]/g, "");
  const phone = /^09\d{8}$/.test(digits) ? `886${digits.slice(1)}` : digits.replace(/^\+886/, "886");
  if (/^8869\d{8}$/.test(phone)) return { kind: "phone" as const, phone, email: `p${phone}@phone.spc.internal` };
  return null;
}

function clientIp(request: NextRequest) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseUrl || !serviceRoleKey) return NextResponse.json({ error: "SERVER_AUTH_NOT_CONFIGURED" }, { status: 500 });
    const ip = clientIp(request);
    const lastRequest = recentRequests.get(ip) || 0;
    if (Date.now() - lastRequest < 15_000) return NextResponse.json({ error: "TOO_MANY_REQUESTS" }, { status: 429 });

    const body = await request.json() as { identity?: string; displayName?: string; role?: string; password?: string; confirmPassword?: string; website?: string };
    if (body.website) return NextResponse.json({ ok: true });
    const identity = parseIdentity(body.identity || "");
    const displayName = (body.displayName || "").trim();
    const password = body.password || "";
    if (!identity) return NextResponse.json({ error: "INVALID_IDENTITY" }, { status: 400 });
    if (!displayName || displayName.length > 80) return NextResponse.json({ error: "INVALID_NAME" }, { status: 400 });
    if (!body.role || !applicationRoles.has(body.role)) return NextResponse.json({ error: "INVALID_ROLE" }, { status: 400 });
    if (password.length < 8 || password.length > 72) return NextResponse.json({ error: "INVALID_PASSWORD" }, { status: 400 });
    if (password !== body.confirmPassword) return NextResponse.json({ error: "PASSWORD_MISMATCH" }, { status: 400 });
    recentRequests.set(ip, Date.now());

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.auth.admin.createUser({
      email: identity.email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: displayName,
        must_change_password: false,
        requested_role: body.role,
        ...(identity.kind === "phone" ? { local_phone: identity.phone } : {}),
      },
    });
    if (error) {
      const duplicate = /already|registered|exists/i.test(error.message);
      return NextResponse.json({ error: duplicate ? "ACCOUNT_EXISTS" : error.message }, { status: duplicate ? 409 : 400 });
    }

    const { error: roleError } = await admin.from("spc_user_roles").upsert({
      user_id: data.user.id,
      email: identity.kind === "email" ? identity.email : "",
      display_name: displayName,
      role: body.role,
      active: false,
      application_status: "pending",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (roleError) {
      await admin.auth.admin.deleteUser(data.user.id);
      throw roleError;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "UNKNOWN_ERROR" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!supabaseUrl || !publishableKey || !serviceRoleKey) return NextResponse.json({ error: "SERVER_AUTH_NOT_CONFIGURED" }, { status: 500 });
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    const verifier = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user }, error: userError } = await verifier.auth.getUser(token);
    if (userError || !user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const body = await request.json() as { displayName?: string; role?: string };
    const displayName = (body.displayName || "").trim();
    if (!displayName || displayName.length > 80) return NextResponse.json({ error: "INVALID_NAME" }, { status: 400 });
    if (!body.role || !applicationRoles.has(body.role)) return NextResponse.json({ error: "INVALID_ROLE" }, { status: 400 });

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: profile, error: profileError } = await admin.from("spc_user_roles")
      .select("application_status, active")
      .eq("user_id", user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile || profile.application_status !== "rejected" || profile.active !== false) {
      return NextResponse.json({ error: "REAPPLY_NOT_ALLOWED" }, { status: 409 });
    }

    const { error: metadataError } = await admin.auth.admin.updateUserById(user.id, {
      ban_duration: "none",
      user_metadata: { ...user.user_metadata, display_name: displayName, requested_role: body.role },
    });
    if (metadataError) throw metadataError;
    const { error: updateError } = await admin.from("spc_user_roles").update({
      display_name: displayName,
      role: body.role,
      application_status: "pending",
      active: false,
      updated_at: new Date().toISOString(),
    }).eq("user_id", user.id);
    if (updateError) throw updateError;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "UNKNOWN_ERROR" }, { status: 500 });
  }
}
