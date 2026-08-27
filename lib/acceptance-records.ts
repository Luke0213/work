export type FinalAcceptanceRecord = {
  draft?: boolean;
  startedAt?: string;
  date?: string;
};

export function acceptanceRecordTime(acceptance: FinalAcceptanceRecord): number {
  const startedAt = acceptance.startedAt?.trim();
  if (startedAt) {
    const parsed = Date.parse(startedAt);
    if (Number.isFinite(parsed)) return parsed;

    const match = startedAt.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(上午|下午)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
      const [, year, month, date, period, rawHour, minute, second = "0"] = match;
      let hour = Number(rawHour);
      if (period === "下午" && hour < 12) hour += 12;
      if (period === "上午" && hour === 12) hour = 0;
      return new Date(Number(year), Number(month) - 1, Number(date), hour, Number(minute), Number(second)).getTime();
    }
  }

  const date = Date.parse(`${acceptance.date || ""}T00:00:00`);
  return Number.isFinite(date) ? date : 0;
}

export function getLatestFinalAcceptance<T extends FinalAcceptanceRecord>(unit: { acceptances?: T[] }): T | undefined {
  return (unit.acceptances || [])
    .filter((acceptance) => acceptance.draft !== true)
    .reduce<T | undefined>((latest, acceptance) =>
      !latest || acceptanceRecordTime(acceptance) > acceptanceRecordTime(latest) ? acceptance : latest,
    undefined);
}
