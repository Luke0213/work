import { getLatestFinalAcceptance } from "./acceptance-records.ts";

export const floorSignatureRoles = ["installer", "office", "siteManager", "supervisor"] as const;
export type FloorSignatureRole = (typeof floorSignatureRoles)[number];
export type FloorSignature = { name: string; data: string; at: string; valid: boolean };
export type FloorSignatures = Partial<Record<FloorSignatureRole, FloorSignature>>;

export type FloorAcceptanceRecord = {
  id: string;
  building: string;
  floor: string;
  signatures: FloorSignatures;
  completedAt?: string;
  completedBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FloorAcceptanceItem = {
  result?: string;
};

export type FloorAcceptanceUnit = {
  id: string;
  building?: string;
  floor?: string;
  acceptances?: Array<{
    id?: string;
    draft?: boolean;
    startedAt?: string;
    date?: string;
    result?: string;
    items?: FloorAcceptanceItem[];
    signature?: FloorSignature;
    completion?: { signatures?: FloorSignatures };
  }>;
};

export const floorIdentity = (building: string, floor: string) => `${building}__${floor}`;

export function floorUnitsFor<T extends { building?: string; floor?: string }>(units: T[], building: string, floor: string): T[] {
  return units.filter((unit) => (unit.building || "") === building && (unit.floor || "") === floor);
}

export type FloorUnitState = "qualified" | "needsAction" | "uninspected";

export function floorUnitAcceptanceState(unit: FloorAcceptanceUnit): FloorUnitState {
  const acceptance = getLatestFinalAcceptance(unit);
  if (!acceptance) return "uninspected";
  const items = acceptance.items || [];
  return acceptance.result === "合格" && items.length > 0 && items.every((item) => item.result === "合格")
    ? "qualified"
    : "needsAction";
}

export function floorAcceptanceSummary(units: FloorAcceptanceUnit[]) {
  const states = units.map(floorUnitAcceptanceState);
  const qualified = states.filter((state) => state === "qualified").length;
  const needsAction = states.filter((state) => state === "needsAction").length;
  const uninspected = states.filter((state) => state === "uninspected").length;
  return { total: units.length, qualified, needsAction, uninspected, allQualified: units.length > 0 && qualified === units.length };
}

export function hasAllFloorSignatures(signatures: FloorSignatures | undefined): boolean {
  return floorSignatureRoles.every((role) => signatures?.[role]?.valid === true);
}

export type ResolvedFloorSignatures = {
  signatures: FloorSignatures;
  conflicts: FloorSignatureRole[];
};

export function canCompleteFloorAcceptance(units: FloorAcceptanceUnit[], resolved: ResolvedFloorSignatures): boolean {
  return floorAcceptanceSummary(units).allQualified
    && resolved.conflicts.length === 0
    && hasAllFloorSignatures(resolved.signatures);
}

export function updateFloorSignature(signatures: FloorSignatures | undefined, role: FloorSignatureRole, signature?: FloorSignature): FloorSignatures {
  const next = { ...(signatures || {}) };
  if (signature) next[role] = signature;
  else delete next[role];
  return next;
}

const legacySignature = (unit: FloorAcceptanceUnit, role: FloorSignatureRole): FloorSignature | undefined => {
  const acceptance = getLatestFinalAcceptance(unit);
  if (!acceptance) return undefined;
  return role === "office"
    ? acceptance.completion?.signatures?.office || acceptance.signature
    : acceptance.completion?.signatures?.[role];
};

export function resolveFloorSignatures(record: FloorAcceptanceRecord | undefined, units: FloorAcceptanceUnit[]): ResolvedFloorSignatures {
  const signatures: FloorSignatures = {};
  const conflicts: FloorSignatureRole[] = [];
  for (const role of floorSignatureRoles) {
    const floorSignature = record?.signatures?.[role];
    if (floorSignature?.valid) {
      signatures[role] = floorSignature;
      continue;
    }
    const candidates = units.map((unit) => legacySignature(unit, role)).filter((signature): signature is FloorSignature => !!signature?.valid);
    const unique = [...new Map(candidates.map((signature) => [`${signature.name}\u0000${signature.data}`, signature])).values()];
    if (unique.length === 1) signatures[role] = unique[0];
    else if (unique.length > 1) conflicts.push(role);
  }
  return { signatures, conflicts };
}

export type FloorReturnContext = {
  building: string;
  floor: string;
  filter: "all" | "incomplete";
  expanded: boolean;
  scrollY: number;
  tab?: "accept" | "sheet";
};

export function createFloorReturnContext(building: string, floor: string, filter: "all" | "incomplete" = "all", expanded = true, scrollY = 0, tab: "accept" | "sheet" = "accept"): FloorReturnContext {
  return { building, floor, filter, expanded, scrollY, tab };
}
