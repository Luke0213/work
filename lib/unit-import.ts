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
