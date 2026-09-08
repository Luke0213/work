import { containsWorkspaceChanges, workspaceSyncError } from "./workspace-persistence.ts";
import { photoReference } from "./photo-reference.ts";
import { threeWayMerge } from "./three-way-merge.ts";

export type SyncState = "clean" | "dirty" | "saving" | "verifying" | "synced" | "conflict" | "timeout" | "offline" | "failed";

// Canonical, collision-free fingerprint. Signed URL renewal is not an edit.
export function intendedFingerprint(value: unknown): string {
  const canonical = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(canonical);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.keys(node).sort().map((key) => {
      let child = (node as Record<string, unknown>)[key];
      if (key === "data" && typeof child === "string") {
        const reference = photoReference(child);
        if (reference !== null) child = `spc-storage://${reference}`;
      }
      return [key, canonical(child)];
    }));
  };
  return JSON.stringify(canonical(value));
}

export type SyncAttempt<T> = { owner: string; base: T; source: T; intended: T; version: number; submitted: boolean; rebaseRequired?: boolean; manualRetryRequired?: boolean; confirmedVersion?: number; failures?: number; nextRetryAt?: number };
export type SyncPorts<T, R extends { version: number }> = {
  durable: (attempt: SyncAttempt<T>) => Promise<void>;
  upload: (value: T, checkpoint: (value: T) => Promise<void>) => Promise<T>;
  save: (attempt: SyncAttempt<T>) => Promise<number>;
  load: (phase?: "rebase" | "verification") => Promise<R>;
  value: (remote: R) => T;
  verify?: (attempt: SyncAttempt<T>, remote: R) => boolean;
  conflict?: (paths: string[], remote: R) => void;
};

const postgresCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

const isPostgresFailure = (error: unknown) => /^(?:[0-9]{2}[0-9A-Z]{3}|P[0-9]{4})$/.test(postgresCode(error) || "");
const isVersionConflict = (error: unknown) => postgresCode(error) === "40001";
const isStatementTimeout = (error: unknown) => postgresCode(error) === "57014";

export class SyncCoordinator<T, R extends { version: number }> {
  state: SyncState = "clean";
  nextRetryAt = 0;
  failures = 0;
  attempt: SyncAttempt<T> | null = null;
  private flight: Promise<{ remote: R; attempt: SyncAttempt<T> }> | null = null;
  private refreshing = false;
  private last: { remote: R; attempt: SyncAttempt<T> } | null = null;
  private now: () => number;
  readonly owner: string;
  constructor(owner: string, now = Date.now) { this.owner = owner; this.now = now; }
  restore(attempt: SyncAttempt<T> | null) {
    if (attempt?.owner === this.owner) {
      this.attempt = attempt; this.state = attempt.manualRetryRequired ? "timeout" : "dirty";
      this.failures = attempt.failures || 0; this.nextRetryAt = attempt.nextRetryAt || 0;
    }
  }
  requestVerification() {
    if (!this.flight) {
      this.failures = 0; this.nextRetryAt = 0;
      if (this.attempt?.manualRetryRequired) this.attempt.manualRetryRequired = false;
      if (this.state === "timeout") this.state = "dirty";
    }
  }
  observe(dirty: boolean, online: boolean) {
    if (this.flight || this.attempt || this.state === "conflict") return;
    this.state = online ? (dirty ? "dirty" : "clean") : "offline";
  }
  canRetry() { return this.failures < 5 && this.now() >= this.nextRetryAt && !this.flight && this.state !== "conflict" && this.state !== "timeout"; }
  async run(base: T, intended: T, version: number, ports: SyncPorts<T, R>) {
    if (this.flight) return this.flight;
    if (!this.attempt && this.last && version <= this.last.remote.version
      && [ports.value(this.last.remote), this.last.attempt.source].some((value) => intendedFingerprint(intended) === intendedFingerprint(value))) return this.last;
    if (!this.canRetry()) throw new Error("同步等待退避或人工確認；本機草稿仍保留");
    this.flight = this.execute(base, intended, version, ports);
    try { return await this.flight; } finally { this.flight = null; }
  }
  private async execute(base: T, intended: T, version: number, ports: SyncPorts<T, R>) {
    const attempt = this.attempt ||= { owner: this.owner, base: structuredClone(base), source: structuredClone(intended), intended: structuredClone(intended), version, submitted: false };
    try {
      this.state = "dirty";
      await ports.durable(attempt);
      if (attempt.rebaseRequired) await this.rebase(attempt, ports);
      if (!attempt.submitted) {
        this.state = "saving";
        attempt.intended = await ports.upload(attempt.intended, async (value) => {
          attempt.intended = structuredClone(value);
          await ports.durable(attempt);
        });
        // Write the uncertain-outcome marker BEFORE sending. A lost response must
        // never lead to a second SAVE, including after a browser restart.
        attempt.submitted = true;
        await ports.durable(attempt);
        try {
          // Recovery may have a stale pending flag or renewed signed URLs even
          // though this intended delta is already the loaded baseline.
          if (!containsWorkspaceChanges(attempt.base, attempt.intended, attempt.base)) {
            attempt.confirmedVersion = await ports.save(attempt);
          }
        }
        catch (error) {
          // 40001 proves rollback and requires rebase. PostgreSQL 57014 also
          // rolls back this statement, but is held for an explicit manual retry
          // so the coordinator never creates an automatic SAVE loop. Transport
          // uncertainty remains submitted and therefore verification-only.
          if (isVersionConflict(error)) {
            attempt.submitted = false;
            attempt.rebaseRequired = true;
            attempt.confirmedVersion = undefined;
            await ports.durable(attempt);
            await this.rebase(attempt, ports);
          } else if (isStatementTimeout(error)) {
            attempt.submitted = false;
            attempt.rebaseRequired = false;
            attempt.manualRetryRequired = true;
            attempt.confirmedVersion = undefined;
            this.state = "timeout";
            await ports.durable(attempt);
          } else if (isPostgresFailure(error)) {
            attempt.submitted = false;
          }
          throw error;
        }
        await ports.durable(attempt);
      }
      this.state = "verifying";
      const remote = await ports.load("verification");
      if (remote.version < (attempt.confirmedVersion ?? attempt.version)
        || !containsWorkspaceChanges(attempt.base, attempt.intended, ports.value(remote))
        || (ports.verify && !ports.verify(attempt, remote))) throw new Error(workspaceSyncError);
      this.failures = 0; this.nextRetryAt = 0; this.state = "synced";
      this.last = { remote, attempt };
      return this.last;
    } catch (error) {
      if (this.state === "conflict") {
        try { await ports.durable(attempt); } catch (storageError) { console.warn("SPC conflict checkpoint failed", storageError); }
        throw error;
      }
      if (isStatementTimeout(error) || this.state === "timeout") {
        attempt.manualRetryRequired = true;
        this.state = "timeout";
        try { await ports.durable(attempt); } catch (storageError) { console.warn("SPC timeout checkpoint failed", storageError); }
        throw error;
      }
      this.failures += 1;
      this.nextRetryAt = this.now() + Math.min(300_000, 15_000 * 2 ** (this.failures - 1));
      attempt.failures = this.failures; attempt.nextRetryAt = this.nextRetryAt;
      this.state = "failed";
      try { await ports.durable(attempt); } catch (storageError) { console.warn("SPC retry checkpoint failed", storageError); }
      throw error;
    }
  }
  private async rebase(attempt: SyncAttempt<T>, ports: SyncPorts<T, R>) {
    this.state = "verifying";
    const remote = await ports.load("rebase");
    const latest = ports.value(remote);
    const merged = threeWayMerge(attempt.base, attempt.intended, latest);
    if (merged.conflicts.length) {
      this.state = "conflict";
      ports.conflict?.(merged.conflicts, remote);
      throw new Error(`同步衝突：${merged.conflicts.join(", ")}`);
    }
    attempt.base = structuredClone(latest);
    attempt.version = remote.version;
    attempt.intended = structuredClone(merged.value);
    attempt.rebaseRequired = false;
    attempt.submitted = false;
    attempt.confirmedVersion = undefined;
    await ports.durable(attempt);
  }
  acknowledge() { this.attempt = null; }
  async refresh(currentVersion: number, clean: () => boolean, version: () => Promise<number>, load: () => Promise<R>, apply: (remote: R) => void) {
    const allowed = () => !this.flight && !this.attempt && (this.state === "clean" || this.state === "synced") && clean();
    if (this.refreshing || !allowed()) return;
    this.refreshing = true;
    try {
      const remoteVersion = await version();
      if (remoteVersion === currentVersion || !allowed()) return;
      const remote = await load();
      if (allowed()) apply(remote);
    } finally { this.refreshing = false; }
  }
}
