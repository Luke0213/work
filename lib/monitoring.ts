import { supabase } from "./supabase";

export type SystemHealth = {
  projects: number; units: number; errors24h: number; backups: number;
  latestBackup: string | null; storageFiles: number; storageBytes: number;
};

export async function reportClientError(message: string, source = "browser", detail: Record<string, unknown> = {}) {
  await supabase.rpc("spc_report_error", { p_message: message, p_source: source, p_detail: detail });
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const { data, error } = await supabase.rpc("spc_system_health");
  if (error) throw error;
  return data as SystemHealth;
}

export function healthWarnings(health: SystemHealth): string[] {
  const warnings: string[] = [];
  if (health.errors24h >= 5) warnings.push(`24 小時內有 ${health.errors24h} 次錯誤`);
  if (health.storageBytes >= 500 * 1024 * 1024) warnings.push("照片空間已超過 500MB");
  if (health.latestBackup && Date.now() - new Date(health.latestBackup).getTime() > 36 * 60 * 60 * 1000) warnings.push("自動備份超過 36 小時未更新");
  return warnings;
}
