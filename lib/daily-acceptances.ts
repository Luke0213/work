export type DailyAcceptance = {
  id?: string;
  date?: string;
  draft?: boolean;
};

export type DailyAcceptanceUnit<A extends DailyAcceptance = DailyAcceptance> = {
  id: string;
  _deleted?: boolean;
  acceptances?: A[];
};

export type DailyAcceptanceEntry<U, A> = {
  date: string;
  unit: U;
  acceptance: A;
};

export function buildDailyAcceptanceEntries<A extends DailyAcceptance, U extends DailyAcceptanceUnit<A>>(units: U[]): DailyAcceptanceEntry<U, A>[] {
  return units.filter((unit) => unit._deleted !== true).flatMap((unit) => {
    const seen = new Set<string>();
    return (unit.acceptances || []).flatMap((acceptance) => {
      if (
        acceptance.draft === true
        || !acceptance.id
        || !acceptance.date
        || seen.has(acceptance.id)
      ) return [];
      seen.add(acceptance.id);
      return [{ date: acceptance.date.slice(0, 10), unit, acceptance }];
    });
  }).sort((a, b) => b.date.localeCompare(a.date) || a.unit.id.localeCompare(b.unit.id));
}
