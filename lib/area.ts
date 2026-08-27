export type AreaUnit = "坪" | "m²";

export const SQUARE_METERS_TO_PING = 0.3025;

const roundArea = (value: number) => Number(value.toFixed(2));

export function squareMetersToPing(squareMeters: number): number {
  return roundArea(squareMeters * SQUARE_METERS_TO_PING);
}

export function pingToSquareMeters(ping: number): number {
  return roundArea(ping / SQUARE_METERS_TO_PING);
}

export function areaInputToPing(value: string | number, unit: AreaUnit): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return unit === "m²" ? squareMetersToPing(numeric) : roundArea(numeric);
}

export function convertAreaInput(value: string, from: AreaUnit, to: AreaUnit): string {
  if (value.trim() === "" || from === to) return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  const converted = from === "坪" ? pingToSquareMeters(numeric) : squareMetersToPing(numeric);
  return String(converted);
}

export function areaValueFromPing(ping: number, unit: AreaUnit): number {
  return unit === "m²" ? pingToSquareMeters(ping) : roundArea(ping);
}

const normalizeHeader = (header: string) => header.toLowerCase().replace(/\s/g, "");
const pingHeaders = new Set(["預估坪數", "預估施工坪數", "坪數", "坪"]);
const squareMeterHeaders = new Set(["m²", "m2", "m^2", "㎡", "平方公尺", "平方米"]);

export function importedAreaToPing(source: Record<string, unknown>): number {
  const entries = Object.entries(source).map(([header, value]) => [normalizeHeader(header), value] as const);
  for (const aliases of [pingHeaders, squareMeterHeaders] as const) {
    const found = entries.find(([header, value]) => aliases.has(header) && String(value ?? "").trim() !== "");
    if (!found) continue;
    const numeric = Number(String(found[1]).replace(/,/g, "").replace(/坪|m²|m2|m\^2|㎡|平方公尺|平方米/gi, "").trim());
    if (!Number.isFinite(numeric)) return Number.NaN;
    return aliases === squareMeterHeaders ? squareMetersToPing(numeric) : roundArea(numeric);
  }
  return Number.NaN;
}
