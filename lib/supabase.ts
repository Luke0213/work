import { createClient } from "@supabase/supabase-js";

// NEXT_PUBLIC_* values are normally replaced during the frontend build. Sites
// remote builds do not currently expose runtime environment variables at that
// stage, so keep the public Supabase connection values as safe fallbacks. The
// service-role key remains runtime-only and is never bundled into the client.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://tcjroakkconafqoqqmic.supabase.co";
const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_JU-LlhiNCeMmBSmebbuzsw_Jm_XDkDP";

if (!url || !publishableKey) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
}

export const supabase = createClient(url, publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
