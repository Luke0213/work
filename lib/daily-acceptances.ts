export type DailyAcceptance = {
  id: string;
  date: string;
  draft?: boolean;
};

export type DailyAcceptanceUnit<A extends DailyAcceptance = DailyAcceptance> = {
  id: string;
  acceptances?: A[];
};

export type DailyAcceptanceEntry<U, A> = {
  date: string;
  unit: U;
  acceptance: A;
};

export function buildDailyAcceptanceEntries<A extends DailyAcceptance, U extends DailyAcceptanceUnit<A>>(units: U[]): DailyAcceptanceEntry<U, A>[] {
  return units.flatMap((unit) => {
    const seen = new Set<string>();
    return (unit.acceptances || []).flatMap((acceptance) => {
      if (acceptance.draft === true || !acceptance.date || seen.has(acceptance.id)) return [];
      seen.add(acceptance.id);
      return [{ date: acceptance.date.slice(0, 10), unit, acceptance }];
    });
  }).sort((a, b) => b.date.localeCompare(a.date) || a.unit.id.localeCompare(b.unit.id));
}
