import { areaInputToPing, type AreaUnit } from "./area.ts";

export type UnitImportCandidate = {
  hasData: boolean;
  duplicate: boolean;
  model: string;
  colorNo: string;
};

export const importableUnitRows = <T extends UnitImportCandidate>(rows: T[]): T[] =>
  rows.filter((row) => row.hasData && !row.duplicate);

export const safeImportedEstimated = (estimated: number): number =>
  Number.isFinite(estimated) && estimated > 0 ? estimated : 0;

export type ImportAreaDetection = {
  unit: AreaUnit | null;
  basis: "header" | "median" | "uncertain";
  header?: string;
  validCount: number;
  median?: number;
};

const normalizeAreaHeader = (header: string) => header.toLowerCase().replace(/\s/g, "");

export const explicitImportAreaUnit = (header: string): AreaUnit | null => {
  const normalized = normalizeAreaHeader(header);
  if (/m²|m2|m\^2|㎡|平方公尺|平方米/.test(normalized)) return "m²";
  if (normalized.includes("坪")) return "坪";
  return null;
};

export const parseImportedAreaNumber = (value: unknown): number => {
  const numeric = Number(String(value ?? "").replace(/,/g, "").replace(/坪|m²|m2|m\^2|㎡|平方公尺|平方米/gi, "").trim());
  return Number.isFinite(numeric) ? numeric : Number.NaN;
};

export const importedAreaEntry = (source: Record<string, unknown>): { header: string; value: number } | null => {
  const entries = Object.entries(source);
  const explicit = entries.find(([header, value]) => explicitImportAreaUnit(header) && String(value ?? "").trim() !== "");
  const generic = entries.find(([header, value]) => normalizeAreaHeader(header).includes("面積") && String(value ?? "").trim() !== "");
  const found = explicit || generic;
  return found ? { header: found[0], value: parseImportedAreaNumber(found[1]) } : null;
};

export const detectImportAreaBatch = (sources: Record<string, unknown>[]): ImportAreaDetection => {
  const entries = sources.map(importedAreaEntry).filter((entry): entry is NonNullable<typeof entry> => !!entry);
  const valid = entries.map((entry) => entry.value).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const explicit = sources.flatMap((source) => Object.keys(source)).map((header) => ({ header, unit: explicitImportAreaUnit(header) })).filter((entry): entry is { header: string; unit: AreaUnit } => !!entry.unit);
  const explicitUnits = [...new Set(explicit.map((entry) => entry.unit))];
  if (explicitUnits.length === 1) return { unit: explicitUnits[0], basis: "header", header: explicit[0].header, validCount: valid.length };
  if (!valid.length) return { unit: null, basis: "uncertain", validCount: 0 };
  const middle = Math.floor(valid.length / 2);
  const median = valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
  if (median < 22) return { unit: "坪", basis: "median", validCount: valid.length, median };
  if (median > 28) return { unit: "m²", basis: "median", validCount: valid.length, median };
  return { unit: null, basis: "uncertain", validCount: valid.length, median };
};

export const importedAreaToCanonicalPing = (value: number, unit: AreaUnit): number =>
  safeImportedEstimated(areaInputToPing(value, unit));

export const importProductKey = (row: Pick<UnitImportCandidate, "model" | "colorNo">): string | null =>
  row.model && row.colorNo ? `${row.model}|${row.colorNo}` : null;

export type OnboardingUnitRow = {
  building: string;
  floor: string;
  number: string;
  model: string;
  colorNo: string;
};

export const onboardingUnitRowIsValid = (row: OnboardingUnitRow, estimatedPing: number): boolean =>
  !!row.building.trim() && !!row.floor.trim() && !!row.number.trim() && Number.isFinite(estimatedPing) && estimatedPing > 0;

export const findExactUnitProduct = <T extends Pick<UnitImportCandidate, "model" | "colorNo">>(row: Pick<OnboardingUnitRow, "model" | "colorNo">, products: T[]): T | undefined => {
  const model = row.model.trim();
  const colorNo = row.colorNo.trim();
  if (!model || !colorNo) return undefined;
  return products.find((product) => product.model === model && product.colorNo === colorNo);
};
