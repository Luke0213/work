type Journal = { id: string; draft?: boolean; createdAt?: string; updatedAt?: string; createdBy?: string };

export async function saveUnitJournal<T extends Journal>(input: {
  entry: T; journals: T[]; draft: boolean; owner: string; now: string;
  saveDraft: (record: T) => Promise<unknown>;
  queue: (record: T) => Promise<unknown>;
  patch: (journals: T[]) => Promise<void>;
  removeDraft: () => Promise<unknown>;
}) {
  const record = { ...input.entry, draft: input.draft, createdAt: input.entry.createdAt || input.now,
    updatedAt: input.now, createdBy: input.entry.createdBy || input.owner };
  // patch only acknowledges LOCAL durability. Cloud verification owns cleanup.
  await input.saveDraft(record);
  await input.queue(record);
  await input.patch([record, ...input.journals.filter((item) => item.id !== record.id)]);
  return record;
}
