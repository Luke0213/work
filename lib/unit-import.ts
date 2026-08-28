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

export const importProductKey = (row: Pick<UnitImportCandidate, "model" | "colorNo">): string | null =>
  row.model && row.colorNo ? `${row.model}|${row.colorNo}` : null;
