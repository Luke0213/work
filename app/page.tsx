"use client";
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import * as XLSX from "xlsx";
import { AlignmentType, BorderStyle, Document, ImageRun, Packer, PageOrientation, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { loadLegacyWorkspace, loadWorkspace, saveWorkspace, uploadEmbeddedPhotos, type EntityActivity } from "../lib/spc-backend";
import { supabase } from "../lib/supabase";
import { isDeletedEntity, liveEntities, retainEntityTombstones, threeWayMerge, tombstoneEntity } from "../lib/three-way-merge";
import { getSystemHealth, healthWarnings, reportClientError, type SystemHealth } from "../lib/monitoring";
import { completeSyncedOutbox, loadOfflineDraft, offlineSummary, queueOfflineWrite, removeOfflineDraft, saveOfflineDraft, storageDiagnostics } from "../lib/offline-drafts";
import { durableStorageState, isIndexedDbMarker, localDraftValue, logStorageException, shouldAttemptCloudSave, shouldRestoreIndexedDbDraft, type StorageErrorDetails } from "../lib/storage-durability";
import { buildAcceptanceExportRecord, buildAcceptanceExportRecords, createReceivableWorkbook, createShipmentWorkbook, saveReceivableWorkbook, saveShipmentWorkbook } from "../lib/acceptance-exports";
import { getLatestFinalAcceptance } from "../lib/acceptance-records";
import { buildDailyAcceptanceEntries } from "../lib/daily-acceptances";
import { AuthResolveGuard, resolveAuthIdentity, type AuthIdentity } from "../lib/auth-session";
import { migrateLegacyStorageValue, scopedDraftKey, scopedStorageKey } from "../lib/auth-storage";
import { printWithLifecycleCleanup, revokeObjectUrlLater } from "../lib/browser-lifecycle";
import { areaInputToPing, areaValueFromPing, convertAreaInput, importedAreaToPing, type AreaUnit } from "../lib/area";
import { shouldUseEnvironmentCapture } from "../lib/photo-capture";
import { findExactUnitProduct, importableUnitRows, importProductKey, onboardingUnitRowIsValid, safeImportedEstimated } from "../lib/unit-import";
import { buildUnitScopedRecord, createFloorReturnContext, floorAcceptanceSummary, floorBatchSelectableIds, floorIdentity, floorSignatureRoles, floorUnitAcceptanceState, floorUnitNeedsAction, floorUnitSignatureCount, floorUnitSignatures, floorUnitsFor, floorWorkbenchSummary, nextPendingFloorUnitId, resolveUnitSignatures, updateLatestFormalAcceptanceSignature, updateUnitScopedRecord, type FloorAcceptanceRecord, type FloorReturnContext, type FloorSignatureRole, type ResolvedFloorSignatures } from "../lib/floor-acceptance";
import { planJournalPhotoRows, type JournalPhotoLayoutItem } from "../lib/journal-photo-layout";

type Status =
  | "待確認"
  | "待場勘"
  | "場勘待改善"
  | "可進場"
  | "施工中"
  | "待驗收"
  | "驗收缺失"
  | "改善中"
  | "待複驗"
  | "已驗收"
  | "已計價";
type Choice = "" | "合格" | "不合格" | "不適用";
type Photo = {
  id: string;
  data: string;
  node?: string;
  date?: string;
  caption?: string;
  includeReport?: boolean;
};
type CheckItem = {
  label: string;
  result: Choice;
  note: string;
  photos?: Photo[];
  value?: string;
  unit?: string;
  requiresMeasurement?: boolean;
};
type Event = {
  id: string;
  at: string;
  title: string;
  detail: string;
  photos: Photo[];
};
type Survey = {
  id: string;
  date: string;
  person: string;
  items: CheckItem[];
  photos: Photo[];
  note: string;
  decision: "可進場" | "待改善";
  areaStatus?: "known" | "pending";
  areaValue?: number;
  areaUnit?: "坪" | "m" | "m²";
  startedAt?: string;
  draft?: boolean;
  doorInspection?: {
    thresholdCm?: number;
    meetsThreshold: boolean;
    hasGap: boolean | null;
    result: "合格" | "不合格";
    rationale: string;
    note: string;
    photos: Photo[];
  };
  siliconeInspection?: {
    matchesFloor: boolean | null;
    otherColor: string;
    note: string;
    photos: Photo[];
  };
  dividerInspection?: {
    needed: "是" | "否" | "待確認";
    quantity?: number;
    location: string;
    note: string;
    photos: Photo[];
  };
  parking?: {
    count: "" | "0" | "1" | "2" | "3" | "4" | "5台以上";
    location: string;
    note: string;
    photos: Photo[];
  };
  stagingArea?: {
    location: string;
    note: string;
    cautions: string;
    photos: Photo[];
  };
  surveySignatures?: { name: string; data: string; at: string; valid: boolean }[];
  risk?: {
    items: string;
    detail: string;
    reason: string;
    person: string;
    date: string;
    signature: string;
    photos: Photo[];
  };
};
type Work = {
  id: string;
  date: string;
  crew: string;
  people: number;
  area: number;
  content: string;
  abnormal: string;
  note: string;
  photos: Photo[];
  startedAt?: string;
  items?: CheckItem[];
  draft?: boolean;
};
type Defect = {
  id: string;
  source: "場勘" | "驗收";
  type: string;
  content: string;
  unit: string;
  due: string;
  status: "待改善" | "改善中" | "待複驗" | "已完成";
  before: Photo[];
  after: Photo[];
  fix: string;
  note?: string;
  completed: string;
};
type Acceptance = {
  id: string;
  date: string;
  person: string;
  area: number;
  result: "合格" | "部分合格" | "不合格";
  items: CheckItem[];
  photos: Photo[];
  note: string;
  signature?: { name: string; data: string; at: string; valid: boolean };
  completion?: {
    department: string;
    officePerson: string;
    floorLevel: string;
    abnormalUnit: string;
    damagedMaterialType: string;
    materialModel: string;
    floorAbnormal: boolean | null;
    boardDamaged: boolean | null;
    trashCleared: boolean | null;
    signatures: Partial<Record<"installer" | "office" | "siteManager" | "supervisor", { name: string; data: string; at: string; valid: boolean }>>;
  };
  recheck?: boolean;
  startedAt?: string;
  draft?: boolean;
};
type Unit = {
  id: string;
  building: string;
  floor: string;
  number: string;
  owner: string;
  phone: string;
  email: string;
  lineId: string;
  customerRole: string;
  contactPreference: string;
  customerNeed: string;
  marketingConsent: boolean;
  consentAt: string;
  customerSource: string;
  order: string;
  brand: string;
  model: string;
  colorNo: string;
  spec: string;
  estimated: number;
  custom: boolean;
  customNote: string;
  note: string;
  status: Status;
  surveys: Survey[];
  works: Work[];
  defects: Defect[];
  acceptances: Acceptance[];
  journals: DailyNote[];
  events: Event[];
  rate: number;
  pricedAt: string;
  _deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
};
type Product = {
  id: string;
  brand: string;
  model: string;
  colorNo: string;
  spec: string;
  note: string;
};
type DailyNote = {
  id: string;
  date: string;
  content: string;
  pending: string;
  note: string;
  photos: Photo[];
  createdAt: string;
  updatedAt?: string;
  createdBy?: string;
  draft?: boolean;
  _deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
};
type Project = {
  id: string;
  name: string;
  address: string;
  builder: string;
  contact: string;
  phone: string;
  note: string;
  expectedDate: string;
  unitNamingRule: string;
  productRule: string;
  specialRule: string;
  acceptanceRule: string;
  importRule: string;
  units: Unit[];
  products: Product[];
  journals: DailyNote[];
  floorAcceptances?: FloorAcceptanceRecord[];
  _deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
};
type LocalWorkspaceSnapshot = {
  savedAt: string;
  version: number;
  pending: boolean;
  projects: Project[];
  catalog: Product[];
};
const statuses: Status[] = [
  "待確認",
  "待場勘",
  "場勘待改善",
  "可進場",
  "施工中",
  "待驗收",
  "驗收缺失",
  "改善中",
  "待複驗",
  "已驗收",
  "已計價",
];
const unitProgressStatuses = ["待場勘", "可進場", "施工中", "改善中", "待驗收", "已驗收"] as const;
type UnitProgressStatus = (typeof unitProgressStatuses)[number];
const getUnitCurrentStatus = (unit: Pick<Unit, "status">): UnitProgressStatus => {
  switch (unit.status) {
    case "待確認":
    case "待場勘":
      return "待場勘";
    case "場勘待改善":
    case "驗收缺失":
    case "改善中":
      return "改善中";
    case "可進場":
      return "可進場";
    case "施工中":
      return "施工中";
    case "待驗收":
    case "待複驗":
      return "待驗收";
    case "已驗收":
    case "已計價":
      return "已驗收";
  }
};
type AppRole = "admin" | "shenyin" | "client" | "crew" | "sales";
type AuthSnapshot = AuthIdentity<AppRole>;
const AuthOwnerContext = createContext("");
const useAuthOwner = () => {
  const owner = useContext(AuthOwnerContext);
  if (!owner) throw new Error("AUTH_OWNER_REQUIRED");
  return owner;
};

function authDebug(detail: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  console.info("[SPC auth]", {
    timestamp: new Date().toISOString(),
    visibility: typeof document === "undefined" ? "server" : document.visibilityState,
    ...detail,
  });
}
const roleLabels: Record<AppRole, string> = {
  admin: "管理員",
  shenyin: "神銀窗口",
  client: "客戶端",
  crew: "工班人員",
  sales: "代銷",
};
const roleOptions: { value: AppRole; label: string }[] = [
  { value: "admin", label: "管理員" },
  { value: "shenyin", label: "神銀窗口" },
  { value: "client", label: "客戶端" },
  { value: "crew", label: "工班人員" },
  { value: "sales", label: "代銷" },
];
const applicationRoleOptions = roleOptions.filter((option) => option.value !== "admin");
const canUseSystem = (role: AppRole | null) => !!role,
  canManageProjectData = (role: AppRole) => role === "admin" || role === "shenyin",
  canUseView = (role: AppRole, view: string) => {
    if (canManageProjectData(role)) return true;
    if (role === "crew") return ["dashboard", "units"].includes(view);
    if (role === "client" || role === "sales") return view === "units";
    return false;
  },
  canUseUnitTab = (role: AppRole, tab: string) => {
    if (canManageProjectData(role)) return true;
    if (role === "crew") return ["master", "survey", "work", "accept", "journal", "defect", "sheet", "timeline"].includes(tab);
    if (role === "client" || role === "sales") return tab === "master";
    return false;
  };
const sideViews: [string, string, string][] = [
  ["dashboard", "⌂", "Dashboard"],
  ["units", "▦", "戶別管理"],
  ["daily-acceptance", "✓", "今日驗收"],
  ["journal", "▤", "今日日誌"],
  ["billing", "＄", "月結／計價"],
  ["project", "⚙", "專案資料"],
];
const surveyLabels = [
  "地坪平整度",
  "地面是否乾淨",
  "垃圾是否清除",
  "門框是否完成",
  "門扇是否已安裝",
  "廁所門框狀態",
  "是否無積水／潮濕",
  "現場是否無施工障礙",
  "其他異常",
];
const doorSurveyLabels = ["門框是否完成", "門扇是否已安裝", "廁所門框狀態"];
const acceptLabels = [
  "型號是否正確",
  "色號是否正確",
  "地板外觀",
  "是否無刮傷",
  "收邊狀況",
  "整體施工品質",
  "現場是否清潔",
  "其他缺失",
];
const key = "spc-workflow-v2",
  productKey = "spc-global-products-v1",
  workspaceDraftKey = "spc-workspace-durable-draft-v1",
  id = () =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  day = () => new Date().toISOString().slice(0, 10),
  stamp = () => new Date().toLocaleString("zh-TW");
const scopedKey = (base: string, owner: string) => scopedStorageKey(base, owner);
const draftKey = (owner: string, kind: string, unitId: string) =>
    scopedDraftKey(owner, kind, unitId),
  readLocal = (k: string) => {
    if (typeof window === "undefined") return "";
    try { return localStorage.getItem(k) || ""; }
    catch (error) { logStorageException("localStorage", "read", error); return ""; }
  },
  readDraft = <T,>(k: string, fallback: T): T => {
    try {
      const raw = readLocal(k);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && !isIndexedDbMarker(parsed) ? { ...fallback, ...parsed } : fallback;
    } catch (error) {
      logStorageException("localStorage", "read", error);
      return fallback;
    }
  },
  writeLocalDraft = (k: string, value: unknown, owner: string) => {
    if (typeof window === "undefined") return Promise.resolve();
    const suffix = k.replace(`spc-draft-${owner}-`, "");
    const kind = suffix.split("-")[0] || "form";
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const indexedDbWrite = saveOfflineDraft({ key: k, owner, kind, recordId: String(record.id || k), unitId: suffix.slice(kind.length + 1), payload: value, baseVersion: Number(record.baseVersion || 0), updatedBy: owner }).catch((error) => console.warn("SPC IndexedDB draft save failed", error));
    try {
      localStorage.setItem(k, localDraftValue(value));
    } catch (error) {
      logStorageException("localStorage", "write", error);
    }
    return indexedDbWrite;
  };
const removeDurableDraft = (draftStorageKey: string) => {
  if (typeof localStorage !== "undefined") {
    try { localStorage.removeItem(draftStorageKey); }
    catch (error) { logStorageException("localStorage", "delete", error); }
  }
  return removeOfflineDraft(draftStorageKey);
};
function useOfflineDraftRestore<T>(draftStorageKey: string, setValue: (value: T) => void, restoreAllowed?: { current: boolean }) {
  useEffect(() => {
    let active = true;
    void loadOfflineDraft<T>(draftStorageKey).then((draft) => {
      if (!active || !draft || restoreAllowed?.current === false) return;
      const local = readLocal(draftStorageKey);
      if (restoreAllowed?.current !== false && shouldRestoreIndexedDbDraft(local)) setValue(draft.payload);
    });
    return () => { active = false; };
  }, [draftStorageKey, setValue, restoreAllowed]);
}
function queueRecordChange(owner: string, kind: string, unitId: string, record: { id: string; [key: string]: unknown }, operation: "upsert" | "complete" | "delete" = "upsert") {
  void queueOfflineWrite({ owner, kind, recordId: record.id, unitId, operation, baseVersion: Number((record as any).baseVersion || 0), updatedBy: owner, payload: record }).catch(() => undefined);
}
const readWorkspaceDraft = (owner: string): LocalWorkspaceSnapshot | null => {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(scopedKey(workspaceDraftKey, owner));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as LocalWorkspaceSnapshot;
      return !isIndexedDbMarker(parsed) && Array.isArray(parsed.projects) && Array.isArray(parsed.catalog)
        ? parsed
        : null;
    } catch (error) {
      logStorageException("localStorage", "read", error);
      return null;
    }
  },
  writeWorkspaceDraft = (
    owner: string,
    projects: Project[],
    catalog: Product[],
    version: number,
    pending: boolean,
  ) => {
    if (typeof window === "undefined") return { local: true, indexedDb: Promise.resolve(true) };
    const snapshot: LocalWorkspaceSnapshot = {
      savedAt: new Date().toISOString(),
      version,
      pending,
      projects,
      catalog,
    };
    const indexedDb = saveOfflineDraft({ key: scopedKey(workspaceDraftKey, owner), owner, kind: "workspace", recordId: "workspace", unitId: "", payload: snapshot, baseVersion: version, updatedBy: owner })
      .then(() => {
        try {
          if (!local) localStorage.removeItem(scopedKey(workspaceDraftKey, owner));
          localStorage.removeItem(scopedKey(key, owner));
          localStorage.removeItem(scopedKey(productKey, owner));
        } catch (error) { logStorageException("localStorage", "delete", error); }
        return { ok: true as const, error: null };
      })
      .catch((error) => ({ ok: false as const, error: logStorageException("IndexedDB", "write", error) }));
    let local = false;
    let localError: StorageErrorDetails | null = null;
    try {
      localStorage.setItem(scopedKey(workspaceDraftKey, owner), localDraftValue({ id: "workspace", savedAt: snapshot.savedAt, version, pending }));
      local = true;
    } catch (error) {
      localError = logStorageException("localStorage", "write", error);
    }
    return { local, localError, indexedDb };
  };
const blankUnit = (): Unit => ({
  id: id(),
  building: "",
  floor: "",
  number: "",
  owner: "",
  phone: "",
  email: "",
  lineId: "",
  customerRole: "",
  contactPreference: "",
  customerNeed: "",
  marketingConsent: false,
  consentAt: "",
  customerSource: "",
  order: "",
  brand: "",
  model: "",
  colorNo: "",
  spec: "",
  estimated: 0,
  custom: false,
  customNote: "",
  note: "",
  status: "待確認",
  surveys: [],
  works: [],
  defects: [],
  acceptances: [],
  journals: [],
  floorAcceptances: [],
  events: [
    {
      id: id(),
      at: stamp(),
      title: "建立戶別資料",
      detail: "戶別主資料已建立",
      photos: [],
    },
  ],
  rate: 0,
  pricedAt: "",
});
const seed: Project = {
  id: id(),
  name: "晴川馥案 SPC 工程",
  address: "桃園市中壢區青埔路 168 號",
  builder: "晴川建設",
  contact: "陳主任",
  phone: "0912-345-678",
  note: "MVP 測試案場",
  expectedDate: "",
  unitNamingRule: "棟別、樓層、戶別分開填寫，不限制命名格式",
  productRule: "SPC 編號與色號由共用產品資料庫選擇",
  specialRule: "特殊戶保留原始說明並標記為待確認",
  acceptanceRule: "逐項檢查；不合格須填說明並上傳照片",
  importRule: "一列一戶；匯入前預覽並確認重複與特殊資料",
  products: [
    {
      id: id(),
      brand: "NATURE",
      model: "SPC-01",
      colorNo: "灰色",
      spec: "5mm＋1mm IXPE",
      note: "",
    },
  ],
  journals: [],
  units: [
    {
      ...blankUnit(),
      building: "A棟",
      floor: "3樓",
      number: "A3-1",
      owner: "王先生",
      brand: "NATURE",
      model: "SPC-01",
      colorNo: "灰色",
      spec: "5mm＋1mm IXPE",
      estimated: 20,
      status: "待場勘",
    },
  ],
};
function normalize(p: Project[]): Project[] {
  return p.map((x) => ({
    ...x,
    expectedDate: x.expectedDate || "",
    unitNamingRule: x.unitNamingRule || "",
    productRule: x.productRule || "",
    specialRule: x.specialRule || "",
    acceptanceRule: x.acceptanceRule || "",
    importRule: x.importRule || "",
    products: x.products || [],
    journals: x.journals || [],
    floorAcceptances: x.floorAcceptances,
    units: (x.units || []).map((u: any) => ({
      ...blankUnit(),
      ...u,
      estimated: Number(u.estimated || u.actual || 0),
      surveys: u.surveys || [],
      works: u.works || [],
      defects: u.defects || [],
      acceptances: u.acceptances || [],
      journals: u.journals || [],
      events:
        u.events ||
        u.logs?.map((l: any) => ({
          id: l.id,
          at: l.at,
          title: l.text,
          detail: l.note,
          photos: (l.photos || []).map((q: string) => ({ id: id(), data: q })),
        })) ||
        [],
      rate: Number(u.rate || 0),
    })),
  }));
}

const liveProjectViews = (projects: Project[]): Project[] => liveEntities(projects).map((project) => ({
  ...project,
  units: liveEntities(project.units),
}));

function exportFullExcel(projects: Project[], catalog: Product[]) {
  const book = XLSX.utils.book_new();
  const add = (name: string, rows: Record<string, unknown>[]) => {
    const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 說明: "目前沒有資料" }]);
    sheet["!cols"] = Object.keys(rows[0] || { 說明: "" }).map((key) => ({ wch: Math.min(36, Math.max(12, key.length * 2 + 4)) }));
    XLSX.utils.book_append_sheet(book, sheet, name.slice(0, 31));
  };
  add("專案", projects.map(({ units, products, journals, ...p }) => ({ ...p, 戶數: units.length, 日誌數: liveEntities(journals).length })));
  add("產品", catalog);
  add("戶別", projects.flatMap((p) => p.units.map(({ surveys, works, defects, acceptances, events, ...u }) => ({ 專案ID: p.id, 專案: p.name, ...u }))));
  add("場勘", projects.flatMap((p) => p.units.flatMap((u) => liveEntities(u.surveys).map(({ items, photos, risk, areaStatus, areaValue, areaUnit, doorInspection, siliconeInspection, dividerInspection, parking, stagingArea, surveySignatures, ...x }) => ({
    專案: p.name, 戶別: u.number, ...x,
    坪數狀態: areaStatus === "known" ? "已知" : "待補",
    坪數: areaStatus === "known" ? areaValue ?? "" : "",
    坪數單位: areaUnit || "坪",
    門檻實測公分: doorInspection?.thresholdCm ?? "",
    門檻至少1點5公分: doorInspection?.meetsThreshold ? "是" : "否",
    門檻有空隙: doorInspection?.hasGap === null || doorInspection?.hasGap === undefined ? "未檢查" : doorInspection.hasGap ? "是" : "否",
    門檢查結果: doorInspection?.result || "",
    門檢查判斷依據: doorInspection?.rationale || "",
    門檢查備註: doorInspection?.note || "",
    門檢查照片數: doorInspection?.photos?.length || 0,
    矽利康與地板同色: siliconeInspection?.matchesFloor === null || siliconeInspection?.matchesFloor === undefined ? "未檢查" : siliconeInspection.matchesFloor ? "是" : "否",
    矽利康其他顏色: siliconeInspection?.otherColor || "",
    矽利康備註: siliconeInspection?.note || "",
    矽利康照片數: siliconeInspection?.photos?.length || 0,
    是否需要分隔條: dividerInspection?.needed || "待確認",
    分隔條數量: dividerInspection?.quantity ?? "",
    分隔條位置: dividerInspection?.location || "",
    分隔條備註: dividerInspection?.note || "",
    分隔條照片數: dividerInspection?.photos?.length || 0,
    可停車數量: parking?.count || "未記錄",
    停車位置說明: parking?.location || "",
    停車備註: parking?.note || "",
    停車照片數: parking?.photos?.length || 0,
    放料區域位置: stagingArea?.location || "",
    放料區域備註: stagingArea?.note || "",
    放料注意事項: stagingArea?.cautions || "",
    放料區域照片數: stagingArea?.photos?.length || 0,
    場勘簽名人: (surveySignatures || []).map((signature) => signature.name).join("、"),
    場勘簽名時間: (surveySignatures || []).map((signature) => `${signature.name} ${signature.at}`).join("；"),
    檢查項目: JSON.stringify(items), 風險: JSON.stringify(risk || {}),
  })))));
  add("施工", projects.flatMap((p) => p.units.flatMap((u) => liveEntities(u.works).map(({ photos, ...x }) => ({ 專案: p.name, 戶別: u.number, ...x, 照片數: photos.length })))));
  add("驗收", projects.flatMap((p) => p.units.flatMap((u) => liveEntities(u.acceptances).map(({ items, photos, signature, ...x }) => ({ 專案: p.name, 戶別: u.number, ...x, 檢查項目: JSON.stringify(items), 簽名人: signature?.name || "" })))));
  add("缺失", projects.flatMap((p) => p.units.flatMap((u) => liveEntities(u.defects).map(({ before, after, ...x }) => ({ 專案: p.name, 戶別: u.number, ...x, 改善前照片: before.length, 改善後照片: after.length })) )));
  add("今日日誌", projects.flatMap((p) => liveEntities(p.journals).map(({ photos, ...x }) => ({ 專案: p.name, ...x, 照片數: photos.length }))));
  add("事件", projects.flatMap((p) => p.units.flatMap((u) => liveEntities(u.events).map(({ photos, ...x }) => ({ 專案: p.name, 戶別: u.number, ...x, 照片數: photos.length })) )));
  XLSX.writeFile(book, `SPC完整資料-${day()}.xlsx`, { compression: true });
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [authSnapshot, setAuthSnapshot] = useState<AuthSnapshot | null>(null);
  const [authError, setAuthError] = useState("");
  const [guestMode, setGuestMode] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const authGuardRef = useRef(new AuthResolveGuard());
  const authSnapshotRef = useRef<AuthSnapshot | null>(null);

  useEffect(() => { authSnapshotRef.current = authSnapshot; }, [authSnapshot]);

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    const resolveAccess = async (event: string, session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]) => {
      const generation = authGuardRef.current.begin();
      authDebug({ event, generation, sessionUserId: session?.user.id || null, validatedUserId: null, workspaceOwner: authSnapshotRef.current?.userId || null });
      if (!session) {
        if (!active || !authGuardRef.current.isCurrent(generation)) return;
        localStorage.removeItem("spc-current-user-id");
        authSnapshotRef.current = null;
        setAuthSnapshot(null);
        setMustChangePassword(false);
        setAuthError("");
        setAuthReady(true);
        return;
      }

      const previousIdentity = authSnapshotRef.current;
      if (previousIdentity && previousIdentity.userId !== session.user.id) {
        authSnapshotRef.current = null;
        setAuthSnapshot(null);
        setAuthReady(false);
        authDebug({ event: "AUTH_USER_CHANGE_TEARDOWN", generation, sessionUserId: session.user.id, validatedUserId: null, workspaceOwner: null });
      }

      const result = await resolveAuthIdentity<AppRole>({
        generation,
        guard: authGuardRef.current,
        sessionUser: session.user,
        previous: previousIdentity?.userId === session.user.id ? previousIdentity : null,
        validateUser: async () => {
          const { data, error } = await supabase.auth.getUser();
          if (error || !data.user) throw error || new Error("AUTH_VALIDATION_EMPTY");
          return data.user;
        },
        loadRole: async () => {
          const { data, error } = await supabase.rpc("spc_current_role");
          if (error) throw error;
          return ["admin", "shenyin", "client", "crew", "sales"].includes(String(data)) ? data as AppRole : "client";
        },
        currentSessionUserId: async () => {
          const { data, error } = await supabase.auth.getSession();
          if (error) throw error;
          return data.session?.user.id || null;
        },
        accountLabel: (user) => user.email?.endsWith("@phone.spc.internal")
          ? String(user.user_metadata?.local_phone || "").replace(/^\+?8869/, "09")
          : user.email || (user.phone?.replace(/^\+?8869/, "09")) || "",
      });
      if (!active || result.kind === "stale") return;
      if (result.kind === "authenticated") {
        authSnapshotRef.current = result.identity;
        localStorage.setItem("spc-current-user-id", result.identity.userId);
        setAuthSnapshot(result.identity);
        setMustChangePassword(Boolean(session.user.user_metadata?.must_change_password));
        setAuthError("");
        setAuthReady(true);
        authDebug({ event, generation, sessionUserId: session.user.id, validatedUserId: result.identity.userId, email: result.identity.email, role: result.identity.role, workspaceOwner: result.identity.userId });
        return;
      }
      if (result.kind === "temporary-error") {
        setAuthError("登入驗證暫時無法完成，系統會自動重試；目前不會將您登出。");
        if (result.identity) setAuthReady(true);
        authDebug({ event: `${event}:temporary-error`, generation, sessionUserId: session.user.id, validatedUserId: result.identity?.userId || null, email: result.identity?.email || null, role: result.identity?.role || null, workspaceOwner: result.identity?.userId || null });
        retryTimer = window.setTimeout(() => void supabase.auth.getSession().then(({ data }) => resolveAccess("VALIDATION_RETRY", data.session)), 1500);
      }
    };
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryMode(true);
        setAuthReady(true);
        return;
      }
      window.setTimeout(() => void resolveAccess(event, session), 0);
    });
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setAuthError("登入狀態暫時無法讀取，系統會等待瀏覽器恢復。");
        return;
      }
      void resolveAccess("INITIAL_SESSION", data.session);
    });
    return () => {
      active = false;
      authGuardRef.current.begin();
      if (retryTimer) window.clearTimeout(retryTimer);
      listener.subscription.unsubscribe();
    };
  }, []);

  if (!authReady) return <AuthLoading message={authError} />;
  if (recoveryMode || mustChangePassword) return <PasswordRecoveryScreen forced={mustChangePassword} onDone={() => { setRecoveryMode(false); setMustChangePassword(false); }} />;
  if (guestMode) return <GuestPreview onExit={() => setGuestMode(false)} />;
  if (!authSnapshot) return <LoginScreen initialError={authError} onGuest={() => setGuestMode(true)} />;
  if (!canUseSystem(authSnapshot.role)) return <VisitorScreen email={authSnapshot.email} error={authError} />;
  return <AuthOwnerContext.Provider value={authSnapshot.userId}><AdminApp key={authSnapshot.userId} authUserId={authSnapshot.userId} email={authSnapshot.email} role={roleLabels[authSnapshot.role]} appRole={authSnapshot.role} /></AuthOwnerContext.Provider>;
}

function AuthLoading({ message = "" }: { message?: string }) {
  return <main className="login-screen"><section className="login-card"><CompanyLogo className="login-mark" /><h1>正在確認登入狀態…</h1><p>{message || "請稍候，系統正在安全地確認您的帳號權限。"}</p></section></main>;
}

function CompanyLogo({ className = "" }: { className?: string }) {
  return <img className={`company-logo ${className}`.trim()} src="/shen-yin-logo.png" alt="神銀建材 Share-Information" />;
}

function PasswordRecoveryScreen({ onDone, forced = false }: { onDone: () => void; forced?: boolean }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const updatePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 8) { setError("密碼至少需要 8 個字元。"); return; }
    if (password !== confirmPassword) { setError("兩次輸入的密碼不一致。"); return; }
    setSubmitting(true); setError("");
    const { error: updateError } = await supabase.auth.updateUser({ password, data: { must_change_password: false } });
    if (updateError) { setError("無法更新密碼，連結可能已失效，請重新寄送密碼信。"); setSubmitting(false); return; }
    await supabase.auth.signOut();
    window.history.replaceState({}, "", window.location.pathname);
    onDone();
  };
  return (
    <main className="login-screen"><section className="login-card">
      <CompanyLogo className="login-mark" /><p className="eyebrow">帳號安全</p><h1>{forced ? "首次登入，請更換密碼" : "設定新密碼"}</h1><p>請輸入至少 8 個字元的新密碼，完成後再重新登入。</p>
      <form className="login-form" onSubmit={updatePassword}>
        <label><span>新密碼</span><input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label><span>再次輸入新密碼</span><input type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        {error && <div className="login-error" role="alert">{error}</div>}
        <button className="primary" disabled={submitting}>{submitting ? "更新中…" : "更新密碼"}</button>
      </form>
    </section></main>
  );
}

function AccountApplicationScreen({ onBack }: { onBack: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [identity, setIdentity] = useState("");
  const [role, setRole] = useState<AppRole>("client");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const apply = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (password.length < 8) { setError("密碼至少需要 8 個字元。"); return; }
    if (password !== confirmPassword) { setError("兩次輸入的密碼不一致。"); return; }
    setSubmitting(true);
    try {
      const response = await fetch("/api/account-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, identity, role, password, confirmPassword, website }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        const labels: Record<string, string> = {
          INVALID_IDENTITY: "請輸入正確的電子郵件或 09 開頭手機號碼。",
          INVALID_NAME: "請填寫姓名。",
          INVALID_ROLE: "請選擇有效的申請身份。",
          INVALID_PASSWORD: "密碼需要 8 至 72 個字元。",
          PASSWORD_MISMATCH: "兩次輸入的密碼不一致。",
          ACCOUNT_EXISTS: "這個電子郵件或手機號碼已經申請過，請直接登入或聯絡管理員。",
          TOO_MANY_REQUESTS: "申請送出太快，請稍候 15 秒再試。",
          SERVER_AUTH_NOT_CONFIGURED: "帳號申請服務暫時無法使用，請聯絡管理員。",
        };
        throw new Error(labels[result.error || ""] || "無法送出申請，請稍後再試。");
      }
      setSuccess(true);
    } catch (err) { setError(err instanceof Error ? err.message : "無法送出申請"); }
    finally { setSubmitting(false); }
  };

  if (success) return (
    <main className="login-screen"><section className="login-card application-card">
      <CompanyLogo className="login-mark" /><p className="eyebrow">申請已送出</p><h1>等待管理員核准</h1>
      <p>管理員核准後，即可使用你剛設定的帳號與密碼登入。</p>
      <button className="primary wide" type="button" onClick={onBack}>返回登入</button>
    </section></main>
  );

  return (
    <main className="login-screen"><section className="login-card application-card">
      <CompanyLogo className="login-mark" /><p className="eyebrow">內部帳號申請</p><h1>申請使用帳號</h1>
      <p>填寫後交由管理員核准；申請期間不會取得任何案場資料。</p>
      <form className="login-form" onSubmit={apply}>
        <label><span>姓名</span><input required maxLength={80} autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="請輸入姓名" /></label>
        <label><span>電子郵件或手機號碼</span><input required autoComplete="username" value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="name@company.com 或 0912345678" /></label>
        <label><span>申請身份</span><select required value={role} onChange={(event) => setRole(event.target.value as AppRole)}>{applicationRoleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>設定密碼</span><input type="password" required minLength={8} maxLength={72} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 個字元" /></label>
        <label><span>再次輸入密碼</span><input type="password" required minLength={8} maxLength={72} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        <label className="application-honeypot" aria-hidden="true"><span>網站</span><input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} /></label>
        {error && <div className="login-error" role="alert">{error}</div>}
        <button className="primary" disabled={submitting}>{submitting ? "送出中…" : "送出帳號申請"}</button>
        <button className="ghost" type="button" onClick={onBack}>返回登入</button>
      </form>
    </section></main>
  );
}

function LoginScreen({ initialError = "", onGuest }: { initialError?: string; onGuest: () => void }) {
  const [applying, setApplying] = useState(false);
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError);
  const [submitting, setSubmitting] = useState(false);
  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const value = identity.trim();
    const digits = value.replace(/[\s-]/g, "");
    const phone = /^09\d{8}$/.test(digits) ? `886${digits.slice(1)}` : digits.replace(/^\+886/, "886");
    const credentials = value.includes("@")
      ? { email: value.toLowerCase(), password }
      : { email: `p${phone}@phone.spc.internal`, password };
    const { error: signInError } = await supabase.auth.signInWithPassword(credentials);
    if (signInError) setError("登入失敗，請確認電子郵件／手機號碼與密碼是否正確。");
    setSubmitting(false);
  };
  if (applying) return <AccountApplicationScreen onBack={() => setApplying(false)} />;
  return (
    <main className="login-screen">
      <section className="login-card">
        <CompanyLogo className="login-mark" />
        <p className="eyebrow">連工帶料工程管理</p>
        <h1>登入工程管理系統</h1>
        <p>案場資料僅限授權的系統管理員存取。</p>
        <form className="login-form" onSubmit={signIn}>
          <label><span>電子郵件或手機號碼</span><input type="text" inputMode="email" autoComplete="username" required value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="name@company.com 或 0912345678" /></label>
          <label><span>密碼</span><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="請輸入密碼" /></label>
          {error && <div className="login-error" role="alert">{error}</div>}
          <button className="primary" disabled={submitting}>{submitting ? "登入中…" : "登入"}</button>
          <button className="ghost account-apply-button" type="button" onClick={() => setApplying(true)}>申請帳號</button>
          <div className="guest-divider"><span>或</span></div>
          <button className="ghost guest-login" type="button" onClick={onGuest}>以訪客身分瀏覽</button>
        </form>
        <small className="login-help">訪客不需要帳號，可查看系統功能，但無法接觸任何案場資料。</small>
      </section>
    </main>
  );
}

const guestFeatures = [
  ["Dashboard", "查看工程管理首頁與進度摘要的介面"],
  ["戶別管理", "了解戶別、產品及施工狀態的管理方式"],
  ["場勘與驗收", "查看檢查流程、缺失追蹤及簽名功能說明"],
  ["今日日誌", "了解每日施工紀錄與照片管理功能"],
  ["月結／計價", "查看月結、計價與報表功能說明"],
  ["專案資料", "了解專案規則與產品資料庫的設定項目"],
];

function GuestPreview({ onExit }: { onExit: () => void }) {
  return (
    <main className="guest-preview">
      <header className="guest-header">
        <div className="brand"><CompanyLogo /><div><b>工程管理系統</b><small>VISITOR PREVIEW</small></div></div>
        <div className="guest-header-actions"><span>訪客瀏覽模式</span><button className="ghost" onClick={onExit}>返回登入</button></div>
      </header>
      <section className="guest-content">
        <div className="guest-hero">
          <p className="eyebrow">系統功能預覽</p>
          <h1>歡迎瀏覽 SPC 工程管理系統</h1>
          <p>您可以了解系統提供的功能；為保護客戶隱私，目前不會載入任何案場、住戶、照片或工程紀錄。</p>
          <div className="guest-lock">🔒 訪客模式已啟用資料隔離</div>
        </div>
        <div className="guest-feature-grid">
          {guestFeatures.map(([title, description], index) => (
            <article className="guest-feature" key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h2>{title}</h2>
              <p>{description}</p>
              <small>僅提供功能介紹，不顯示實際資料</small>
            </article>
          ))}
        </div>
        <section className="guest-empty-state">
          <div>▦</div><h2>案場資料已隱藏</h2><p>訪客無法查看、搜尋、新增、修改、刪除或匯出任何案場資料。</p>
        </section>
      </section>
    </main>
  );
}

function VisitorScreen({ email, error }: { email: string; error?: string }) {
  return (
    <main className="login-screen">
      <section className="login-card visitor-card">
        <CompanyLogo className="login-mark" />
        <p className="eyebrow">訪客帳號</p>
        <h1>您目前沒有案場存取權限</h1>
        <p>為保護案場、住戶、照片與工程紀錄，訪客帳號無法查看或修改任何工程資料。</p>
        <div className="visitor-account">目前登入：<b>{email}</b></div>
        {error && <div className="login-error" role="alert">{error}</div>}
        <button className="ghost" onClick={() => void supabase.auth.signOut()}>登出</button>
        <small className="login-help">如需系統管理員權限，請聯絡帳號管理人員。</small>
      </section>
    </main>
  );
}

function SessionChip({ email, role }: { email: string; role: string }) {
  const signOut = async () => {
    localStorage.removeItem("spc-current-user-id");
    await supabase.auth.signOut();
  };
  return <div className="session-chip"><span><b>{role}</b><small>{email}</small></span><button onClick={() => void signOut()}>登出</button></div>;
}

function AdminApp({ authUserId, email, role, appRole }: { authUserId: string; email: string; role: string; appRole: AppRole }) {
  const mountIdRef = useRef(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const canManageProjects = canManageProjectData(appRole);
  const canManageAccounts = appRole === "admin";
  const versionRef = useRef(0);
  const savingRef = useRef(false);
  const retrySyncRef = useRef(false);
  const baselineRef = useRef<{ projects: Project[]; catalog: Product[] }>({ projects: [], catalog: [] });
  const latestRef = useRef<{ projects: Project[]; catalog: Product[] }>({ projects: [], catalog: [] });
  const remoteConflictRef = useRef<{ projects: Project[]; catalog: Product[] } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]),
    [catalog, setCatalog] = useState<Product[]>([]),
    [pid, setPid] = useState(""),
    [uid, setUid] = useState(""),
    [floorContext, setFloorContext] = useState<FloorReturnContext | null>(null),
    [view, setView] = useState("dashboard"),
    [ready, setReady] = useState(false),
    [menuOpen, setMenuOpen] = useState(false),
    [mode, setMode] = useState<"entry" | "app" | "new">("entry"),
    [storageWarning, setStorageWarning] = useState(""),
    [syncTick, setSyncTick] = useState(0),
    [activity, setActivity] = useState<EntityActivity[]>([]),
    [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null),
    [offlineState, setOfflineState] = useState({ pending: 0, failed: 0, conflicts: 0, photos: 0 }),
    [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine),
    [showQuickStart, setShowQuickStart] = useState(false),
    [conflictPaths, setConflictPaths] = useState<string[]>([]);
  useEffect(() => {
    for (const legacyKey of ["spc-last-survey-person", "spc-last-crew", "spc-last-acceptance-person", "spc-dashboard-unit-filter"]) {
      const storage = legacyKey === "spc-dashboard-unit-filter" ? sessionStorage : localStorage;
      try { migrateLegacyStorageValue(storage, legacyKey, authUserId); }
      catch (error) { logStorageException("localStorage", "write", error); }
    }
    setShowQuickStart(readLocal(scopedKey("spc-quick-start-seen", authUserId)) !== "1");
    authDebug({ event: "WORKSPACE_MOUNT", generation: null, sessionUserId: authUserId, validatedUserId: authUserId, email, role: appRole, workspaceOwner: authUserId, mountId: mountIdRef.current });
    return () => authDebug({ event: "WORKSPACE_UNMOUNT", generation: null, sessionUserId: authUserId, validatedUserId: authUserId, email, role: appRole, workspaceOwner: authUserId, mountId: mountIdRef.current });
  }, [authUserId, email, appRole]);
  useEffect(() => {
    let active = true;
    const refresh = () => { setOnline(navigator.onLine); void offlineSummary(authUserId).then((summary) => active && setOfflineState(summary)); };
    refresh();
    window.addEventListener("spc-offline-change", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => { active = false; window.removeEventListener("spc-offline-change", refresh); window.removeEventListener("online", refresh); window.removeEventListener("offline", refresh); };
  }, [authUserId]);
  useEffect(() => { latestRef.current = { projects, catalog }; }, [projects, catalog]);
  useEffect(() => {
    if (view === "survey") {
      setUid("");
      setView("units");
      return;
    }
    if (!canUseView(appRole, view)) {
      setUid("");
      setView(appRole === "client" || appRole === "sales" ? "units" : "dashboard");
    }
  }, [appRole, view]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      setReady(false);
      setStorageWarning("正在從 Supabase 載入…");
      try {
        const indexedWorkspace = await loadOfflineDraft<LocalWorkspaceSnapshot>(scopedKey(workspaceDraftKey, authUserId));
        const durableDraft = readWorkspaceDraft(authUserId) || indexedWorkspace?.payload || null;
        const snapshot = await loadWorkspace();
        const legacy = snapshot.projects.length ? null : await loadLegacyWorkspace();
        if (!active) return;
        const localProjects = normalize(JSON.parse(readLocal(scopedKey(key, authUserId)) || "[]"));
        const localCatalog = JSON.parse(readLocal(scopedKey(productKey, authUserId)) || "[]") as Product[];
        const useDurableDraft = durableDraft?.pending || (!snapshot.projects.length && durableDraft?.projects.length);
        const loadedProjects = normalize(
          (useDurableDraft
            ? durableDraft.projects
            : snapshot.projects.length
              ? snapshot.projects
              : legacy?.projects || durableDraft?.projects || localProjects) as Project[],
        );
        const loadedCatalog = (useDurableDraft
          ? durableDraft.catalog
          : snapshot.catalog.length
            ? snapshot.catalog
            : legacy?.catalog || durableDraft?.catalog || localCatalog) as Product[];
        versionRef.current = snapshot.version;
        setActivity(snapshot.activity || []);
        setProjects(loadedProjects);
        setCatalog(loadedCatalog);
        setPid(liveProjectViews(loadedProjects)[0]?.id || "");
        if (!snapshot.projects.length && loadedProjects.length && !durableDraft?.pending) {
          versionRef.current = await saveWorkspace(snapshot.version, loadedProjects, loadedCatalog, snapshot.projects, snapshot.catalog);
        }
        baselineRef.current = useDurableDraft
          ? { projects: [], catalog: [] }
          : { projects: structuredClone(loadedProjects), catalog: structuredClone(loadedCatalog) };
        setReady(true);
        writeWorkspaceDraft(authUserId, loadedProjects, loadedCatalog, versionRef.current, !!useDurableDraft);
        setStorageWarning(useDurableDraft ? "尚未同步：已恢復本機暫存" : "已儲存：已與 Supabase 同步");
      } catch (error) {
        const indexedWorkspace = await loadOfflineDraft<LocalWorkspaceSnapshot>(scopedKey(workspaceDraftKey, authUserId));
        const durableDraft = readWorkspaceDraft(authUserId) || indexedWorkspace?.payload || null;
        const localProjects = normalize(JSON.parse(readLocal(scopedKey(key, authUserId)) || "[]"));
        const localCatalog = JSON.parse(readLocal(scopedKey(productKey, authUserId)) || "[]") as Product[];
        const recoveredProjects = normalize((durableDraft?.projects?.length ? durableDraft.projects : localProjects) as Project[]);
        const recoveredCatalog = (durableDraft?.catalog?.length ? durableDraft.catalog : localCatalog) as Product[];
        if (active && recoveredProjects.length) {
          setProjects(recoveredProjects);
          setCatalog(recoveredCatalog);
          setPid(liveProjectViews(recoveredProjects)[0]?.id || "");
          baselineRef.current = { projects: [], catalog: [] };
          setReady(true);
          writeWorkspaceDraft(authUserId, recoveredProjects, recoveredCatalog, versionRef.current, true);
          setStorageWarning("尚未同步：網路或資料庫暫時連不上，已載入本機暫存");
        } else {
          setStorageWarning(`資料初始化失敗：${error instanceof Error ? error.message : "請執行新版 migration"}`);
        }
      }
    };
    void load();
    return () => { active = false; };
  }, [authUserId]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let timer: number | undefined;
    const pendingDraft = !!readWorkspaceDraft(authUserId)?.pending;
    const current = { projects, catalog },
      baseline = baselineRef.current,
      changed = JSON.stringify(current) !== JSON.stringify(baseline);
    const storage = writeWorkspaceDraft(authUserId, projects, catalog, versionRef.current, changed || pendingDraft);
    void storage.indexedDb.then((indexedDb) => {
      if (!active) return;
      const errors = [storage.localError, indexedDb.error].filter((error): error is StorageErrorDetails => !!error);
      const durable = durableStorageState(indexedDb.ok, storage.local, errors);
      if (!changed && !pendingDraft) {
        setStorageWarning(durable.saved ? (durable.fallbackOnly ? durable.message : "已儲存") : durable.message);
        if (!durable.saved) void storageDiagnostics(authUserId).then((diagnostics) => console.warn("SPC storage diagnostics", diagnostics));
        return;
      }
      setStorageWarning(durable.saved
        ? (navigator.onLine ? `儲存中：${durable.message}，正在同步…` : `尚未同步：${durable.message}，網路離線`)
        : (navigator.onLine ? `${durable.message}；正在直接同步雲端…` : `${durable.message}；目前離線，請勿關閉此頁`));
      if (!durable.saved) void storageDiagnostics(authUserId).then((diagnostics) => console.warn("SPC storage diagnostics", diagnostics));
      if (!shouldAttemptCloudSave(changed, pendingDraft, navigator.onLine)) return;
      timer = window.setTimeout(async () => {
      if (savingRef.current) {
        retrySyncRef.current = true;
        return;
      }
      savingRef.current = true;
      retrySyncRef.current = false;
      const saveInput = JSON.stringify({ projects, catalog });
      try {
        const uploaded = await uploadEmbeddedPhotos(projects);
        const nextVersion = await saveWorkspace(
          versionRef.current,
          uploaded,
          catalog,
          baselineRef.current.projects,
          baselineRef.current.catalog,
        );
        versionRef.current = nextVersion;
        baselineRef.current = { projects: structuredClone(uploaded), catalog: structuredClone(catalog) };
        try {
          const committed = await loadWorkspace();
          setActivity(committed.activity || []);
          if (JSON.stringify(latestRef.current) === saveInput) {
            const shared = { projects: normalize(committed.projects as Project[]), catalog: committed.catalog as Product[] };
            versionRef.current = committed.version;
            baselineRef.current = structuredClone(shared);
            setProjects(shared.projects);
            setCatalog(shared.catalog);
          }
        } catch { /* the save succeeded */ }
        const stillCurrent = JSON.stringify(latestRef.current) === saveInput;
        if (stillCurrent && JSON.stringify(uploaded) !== JSON.stringify(projects)) setProjects(uploaded);
        if (stillCurrent) {
          const committedCache = writeWorkspaceDraft(authUserId, uploaded, catalog, nextVersion, false);
          const indexedCache = await committedCache.indexedDb;
          const cacheErrors = [committedCache.localError, indexedCache.error].filter((error): error is StorageErrorDetails => !!error);
          const cacheState = durableStorageState(indexedCache.ok, committedCache.local, cacheErrors);
          try { await completeSyncedOutbox(authUserId); } catch (error) { logStorageException("IndexedDB", "delete", error); }
          setStorageWarning(cacheState.saved
            ? `已儲存：已與 Supabase 同步 · 版本 ${nextVersion}`
            : "雲端已同步，但本機離線暫存不可用");
        } else {
          writeWorkspaceDraft(authUserId, latestRef.current.projects, latestRef.current.catalog, nextVersion, true);
          retrySyncRef.current = true;
          setStorageWarning("儲存中：上一筆已同步，正在接續同步最新修改…");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("SPC_VERSION_CONFLICT") || message.includes("40001")) {
          const latest = await loadWorkspace();
          const remote = { projects: normalize(latest.projects as Project[]), catalog: latest.catalog as Product[] };
          const merged = threeWayMerge(baselineRef.current, { projects, catalog }, remote);
          remoteConflictRef.current = remote;
          versionRef.current = latest.version;
          baselineRef.current = structuredClone(remote);
          setProjects(merged.value.projects);
          setCatalog(merged.value.catalog);
          setConflictPaths(merged.conflicts);
          setStorageWarning(merged.conflicts.length
            ? `已合併其他電腦的更新；${merged.conflicts.length} 個同欄位衝突保留這台電腦的內容，正在重新同步…`
            : "已自動合併其他電腦的更新，正在重新同步…");
        } else {
          const fallback = writeWorkspaceDraft(authUserId, projects, catalog, versionRef.current, true);
          const indexedFallback = await fallback.indexedDb;
          const fallbackErrors = [fallback.localError, indexedFallback.error].filter((storageError): storageError is StorageErrorDetails => !!storageError);
          const durable = durableStorageState(indexedFallback.ok, fallback.local, fallbackErrors);
          setStorageWarning(durable.saved ? `尚未同步：${durable.message}，${message}` : durable.message);
          if (!durable.saved) void storageDiagnostics(authUserId).then((diagnostics) => console.warn("SPC storage diagnostics", diagnostics));
          void reportClientError(message, "supabase-sync", { version: versionRef.current });
        }
      } finally {
        savingRef.current = false;
        if (retrySyncRef.current) {
          retrySyncRef.current = false;
          window.setTimeout(() => setSyncTick((value) => value + 1), 0);
        }
      }
      }, 600);
    });
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [projects, catalog, ready, syncTick]);
  useEffect(() => {
    if (!ready) return;
    const refreshSharedData = async () => {
      if (savingRef.current || JSON.stringify(latestRef.current) !== JSON.stringify(baselineRef.current)) return;
      try {
        const snapshot = await loadWorkspace();
        setActivity(snapshot.activity || []);
        if (snapshot.version <= versionRef.current) return;
        const shared = { projects: normalize(snapshot.projects as Project[]), catalog: snapshot.catalog as Product[] };
        versionRef.current = snapshot.version;
        baselineRef.current = structuredClone(shared);
        setProjects(shared.projects);
        setCatalog(shared.catalog);
        setStorageWarning(`已收到其他使用者的更新 · 版本 ${snapshot.version}`);
      } catch { /* keep the current screen and retry later */ }
    };
    const timer = window.setInterval(() => void refreshSharedData(), 8000);
    return () => window.clearInterval(timer);
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const retry = () => setSyncTick((x) => x + 1);
    window.addEventListener("online", retry);
    const timer = window.setInterval(() => {
      if (!navigator.onLine) return;
      void loadOfflineDraft<LocalWorkspaceSnapshot>(scopedKey(workspaceDraftKey, authUserId))
        .then((draft) => { if (draft?.payload.pending) retry(); });
    }, 15000);
    return () => {
      window.removeEventListener("online", retry);
      window.clearInterval(timer);
    };
  }, [ready]);
  useEffect(() => {
    if (!canManageProjects) return;
    if (!ready) return;
    const refresh = async () => {
      try { setSystemHealth(await getSystemHealth()); }
      catch (error) { void reportClientError(error instanceof Error ? error.message : String(error), "health-check"); }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5 * 60 * 1000);
    const onError = (event: ErrorEvent) => void reportClientError(event.message, "window.error", { filename: event.filename, line: event.lineno, column: event.colno });
    const onReject = (event: PromiseRejectionEvent) => void reportClientError(event.reason instanceof Error ? event.reason.message : String(event.reason), "unhandledrejection");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onReject);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onReject);
    };
  }, [ready, canManageProjects]);
  useEffect(() => {
    if (
      ready &&
      liveEntities(projects).some(
        (p) =>
          p.products.length !== catalog.length ||
          p.products.some((x, i) => x.id !== catalog[i]?.id),
      )
    )
      setProjects((ps) => ps.map((p) => isDeletedEntity(p) ? p : { ...p, products: catalog }));
  }, [projects.length, catalog, ready]);
  const liveProjects = liveProjectViews(projects),
    project = liveProjects.find((p) => p.id === pid),
    unit = project?.units.find((u) => u.id === uid);
  useEffect(() => {
    if (!pid || liveProjects.some((candidate) => candidate.id === pid)) return;
    setPid(liveProjects[0]?.id || "");
    setUid("");
    setFloorContext(null);
    setView("dashboard");
  }, [pid, projects]);
  const setProjectsDurably = (update: (current: Project[]) => Project[]) =>
    setProjects((current) => {
      const next = update(current);
      latestRef.current = { projects: next, catalog: latestRef.current.catalog };
      writeWorkspaceDraft(authUserId, next, latestRef.current.catalog, versionRef.current, true);
      return next;
    });
  const updateCatalog = (products: Product[]) => {
    setCatalog(products);
    latestRef.current.catalog = products;
    setProjectsDurably((ps) => ps.map((p) => isDeletedEntity(p) ? p : { ...p, products }));
  };
  const patchProject = (x: Partial<Project>) => {
    if (x.products) {
      const products = x.products;
      setCatalog(products);
      latestRef.current.catalog = products;
      setProjectsDurably((ps) =>
        ps.map((p) =>
          isDeletedEntity(p) ? p : p.id === pid ? { ...p, ...x, products } : { ...p, products },
        ),
      );
      return;
    }
    setProjectsDurably((ps) => ps.map((p) => {
      if (p.id !== pid || isDeletedEntity(p)) return p;
      return { ...p, ...x, ...(x.units ? { units: retainEntityTombstones(p.units, x.units) } : {}) };
    }));
  };
  const patchUnit = (x: Partial<Unit>) =>
    setProjectsDurably((ps) =>
      ps.map((p) =>
        p.id !== pid || isDeletedEntity(p)
          ? p
          : {
              ...p,
              units: p.units.map((u) => (u.id !== uid || isDeletedEntity(u) ? u : { ...u, ...x })),
            },
      ),
    );
  const patchUnitById = (unitId: string, updater: (current: Unit) => Unit) =>
    setProjectsDurably((ps) =>
      ps.map((p) => p.id !== pid || isDeletedEntity(p) ? p : {
        ...p,
        units: p.units.map((current) => current.id === unitId && !isDeletedEntity(current) ? updater(current) : current),
      }),
    );
  const removeUnit = (target: string) =>
    setProjectsDurably((ps) => ps.map((p) => {
      if (p.id !== pid || isDeletedEntity(p)) return p;
      const unit = p.units.find((candidate) => candidate.id === target && !isDeletedEntity(candidate));
      if (!unit) return p;
      const deleted = tombstoneEntity(unit, authUserId, stamp());
      return { ...p, units: p.units.map((candidate) => candidate.id === target ? deleted : candidate) };
    }));
  const removeProject = () => {
    setProjectsDurably((ps) => ps.map((p) => {
      if (p.id !== pid || isDeletedEntity(p)) return p;
      return tombstoneEntity(p, authUserId, stamp());
    }));
    setPid("");
    setUid("");
    setView("dashboard");
  };
  const addEvent = (title: string, detail: string, photos: Photo[] = []) =>
    unit &&
    patchUnit({
      events: [
        { id: id(), at: stamp(), title, detail, photos },
        ...unit.events,
      ],
    });
  const exportBackup = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), version: versionRef.current, projects, catalog }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `SPC-backup-${day()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    revokeObjectUrlLater(a.href);
  };
  const importBackup = async (file: File) => {
    try {
      const backup = JSON.parse(await file.text()) as { projects?: Project[]; catalog?: Product[] };
      if (!Array.isArray(backup.projects) || !Array.isArray(backup.catalog)) throw new Error("備份格式不正確");
      if (!confirm(`即將以備份中的 ${backup.projects.length} 個專案取代目前資料，是否繼續？`)) return;
      setProjects(normalize(backup.projects));
      setCatalog(backup.catalog);
      setPid(liveProjectViews(normalize(backup.projects))[0]?.id || "");
      setStorageWarning("備份已載入，正在同步…");
    } catch (error) { alert(error instanceof Error ? error.message : "無法讀取備份"); }
  };
  if (!ready)
    return <main className="auth-screen"><section className="panel"><h1>{storageWarning || "正在載入工程資料…"}</h1></section></main>;
  if (mode === "entry")
    return (
      <SystemEntry
        count={liveProjects.length}
        warning={storageWarning}
        create={() => setMode("new")}
        enter={() => setMode("app")}
        manageAccounts={canManageAccounts ? () => { setView("accounts"); setMode("app"); } : undefined}
      />
    );
  if (mode === "new")
    return (
      <ProjectOnboarding
        catalog={catalog}
        cancel={() => setMode("entry")}
        complete={(project, products) => {
          setCatalog(products);
          setProjects([...projects, project]);
          setPid(project.id);
          setUid("");
          setView("dashboard");
          setMode("app");
        }}
      />
    );
  return (
    <main>
      <header>
        <div className="brand">
          <button
            className="menu-toggle"
            aria-label="開啟功能選單"
            onClick={() => setMenuOpen(true)}
          >
            ☰
          </button>
          <button
            type="button"
            className="brand-home-button"
            onClick={() => {
              setUid("");
              setFloorContext(null);
              setView("dashboard");
            }}
            aria-label="返回主頁"
            >
              <CompanyLogo className="home-logo" />
          </button>
          <div>
            <b>連工帶料工程管理</b>
            <small>戶別全流程 MVP</small>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className={`sync sync-button ${!online || offlineState.pending || offlineState.failed ? "storage-alert" : ""}`} onClick={() => setSyncTick((value) => value + 1)} title="點擊重新同步">
            {online ? "●" : "○"} {storageWarning || "已與 Supabase 同步"}{offlineState.pending ? ` · ${offlineState.pending} 筆待同步` : ""}{offlineState.photos ? ` · ${offlineState.photos} 張照片` : ""}
          </button>
          {canManageProjects && <><button className="ghost" onClick={exportBackup}>下載備份</button>
          <button className="ghost" onClick={() => exportFullExcel(liveProjects, catalog)}>完整 Excel</button>
          <button className="ghost" onClick={() => systemHealth && alert([
            `專案：${systemHealth.projects}｜戶別：${systemHealth.units}`,
            `照片：${systemHealth.storageFiles} 張｜${(systemHealth.storageBytes / 1024 / 1024).toFixed(1)} MB`,
            `24 小時錯誤：${systemHealth.errors24h}｜備份：${systemHealth.backups} 份`,
            `最新備份：${systemHealth.latestBackup ? new Date(systemHealth.latestBackup).toLocaleString("zh-TW") : "尚無"}`,
            ...healthWarnings(systemHealth).map((x) => `⚠ ${x}`),
          ].join("\n"))}>系統監控{systemHealth && healthWarnings(systemHealth).length ? ` (${healthWarnings(systemHealth).length})` : ""}</button>
          <label className="ghost" style={{ cursor: "pointer" }}>還原備份
            <input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && void importBackup(e.target.files[0])} />
          </label></>}
          <SessionChip email={email} role={role} />
        </div>
      </header>
          {showQuickStart && <div className="quick-start"><div><b>第一次使用，照這 5 步即可</b><span>① 選案場　→　② 選戶別　→　③ 開始檢查　→　④ 📷 拍照　→　⑤ 💾 暫存／✓ 完成</span></div><button onClick={() => { localStorage.setItem(scopedKey("spc-quick-start-seen", authUserId), "1"); setShowQuickStart(false); }}>知道了</button></div>}
      {!!conflictPaths.length && <Modal close={() => undefined} title="偵測到同一筆資料被兩人修改"><div className="form"><div className="warning">系統沒有直接覆蓋資料。共有 {conflictPaths.length} 個相同欄位發生衝突，請選擇要保留哪一版。</div><div className="conflict-list">{conflictPaths.slice(0, 8).map((path) => <code key={path}>{path}</code>)}{conflictPaths.length > 8 && <small>另有 {conflictPaths.length - 8} 個欄位</small>}</div><div className="form-actions"><button className="ghost" onClick={() => { const remote = remoteConflictRef.current; if (remote) { setProjects(remote.projects); setCatalog(remote.catalog); writeWorkspaceDraft(authUserId, remote.projects, remote.catalog, versionRef.current, false); } setConflictPaths([]); }}>使用 Supabase 最新資料</button><button className="primary" onClick={() => { setConflictPaths([]); setSyncTick((value) => value + 1); }}>保留這台電腦內容並重新同步</button></div></div></Modal>}
      <div className="shell">
        <aside
          className={menuOpen ? "mobile-open" : ""}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button")) setMenuOpen(false);
          }}
        >
          <div className="drawer-head">
            <b>功能選單</b>
            <button
              aria-label="關閉功能選單"
              onClick={() => setMenuOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="global-database">
            <p className="side-title">共用資料庫</p>
            <button
              className={
                view === "products"
                  ? "global-products active"
                  : "global-products"
              }
              onClick={() => {
                setUid("");
                setView("products");
              }}
            >
              <span>◇</span>
              <b>SPC 產品管理</b>
              <small>全案場共用</small>
            </button>
            {canManageAccounts && (
              <button
                className={view === "accounts" ? "global-products active" : "global-products"}
                onClick={() => { setUid(""); setFloorContext(null); setView("accounts"); }}
              >
                <span>♙</span>
                <b>帳號管理</b>
                <small>所有管理員皆可使用</small>
              </button>
            )}
          </div>
          <p className="side-title project-section-title">專案／建案</p>
          <button
            className="primary wide"
            onClick={() => {
              setMenuOpen(false);
              setMode("new");
            }}
          >
            ＋ 新增專案
          </button>
          <div className="project-list">
            {liveProjects.map((p) => (
              <div className="project-group" key={p.id}>
                <button
                  className={p.id === pid ? "project active" : "project"}
                  onClick={() => {
                    setPid(p.id);
                    setUid("");
                    setFloorContext(null);
                    setView("dashboard");
                  }}
                >
                  <span className="project-name">
                    <b>{p.name}</b>
                    <i>{p.id === pid ? "⌄" : "›"}</i>
                  </span>
                  <small>
                    {p.units.length} 戶 · {p.address || "尚未填地址"}
                  </small>
                </button>
                {p.id === pid && (
                  <>
                    <p className="project-subtitle">案場功能</p>
                    <nav className="project-subnav">
                      {sideViews.map(([key, icon, label]) => (
                        <button
                          key={key}
                          className={view === key && !uid ? "active" : ""}
                          onClick={() => {
                            setUid("");
                            setFloorContext(null);
                            setView(key);
                          }}
                        >
                          <span>{icon}</span>
                          {label}
                        </button>
                      ))}
                    </nav>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="privacy">
            資料已同步至 Supabase 雲端。
            <br />
            家裡、公司與行動裝置可共用。
          </div>
        </aside>
        {menuOpen && (
          <button
            className="menu-backdrop"
            aria-label="關閉功能選單"
            onClick={() => setMenuOpen(false)}
          />
        )}
        <section className="content">
          {view === "accounts" && canManageAccounts ? (
            <AccountManagement />
          ) : view === "products" ? (
            <GlobalProducts products={catalog} setProducts={updateCatalog} />
          ) : !project ? (
            <Empty />
          ) : unit ? (
            <UnitDetail
              project={project}
              unit={unit}
              role={appRole}
              activity={activity.find((item) => item.entityType === "unit" && item.entityId === unit.id)}
              patch={patchUnit}
              patchProject={patchProject}
              addEvent={addEvent}
              floorContext={floorContext}
              floorUnits={floorContext ? floorUnitsFor(project.units, floorContext.building, floorContext.floor) : []}
              openUnit={setUid}
              back={() => {
                setUid("");
                if (floorContext) window.setTimeout(() => window.scrollTo({ top: floorContext.scrollY }), 0);
              }}
              remove={() => {
                removeUnit(unit.id);
                setUid("");
              }}
            />
          ) : floorContext ? (
            <FloorAcceptanceView
              project={project}
              context={floorContext}
              patchUnitById={patchUnitById}
              openUnit={(unitId, context) => { setFloorContext(context); setUid(unitId); }}
              back={() => setFloorContext(null)}
            />
          ) : (
            <ProjectArea
              project={project}
              view={view}
              setView={setView}
              patch={patchProject}
              open={(unitId) => { setFloorContext(null); setUid(unitId); }}
              openFloor={(building, floor) => setFloorContext(createFloorReturnContext(building, floor))}
              remove={removeProject}
            />
          )}
        </section>
      </div>
    </main>
  );
}

type ManagedUser = {
  id: string;
  email: string;
  phone: string;
  role: AppRole;
  active: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  confirmedAt: string | null;
  applicationStatus: "pending" | "approved" | "rejected";
};

const displayIdentity = (email: string, phone: string) =>
  email || phone.replace(/^\+?8869/, "09");

function AccountManagement() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [newIdentity, setNewIdentity] = useState("");
  const [newRole, setNewRole] = useState<AppRole>("client");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const adminRequest = async (body?: object) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("登入已逾時，請重新登入。 ");
    const response = await fetch("/api/admin/users", {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json() as { error?: string; users?: ManagedUser[]; currentUserId?: string };
    if (!response.ok) {
      const labels: Record<string, string> = {
        ADMIN_REQUIRED: "只有啟用中的系統管理員可以管理帳號。",
        CANNOT_LOCK_SELF: "為避免鎖住系統，不能停用自己或變更自己的身份。",
        INVALID_ROLE: "請選擇有效的帳號身份。",
        INVALID_IDENTITY: "請輸入正確的電子郵件或台灣手機號碼。",
        SERVER_AUTH_NOT_CONFIGURED: "帳號管理服務尚未完成安全設定。",
      };
      throw new Error(labels[result.error || ""] || result.error || "操作失敗，請稍後再試。");
    }
    return result;
  };

  const loadUsers = async () => {
    setLoading(true); setError("");
    try {
      const result = await adminRequest();
      setUsers(result.users || []);
      setCurrentUserId(result.currentUserId || "");
    } catch (err) { setError(err instanceof Error ? err.message : "無法載入帳號"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void loadUsers(); }, []);

  const act = async (key: string, body: object, success: string) => {
    setBusy(key); setError(""); setMessage("");
    try { await adminRequest(body); setMessage(success); await loadUsers(); }
    catch (err) { setError(err instanceof Error ? err.message : "操作失敗"); }
    finally { setBusy(""); }
  };

  const createAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    const identity = newIdentity.trim();
    if (!identity) return;
    await act("create", { action: "create", identity, role: newRole }, `已建立 ${identity}，首次登入請使用預設密碼 1234qwer`);
    setNewIdentity("");
  };

  const formatTime = (value: string | null) => value ? new Date(value).toLocaleString("zh-TW") : "尚未登入";

  return (
    <div className="account-page">
      <div className="page-head account-head">
        <div><p className="eyebrow">系統管理</p><h1>帳號管理</h1><p>以電子郵件或手機號碼建立帳號、指定身份與查看最近登入狀態。</p></div>
        <button className="ghost" onClick={() => void loadUsers()} disabled={loading}>重新整理</button>
      </div>
      <section className="panel invite-panel">
        <div><h2>建立新帳號</h2><p className="muted">可使用電子郵件或台灣手機號碼；預設密碼為 1234qwer，首次登入會強制更換。</p></div>
        <form onSubmit={createAccount}>
          <input type="text" required value={newIdentity} onChange={(event) => setNewIdentity(event.target.value)} placeholder="name@company.com 或 0912345678" aria-label="電子郵件或手機號碼" />
          <select value={newRole} onChange={(event) => setNewRole(event.target.value as AppRole)} aria-label="新帳號身份">{roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <button className="primary" disabled={busy === "create"}>{busy === "create" ? "建立中…" : "建立帳號"}</button>
        </form>
      </section>
      {message && <div className="save-success">{message}</div>}
      {error && <div className="login-error" role="alert">{error}</div>}
      <section className="panel account-list-panel">
        <div className="panel-head"><div><h2>所有帳號</h2><p>{loading ? "正在讀取…" : `共 ${users.length} 個帳號`}</p></div></div>
        <div className="account-list">
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            const identity = displayIdentity(user.email, user.phone);
            return (
              <article className={`account-row ${user.active ? "" : "disabled"}`} key={user.id}>
                <div className="account-identity"><span>{identity.slice(0, 1).toUpperCase()}</span><div><b>{identity}</b><small>{isSelf ? "目前登入帳號" : user.applicationStatus === "pending" ? "待審核申請" : user.confirmedAt ? "已確認" : "尚未確認"}</small></div></div>
                <div className="account-last"><small>最後登入</small><b>{formatTime(user.lastSignInAt)}</b></div>
                <label className="account-role"><small>身份</small><select value={user.role} disabled={isSelf || !!busy} onChange={(event) => void act(`role-${user.id}`, { action: "role", userId: user.id, role: event.target.value }, `已更新 ${identity} 的身份`)}>{roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <div className="account-actions">
                  <button className="ghost" disabled={!!busy} onClick={() => { if (confirm(`確定將 ${identity} 的密碼重設為 1234qwer？`)) void act(`reset-${user.id}`, { action: "reset", userId: user.id }, `已重設 ${identity}，下次登入會強制更換密碼`); }}>重設密碼</button>
                  <button className={user.active ? "danger" : "primary"} disabled={isSelf || !!busy} onClick={() => { if (!user.active || confirm(`確定要停用 ${identity}？停用後將立即無法登入。`)) void act(`active-${user.id}`, { action: "active", userId: user.id, active: !user.active }, user.active ? `已停用 ${identity}` : user.applicationStatus === "pending" ? `已核准 ${identity} 的帳號申請` : `已啟用 ${identity}`); }}>{user.active ? "停用" : user.applicationStatus === "pending" ? "核准申請" : "啟用"}</button>
                </div>
              </article>
            );
          })}
          {!loading && !users.length && <div className="empty">目前沒有帳號</div>}
        </div>
      </section>
    </div>
  );
}

function SystemEntry({
  count,
  warning,
  create,
  enter,
  manageAccounts,
}: {
  count: number;
  warning: string;
  create: () => void;
  enter: () => void;
  manageAccounts?: () => void;
}) {
  return (
    <main className="entry-screen">
      <div className="entry-brand"><CompanyLogo /><div><b>連工帶料工程管理</b><small>資料建立一次，工程全程沿用</small></div></div>
      <section className="entry-card">
        <p className="eyebrow">請選擇要進行的工作</p>
        <h1>開始使用系統</h1>
        <p className="entry-lead">建立新案場時先完成固定欄位；日常作業則直接進入既有案場。</p>
        <div className="entry-options">
          <button onClick={create}>
            <i>＋</i><span><b>建立新案場資料</b><small>填寫案場、產品與第一批戶別</small></span><em>開始建立 →</em>
          </button>
          <button onClick={enter}>
            <i>⌂</i><span><b>進入儀表板及現有案場</b><small>{count ? `目前共有 ${count} 個案場` : "尚未建立任何案場"}</small></span><em>{count ? "進入系統 →" : "請先建立案場"}</em>
          </button>
          {manageAccounts && (
            <button onClick={manageAccounts}>
              <i>♙</i><span><b>帳號管理</b><small>邀請帳號、調整角色與停用權限</small></span><em>管理帳號 →</em>
            </button>
          )}
        </div>
        {warning && <div className="form-error">{warning}</div>}
        <div className="privacy entry-privacy">資料已同步至 Supabase 雲端，可由不同電腦、手機或平板共用。</div>
      </section>
    </main>
  );
}

function ProjectOnboarding({
  catalog,
  cancel,
  complete,
}: {
  catalog: Product[];
  cancel: () => void;
  complete: (project: Project, products: Product[]) => void;
}) {
  const authUserId = useAuthOwner();
  const emptyRow = { building: "", floor: "", number: "", model: "", colorNo: "", estimated: "", areaUnit: "坪" as AreaUnit, note: "" };
  const onboardingKey = draftKey(authUserId, "project-onboarding", "new");
  const recovered = readDraft(onboardingKey, { step: 1, basic: { name: "", address: "", builder: "", contact: "", phone: "", expectedDate: "", note: "" }, products: catalog, product: { id: id(), brand: "", model: "", colorNo: "", spec: "", note: "" } as Product, rows: [{ ...emptyRow }] });
  const [step, setStep] = useState(recovered.step);
  const [basic, setBasic] = useState(recovered.basic);
  const [products, setProducts] = useState<Product[]>(recovered.products);
  const [product, setProduct] = useState<Product>(recovered.product);
  const [rows, setRows] = useState(recovered.rows);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [onboardingDraftReady, setOnboardingDraftReady] = useState(() => !!readLocal(onboardingKey));
  useEffect(() => {
    if (readLocal(onboardingKey)) { setOnboardingDraftReady(true); return; }
    void loadOfflineDraft<typeof recovered>(onboardingKey).then((saved) => {
      if (saved) { setStep(saved.payload.step); setBasic(saved.payload.basic); setProducts(saved.payload.products); setProduct(saved.payload.product); setRows(saved.payload.rows); }
      setOnboardingDraftReady(true);
    }).catch(() => setOnboardingDraftReady(true));
  }, [onboardingKey]);
  useEffect(() => {
    if (!onboardingDraftReady) return;
    writeLocalDraft(onboardingKey, { id: "project-onboarding-new", step, basic, products, product, rows }, authUserId);
  }, [onboardingKey, onboardingDraftReady, step, basic, products, product, rows]);
  const addProduct = () => {
    if (!product.model.trim() || !product.colorNo.trim()) return setError("請填寫 SPC 編號與色號。");
    if (products.some((x) => x.model === product.model.trim() && x.colorNo === product.colorNo.trim())) return setError("此 SPC 編號與色號已存在，可直接在下一步選擇。");
    setProducts([...products, { ...product, model: product.model.trim(), colorNo: product.colorNo.trim() }]);
    setProduct({ id: id(), brand: "", model: "", colorNo: "", spec: "", note: "" });
    setError("");
  };
  const updateRow = (index: number, key: string, value: string) => setRows(rows.map((row, i) => i === index ? { ...row, [key]: value, ...(key === "model" ? { colorNo: "" } : {}) } : row));
  const finish = () => {
    const invalid = rows.findIndex((r) => !onboardingUnitRowIsValid(r, areaInputToPing(r.estimated, r.areaUnit || "坪")));
    if (invalid >= 0) return setError(`第 ${invalid + 1} 戶資料不完整，請確認棟別、樓層、戶別與坪數。`);
    const units = rows.map((r) => {
      const model = r.model.trim();
      const colorNo = r.colorNo.trim();
      const product = findExactUnitProduct({ model, colorNo }, products);
      return { ...blankUnit(), building: r.building, floor: r.floor, number: r.number, brand: product?.brand || "", model, colorNo, spec: product?.spec || "", estimated: areaInputToPing(r.estimated, r.areaUnit || "坪"), note: r.note };
    });
    complete({
      id: id(), name: basic.name.trim(), address: basic.address.trim(), builder: basic.builder.trim(), contact: basic.contact.trim(), phone: basic.phone.trim(), note: basic.note,
      expectedDate: basic.expectedDate, unitNamingRule: "", productRule: "", specialRule: "", acceptanceRule: "", importRule: "",
      units, products, journals: [],
    }, products);
    removeDurableDraft(onboardingKey);
    void removeOfflineDraft(onboardingKey);
  };
  return (
    <main className="onboarding-screen">
      <header><div className="brand"><CompanyLogo /><div><b>建立新案場資料</b><small>固定欄位標準化</small></div></div><button className="ghost" onClick={cancel}>離開建立流程</button></header>
      <section className="onboarding-wrap form">
        <div className="onboarding-steps"><span className={step >= 1 ? "active" : ""}>1 案場資料</span><span className={step >= 2 ? "active" : ""}>2 SPC產品</span><span className={step >= 3 ? "active" : ""}>3 戶別資料</span><span className={step >= 4 ? "active" : ""}>4 確認啟用</span></div>
        {step === 1 && <section className="panel form"><div><p className="eyebrow">前置統一表單</p><h1>案場基本資料</h1><p className="muted">所有工程節點與報告都會沿用，不必再次輸入。</p></div><div className="grid3">
          <Field label="建案名稱（必填）" value={basic.name} set={(name) => setBasic({ ...basic, name })} /><Field label="案場地址（必填）" value={basic.address} set={(address) => setBasic({ ...basic, address })} /><Field label="建設公司" value={basic.builder} set={(builder) => setBasic({ ...basic, builder })} /><Field label="工地窗口" value={basic.contact} set={(contact) => setBasic({ ...basic, contact })} /><Field label="聯絡資訊" value={basic.phone} set={(phone) => setBasic({ ...basic, phone })} /><Field label="預計工程日期" type="date" value={basic.expectedDate} set={(expectedDate) => setBasic({ ...basic, expectedDate })} /><Field label="備註" value={basic.note} set={(note) => setBasic({ ...basic, note })} />
        </div><button className="primary next-step" disabled={!basic.name.trim() || !basic.address.trim()} onClick={() => setStep(2)}>下一步：確認SPC產品 →</button></section>}
        {step === 2 && <section className="panel form"><div><p className="eyebrow">全案場共用產品庫</p><h1>選擇或新增SPC產品</h1><p className="muted">點一下已有色號即可自動帶入下方欄位；沒有的產品只需新增一次。</p></div><div className="onboarding-products">{products.map((p) => <button type="button" className={product.id === p.id ? "selected" : ""} key={p.id} onClick={() => { setProduct({ ...p }); setError(""); }}><b>{p.model}</b><span>{p.colorNo}</span><small>{p.brand || "未填品牌"}</small></button>)}</div><div className="grid3 product-inline"><Field label="品牌／廠商" value={product.brand} set={(brand) => setProduct({ ...product, brand })} /><Field label="SPC編號" value={product.model} set={(model) => setProduct({ ...product, model })} /><Field label="色號" value={product.colorNo} set={(colorNo) => setProduct({ ...product, colorNo })} /><Field label="規格" value={product.spec} set={(spec) => setProduct({ ...product, spec })} /><button className="ghost" onClick={addProduct}>＋ 加入產品庫</button></div><div className="step-actions"><button className="ghost" onClick={() => setStep(1)}>← 上一步</button><button className="primary" disabled={!products.length} onClick={() => setStep(3)}>下一步：建立戶別 →</button></div></section>}
        {step === 3 && <section className="panel form"><div className="panel-head"><div><p className="eyebrow">固定欄位，一列一戶</p><h1>建立第一批戶別</h1><p>少量資料直接填寫；大量資料可在這裡直接使用 Excel／CSV 匯入。</p></div><div className="actions"><button className="unit-import-toggle" onClick={() => setImporting(true)}>▤ 匯入 Excel</button><button className="add-row" onClick={() => setRows([...rows, { ...emptyRow }])}>＋ 新增一戶</button></div></div><div className="batch-rows">{rows.map((r, i) => { const models = [...new Set(products.map((p) => p.model))]; const colors = products.filter((p) => p.model === r.model).map((p) => p.colorNo); return <div className="batch-row" key={i}><div className="batch-row-title"><b>第 {i + 1} 戶</b>{rows.length > 1 && <button onClick={() => setRows(rows.filter((_, j) => j !== i))}>移除</button>}</div><div className="grid3"><Field label="棟別" value={r.building} set={(v) => updateRow(i, "building", v)} /><Field label="樓層" value={r.floor} set={(v) => updateRow(i, "floor", v)} /><Field label="戶別" value={r.number} set={(v) => updateRow(i, "number", v)} /><label className="field"><span>SPC編號</span><select value={r.model} onChange={(e) => updateRow(i, "model", e.target.value)}><option value="">請選擇</option>{models.map((m) => <option key={m}>{m}</option>)}</select></label><label className="field"><span>色號</span><select value={r.colorNo} disabled={!r.model} onChange={(e) => updateRow(i, "colorNo", e.target.value)}><option value="">請選擇</option>{colors.map((c) => <option key={c}>{c}</option>)}</select></label><AreaDraftInput value={r.estimated} unit={r.areaUnit || "坪"} setArea={(estimated, areaUnit) => setRows((current) => current.map((row, index) => index === i ? { ...row, estimated, areaUnit } : row))} /><Field label="備註／特殊說明" value={r.note} set={(v) => updateRow(i, "note", v)} /></div></div>})}</div><div className="step-actions"><button className="ghost" onClick={() => setStep(2)}>← 上一步</button><button className="primary" onClick={() => { setError(""); setStep(4); }}>下一步：確認資料 →</button></div>{importing && <ImportUnits p={{ id: "project-onboarding-import", name: basic.name, address: basic.address, builder: basic.builder, contact: basic.contact, phone: basic.phone, note: basic.note, expectedDate: basic.expectedDate, unitNamingRule: "", productRule: "", specialRule: "", acceptanceRule: "", importRule: "", products, journals: [], units: rows.filter((row) => row.building && row.floor && row.number).map((row) => ({ ...blankUnit(), building: row.building, floor: row.floor, number: row.number, model: row.model, colorNo: row.colorNo, estimated: areaInputToPing(row.estimated, row.areaUnit || "坪") || 0, note: row.note })) }} close={() => setImporting(false)} save={(units, importedProducts, projectName) => { const existingRows = rows.filter((row) => [row.building, row.floor, row.number, row.model, row.colorNo, row.estimated, row.note].some(Boolean)); setRows([...existingRows, ...units.map((unit) => ({ building: unit.building, floor: unit.floor, number: unit.number, model: unit.model, colorNo: unit.colorNo, estimated: String(unit.estimated), areaUnit: "坪" as AreaUnit, note: unit.note }))]); setProducts((current) => [...current, ...importedProducts.filter((item) => !current.some((existing) => existing.model === item.model && existing.colorNo === item.colorNo))]); if (projectName) setBasic({ ...basic, name: projectName }); setImporting(false); setError(""); }} />}</section>}
        {step === 4 && <section className="panel form"><div><p className="eyebrow">最後確認</p><h1>確認並啟用案場</h1></div><div className="activation-summary"><span>建案<b>{basic.name}</b></span><span>案場地址<b>{basic.address}</b></span><span>SPC產品<b>{products.length} 筆</b></span><span>第一批戶別<b>{rows.length} 戶</b></span></div><div className="warning">確認後會正式建立案場，戶別基本資料將直接沿用至場勘、施工、驗收與報告。</div><div className="step-actions"><button className="ghost" onClick={() => setStep(3)}>← 返回修改</button><button className="primary" onClick={finish}>確認並開始使用</button></div></section>}
        {error && <div className="form-error">{error}</div>}
      </section>
    </main>
  );
}
function Empty() {
  return (
    <div className="empty">
      <h2>請建立第一個建案</h2>
    </div>
  );
}
function ProjectArea({
  project,
  view,
  setView,
  patch,
  open,
  openFloor,
  remove,
}: {
  project: Project;
  view: string;
  setView: (x: string) => void;
  patch: (x: Partial<Project>) => void;
  open: (x: string) => void;
  openFloor: (building: string, floor: string) => void;
  remove: () => void;
}) {
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">目前建案</p>
          <h1>{project.name}</h1>
          <p>📍 {project.address || "尚未填寫案場地址"}</p>
        </div>
        <div className="actions">
          <button
            className="danger"
            onClick={() =>
              confirm(
                `確定刪除「${project.name}」及全部戶別與工程紀錄？此動作無法復原。`,
              ) && remove()
            }
          >
            刪除案場
          </button>
          <button className="primary" onClick={() => setView("units")}>
            ＋ 新增戶別
          </button>
        </div>
      </div>
      <Tabs
        value={view}
        set={setView}
        items={[
          ["dashboard", "Dashboard"],
          ["units", "戶別管理"],
          ["daily-acceptance", "今日驗收"],
          ["journal", "今日日誌"],
          ["billing", "月結／計價"],
          ["project", "專案資料"],
        ]}
      />
      {view === "dashboard" && (
        <Dashboard p={project} open={open} setView={setView} />
      )}{" "}
      {view === "units" && <Units p={project} patch={patch} open={open} openFloor={openFloor} />}{" "}
      {view === "daily-acceptance" && <DailyAcceptanceView p={project} />}{" "}
      {view === "products" && <Products p={project} patch={patch} />}{" "}
      {view === "journal" && <Journal p={project} patch={patch} />}{" "}
      {view === "billing" && <Billing p={project} patch={patch} />}{" "}
      {view === "project" && <ProjectForm p={project} patch={patch} />}
    </>
  );
}
function DailyAcceptanceView({ p }: { p: Project }) {
  const entries = useMemo(() => buildDailyAcceptanceEntries<Acceptance, Unit>(p.units), [p.units]);
  const dates = [...new Set(entries.map((entry) => entry.date))];
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  const [selected, setSelected] = useState<(typeof entries)[number] | null>(null);
  const records = entries.filter((entry) => entry.date === selectedDate);
  const exportDay = () => {
    const exportRecords = records.map(({ unit, acceptance }) => buildAcceptanceExportRecord(p, unit, acceptance, true));
    const workbook = createShipmentWorkbook(p, exportRecords, selectedDate.slice(0, 7));
    saveShipmentWorkbook(workbook, `${selectedDate}_${p.name}_SPC已出貨明細總表.xlsx`);
  };
  return (
    <div className="form daily-acceptance-view">
      <section className="panel">
        <div className="panel-head">
          <div><p className="eyebrow">案場正式驗收紀錄</p><h2>今日驗收</h2><p>依驗收／複驗紀錄本身的日期顯示，不含草稿。</p></div>
          <button className="primary" disabled={!records.length} onClick={exportDay}>匯出當日細總表 Excel</button>
        </div>
        <div className="daily-acceptance-summary">
          <label className="field"><span>日期</span><input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
          <article><span>當日正式驗收筆數</span><b>{records.length}</b></article>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>棟／區域</th><th>樓層</th><th>戶別</th><th>型號</th><th>色號</th><th>坪數</th><th>驗收人</th><th>驗收結果</th><th>紀錄類型</th></tr></thead>
            <tbody>
              {records.map((entry) => <tr key={`${entry.unit.id}-${entry.acceptance.id}`} className="clickable-row" onClick={() => setSelected(entry)}>
                <td>{entry.unit.building || "—"}</td><td>{entry.unit.floor || "—"}</td><td>{entry.unit.number || "—"}</td><td>{entry.unit.model || "—"}</td><td>{entry.unit.colorNo || "—"}</td><td>{entry.acceptance.area || entry.unit.estimated || 0} 坪</td><td>{entry.acceptance.person || "—"}</td><td>{entry.acceptance.result}</td><td>{entry.acceptance.recheck ? "複驗" : "驗收"}</td>
              </tr>)}
              {!records.length && <tr><td colSpan={9}>此日期沒有正式驗收紀錄。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>歷史驗收紀錄</h2><p>點選日期查看該日所有正式驗收與複驗。</p></div></div>
        <div className="daily-acceptance-history">
          {dates.map((date) => <button key={date} className={selectedDate === date ? "primary" : "ghost"} onClick={() => setSelectedDate(date)}><b>{date.replaceAll("-", "/")}</b><span>{entries.filter((entry) => entry.date === date).length} 筆</span></button>)}
          {!dates.length && <p>尚無正式驗收紀錄。</p>}
        </div>
      </section>
      {selected && <Modal close={() => setSelected(null)} title={`${selected.acceptance.recheck ? "複驗" : "驗收"}詳細內容｜${selected.date}`}>
        <RecordConfirmation title={`${selected.unit.building} ${selected.unit.floor}-${selected.unit.number}`} rows={[
          ["型號／色號", `${selected.unit.model || "—"}／${selected.unit.colorNo || "—"}`],
          ["驗收坪數", `${selected.acceptance.area || selected.unit.estimated || 0} 坪`],
          ["驗收人", selected.acceptance.person || "—"],
          ["驗收結果", selected.acceptance.result],
          ["紀錄類型", selected.acceptance.recheck ? "複驗" : "驗收"],
          ["備註", selected.acceptance.note || "—"],
          ["檢查項目", selected.acceptance.items.map((item) => `${item.label}：${item.result || "未填"}`).join("；")],
        ]} />
        <PhotoGrid photos={selected.acceptance.photos || []} />
      </Modal>}
    </div>
  );
}
function Dashboard({
  p,
  open,
  setView,
}: {
  p: Project;
  open: (x: string) => void;
  setView: (x: string) => void;
}) {
  const authUserId = useAuthOwner();
  const overdueIds = new Set(
      p.units
        .filter((u) =>
          u.defects.some(
            (d) => d.status !== "已完成" && d.due && d.due < day(),
          ),
        )
        .map((u) => u.id),
    );
  const go = (target: string) => {
    sessionStorage.setItem(scopedKey("spc-dashboard-unit-filter", authUserId), target);
    setView("units");
  };
  const groups = {
    survey: p.units.filter((u) =>
      ["待確認", "待場勘", "場勘待改善"].includes(u.status),
    ),
    work: p.units.filter((u) => ["可進場", "施工中"].includes(u.status)),
    accept: p.units.filter((u) =>
      ["待驗收", "驗收缺失", "改善中", "待複驗"].includes(u.status),
    ),
    done: p.units.filter((u) => ["已驗收", "已計價"].includes(u.status)),
  };
  const tasks = {
      survey: p.units.filter((u) => getUnitCurrentStatus(u) === "待場勘"),
      fix: p.units.filter((u) => getUnitCurrentStatus(u) === "改善中"),
      accept: p.units.filter((u) => getUnitCurrentStatus(u) === "待驗收"),
      overdue: p.units.filter((u) => overdueIds.has(u.id)),
    },
    all = [
      ...new Map(
        [...tasks.overdue, ...tasks.fix, ...tasks.accept, ...tasks.survey].map(
          (u) => [u.id, u],
        ),
      ).values(),
    ],
    percent = p.units.length
      ? Math.round((groups.done.length / p.units.length) * 100)
      : 0;
  const taskText = (u: Unit) =>
    overdueIds.has(u.id)
      ? u.defects.find((d) => d.status !== "已完成" && d.due && d.due < day())
          ?.content || "缺失改善已逾期"
      : u.status === "待驗收"
        ? "施工完成，等待安排驗收"
        : u.status === "待複驗"
          ? "改善完成，等待複驗"
          : u.status === "場勘待改善"
            ? "場勘條件尚未符合進場要求"
            : u.status === "驗收缺失" || u.status === "改善中"
              ? u.defects.find((d) => d.status !== "已完成")?.content ||
                "驗收缺失待改善"
              : "等待安排現場場勘";
  const total = Math.max(p.units.length, 1),
    surveyEnd = (groups.survey.length / total) * 100,
    workEnd = surveyEnd + (groups.work.length / total) * 100,
    acceptEnd = workEnd + (groups.accept.length / total) * 100;
  const donut = `conic-gradient(#92511f 0 ${surveyEnd}%, #ff8a00 ${surveyEnd}% ${workEnd}%, #1686df ${workEnd}% ${acceptEnd}%, #2aa53b ${acceptEnd}% 100%)`;
  return (
    <div className="mobile-dashboard">
      <section className="dash-card progress-card">
        <div className="dash-card-head">
          <div><h2>戶別進度總覽</h2><small>點擊進度即可閱覽對應戶別</small></div>
        </div>
        <div className="progress-overview">
          <div className="progress-total">
            <span>總戶數</span><strong>{p.units.length}<small>戶</small></strong>
            <div className="progress-donut" style={{ background: donut }}><span><b>{percent}%</b><small>完成</small></span></div>
          </div>
          <div className="progress-options">
            <DashStage icon="♙" label="待場勘" count={groups.survey.length} tone="brown" active={false} click={() => go("__survey")} />
            <DashStage icon="⌘" label="施工中" count={groups.work.length} tone="amber" active={false} click={() => go("__work")} />
            <DashStage icon="▣" label="待驗收" count={groups.accept.length} tone="blue" active={false} click={() => go("__accept")} />
            <DashStage icon="✓" label="已完成" count={groups.done.length} tone="green" active={false} click={() => go("__done")} />
          </div>
        </div>
      </section>
      <section className="dash-card alert-card">
        <div className="dash-card-head"><div><h2>異常提醒</h2><small>點擊直接查看問題戶別</small></div></div>
        <div className="alert-options">
          <DashAlert icon="!" label="待改善" count={tasks.fix.length} tone="amber" active={false} click={() => go("__fix")} />
          <DashAlert icon="◷" label="逾期戶" count={tasks.overdue.length} tone="red" active={false} click={() => go("__overdue")} />
        </div>
      </section>
      <section className="dash-card task-card">
        <div className="dash-card-head">
          <div><h2>待處理戶別</h2><small>點擊戶別可直接開啟詳細資料</small></div>
        </div>
        {all.slice(0, 6).map((u) => (
          <button className="task-row" key={u.id} onClick={() => open(u.id)}>
            <span
              className={`task-icon ${overdueIds.has(u.id) ? "red" : u.status.includes("驗收") || u.status === "待複驗" ? "blue" : u.status.includes("改善") ? "amber" : "green"}`}
            >
              {overdueIds.has(u.id)
                ? "!"
                : u.status.includes("驗收") || u.status === "待複驗"
                  ? "▣"
                  : u.status.includes("改善")
                    ? "⌘"
                    : "◷"}
            </span>
            <span className="task-main">
              <b>
                {u.building}｜{u.floor}｜{u.number}
              </b>
              <em>{taskText(u)}</em>
              <small>目前狀態：{u.status}</small>
            </span>
            <span
              className={`mini-status ${overdueIds.has(u.id) ? "red" : ""}`}
            >
              {overdueIds.has(u.id) ? "已逾期" : u.status}
            </span>
            <strong>›</strong>
          </button>
        ))}
        {!all.length && <p className="clear-state">目前沒有待處理戶別。</p>}
      </section>
    </div>
  );
}
function DashAction({
  icon,
  label,
  count,
  tone,
  active,
  click,
}: {
  icon: string;
  label: string;
  count: number;
  tone: string;
  active: boolean;
  click: () => void;
}) {
  return (
    <button
      className={`dash-action ${tone} ${active ? "active" : ""}`}
      onClick={click}
    >
      <span>{icon}</span>
      <b>{label}</b>
      <strong>{count}</strong>
      <small>戶</small>
    </button>
  );
}
function DashStage({
  icon,
  label,
  count,
  tone,
  active,
  click,
}: {
  icon: string;
  label: string;
  count: number;
  tone: string;
  active: boolean;
  click: () => void;
}) {
  return (
    <button className={`dash-stage ${tone} ${active ? "active" : ""}`} onClick={click}>
      <i>{icon}</i><b>{label}</b><strong>{count}<small>戶</small></strong><em>›</em>
    </button>
  );
}
function DashAlert({ icon, label, count, tone, active, click }: { icon: string; label: string; count: number; tone: string; active: boolean; click: () => void }) {
  return <button className={`dash-alert ${tone} ${active ? "active" : ""}`} onClick={click}><i>{icon}</i><span><b>{label}</b><strong>{count}<small>戶</small></strong></span><em>›</em></button>;
}
function BuildingIcon({ house }: { house: boolean }) {
  return house ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10.5V20h13v-9.5M9.5 20v-6h5v6" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 21V4h12v17M3 21h18" />
      <path d="M9 8h2m2 0h2M9 12h2m2 0h2M9 16h2m2 0h2" />
    </svg>
  );
}
function WholeUnitIcon() {
  return (
    <svg className="whole-unit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m10 9 5 3-5 3Z" />
    </svg>
  );
}
function CarIcon() {
  return <svg className="survey-tile-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 11 1.5-4h11l1.5 4M4 11h16v7H4zM7 18v2m10-2v2M7.5 14.5h.01m8.99 0h.01" /></svg>;
}
function SignatureIcon() {
  return <svg className="survey-tile-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" /><path d="M12 20h8" /></svg>;
}
function Units({
  p,
  patch,
  open,
  openFloor,
}: {
  p: Project;
  patch: (x: Partial<Project>) => void;
  open: (x: string) => void;
  openFloor: (building: string, floor: string) => void;
}) {
  const authUserId = useAuthOwner();
  const empty = {
      building: "",
      floor: "",
      number: "",
      model: "",
      colorNo: "",
    estimated: "",
    areaUnit: "坪" as AreaUnit,
      note: "",
    },
    recoveredCreate = readDraft(draftKey(authUserId, "unit-create", p.id), { draft: empty, rows: [{ ...empty }], batch: false }),
    [draft, setDraft] = useState(recoveredCreate.draft || empty),
    [q, setQ] = useState(""),
    [b, setB] = useState(""),
    [f, setF] = useState(""),
    [m, setM] = useState(""),
    [color, setColor] = useState(""),
    [status, setStatus] = useState(() => {
      if (typeof window === "undefined") return "";
      const filterKey = scopedKey("spc-dashboard-unit-filter", authUserId);
      const v = sessionStorage.getItem(filterKey) || "";
      sessionStorage.removeItem(filterKey);
      return v;
    }),
    [batch, setBatch] = useState(!!recoveredCreate.batch),
    [rows, setRows] = useState(recoveredCreate.rows?.length ? recoveredCreate.rows : [{ ...empty }]),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [bulkMode, setBulkMode] = useState(false),
    [expanded, setExpanded] = useState<string[]>([]),
    [openBuildings, setOpenBuildings] = useState<string[]>([]),
    [filtersOpen, setFiltersOpen] = useState(false),
    [creating, setCreating] = useState(false),
    [batchStatus, setBatchStatus] = useState<Status>("待場勘"),
    [creationDraftReady, setCreationDraftReady] = useState(() => !!readLocal(draftKey(authUserId, "unit-create", p.id)));
  useEffect(() => {
    if (!creationDraftReady) return;
    const hasContent = Object.values(draft).some(Boolean) || rows.some((row) => Object.values(row).some(Boolean));
    const storageKey = draftKey(authUserId, "unit-create", p.id);
    if (hasContent) writeLocalDraft(storageKey, { id: `unit-create-${p.id}`, draft, rows, batch }, authUserId);
  }, [draft, rows, batch, p.id, creationDraftReady]);
  useEffect(() => {
    const storageKey = draftKey(authUserId, "unit-create", p.id);
    if (readLocal(storageKey)) { setCreationDraftReady(true); return; }
    void loadOfflineDraft<{ draft: typeof empty; rows: typeof rows; batch: boolean }>(storageKey).then((saved) => {
      if (saved) { setDraft(saved.payload.draft); setRows(saved.payload.rows); setBatch(saved.payload.batch); }
      setCreationDraftReady(true);
    }).catch(() => setCreationDraftReady(true));
  }, [p.id]);
  useEffect(() => {
    if (status.startsWith("__"))
      setTimeout(
        () =>
          document
            .querySelector(".unit-manager")
            ?.scrollIntoView({ behavior: "smooth", block: "start" }),
        80,
      );
  }, []);
  const models = [...new Set(p.products.map((x) => x.model).filter(Boolean))],
    colors = [
      ...new Set(
        p.products
          .filter((x) => x.model === draft.model)
          .map((x) => x.colorNo)
          .filter(Boolean),
      ),
    ],
    values = (k: keyof Unit) => [
      ...new Set(p.units.map((u) => String(u[k] || "")).filter(Boolean)),
    ],
    statusMatch = (u: Unit) =>
      !status || status === "__survey"
        ? !status || getUnitCurrentStatus(u) === "待場勘"
        : status === "__work"
          ? ["可進場", "施工中"].includes(getUnitCurrentStatus(u))
          : status === "__done"
            ? getUnitCurrentStatus(u) === "已驗收"
        : status === "__fix"
          ? getUnitCurrentStatus(u) === "改善中"
          : status === "__accept"
            ? getUnitCurrentStatus(u) === "待驗收"
            : status === "__overdue"
              ? u.defects.some(
                  (d) => d.status !== "已完成" && d.due && d.due < day(),
                )
              : u.status === status,
    shown = p.units.filter(
      (u) =>
        [u.building, u.floor, u.number, u.owner].join("").includes(q) &&
        (!b || u.building === b) &&
        (!f || u.floor === f) &&
        (!m || u.model === m) &&
        (!color || u.colorNo === color) &&
        statusMatch(u),
    );
  const specialStatusLabels: Record<string, string> = {
      __survey: "待場勘",
      __work: "施工中",
      __fix: "待改善",
      __accept: "待驗收",
      __done: "已完成",
      __overdue: "逾期戶",
    },
    statusText = status ? specialStatusLabels[status] || status : "全部",
    activeFilterCount = [b, f, m, color, status].filter(Boolean).length,
    appliedFilters = [
      `棟別：${b || "全部"}`,
      `樓層：${f || "全部"}`,
      `狀態：${statusText}`,
      m ? `型號：${m}` : "",
      color ? `色號：${color}` : "",
    ].filter(Boolean);
  const buildingNames = [
      ...new Set(shown.map((u) => u.building || "未分類棟")),
    ].sort((a, b) => a.localeCompare(b, "zh-Hant", { numeric: true })),
    toggleMany = (ids: string[], checked: boolean) =>
      setSelected((xs) =>
        checked
          ? [...new Set([...xs, ...ids])]
          : xs.filter((x) => !ids.includes(x)),
      ),
    allShownSelected =
      shown.length > 0 && shown.every((u) => selected.includes(u.id)),
    applyBatch = () => {
      if (!selected.length) return;
      const chosen = p.units.filter((u) => selected.includes(u.id)),
        original = [...new Set(chosen.map((u) => u.status))],
        when = stamp(),
        mixed = original.length > 1,
        summary = `即將變更 ${chosen.length} 戶工程狀態。\n\n選取戶數：${chosen.length} 戶\n原本狀態：${original.join("、")}${mixed ? "（包含不同原始狀態，請特別確認）" : ""}\n新狀態：${batchStatus}\n操作日期：${when}\n\n是否確認？`;
      if (!confirm(summary)) return;
      patch({
        units: p.units.map((u) =>
          selected.includes(u.id)
            ? {
                ...u,
                status: batchStatus,
                events: [
                  {
                    id: id(),
                    at: when,
                    title: "批次變更工程狀態",
                    detail: `由 ${u.status} 更新為 ${batchStatus}`,
                    photos: [],
                  },
                  ...u.events,
                ],
              }
            : u,
        ),
      });
      setSelected([]);
    };
  useEffect(() => {
    setOpenBuildings((current) => {
      const next = current.filter((name) => buildingNames.includes(name));
      return next.length || !buildingNames.length ? next : [buildingNames[0]];
    });
  }, [buildingNames.join("|")]);
  const create = () => {
    const product = p.products.find(
      (x) => x.model === draft.model && x.colorNo === draft.colorNo,
    );
    if (
      !draft.building ||
      !draft.floor ||
      !draft.number ||
      !product ||
      !areaInputToPing(draft.estimated, draft.areaUnit || "坪")
    ) {
      setError("請完整填寫棟別、樓層、戶別、有效的 SPC 編號／色號及預估施工坪數。");
      return;
    }
    const u = {
      ...blankUnit(),
      building: draft.building,
      floor: draft.floor,
      number: draft.number,
      brand: product.brand,
      model: product.model,
      colorNo: product.colorNo,
      spec: product.spec,
      estimated: areaInputToPing(draft.estimated, draft.areaUnit || "坪"),
      note: draft.note,
    };
    patch({ units: [...p.units, u] });
    setDraft(empty);
    removeDurableDraft(draftKey(authUserId, "unit-create", p.id));
    setError("");
    open(u.id);
  };
  const updateRow = (i: number, k: string, v: string) =>
    setRows((rs) =>
      rs.map((r, j) =>
        j === i
          ? { ...r, [k]: v, ...(k === "model" ? { colorNo: "" } : {}) }
          : r,
      ),
    );
  const createBatch = () => {
    const bad: string[] = [],
      add: Unit[] = [];
    rows.forEach((r, i) => {
      const product = p.products.find(
        (x) => x.model === r.model && x.colorNo === r.colorNo,
      );
      if (
        !r.building ||
        !r.floor ||
        !r.number ||
        !product ||
        !areaInputToPing(r.estimated, r.areaUnit || "坪")
      ) {
        bad.push(
          `第 ${i + 1} 戶：${!product ? `${r.model || "未選編號"}／${r.colorNo || "未選色號"} 不在產品資料中` : "欄位未完整填寫或坪數格式不正確"}`,
        );
        return;
      }
      add.push({
        ...blankUnit(),
        building: r.building,
        floor: r.floor,
        number: r.number,
        brand: product.brand,
        model: r.model,
        colorNo: r.colorNo,
        spec: product.spec,
        estimated: areaInputToPing(r.estimated, r.areaUnit || "坪"),
        note: r.note,
      });
    });
    if (bad.length) {
      setError(`批量建立未執行，請確認：\n${bad.join("\n")}`);
      return;
    }
    patch({ units: [...p.units, ...add] });
    setRows([{ ...empty }]);
    setBatch(false);
    setCreating(false);
    removeDurableDraft(draftKey(authUserId, "unit-create", p.id));
    setError("");
  };
  return (
    <div className="form">
      {creating ? (
        <section className="panel form unit-create">
          <div className="panel-head">
            <div>
              <p className="eyebrow">建立工程資料</p>
              <h2>新增戶別</h2>
              <p>先選擇已建立的 SPC 產品，確認後才產生戶別案件。</p>
            </div>
            <div className="actions">
              <button
                className="ghost"
                onClick={() => {
                  setCreating(false);
                  setBatch(false);
                  setError("");
                }}
              >
                ← 返回戶別列表
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setBatch(!batch);
                  setError("");
                }}
              >
                {batch ? "改為單筆新增" : "批量建立"}
              </button>
            </div>
          </div>
          {!p.products.length && (
            <div className="warning">
              尚未建立 SPC 產品資料，請先到「SPC產品」新增產品編號與色號。
            </div>
          )}
          {!batch ? (
            <>
              <div className="grid3">
                <Field
                  label="棟別"
                  value={draft.building}
                  set={(building) => setDraft({ ...draft, building })}
                />
                <Field
                  label="樓層"
                  value={draft.floor}
                  set={(floor) => setDraft({ ...draft, floor })}
                />
                <Field
                  label="戶別"
                  value={draft.number}
                  set={(number) => setDraft({ ...draft, number })}
                />
                <label className="field">
                  <span>SPC 編號</span>
                  <select
                    value={draft.model}
                    onChange={(e) =>
                      setDraft({ ...draft, model: e.target.value, colorNo: "" })
                    }
                  >
                    <option value="">請選擇產品編號</option>
                    {models.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>色號</span>
                  <select
                    disabled={!draft.model}
                    value={draft.colorNo}
                    onChange={(e) =>
                      setDraft({ ...draft, colorNo: e.target.value })
                    }
                  >
                    <option value="">
                      {draft.model ? "請選擇色號" : "請先選擇 SPC 編號"}
                    </option>
                    {colors.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                <AreaDraftInput
                  value={draft.estimated}
                  unit={draft.areaUnit || "坪"}
                  setArea={(estimated, areaUnit) => setDraft({ ...draft, estimated, areaUnit })}
                />
                <Field label="備註／特殊說明" value={draft.note} set={(note) => setDraft({ ...draft, note })} />
              </div>
              <button
                className="primary create-unit"
                disabled={!p.products.length}
                onClick={create}
              >
                建立戶別並開啟工程資料
              </button>
            </>
          ) : (
            <div className="batch field-batch">
              <div className="batch-head">
                <div>
                  <b>批量新增戶別</b>
                  <small>
                    每一列代表一戶，SPC 編號與色號皆從共用產品庫選擇。
                  </small>
                </div>
                <button
                  className="add-row"
                  onClick={() => setRows([...rows, { ...empty }])}
                >
                  ＋ 新增一戶
                </button>
              </div>
              <div className="batch-rows">
                {rows.map((r, i) => {
                  const rowColors = [
                    ...new Set(
                      p.products
                        .filter((x) => x.model === r.model)
                        .map((x) => x.colorNo)
                        .filter(Boolean),
                    ),
                  ];
                  return (
                    <div className="batch-row" key={i}>
                      <div className="batch-row-title">
                        <b>第 {i + 1} 戶</b>
                        {rows.length > 1 && (
                          <button
                            onClick={() =>
                              setRows(rows.filter((_, j) => j !== i))
                            }
                          >
                            移除
                          </button>
                        )}
                      </div>
                      <div className="grid3">
                        <Field
                          label="棟別"
                          value={r.building}
                          set={(v) => updateRow(i, "building", v)}
                        />
                        <Field
                          label="樓層"
                          value={r.floor}
                          set={(v) => updateRow(i, "floor", v)}
                        />
                        <Field
                          label="戶別"
                          value={r.number}
                          set={(v) => updateRow(i, "number", v)}
                        />
                        <label className="field">
                          <span>SPC 編號</span>
                          <select
                            value={r.model}
                            onChange={(e) =>
                              updateRow(i, "model", e.target.value)
                            }
                          >
                            <option value="">請選擇產品編號</option>
                            {models.map((x) => (
                              <option key={x}>{x}</option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span>色號</span>
                          <select
                            disabled={!r.model}
                            value={r.colorNo}
                            onChange={(e) =>
                              updateRow(i, "colorNo", e.target.value)
                            }
                          >
                            <option value="">
                              {r.model ? "請選擇色號" : "請先選擇 SPC 編號"}
                            </option>
                            {rowColors.map((x) => (
                              <option key={x}>{x}</option>
                            ))}
                          </select>
                        </label>
                        <AreaDraftInput
                          value={r.estimated}
                          unit={r.areaUnit || "坪"}
                          setArea={(estimated, areaUnit) => setRows((current) => current.map((row, index) => index === i ? { ...row, estimated, areaUnit } : row))}
                        />
                        <Field label="備註／特殊說明" value={r.note} set={(v) => updateRow(i, "note", v)} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <button
                className="add-row add-row-bottom"
                onClick={() => setRows([...rows, { ...empty }])}
              >
                ＋ 新增下一戶
              </button>
              <button
                className="primary"
                disabled={!rows.length || !p.products.length}
                onClick={createBatch}
              >
                檢查並批量建立 {rows.length} 戶
              </button>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
        </section>
      ) : (
        <section className="panel form unit-manager">
          <div className="panel-head unit-manager-head">
            <div>
              <h2>戶別管理｜共 {p.units.length} 戶</h2>
              <p>依棟別與樓層快速瀏覽戶別進度。</p>
            </div>
            <div className="actions">
              <button
                className="primary"
                onClick={() => {
                  setCreating(true);
                  setError("");
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                ＋ 新增戶別
              </button>
            </div>
          </div>
          <div className="unit-search-row">
            <label className="unit-search">
              <span>⌕</span>
              <input
                placeholder="搜尋戶別 / 樓層 / 客戶"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <button
              className={filtersOpen ? "filter-toggle open" : "filter-toggle"}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <span>⌯</span>
              篩選 {activeFilterCount}
            </button>
          </div>
          <div className="applied-filters">
            已套用：{appliedFilters.join("、")}
          </div>
          {filtersOpen && (
            <div className="filters unit-filters compact">
              {[
                [b, setB, values("building"), "棟別"],
                [f, setF, values("floor"), "樓層"],
                [m, setM, values("model"), "型號"],
                [color, setColor, values("colorNo"), "色號"],
                [
                  status,
                  setStatus,
                  status.startsWith("__") ? [status, ...statuses] : statuses,
                  "狀態",
                ],
              ].map((x: any, i) => (
                <select
                  key={i}
                  value={x[0]}
                  onChange={(e) => {
                    x[1](e.target.value);
                    setSelected([]);
                  }}
                >
                  <option value="">{x[3]}：全部</option>
                  {x[2].map((v: string) => (
                    <option key={v} value={v}>
                      {i === 4
                        ? (
                            {
                              __survey: "待場勘（相關狀態）",
                              __work: "施工中（相關狀態）",
                              __fix: "待改善（相關狀態）",
                              __accept: "待驗收（相關狀態）",
                              __done: "已完成（相關狀態）",
                              __overdue: "逾期戶",
                            } as Record<string, string>
                          )[v] || v
                        : v}
                    </option>
                  ))}
                </select>
              ))}
              <button
                className="ghost clear-filters"
                onClick={() => {
                  setB("");
                  setF("");
                  setM("");
                  setColor("");
                  setStatus("");
                  setSelected([]);
                }}
              >
                清除篩選
              </button>
            </div>
          )}
          <div className="bulk-toolbar">
            {!bulkMode ? (
              <button className="ghost bulk-mode-toggle" onClick={() => setBulkMode(true)}>
                批次操作
              </button>
            ) : <label>
                <input
                  type="checkbox"
                  checked={allShownSelected}
                  onChange={(e) =>
                    toggleMany(
                      shown.map((u) => u.id),
                      e.target.checked,
                    )
                  }
                />{" "}
                全選目前篩選結果（{shown.length} 戶）
              </label>}
            {bulkMode && selected.length > 0 && (
              <div>
                <b>已選 {selected.length} 戶</b>
                <select
                  value={batchStatus}
                  onChange={(e) => setBatchStatus(e.target.value as Status)}
                >
                  {statuses.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <button className="primary" onClick={applyBatch}>
                  批次變更狀態
                </button>
                <button className="ghost" onClick={() => { setSelected([]); setBulkMode(false); }}>
                  取消選取
                </button>
              </div>
            )}
            {bulkMode && selected.length === 0 && (
              <button className="ghost" onClick={() => setBulkMode(false)}>結束批次操作</button>
            )}
          </div>
          <div className="building-groups">
            {buildingNames.map((building) => {
              const buildingUnits = shown.filter(
                  (u) => (u.building || "未分類棟") === building,
                ),
                floors = [
                  ...new Set(buildingUnits.map((u) => u.floor || "未分類樓層")),
                ].sort((a, b) =>
                  b.localeCompare(a, "zh-Hant", { numeric: true }),
                ),
                buildingOpen = openBuildings.includes(building);
              return (
                <section
                  className={buildingOpen ? "building-group open" : "building-group"}
                  key={building}
                >
                  <button
                    className="building-title"
                    onClick={() =>
                      setOpenBuildings((xs) =>
                        xs.includes(building)
                          ? xs.filter((name) => name !== building)
                          : [...xs, building],
                      )
                    }
                  >
                    <span className="building-icon">
                      <BuildingIcon house={building.includes("透天")} />
                    </span>
                    <h3>{building}</h3>
                    <span>{buildingUnits.length} 戶</span>
                    <i>{buildingOpen ? "⌃" : "⌄"}</i>
                  </button>
                  {buildingOpen && floors.map((floor) => {
                    const floorUnits = buildingUnits.filter(
                        (u) => (u.floor || "未分類樓層") === floor,
                      ),
                      groupKey = `${building}__${floor}`,
                      isOpen = expanded.includes(groupKey),
                      floorSelected = floorUnits.every((u) =>
                        selected.includes(u.id),
                      ),
                      floorStates = unitProgressStatuses
                        .map(
                          (s) =>
                            [
                              s,
                              floorUnits.filter((u) => getUnitCurrentStatus(u) === s).length,
                            ] as const,
                        )
                        .filter((x) => x[1] > 0),
                      acceptanceSummary = floorAcceptanceSummary(floorUnits);
                    return (
                      <div className="floor-group" key={groupKey}>
                        <div
                          className={`${isOpen ? "floor-head open" : "floor-head"}${bulkMode ? " bulk" : ""}`}
                        >
                          {bulkMode && <label className="floor-check" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={floorSelected}
                              onChange={(e) =>
                                toggleMany(
                                  floorUnits.map((u) => u.id),
                                  e.target.checked,
                                )
                              }
                            />
                          </label>}
                          <button
                            className="floor-row-main"
                            onClick={() =>
                              setExpanded((xs) =>
                                isOpen
                                  ? xs.filter((x) => x !== groupKey)
                                  : [...xs, groupKey],
                              )
                            }
                          >
                            <b>{floor === "整戶" && <WholeUnitIcon />}{floor}</b>
                            <em>| 共 {floorUnits.length} 戶</em>
                            <span className="floor-summary">
                              {floorStates.map(([s, n]) => (
                                <i key={s}>
                                  <span className={`status-dot ns${statuses.indexOf(s)}`} />
                                  {s} {n}
                                </i>
                              ))}
                            </span>
                            <span className="chevron">
                              {isOpen ? "⌃" : "›"}
                            </span>
                          </button>
                          {!bulkMode && <button className="floor-acceptance-entry" type="button" onClick={() => openFloor(
                            floorUnits[0]?.building || (building === "未分類棟" ? "" : building),
                            floorUnits[0]?.floor || (floor === "未分類樓層" ? "" : floor),
                          )}>
                            <b>驗收／簽名</b>
                            <small>{acceptanceSummary.allQualified ? `✓ ${acceptanceSummary.total} / ${acceptanceSummary.total} 全部合格` : `合格 ${acceptanceSummary.qualified} · 待處理 ${acceptanceSummary.needsAction} · 未驗收 ${acceptanceSummary.uninspected}`}</small>
                          </button>}
                        </div>
                        {isOpen && (
                          <div className="unit-cards">
                            {floorUnits.map((u) => (
                              <article
                                className={`unit-card${bulkMode ? " bulk" : ""}`}
                                key={u.id}
                                onClick={() => open(u.id)}
                              >
                                {bulkMode && <label onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={selected.includes(u.id)}
                                    onChange={(e) =>
                                      toggleMany([u.id], e.target.checked)
                                    }
                                  />
                                </label>}
                                <div>
                                  <b>{u.number || "未命名"}</b>
                                  <small>
                                    {u.model || "未填型號"}｜{u.colorNo || "未填色號"}｜{u.estimated || 0} 坪
                                  </small>
                                  {u.note.includes("【特殊案件】") && (
                                    <span className="special-badge">
                                      特殊案件
                                    </span>
                                  )}
                                </div>
                                <Pill s={u.status} />
                                <span className="unit-card-arrow">›</span>
                              </article>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })}
            {!shown.length && (
              <p className="no-data">沒有符合目前篩選條件的戶別。</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

type ImportUnitRow = {
  row: number;
  building: string;
  floor: string;
  number: string;
  model: string;
  colorNo: string;
  estimated: number;
  status: Status;
  note: string;
  product?: Product;
  newProduct: boolean;
  special: boolean;
  warning: string;
  hasData: boolean;
  duplicate: boolean;
};

function ImportUnits({
  p,
  close,
  save,
}: {
  p: Project;
  close: () => void;
  save: (units: Unit[], products: Product[], projectName: string) => void;
}) {
  const [fileName, setFileName] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [formatName, setFormatName] = useState("");
  const [projectName, setProjectName] = useState(
    p.name && !p.name.includes("未命名") ? p.name : "",
  );
  const [rows, setRows] = useState<ImportUnitRow[]>([]);
  const [message, setMessage] = useState("");
  const clean = (value: unknown) => String(value ?? "").trim();
  const read = (source: Record<string, unknown>, aliases: string[]) => {
    const normalized = Object.fromEntries(
      Object.entries(source).map(([key, value]) => [
        key.replace(/\s/g, ""),
        value,
      ]),
    );
    for (const alias of aliases) {
      const value = normalized[alias.replace(/\s/g, "")];
      if (value !== undefined && clean(value) !== "") return clean(value);
    }
    return "";
  };
  const parseFile = async (file?: File) => {
    if (!file) return;
    setMessage("");
    setRows([]);
    setFileName(file.name);
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const selectedSheet = workbook.SheetNames.includes("可匯入資料")
        ? "可匯入資料"
        : workbook.SheetNames[0];
      const sheet = workbook.Sheets[selectedSheet];
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: "",
        raw: false,
      });
      const titleCandidate = matrix
        .slice(0, 8)
        .flat()
        .map(clean)
        .find(
          (text) =>
            /SPC/i.test(text) &&
            !/(SPC編號|SPC型號|色號|樓層|戶別)/i.test(text.replace(/\s/g, "")),
        );
      const detectedProjectName = (titleCandidate || "")
        .replace(/SPC.*$/i, "")
        .replace(/[\s\-_｜|]+$/g, "")
        .trim();
      if (detectedProjectName && (!p.name.trim() || p.name.includes("未命名")))
        setProjectName(detectedProjectName);
      const matrixHeaders = matrix
        .map((row, index) => ({
          index,
          row,
          unitCount: row.filter((cell) => /^A\d+$/i.test(clean(cell))).length,
        }))
        .filter(
          ({ row, unitCount }) =>
            clean(row[0]).replace(/\s/g, "") === "樓層/戶別" && unitCount > 0,
        )
        .sort((a, b) => b.unitCount - a.unitCount);
      const isMatrixLayout = matrixHeaders.length > 0;
      let raw: Record<string, unknown>[];
      if (isMatrixLayout) {
        const productByColor = new Map<string, string>();
        matrix.forEach((row) => {
          const color = clean(row[0])
            .split(/[\n(（]/)[0]
            .trim();
          const model = clean(row[1]).match(/Y-[A-Z0-9-]+/i)?.[0] || "";
          if (color && model) productByColor.set(color, model);
        });
        const converted: Record<string, unknown>[] = [];
        const mainHeader = matrixHeaders[0];
        for (
          let rowIndex = mainHeader.index + 1;
          rowIndex < matrix.length;
          rowIndex++
        ) {
          const colorRow = matrix[rowIndex] || [];
          const floorMatch = clean(colorRow[0]).match(/^(\d+F)/i);
          if (!floorMatch) continue;
          const areaRow = matrix[rowIndex + 1] || [];
          for (let column = 1; column < mainHeader.row.length; column++) {
            const number = clean(mainHeader.row[column]);
            if (!/^A\d+$/i.test(number)) continue;
            const originalColor = clean(colorRow[column]);
            const colorNo = originalColor.split(/[\n(（]/)[0].trim();
            const estimated = Number(clean(areaRow[column]).replace(/,/g, ""));
            if (!originalColor && !estimated) continue;
            const extra = originalColor
              .replace(colorNo, "")
              .replace(/[()（）]/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            const isSpecial = /特殊/.test(originalColor);
            converted.push({
              棟別: "A棟",
              樓層: floorMatch[1].toUpperCase(),
              戶別: number,
              SPC編號: productByColor.get(colorNo) || "",
              色號: colorNo,
              預估坪數: estimated,
              工程狀態: "待確認",
              備註: isSpecial
                ? `【特殊案件】原始內容：${originalColor.replace(/\n/g, "／")}`
                : extra
                  ? `${extra}${/點交/.test(extra) ? "；請確認點交坪數是否已包含於預估坪數" : ""}`
                  : "",
              特殊標記: isSpecial ? "是" : "",
              來源列: rowIndex + 1,
            });
          }
        }
        const townhouseHeader = matrix.findIndex(
          (row) =>
            clean(row[0]).replace(/\s/g, "") === "樓層/戶別" &&
            row.some((cell) => /^B\d+$/i.test(clean(cell))),
        );
        if (townhouseHeader >= 0) {
          const header = matrix[townhouseHeader] || [];
          const colorRow = matrix[townhouseHeader + 1] || [];
          const detailRow = matrix[townhouseHeader + 2] || [];
          for (let column = 1; column < header.length; column++) {
            const number = clean(header[column]);
            if (!/^B\d+$/i.test(number)) continue;
            const colorNo = clean(colorRow[column])
              .split(/[\n(（]/)[0]
              .trim();
            const detail = clean(detailRow[column]);
            const estimated = [...detail.matchAll(/-(\d+(?:\.\d+)?)/g)].reduce(
              (sum, match) => sum + Number(match[1]),
              0,
            );
            if (!detail && !colorNo) continue;
            converted.push({
              棟別: "透天區",
              樓層: "整戶",
              戶別: number,
              SPC編號: productByColor.get(colorNo) || "",
              色號: colorNo,
              預估坪數: Number(estimated.toFixed(2)),
              工程狀態: "待確認",
              備註: detail ? `來源明細：${detail.replace(/\n/g, "／")}` : "",
              來源列: townhouseHeader + 2,
            });
          }
        }
        raw = converted;
        setFormatName("樓層 × 戶別矩陣格式");
      } else {
        raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: "",
          raw: false,
        });
        setFormatName("標準一列一戶格式");
      }
      const existing = new Set(
        p.units.map((u) => `${u.building}|${u.floor}|${u.number}`),
      );
      const inFile = new Set<string>();
      const parsed = raw.map((source, index) => {
        const building = read(source, ["棟別"]);
        const floor = read(source, ["樓層"]);
        const number = read(source, ["戶別"]);
        const model = read(source, ["SPC編號", "型號", "SPC型號"]);
        const colorNo = read(source, ["色號", "顏色"]);
        const importedEstimated = importedAreaToPing(source);
        const estimated = safeImportedEstimated(importedEstimated);
        const statusText = read(source, ["工程狀態", "狀態"]);
        const status = statuses.includes(statusText as Status)
          ? (statusText as Status)
          : "待確認";
        const note = read(source, ["備註"]);
        const specialText = read(source, ["特殊標記"]);
        const special =
          specialText === "是" ||
          /特殊/.test(colorNo) ||
          note.includes("【特殊案件】");
        const product = p.products.find(
          (item) =>
            item.model.trim() === model && item.colorNo.trim() === colorNo,
        );
        const areaText = read(source, ["預估坪數", "預估施工坪數", "坪數", "坪", "m²", "m2", "m^2", "㎡", "平方公尺", "平方米"]);
        const hasData = Boolean(building || floor || number || model || colorNo || areaText || statusText || note || specialText);
        const key = `${building}|${floor}|${number}`;
        const hasUnitKey = Boolean(building && floor && number);
        const duplicate = hasUnitKey && (existing.has(key) || inFile.has(key));
        if (hasUnitKey) inFile.add(key);
        const warnings: string[] = [];
        if (!building || !floor || !number) warnings.push("棟別、樓層或戶別待補");
        if (!model || !colorNo) warnings.push("SPC 編號或色號待補");
        if (!Number.isFinite(importedEstimated) || importedEstimated <= 0)
          warnings.push("坪數待補");
        if (statusText && !statuses.includes(statusText as Status))
          warnings.push(`狀態「${statusText}」無法識別，已設為待確認`);
        return {
          row: Number(source["來源列"] || index + 2),
          building,
          floor,
          number,
          model,
          colorNo,
          estimated,
          status,
          note,
          product,
          newProduct: Boolean(model && colorNo && !product),
          special,
          warning: warnings.join("；"),
          hasData,
          duplicate,
        };
      });
      setSheetName(selectedSheet);
      setRows(parsed);
      if (!parsed.length)
        setMessage("找不到可匯入的資料列，請確認欄位標題與內容。");
    } catch {
      setMessage("檔案無法讀取，請確認它是有效的 Excel 或 CSV 檔案。");
    }
  };
  const importable = importableUnitRows(rows);
  const pending = importable.filter((row) => row.warning).length;
  const blanks = rows.filter((row) => !row.hasData).length;
  const duplicates = rows.filter((row) => row.duplicate).length;
  const specialCount = importable.filter((row) => row.special).length;
  const newProductKeys = [
    ...new Set(
      importable
        .filter((row) => row.newProduct && row.model && row.colorNo)
        .map(importProductKey)
        .filter((key): key is string => key !== null),
    ),
  ];
  const confirmImport = () => {
    if (!importable.length) return;
    if (
      !confirm(
        `建案名稱：${projectName || "未填寫"}\n即將匯入 ${importable.length} 戶，其中 ${pending} 戶待補資料、${specialCount} 戶標記為特殊案件。\n同時新增 ${newProductKeys.length} 筆 SPC 產品資料到共用產品庫。\n重複 ${duplicates} 列、完全空白 ${blanks} 列不會匯入。\n\n是否確認？`,
      )
    )
      return;
    const units = importable.map((row) => ({
      ...blankUnit(),
      building: row.building,
      floor: row.floor,
      number: row.number,
      brand: row.product?.brand || "",
      model: row.model,
      colorNo: row.colorNo,
      spec: row.product?.spec || "",
      estimated: row.estimated,
      status: row.status,
      note: row.note,
      events: [
        {
          id: id(),
          at: stamp(),
          title: "由 Excel 匯入戶別資料",
          detail: `${row.special ? "特殊案件／" : ""}${row.model || "SPC 待確認"}／${row.colorNo}／${row.estimated}坪`,
          photos: [],
        },
      ],
    }));
    const products = newProductKeys.map((key) => {
      const [model, colorNo] = key.split("|");
      return {
        id: id(),
        brand: "",
        model,
        colorNo,
        spec: "",
        note: "由戶別 Excel 匯入自動建立",
      };
    });
    save(units, products, projectName.trim());
  };
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal-card import-modal-card">
        <div className="panel-head">
          <div>
            <p className="eyebrow">戶別管理</p>
            <h2>匯入 Excel</h2>
            <p>先預覽檢查，不會直接寫入既有資料。</p>
          </div>
          <button className="x" onClick={close} aria-label="關閉">
            ×
          </button>
        </div>
        <label className="import-drop">
          <b>{fileName || "選擇 Excel 或 CSV 檔案"}</b>
          <span>
            欄位：棟別、樓層、戶別、SPC 編號、色號、預估施工坪數／m²、工程狀態、備註
          </span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(event) => parseFile(event.target.files?.[0])}
          />
        </label>
        {message && <div className="form-error">{message}</div>}
        {!!rows.length && (
          <>
            <label className="field import-project-name">
              <span>建案名稱（從檔案標題自動帶入，可修改）</span>
              <input
                value={projectName}
                placeholder="未辨識到標題，請手動輸入"
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            <div className="import-summary">
              <article>
                <span>資料列</span>
                <b>{rows.length}</b>
              </article>
              <article className="import-ok">
                <span>可匯入</span>
                <b>{importable.length}</b>
              </article>
              <article className="import-error">
                <span>待補資料</span>
                <b>{pending}</b>
              </article>
              <article className="import-duplicate">
                <span>重複跳過</span>
                <b>{duplicates}</b>
              </article>
              <article className="import-product">
                <span>新增產品</span>
                <b>{newProductKeys.length}</b>
              </article>
              <article className="import-special">
                <span>特殊案件</span>
                <b>{specialCount}</b>
              </article>
            </div>
            <p className="import-sheet">
              來源工作表：{sheetName}｜辨識格式：{formatName}
            </p>
            <div className="table-wrap import-preview">
              <table>
                <thead>
                  <tr>
                    <th>列</th>
                    <th>棟／樓／戶</th>
                    <th>SPC 編號／色號</th>
                    <th>換算後坪數</th>
                    <th>狀態</th>
                    <th>檢查結果</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.row}>
                      <td>{row.row}</td>
                      <td>
                        {row.building}／{row.floor}／{row.number}
                      </td>
                      <td>
                        {row.model || "待確認"}／{row.colorNo}
                      </td>
                      <td>
                        {Number.isFinite(row.estimated) ? `${row.estimated.toFixed(2)} 坪` : "—"}
                      </td>
                      <td>{row.status}</td>
                      <td>
                        <span
                          className={
                            row.duplicate
                                ? "import-result duplicate"
                              : !row.hasData
                                ? "import-result error"
                              : row.warning
                                ? "import-result error"
                                : row.special
                                  ? "import-result special"
                                  : row.newProduct
                                    ? "import-result product"
                                    : "import-result ok"
                          }
                        >
                          {row.duplicate
                              ? "戶別重複，不匯入"
                            : !row.hasData
                              ? "完全空白，不匯入"
                            : row.warning
                              ? `待補資料：${row.warning}`
                              : row.special
                                ? "特殊案件，可匯入"
                                : row.newProduct
                                  ? "可匯入，將新增產品"
                                  : "可匯入"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="actions import-actions">
          <button className="ghost" onClick={close}>
            取消
          </button>
          <button
            className="primary"
            disabled={!importable.length}
            onClick={confirmImport}
          >
            匯入可匯入的 {importable.length} 戶
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectForm({
  p,
  patch,
}: {
  p: Project;
  patch: (x: Partial<Project>) => void;
}) {
  return (
    <div className="form">
      <section className="panel form">
        <div className="panel-head">
          <div>
            <p className="eyebrow">建立一次，全案共用</p>
            <h2>專案基本資料</h2>
            <p>戶別、場勘、施工、驗收與報告會直接沿用。</p>
          </div>
        </div>
        <div className="grid3">
          {[
            ["name", "建案名稱"],
            ["address", "案場地址"],
            ["builder", "建設公司"],
            ["contact", "工地窗口"],
            ["phone", "聯絡資訊"],
            ["note", "備註"],
          ].map(([k, l]) => (
            <Field key={k} label={l} value={(p as any)[k]} set={(v: string) => patch({ [k]: v })} />
          ))}
          <Field label="預計工程日期" type="date" value={p.expectedDate || ""} set={(expectedDate: string) => patch({ expectedDate })} />
        </div>
        <div className="save-success">✓ 專案資料會自動保存在此裝置</div>
      </section>
    </div>
  );
}
function GlobalProducts({
  products,
  setProducts,
}: {
  products: Product[];
  setProducts: (x: Product[]) => void;
}) {
  const authUserId = useAuthOwner();
  const blank = (): Product => ({
      id: id(),
      brand: "",
      model: "",
      colorNo: "",
      spec: "",
      note: "",
    }),
    formDraftKey = draftKey(authUserId, "global-product", "new"),
    [form, setForm] = useState<Product>(() => readDraft(formDraftKey, blank())),
    [q, setQ] = useState("");
  useOfflineDraftRestore(formDraftKey, setForm);
  useEffect(() => { writeLocalDraft(formDraftKey, form, authUserId); }, [formDraftKey, form, authUserId]);
  const shown = products.filter((x) =>
    [x.brand, x.model, x.colorNo, x.spec, x.note]
      .join(" ")
      .toLowerCase()
      .includes(q.toLowerCase()),
  );
  const add = () => {
    if (
      products.some(
        (x) =>
          x.model.trim() === form.model.trim() &&
          x.colorNo.trim() === form.colorNo.trim(),
      )
    ) {
      alert("此 SPC 編號與色號已存在，請勿重複建立。");
      return;
    }
    setProducts([
      { ...form, model: form.model.trim(), colorNo: form.colorNo.trim() },
      ...products,
    ]);
    setForm(blank());
    removeDurableDraft(formDraftKey);
    void removeOfflineDraft(formDraftKey);
  };
  return (
    <div className="form global-product-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">全系統共用資料</p>
          <h1>SPC 產品資料庫</h1>
          <p>產品只需建立一次，所有案場建立戶別時都能直接選擇。</p>
        </div>
      </div>
      <section className="panel form">
        <div className="panel-head">
          <div>
            <h2>新增 SPC 產品</h2>
            <p>同一個 SPC 編號可以建立多個不同色號。</p>
          </div>
        </div>
        <div className="grid3">
          <Field
            label="品牌／廠商"
            value={form.brand}
            set={(brand) => setForm({ ...form, brand })}
          />
          <Field
            label="SPC 編號"
            value={form.model}
            set={(model) => setForm({ ...form, model })}
          />
          <Field
            label="色號／顏色"
            value={form.colorNo}
            set={(colorNo) => setForm({ ...form, colorNo })}
          />
          <Field
            label="規格"
            value={form.spec}
            set={(spec) => setForm({ ...form, spec })}
          />
          <Field
            label="備註"
            value={form.note}
            set={(note) => setForm({ ...form, note })}
          />
        </div>
        <button
          className="primary"
          disabled={!form.model.trim() || !form.colorNo.trim()}
          onClick={add}
        >
          ＋ 新增至共用產品庫
        </button>
      </section>
      <section className="panel">
        <div className="panel-head product-list-head">
          <div>
            <h2>產品清單</h2>
            <p>目前共 {products.length} 筆產品色號，可供全部案場使用。</p>
          </div>
          <input
            className="product-search"
            placeholder="搜尋編號、色號、品牌或規格"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>品牌</th>
                <th>SPC 編號</th>
                <th>色號</th>
                <th>規格</th>
                <th>備註</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.id}>
                  <td>{x.brand || "—"}</td>
                  <td>
                    <b>{x.model}</b>
                  </td>
                  <td>{x.colorNo}</td>
                  <td>{x.spec || "—"}</td>
                  <td>{x.note || "—"}</td>
                  <td>
                    <button
                      className="danger"
                      onClick={() =>
                        confirm("刪除此產品色號？既有戶別資料不會被改動。") &&
                        setProducts(products.filter((p) => p.id !== x.id))
                      }
                    >
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!shown.length && <p className="no-data">沒有符合的產品資料。</p>}
      </section>
    </div>
  );
}
function Products({
  p,
  patch,
}: {
  p: Project;
  patch: (x: Partial<Project>) => void;
}) {
  const authUserId = useAuthOwner();
  const productDraftKey = draftKey(authUserId, "project-product", p.id);
  const [form, setForm] = useState<Product>(() => readDraft(productDraftKey, {
      id: id(),
      brand: "",
      model: "",
      colorNo: "",
      spec: "",
      note: "",
    })),
    [selected, setSelected] = useState(""),
    [unitId, setUnitId] = useState("");
  useOfflineDraftRestore(productDraftKey, setForm);
  useEffect(() => { writeLocalDraft(productDraftKey, form, authUserId); }, [productDraftKey, form, authUserId]);
  const assign = () => {
    const product = p.products.find((x) => x.id === selected);
    if (!product || !unitId) return;
    patch({
      units: p.units.map((u) =>
        u.id === unitId
          ? {
              ...u,
              brand: product.brand,
              model: product.model,
              colorNo: product.colorNo,
              spec: product.spec,
              events: [
                {
                  id: id(),
                  at: stamp(),
                  title: "完成 SPC 產品選擇",
                  detail: `${product.model}／${product.colorNo}`,
                  photos: [],
                },
                ...u.events,
              ],
            }
          : u,
      ),
    });
  };
  const addProduct = () => {
    if (
      p.products.some(
        (x) => x.model === form.model && x.colorNo === form.colorNo,
      )
    ) {
      alert("此 SPC 編號與色號已存在，請勿重複建立。");
      return;
    }
    patch({ products: [form, ...p.products] });
    setForm({
      id: id(),
      brand: "",
      model: "",
      colorNo: "",
      spec: "",
      note: "",
    });
    removeDurableDraft(productDraftKey);
    void removeOfflineDraft(productDraftKey);
  };
  return (
    <div className="panel form">
      <div className="panel-head">
        <div>
          <h2>SPC 產品資料</h2>
          <p>同一個 SPC 編號可建立多個色號，戶別只能選擇這裡已建立的組合。</p>
        </div>
      </div>
      <div className="grid3">
        <Field
          label="品牌／廠商"
          value={form.brand}
          set={(brand) => setForm({ ...form, brand })}
        />
        <Field
          label="SPC 編號"
          value={form.model}
          set={(model) => setForm({ ...form, model })}
        />
        <Field
          label="色號／顏色"
          value={form.colorNo}
          set={(colorNo) => setForm({ ...form, colorNo })}
        />
        <Field
          label="規格"
          value={form.spec}
          set={(spec) => setForm({ ...form, spec })}
        />
        <Field
          label="備註"
          value={form.note}
          set={(note) => setForm({ ...form, note })}
        />
      </div>
      <button
        className="primary"
        disabled={!form.model || !form.colorNo}
        onClick={addProduct}
      >
        ＋ 新增產品色號
      </button>
      <h3>指定產品給既有戶別</h3>
      <div className="filters">
        <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          <option value="">選擇戶別</option>
          {p.units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.building}／{u.floor}／{u.number}
            </option>
          ))}
        </select>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">選擇 SPC 編號／色號</option>
          {p.products.map((x) => (
            <option key={x.id} value={x.id}>
              {x.model}／{x.colorNo}
            </option>
          ))}
        </select>
        <button
          className="primary"
          disabled={!unitId || !selected}
          onClick={assign}
        >
          套用至戶別
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>品牌</th>
              <th>SPC 編號</th>
              <th>對應色號</th>
              <th>規格</th>
              <th>備註</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {p.products.map((x) => (
              <tr key={x.id}>
                <td>{x.brand}</td>
                <td>
                  <b>{x.model}</b>
                </td>
                <td>{x.colorNo}</td>
                <td>{x.spec}</td>
                <td>{x.note}</td>
                <td>
                  <button
                    className="danger"
                    onClick={() =>
                      confirm("刪除此產品色號？既有戶別資料不會被改動。") &&
                      patch({
                        products: p.products.filter((q) => q.id !== x.id),
                      })
                    }
                  >
                    刪除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function FloorAcceptanceView({ project, context, patchUnitById, openUnit, back }: {
  project: Project;
  context: FloorReturnContext;
  patchUnitById: (unitId: string, updater: (current: Unit) => Unit) => void;
  openUnit: (unitId: string, context: FloorReturnContext) => void;
  back: () => void;
}) {
  const units = floorUnitsFor(project.units, context.building, context.floor);
  const summary = floorWorkbenchSummary(units);
  const [filter, setFilter] = useState<"all" | "incomplete">(context.filter);
  const [expanded, setExpanded] = useState(context.expanded);
  const initialUnitId = units.some((unit) => unit.id === context.currentUnitId)
    ? context.currentUnitId!
    : units.find(floorUnitNeedsAction)?.id || units[0]?.id || "";
  const [currentUnitId, setCurrentUnitId] = useState(initialUnitId);
  const [workMode, setWorkMode] = useState(context.workMode === true);
  const [signaturePanel, setSignaturePanel] = useState(false);
  const [signRole, setSignRole] = useState<FloorSignatureRole | null>(null);
  const [notice, setNotice] = useState("");
  const [batchExportOpen, setBatchExportOpen] = useState(false);
  useEffect(() => {
    if (units.some((unit) => unit.id === currentUnitId)) return;
    setCurrentUnitId(units.find(floorUnitNeedsAction)?.id || units[0]?.id || "");
  }, [units, currentUnitId]);
  const currentUnit = units.find((unit) => unit.id === currentUnitId) || units[0];
  const currentIndex = currentUnit ? units.findIndex((unit) => unit.id === currentUnit.id) : -1;
  const visibleUnits = filter === "incomplete" ? units.filter(floorUnitNeedsAction) : units;
  const returnContext = (tab: "accept" | "sheet" = "accept") => createFloorReturnContext(context.building, context.floor, filter, expanded, window.scrollY, tab, currentUnit?.id, workMode);
  const signatureLabels: Record<FloorSignatureRole, string> = { installer: "施工人員", office: "工務人員", siteManager: "工地主任", supervisor: "神銀主管" };
  const acceptance = currentUnit ? getLatestFinalAcceptance(currentUnit) : undefined;
  const acceptanceState = currentUnit ? floorUnitAcceptanceState(currentUnit) : "uninspected";
  const signatures = currentUnit ? floorUnitSignatures(currentUnit) : {};
  const signatureCount = currentUnit ? floorUnitSignatureCount(currentUnit) : 0;
  const moveTo = (index: number) => {
    const target = units[index];
    if (!target) return;
    setCurrentUnitId(target.id);
    setNotice("");
  };
  const moveToNextPending = () => {
    if (!currentUnit) return;
    const targetId = nextPendingFloorUnitId(units, currentUnit.id);
    if (!targetId) { setNotice("本樓層目前沒有下一個待處理戶"); return; }
    setCurrentUnitId(targetId);
    setNotice("");
  };
  const startWork = () => {
    const target = units.find(floorUnitNeedsAction) || currentUnit || units[0];
    if (target) setCurrentUnitId(target.id);
    setWorkMode(true);
    setNotice("");
  };
  return <div className="floor-acceptance-page">
    <button className="back" onClick={back}>← 返回戶別管理</button>
    <section className="panel floor-acceptance-hero">
      <div><p className="eyebrow">{project.name}</p><h1>{context.building} · {context.floor}</h1><p>{summary.total} 戶</p></div>
      <div className="floor-workbench-counts"><span>驗收完成 <b>{summary.acceptanceComplete} / {summary.total}</b></span><span>四簽完成 <b>{summary.signaturesComplete} / {summary.total}</b></span></div>
    </section>
    <section className="panel floor-unit-section">
      <div className="panel-head"><div><h2>樓層連續驗收工作台</h2><p>逐戶確認驗收與四人簽名，不會共用或複製戶別資料。</p></div><div className="actions"><button className="ghost" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起戶別" : "展開戶別"}</button><button className="ghost" onClick={() => setBatchExportOpen(true)}>匯出驗收單</button><button className="primary" onClick={startWork}>{workMode ? "繼續作業" : "開始／繼續作業"}</button></div></div>
      <div className="floor-filter"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部</button><button className={filter === "incomplete" ? "selected" : ""} onClick={() => setFilter("incomplete")}>待處理</button></div>
      {expanded && <div className="floor-acceptance-grid">{visibleUnits.map((unit) => {
        const state = floorUnitAcceptanceState(unit);
        const count = floorUnitSignatureCount(unit);
        const pending = floorUnitNeedsAction(unit);
        return <button className={`floor-unit-card ${state} ${pending ? "pending" : "complete"} ${currentUnit?.id === unit.id ? "current" : ""}`} key={unit.id} onClick={() => { setCurrentUnitId(unit.id); setWorkMode(true); setNotice(""); }}><b>{unit.number || "未命名"}</b><span>{state === "qualified" ? "✓ 驗收合格" : state === "needsAction" ? "⚠ 待改善" : "○ 未驗收"}</span><small>{count === 4 ? "✓" : "⚠"} 四簽 {count}/4</small></button>;
      })}{!visibleUnits.length && <p className="muted">本樓層目前沒有待處理戶。</p>}</div>}
    </section>
    {workMode && currentUnit && <section className="floor-workbench">
      <aside className="panel floor-workbench-selector" aria-label="本樓層戶別選擇">{units.map((unit) => <button key={unit.id} className={`${unit.id === currentUnit.id ? "current" : ""} ${floorUnitNeedsAction(unit) ? "pending" : "complete"}`} onClick={() => { setCurrentUnitId(unit.id); setNotice(""); }}><b>{unit.number || "未命名"}</b><span>{floorUnitAcceptanceState(unit) === "qualified" ? "✓" : "⚠"} · {floorUnitSignatureCount(unit)}/4</span></button>)}</aside>
      <section className="panel floor-workbench-current">
        <div className="floor-workbench-heading"><div><p className="eyebrow">{context.building} · {context.floor}　{currentIndex + 1}/{units.length}</p><h2>{currentUnit.number || "未命名戶別"}</h2></div><div className={floorUnitNeedsAction(currentUnit) ? "floor-pending" : "floor-ready"}>{floorUnitNeedsAction(currentUnit) ? "待處理" : "✓ 此戶完成"}</div></div>
        <div className="floor-current-status"><span>{acceptanceState === "qualified" ? "✓ 驗收合格" : acceptanceState === "needsAction" ? "⚠ 驗收待改善" : "○ 尚未完成驗收"}</span><span>{signatureCount === 4 ? "✓" : "⚠"} 簽名 {signatureCount}/4</span></div>
        <div className="floor-unit-facts"><div><small>SPC 型號／色號</small><b>{[currentUnit.model, currentUnit.colorNo].filter(Boolean).join("／") || "—"}</b></div>{currentUnit.spec && <div><small>產品規格</small><b>{currentUnit.spec}</b></div>}<div><small>坪數／面積</small><b>{Number.isFinite(currentUnit.estimated) && currentUnit.estimated > 0 ? `${areaValueFromPing(currentUnit.estimated, "坪")} 坪` : "—"}</b></div></div>
        <div className="floor-unit-signatures">{floorSignatureRoles.map((role) => <div key={role} className={signatures[role]?.valid ? "signed" : "unsigned"}><b>{signatureLabels[role]}</b><span>{signatures[role]?.valid ? "✓ 已簽" : "○ 待簽"}</span></div>)}</div>
        {!acceptance && <div className="warning">尚未完成驗收，請先進入完整驗收頁完成正式驗收；系統不會建立假 Acceptance。</div>}
        {signatureCount === 4 && <div className="save-success">✓ 此戶四人簽名完成</div>}
        {notice && <div className="warning">{notice}</div>}
        <div className="floor-workbench-actions"><button className="primary" disabled={!acceptance} onClick={() => setSignaturePanel(true)}>簽名／補簽</button><button className="ghost" onClick={() => openUnit(currentUnit.id, returnContext("accept"))}>查看完整驗收資料</button>{signatureCount === 4 && <button className="ghost" onClick={moveToNextPending}>下一個待處理 →</button>}</div>
      </section>
      <nav className="floor-workbench-nav" aria-label="樓層戶別導覽"><button className="ghost" disabled={currentIndex <= 0} onClick={() => moveTo(currentIndex - 1)}>← <span>上一戶</span></button><button className="primary" onClick={moveToNextPending}>下一待處理</button><button className="ghost" disabled={currentIndex < 0 || currentIndex >= units.length - 1} onClick={() => moveTo(currentIndex + 1)}><span>下一戶</span> →</button></nav>
    </section>}
    {signaturePanel && currentUnit && !signRole && <Modal close={() => setSignaturePanel(false)} title={`${currentUnit.number || "戶別"}｜簽名／補簽`}><div className="floor-quick-sign-list">{floorSignatureRoles.map((role) => <button className={signatures[role]?.valid ? "signed" : "unsigned"} key={role} onClick={() => setSignRole(role)}><b>{signatureLabels[role]}</b><span>{signatures[role]?.valid ? "✓ 已簽 · 重新簽名" : "○ 待簽 · 開始簽名"}</span></button>)}</div><p className="muted">簽名只會儲存到目前戶別的最新正式驗收。</p></Modal>}
    {signRole && currentUnit && <Sign close={() => setSignRole(null)} save={(signature) => { const targetUnitId = currentUnit.id; const targetRole = signRole; patchUnitById(targetUnitId, (latestUnit) => updateLatestFormalAcceptanceSignature(latestUnit, targetRole, signature)); setSignRole(null); setSignaturePanel(false); }} />}
    {batchExportOpen && <FloorBatchExport project={project} units={units} context={context} close={() => setBatchExportOpen(false)} />}
  </div>;
}

const completionCopyLabels = ["第一聯：客戶存根聯", "第二聯：公司收執聯", "第三聯：廠商收執聯"] as const;

function FloorBatchExport({ project, units, context, close }: { project: Project; units: Unit[]; context: FloorReturnContext; close: () => void }) {
  const [stage, setStage] = useState<"select" | "edit" | "confirm">("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, CompletionExportDraft>>({});
  const [resolvedByUnit, setResolvedByUnit] = useState<Record<string, ResolvedFloorSignatures>>({});
  const [currentUnitId, setCurrentUnitId] = useState("");
  const floorRecord = (project.floorAcceptances || []).find((record) => record.building === context.building && record.floor === context.floor);
  const exportableIds = floorBatchSelectableIds(units);
  const selectedUnits = units.filter((unit) => selectedIds.includes(unit.id));
  const currentUnit = selectedUnits.find((unit) => unit.id === currentUnitId) || selectedUnits[0];
  const currentIndex = currentUnit ? selectedUnits.findIndex((unit) => unit.id === currentUnit.id) : -1;
  const signatureLabels: Record<FloorSignatureRole, string> = { installer: "施工人員", office: "工務人員", siteManager: "工地主任", supervisor: "神銀主管" };
  const createUnitExport = (unit: Unit) => {
    const acceptance = getLatestFinalAcceptance(unit)!;
    const completion = completionDefaults(acceptance, unit);
    const resolved = resolveUnitSignatures(unit, floorRecord, units);
    const draft = buildCompletionExportDraft(project, unit, acceptance, completion);
    return {
      resolved,
      draft: { ...draft, signatureNames: { ...draft.signatureNames, ...Object.fromEntries(floorSignatureRoles.map((role) => [role, resolved.signatures[role]?.name || draft.signatureNames[role]])) } } as CompletionExportDraft,
    };
  };
  const beginEdit = () => {
    const targets = units.filter((unit) => selectedIds.includes(unit.id) && getLatestFinalAcceptance(unit));
    const initialized = buildUnitScopedRecord(targets, createUnitExport);
    setDrafts(buildUnitScopedRecord(targets, (unit) => initialized[unit.id].draft));
    setResolvedByUnit(buildUnitScopedRecord(targets, (unit) => initialized[unit.id].resolved));
    setCurrentUnitId(targets[0]?.id || "");
    setStage("edit");
  };
  const setCurrentDraft = (update: (draft: CompletionExportDraft) => CompletionExportDraft) => {
    if (!currentUnit) return;
    setDrafts((record) => updateUnitScopedRecord(record, currentUnit.id, update));
  };
  const currentDraft = currentUnit ? drafts[currentUnit.id] : undefined;
  const conflictUnits = selectedUnits.filter((unit) => (resolvedByUnit[unit.id]?.conflicts.length || 0) > 0);
  const incompleteSignatureUnits = selectedUnits.filter((unit) => floorSignatureRoles.filter((role) => resolvedByUnit[unit.id]?.signatures[role]?.valid).length < 4);
  return <>
    <Modal close={close} title={`${context.building} · ${context.floor}｜樓層驗收單批次匯出`}>
      <div className="floor-batch-export">
        <div className="floor-batch-steps"><span className={stage === "select" ? "current" : ""}>1 選擇戶別</span><span className={stage === "edit" ? "current" : ""}>2 編輯確認</span><span className={stage === "confirm" ? "current" : ""}>3 匯出確認</span></div>
        {stage === "select" && <section className="floor-batch-select">
          <div className="panel-head"><div><h3>選擇本樓層要匯出的戶別</h3><p>只有正式驗收可匯出；簽名未滿或舊資料衝突仍可選取並會顯示提醒。</p></div><button className="ghost" onClick={() => setSelectedIds(exportableIds)}>全選可匯出</button></div>
          <div className="floor-batch-unit-grid">{units.map((unit) => {
            const acceptance = getLatestFinalAcceptance(unit);
            const resolved = acceptance ? resolveUnitSignatures(unit, floorRecord, units) : undefined;
            const signatureCount = resolved ? floorSignatureRoles.filter((role) => resolved.signatures[role]?.valid).length : 0;
            const disabled = !acceptance;
            return <label className={`floor-batch-unit ${disabled ? "disabled" : ""}`} key={unit.id}><input type="checkbox" disabled={disabled} checked={selectedIds.includes(unit.id)} onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, unit.id] : ids.filter((id) => id !== unit.id))} /><span><b>{unit.number || "未命名戶別"}</b><small>{disabled ? "尚未完成正式驗收" : `${floorUnitAcceptanceState(unit) === "qualified" ? "驗收合格" : "驗收待改善"} · ${signatureCount === 4 ? "✓ 四簽 4/4" : `⚠ 四簽 ${signatureCount}/4`}`}</small>{!!resolved?.conflicts.length && <em>⚠ 舊簽名資料不一致</em>}</span></label>;
          })}</div>
          <div className="floor-batch-footer"><b>已選 {selectedIds.length} 戶</b><div className="actions"><button className="ghost" onClick={close}>取消</button><button className="primary" disabled={!selectedIds.length} onClick={beginEdit}>下一步：編輯資料</button></div></div>
        </section>}
        {stage === "edit" && currentUnit && currentDraft && <section className="floor-batch-edit">
          <div className="floor-batch-unit-selector" aria-label="批次匯出戶別切換">{selectedUnits.map((unit, index) => <button className={unit.id === currentUnit.id ? "current" : ""} key={unit.id} onClick={() => setCurrentUnitId(unit.id)}>{unit.number || "未命名"}<small>{index + 1}/{selectedUnits.length}</small></button>)}</div>
          <div className="panel-head"><div><p className="eyebrow">準備匯出 {selectedUnits.length} 戶</p><h3>{currentUnit.number || "未命名戶別"}｜文件資料</h3><p>第 {currentIndex + 1} 戶，共 {selectedUnits.length} 戶；修改只影響本次匯出。</p></div><button className="ghost" onClick={() => { const initialized = createUnitExport(currentUnit); setDrafts((record) => ({ ...record, [currentUnit.id]: initialized.draft })); }}>還原此戶自動資料</button></div>
          {!!resolvedByUnit[currentUnit.id]?.conflicts.length && <div className="warning">此戶舊簽名資料不一致：{resolvedByUnit[currentUnit.id].conflicts.map((role) => signatureLabels[role]).join("、")}。</div>}
          <div className="floor-batch-export-editor-grid">
            {([['department','部門別'],['officePerson','工務人員'],['projectName','案場名稱'],['projectAddress','案場地址'],['order','訂單編號'],['constructionDate','施工日期'],['highlights','其他重點列示'],['area','坪數確認'],['unitDisplay','戶別'],['abnormalUnit','地坪異常戶別'],['damagedMaterialType','損壞板材種類'],['materialModel','板材型號']] as const).map(([key,label]) => <Field key={key} label={label} value={currentDraft[key]} set={(value) => setCurrentDraft((draft) => ({ ...draft, [key]: value }))} />)}
            <CompletionDraftBoolean label="地坪是否異常" value={currentDraft.floorAbnormal} set={(value) => setCurrentDraft((draft) => ({ ...draft, floorAbnormal: value }))} />
            <CompletionDraftBoolean label="現場板材是否損壞" value={currentDraft.boardDamaged} set={(value) => setCurrentDraft((draft) => ({ ...draft, boardDamaged: value }))} />
            <CompletionDraftBoolean label="現場垃圾是否清運完畢" value={currentDraft.trashCleared} set={(value) => setCurrentDraft((draft) => ({ ...draft, trashCleared: value }))} />
            {floorSignatureRoles.map((role) => <Field key={role} label={`${signatureLabels[role]}簽名人姓名`} value={currentDraft.signatureNames[role]} set={(value) => setCurrentDraft((draft) => ({ ...draft, signatureNames: { ...draft.signatureNames, [role]: value } }))} />)}
          </div>
          <div className="floor-batch-footer"><button className="ghost" onClick={() => setStage("select")}>返回選擇</button><div className="actions"><button className="ghost" disabled={currentIndex <= 0} onClick={() => setCurrentUnitId(selectedUnits[currentIndex - 1].id)}>← 上一戶</button>{currentIndex < selectedUnits.length - 1 ? <button className="primary" onClick={() => setCurrentUnitId(selectedUnits[currentIndex + 1].id)}>儲存本次修改並下一戶 →</button> : <button className="primary" onClick={() => setStage("confirm")}>下一步：總確認</button>}</div></div>
        </section>}
        {stage === "confirm" && <section className="floor-batch-confirm">
          <div><p className="eyebrow">{context.building} · {context.floor}</p><h3>準備匯出 {selectedUnits.length} 戶</h3></div><div className="floor-batch-summary"><span>戶別<b>{selectedUnits.length}</b></span><span>三聯驗收單組數<b>{selectedUnits.length}</b></span><span>驗收單聯數<b>{selectedUnits.length * 3}</b></span></div>
          {!!incompleteSignatureUnits.length && <div className="warning">{incompleteSignatureUnits.length} 戶簽名未滿 4/4，空缺簽名將保持空白。</div>}
          {!!conflictUnits.length && <div className="warning">{conflictUnits.length} 戶有舊簽名資料衝突，系統不會自行選用衝突簽名。</div>}
          <div className="floor-batch-review">{selectedUnits.map((unit) => { const count = floorSignatureRoles.filter((role) => resolvedByUnit[unit.id]?.signatures[role]?.valid).length; return <div key={unit.id}><b>{unit.number || "未命名戶別"}</b><span>{[unit.model, unit.colorNo].filter(Boolean).join("／") || "—"} · {drafts[unit.id]?.area ? `${drafts[unit.id].area} 坪` : "坪數 —"}</span><small>{floorUnitAcceptanceState(unit) === "qualified" ? "驗收合格" : "驗收待改善"} · {count === 4 ? "四簽 4/4" : `四簽 ${count}/4 ⚠`}</small>{!!resolvedByUnit[unit.id]?.conflicts.length && <em>⚠ legacy 簽名資料衝突</em>}</div>; })}</div>
          <div className="floor-batch-footer"><button className="ghost" onClick={() => setStage("edit")}>返回修改</button><button className="primary" onClick={() => printWithLifecycleCleanup("printing-completion-batch")}>確認並匯出</button></div>
        </section>}
      </div>
    </Modal>
    <div className="floor-batch-print" aria-hidden="true">{selectedUnits.map((unit) => drafts[unit.id] && resolvedByUnit[unit.id] ? <div className="completion-paper floor-batch-paper" key={unit.id}>{completionCopyLabels.map((copy) => <CompletionCopy key={copy} copy={copy} draft={drafts[unit.id]} signatures={resolvedByUnit[unit.id].signatures} />)}</div> : null)}</div>
  </>;
}

function UnitDetail({
  project,
  unit,
  role,
  activity,
  patch,
  patchProject,
  addEvent,
  back,
  floorContext,
  floorUnits,
  openUnit,
  remove,
}: {
  project: Project;
  unit: Unit;
  role: AppRole;
  activity?: EntityActivity;
  patch: (x: Partial<Unit>) => void;
  patchProject: (x: Partial<Project>) => void;
  addEvent: (a: string, b: string, p?: Photo[]) => void;
  back: () => void;
  floorContext: FloorReturnContext | null;
  floorUnits: Unit[];
  openUnit: (unitId: string) => void;
  remove: () => void;
}) {
  const [tab, setTab] = useState(floorContext?.tab || "master");
  useEffect(() => { if (floorContext?.tab) setTab(floorContext.tab); }, [unit.id, floorContext?.tab]);
  useEffect(() => {
    if (!canUseUnitTab(role, tab)) setTab("master");
  }, [role, tab]);
  return (
    <>
      <button className="back" onClick={back}>
        {floorContext ? `← 返回 ${floorContext.floor || "未分類樓層"} 樓層驗收` : "← 返回戶別管理"}
      </button>
      {floorContext && <div className="floor-unit-navigation">
        <button className="ghost" disabled={floorUnits.findIndex((item) => item.id === unit.id) <= 0} onClick={() => {
          const index = floorUnits.findIndex((item) => item.id === unit.id);
          if (index > 0) openUnit(floorUnits[index - 1].id);
        }}>← 上一戶</button>
        <span>{floorContext.building} · {floorContext.floor}</span>
        <button className="ghost" disabled={floorUnits.findIndex((item) => item.id === unit.id) < 0 || floorUnits.findIndex((item) => item.id === unit.id) >= floorUnits.length - 1} onClick={() => {
          const index = floorUnits.findIndex((item) => item.id === unit.id);
          if (index >= 0 && index < floorUnits.length - 1) openUnit(floorUnits[index + 1].id);
        }}>下一戶 →</button>
      </div>}
      <div className="unit-head">
        <div className="unit-head-copy">
          <p className="eyebrow">{project.name}</p>
          <h1 className="unit-head-title">
            {unit.building} · {unit.floor} · {unit.number}
          </h1>
          <p className="unit-head-meta">
            {unit.brand} {unit.model}／{unit.colorNo} · 預估 {unit.estimated} 坪
          </p>
          {activity && <small className="muted">最後修改：{activity.updatedByEmail || "未知帳號"} · {new Date(activity.updatedAt).toLocaleString("zh-TW")}</small>}
        </div>
        <div className="unit-head-status">
          <small>目前工程狀態</small>
          <Pill s={unit.status} />
        </div>
      </div>
      <Next unit={unit} setTab={setTab} />
      <div id="unit-action-area" style={{ scrollMarginTop: 80 }}>
        <Tabs
          value={tab}
          set={setTab}
          items={[
            ["master", "戶別主資料"],
            ["survey", "場勘"],
            ["work", "施工"],
            ["accept", "驗收／複驗"],
            ["journal", "驗收日誌"],
            ["defect", "缺失改善"],
            ["timeline", "Timeline"],
            ["sheet", "電子驗收單"],
          ].filter(([value]) => canUseUnitTab(role, value))}
        />
        {tab === "master" && (
          <Master
            p={project}
            u={unit}
            role={role}
            patch={patch}
            patchProject={patchProject}
            remove={remove}
          />
        )}{" "}
        {tab === "survey" && (
          <SurveyTab project={project} u={unit} patch={patch} add={addEvent} />
        )}{" "}
        {tab === "work" && <WorkTab u={unit} patch={patch} add={addEvent} />}{" "}
        {tab === "accept" && (
          <AcceptTab key={unit.id} project={project} u={unit} patch={patch} add={addEvent} />
        )}{" "}
        {tab === "journal" && <UnitJournalTab project={project} u={unit} patch={patch} />}{" "}
        {tab === "defect" && (
          <DefectsTab u={unit} patch={patch} add={addEvent} />
        )}{" "}
        {tab === "timeline" && <Timeline u={unit} />}{" "}
        {tab === "sheet" && <Sheet project={project} u={unit} />}
      </div>
    </>
  );
}
function Next({ unit, setTab }: { unit: Unit; setTab: (x: string) => void }) {
  const map: Record<string, [string, string, string]> = {
    待確認: [
      "確認戶別資料",
      "確認型號、色號與預估坪數後即可安排場勘",
      "master",
    ],
    待場勘: ["開始場勘", "判斷現場是否符合 SPC 進場條件", "survey"],
    場勘待改善: ["登記改善", "完成改善並確認是否可進場", "defect"],
    可進場: ["新增施工紀錄", "填寫施工日期、人數、坪數與現場照片", "work"],
    施工中: ["繼續施工或完成施工", "保留本次紀錄，完成後送往驗收", "work"],
    待驗收: ["開始驗收", "確認施工品質、坪數並完成簽名", "accept"],
    驗收缺失: ["新增改善結果", "指定責任單位與改善期限", "defect"],
    改善中: ["更新改善進度", "上傳改善後照片並送往複驗", "defect"],
    待複驗: ["開始複驗", "確認缺失已改善後完成驗收", "accept"],
    已驗收: ["產生電子驗收單", "預覽內容並匯出正式文件", "sheet"],
    已計價: ["查看完整工程歷程", "此戶已完成計價，可查詢所有紀錄", "timeline"],
  };
  const [x, , t] = map[unit.status];
  return (
    <div className="next-card">
      <div>
        <h2>{x}</h2>
      </div>
      <button
        onClick={() => {
          setTab(t);
          setTimeout(
            () =>
              document
                .getElementById("unit-action-area")
                ?.scrollIntoView({ behavior: "smooth", block: "start" }),
            60,
          );
        }}
      >
        立即處理 →
      </button>
    </div>
  );
}
function Master({
  p,
  u,
  role,
  patch,
  patchProject,
  remove,
}: {
  p: Project;
  u: Unit;
  role: AppRole;
  patch: (x: Partial<Unit>) => void;
  patchProject: (x: Partial<Project>) => void;
  remove: () => void;
}) {
  const isCrew = role === "crew";
  const canManage = canManageProjectData(role);
  const [estimatedUnit, setEstimatedUnit] = useState<AreaUnit>("坪");
  const models = [...new Set(p.products.map((x) => x.model).filter(Boolean))],
    colors = [
      ...new Set(
        p.products
          .filter((x) => x.model === u.model)
          .map((x) => x.colorNo)
          .filter(Boolean),
      ),
    ];
  const choose = (model: string, colorNo: string) => {
    const product = p.products.find(
      (x) => x.model === model && x.colorNo === colorNo,
    );
    patch(
      product
        ? { brand: product.brand, model, colorNo, spec: product.spec }
        : { model, colorNo },
    );
  };
  return (
    <div className="panel form">
      <div className="panel-head">
        <div>
          <h2>戶別主資料</h2>
          <p>後續場勘、施工、驗收均直接沿用。</p>
        </div>
        {canManage && <button
          className="danger"
          onClick={() => confirm("確定刪除此戶及全部工程紀錄？") && remove()}
        >
          刪除戶別
        </button>}
      </div>
      <div className="grid3">
        <Field
          label="建案名稱（全案共用）"
          value={p.name}
          disabled={!canManage}
          set={(name: string) => patchProject({ name })}
        />
        <Field
          label="棟別"
          value={u.building}
          disabled={isCrew}
          set={(building: string) => patch({ building })}
        />
        <Field
          label="樓層"
          value={u.floor}
          disabled={isCrew}
          set={(floor: string) => patch({ floor })}
        />
        <Field
          label="戶別"
          value={u.number}
          disabled={isCrew}
          set={(number: string) => patch({ number })}
        />
        <label className="field">
          <span>SPC 編號</span>
          <select disabled={isCrew} value={u.model} onChange={(e) => choose(e.target.value, "")}>
            <option value="">請選擇產品編號</option>
            {models.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>色號</span>
          <select
            disabled={isCrew || !u.model}
            value={u.colorNo}
            onChange={(e) => choose(u.model, e.target.value)}
          >
            <option value="">請選擇色號</option>
            {colors.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <Field label="品牌／廠商" value={u.brand} disabled />
        <Field label="規格" value={u.spec} disabled />
        <label className="field">
          <span>預估施工坪數</span>
          <div className="area-input-row">
            <input
              type="number"
              min="0"
              step="0.01"
              value={areaValueFromPing(u.estimated, estimatedUnit)}
              disabled={isCrew}
              onChange={(event) => patch({ estimated: areaInputToPing(event.target.value, estimatedUnit) })}
            />
            <select disabled={isCrew} value={estimatedUnit} onChange={(event) => setEstimatedUnit(event.target.value as AreaUnit)}>
              <option value="坪">坪</option>
              <option value="m²">m²</option>
            </select>
          </div>
        </label>
        <Field
          label="備註"
          value={u.note}
          disabled={isCrew}
          set={(note: string) => patch({ note })}
        />
      </div>
      <label>
        <input
          type="checkbox"
          disabled={isCrew}
          checked={u.custom}
          onChange={(e) => patch({ custom: e.target.checked })}
        />{" "}
        客變戶
      </label>
      {u.custom && (
        <Field
          label="客變說明"
          value={u.customNote}
          disabled={isCrew}
          set={(customNote: string) => patch({ customNote })}
        />
      )}
      {!isCrew && <section className="customer-section">
        <div className="panel-head">
          <div>
            <p className="eyebrow">選填資料</p>
            <h3>客戶聯絡資料</h3>
            <p>供工程聯繫使用；未填寫不影響工程流程。</p>
          </div>
        </div>
        <div className="grid3">
          <Field label="客戶姓名" value={u.owner} set={(owner: string) => patch({ owner })} />
          <Field label="聯絡電話" value={u.phone} set={(phone: string) => patch({ phone })} />
          <Field label="LINE ID" value={u.lineId} set={(lineId: string) => patch({ lineId })} />
          <Field label="Email" type="email" value={u.email} set={(email: string) => patch({ email })} />
          <label className="field">
            <span>身分類型</span>
            <select value={u.customerRole} onChange={(e) => patch({ customerRole: e.target.value })}>
              <option value="">未選擇</option>
              <option>屋主</option><option>家人</option><option>設計師</option><option>其他</option>
            </select>
          </label>
          <label className="field">
            <span>偏好聯絡方式</span>
            <select value={u.contactPreference} onChange={(e) => patch({ contactPreference: e.target.value })}>
              <option value="">未選擇</option>
              <option>電話</option><option>LINE</option><option>Email</option>
            </select>
          </label>
          <Field label="客戶需求／備註" value={u.customerNeed} set={(customerNeed: string) => patch({ customerNeed })} />
          <Field label="資料來源" value={u.customerSource} set={(customerSource: string) => patch({ customerSource })} />
        </div>
        <label className="consent-check">
          <input
            type="checkbox"
            checked={u.marketingConsent}
            onChange={(e) => patch({ marketingConsent: e.target.checked, consentAt: e.target.checked ? stamp() : "" })}
          />
          <span><b>同意接收後續服務資訊</b><small>此項與工程聯絡用途分開，可隨時取消。</small></span>
        </label>
        {u.marketingConsent && <div className="consent-time">同意時間：{u.consentAt}</div>}
      </section>}
      {canManage && (u.status === "待確認" ? (
        <button
          className="primary"
          disabled={
            !p.name.trim() ||
            !u.building ||
            !u.floor ||
            !u.number ||
            !u.model ||
            !u.colorNo
          }
          onClick={() =>
            patch({
              status: "待場勘",
              events: [
                {
                  id: id(),
                  at: stamp(),
                  title: "主資料確認完成",
                  detail: "資料確認無誤，已安排進入待場勘",
                  photos: [],
                },
                ...u.events,
              ],
            })
          }
        >
          確認資料無誤 → 安排場勘
        </button>
      ) : (
        <div className="save-success">
          ✓ 戶別主資料已建立，後續工程節點將直接沿用
        </div>
      ))}
    </div>
  );
}
function AutoRecord({ label, at }: { label: string; at: string }) {
  return <div className="auto-record"><span>●</span><div><b>{label}</b><small>{at || stamp()}｜由系統自動記錄，不需另外填寫</small></div></div>;
}
function InspectionGuide() {
  return <div className="inspection-guide" aria-label="檢查操作順序"><span>① 檢查項目</span><span>② 合格／不合格／待確認</span><span>③ 數值／選項</span><span>④ 📷 照片</span><span>⑤ 📝 備註</span><span>⑥ 💾 暫存／✓ 完成</span></div>;
}
function SurveyTab({
  project,
  u,
  patch,
  add,
}: {
  project: Project;
  u: Unit;
  patch: (x: Partial<Unit>) => void;
  add: any;
}) {
  const authUserId = useAuthOwner();
  const fallback: Survey = {
      id: id(),
      date: day(),
      person: readLocal(scopedKey("spc-last-survey-person", authUserId)),
      items: surveyLabels.map((label) => ({
        label,
        result: "" as Choice,
        note: "",
        photos: [],
      })),
      photos: [],
      note: "",
      decision: "可進場",
      areaStatus: "pending",
      areaValue: undefined,
      areaUnit: "坪",
      doorInspection: { thresholdCm: undefined, meetsThreshold: false, hasGap: null, result: "不合格", rationale: "", note: "", photos: [] },
      siliconeInspection: { matchesFloor: null, otherColor: "", note: "", photos: [] },
      dividerInspection: { needed: "待確認", quantity: undefined, location: "", note: "", photos: [] },
      parking: { count: "", location: "", note: "", photos: [] },
      stagingArea: { location: "", note: "", cautions: "", photos: [] },
      surveySignatures: [],
      startedAt: stamp(),
    },
    [s, setS] = useState<Survey>(() =>
      readDraft(draftKey(authUserId, "survey", u.id), fallback),
    ),
    [risk, setRisk] = useState(false),
    [surveySigning, setSurveySigning] = useState(false),
    [surveyDetail, setSurveyDetail] = useState<"door" | "silicone" | "divider" | "parking" | "staging" | "signatures" | null>(null),
    [doorFlowActive, setDoorFlowActive] = useState(false),
    [doorFlowResume, setDoorFlowResume] = useState(0),
    [saved, setSaved] = useState(""),
    [confirming, setConfirming] = useState(false);
  useOfflineDraftRestore(draftKey(authUserId, "survey", u.id), setS);
  useEffect(() => {
    writeLocalDraft(draftKey(authUserId, "survey", u.id), s, authUserId);
  }, [s, u.id, authUserId]);
  const door = s.doorInspection || { thresholdCm: undefined, meetsThreshold: false, hasGap: null, result: "不合格" as const, rationale: "", note: "", photos: [] },
    silicone = s.siliconeInspection || { matchesFloor: null, otherColor: "", note: "", photos: [] },
    divider = s.dividerInspection || { needed: "待確認" as const, quantity: undefined, location: "", note: "", photos: [] },
    parking = s.parking || { count: "" as const, location: "", note: "", photos: [] },
    stagingArea = s.stagingArea || { location: "", note: "", cautions: "", photos: [] },
    surveySignatures = s.surveySignatures || [],
    doorMeasured = Number.isFinite(Number(door.thresholdCm)) && Number(door.thresholdCm) > 0,
    doorThresholdFailed = doorMeasured && Number(door.thresholdCm) < 1.5,
    doorResult: "合格" | "不合格" = doorThresholdFailed || door.hasGap === true ? "不合格" : "合格",
    updateDoor = (change: Partial<NonNullable<Survey["doorInspection"]>>) => {
      const next = { ...door, ...change };
      const nextMeasured = Number.isFinite(Number(next.thresholdCm)) && Number(next.thresholdCm) > 0;
      next.meetsThreshold = nextMeasured && Number(next.thresholdCm) >= 1.5;
      next.result = (nextMeasured && Number(next.thresholdCm) < 1.5) || next.hasGap === true ? "不合格" : "合格";
      setS({ ...s, doorInspection: next });
    },
    doorItems = s.items.filter((item) => doorSurveyLabels.includes(item.label)),
    updateDoorItem = (label: string, change: Partial<CheckItem>) => setS({ ...s, items: s.items.map((item) => item.label === label ? { ...item, ...change } : item) }),
    doorItemsInvalid = doorItems.length !== doorSurveyLabels.length || doorItems.some((item) => !item.result),
    doorItemsBad = doorItems.some((item) => item.result === "不合格"),
    doorItemEvidenceInvalid = doorItems.some((item) => item.result === "不合格" && (!item.note.trim() || !item.photos?.length)),
    doorBad: CheckItem[] = doorResult === "不合格" ? [{ label: "門檻檢查", result: "不合格", note: [door.rationale, door.note].filter(Boolean).join("；"), photos: door.photos }] : [],
    bad = [...s.items.filter((x) => x.result === "不合格"), ...doorBad],
    incomplete = s.items.some((x) => !x.result),
    invalidBad = bad.some((x) => !x.note.trim() || !x.photos?.length),
    doorInvalid = door.hasGap === null || (doorResult === "不合格" && (!door.rationale.trim() || !door.photos?.length)),
    doorCombinedInvalid = doorInvalid || doorItemsInvalid || doorItemEvidenceInvalid,
    doorCombinedResult = !doorCombinedInvalid && doorResult === "合格" && !doorItemsBad ? "合格" : "不合格",
    siliconeInvalid = silicone.matchesFloor === null || (silicone.matchesFloor === false && !silicone.otherColor.trim()),
    dividerInvalid = divider.needed === "是" && (!Number.isFinite(Number(divider.quantity)) || Number(divider.quantity) <= 0 || !divider.location.trim()),
    signaturesInvalid = surveySignatures.filter((signature) => signature.valid).length < 2,
    surveyChecklistItems = [
      ...s.items.filter((item) => !doorSurveyLabels.includes(item.label) && item.label !== "其他異常"),
      ...s.items.filter((item) => item.label === "其他異常"),
    ],
    allPhotos = [...s.photos, ...s.items.flatMap((x) => x.photos || []), ...(door.photos || []), ...(silicone.photos || []), ...(divider.photos || []), ...(parking.photos || []), ...(stagingArea.photos || [])],
    saveDraft = () => {
      const draft = { ...s, draft: true };
      patch({ surveys: [draft, ...u.surveys.filter((record) => record.id !== s.id)] });
      writeLocalDraft(draftKey(authUserId, "survey", u.id), draft, authUserId);
      queueRecordChange(authUserId, "survey", u.id, draft);
      setSaved("✓ 場勘草稿已暫存；換裝置或重新整理後仍可繼續");
    },
    save = () => {
      const survey: Survey = {
        ...s,
        draft: false,
        doorInspection: { ...door, meetsThreshold: doorMeasured && Number(door.thresholdCm) >= 1.5, result: doorResult },
      };
      const status: Status = s.decision === "可進場" ? "可進場" : "場勘待改善";
      patch({
        surveys: u.surveys.some((record) => record.id === survey.id)
          ? u.surveys.map((record) => record.id === survey.id ? survey : record)
          : [survey, ...u.surveys],
        status,
        events: [
          {
            id: id(),
            at: stamp(),
            title: "完成場勘",
            detail: `結果：${s.decision}`,
            photos: allPhotos,
          },
          ...u.events,
        ],
        defects:
          s.decision === "待改善"
            ? [
                ...bad.map((x) => ({
                  id: id(),
                  source: "場勘" as const,
                  type: x.label,
                  content: x.note,
                  unit: "待指定",
                  due: "",
                  status: "待改善" as const,
                  before: x.photos || [],
                  after: [],
                  fix: "",
                  completed: "",
                })),
                ...u.defects,
              ]
            : u.defects,
      });
      add("完成場勘", s.decision, allPhotos);
      localStorage.setItem(scopedKey("spc-last-survey-person", authUserId), s.person);
      removeDurableDraft(draftKey(authUserId, "survey", u.id));
      queueRecordChange(authUserId, "survey", u.id, survey, "complete");
      setSaved("✓ 場勘結果已儲存成功");
      setConfirming(false);
    };
  return (
    <div className="panel form survey-tab">
      <div className="panel-head">
        <div>
          <h2>進場條件場勘</h2>
          <p>基本資料會沿用至後續所有工程節點。</p>
        </div>
      </div>
      <InspectionGuide />
      <AutoRecord label="場勘開始時間" at={s.startedAt || s.date} />
      <section className="survey-area-panel survey-estimated-area">
        <div><h3>預估施工坪數</h3><p>沿用戶別主資料，此處僅供查看。</p></div>
        <strong>{u.estimated} 坪</strong>
      </section>
      {surveyDetail === "door" && <Modal close={() => { setSurveyDetail(null); setDoorFlowActive(false); }} title="門與門檻檢查"><section className="survey-area-panel door-inspection-panel">
        <div className="panel-head"><div><h3>門與門檻檢查</h3><p>門框、門扇、廁所門框與門檻集中在同一頁完成；門檻標準至少 1.5 cm 且不可有空隙。</p></div><span className={doorCombinedResult === "合格" ? "status done" : "status danger"}>{doorCombinedInvalid ? "尚未完成" : doorCombinedResult}</span></div>
        <div className="door-combined-checks">
          {doorItems.map((item) => <section className={`door-subcheck ${item.result === "合格" ? "good" : item.result === "不合格" ? "bad" : ""}`} key={item.label}><b>{item.label}</b><div className="result-actions">{(["合格", "不合格", "不適用"] as Choice[]).map((result) => <button type="button" key={result} className={item.result === result ? `selected ${result === "合格" ? "good" : result === "不合格" ? "bad" : "na"}` : ""} onClick={() => updateDoorItem(item.label, { result })}>{result}</button>)}</div><label className="field"><span>備註／原因</span><textarea value={item.note} onChange={(event) => updateDoorItem(item.label, { note: event.target.value })} placeholder={item.result === "不合格" ? "請填寫原因及改善方式" : "可補充現場狀況"} /></label><Photos node={`場勘｜${item.label}`} label={`${item.label}照片`} photos={item.photos || []} set={(photos: Photo[]) => updateDoorItem(item.label, { photos })} /></section>)}
        </div>
        <div className="grid3">
          <label className="field"><span>門檻實際測量（cm）</span><input type="number" min="0" step="0.1" value={door.thresholdCm ?? ""} onChange={(event) => updateDoor({ thresholdCm: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
          <div className="completion-check"><b>是否達到至少 1.5 cm</b><strong>{doorMeasured ? (Number(door.thresholdCm) >= 1.5 ? "✓ 是" : "✕ 否") : "等待輸入實測值"}</strong></div>
          <div className="completion-check"><b>門檻是否有空隙</b><div><button type="button" className={door.hasGap === true ? "selected" : ""} onClick={() => updateDoor({ hasGap: true })}>有空隙</button><button type="button" className={door.hasGap === false ? "selected" : ""} onClick={() => updateDoor({ hasGap: false })}>無空隙</button></div></div>
        </div>
        <label className="field"><span>{doorResult === "合格" && !doorItemsBad ? "判斷依據（選填）" : "為什麼不合格／如何改善（必填）"}</span><textarea value={door.rationale} onChange={(event) => updateDoor({ rationale: event.target.value })} placeholder={doorResult === "合格" && !doorItemsBad ? "正常情況可不填；如有測量可補充數值與現況" : "請說明不合格原因及預計改善方式"} /></label>
        <Field label="門檢查備註" value={door.note} set={(note: string) => updateDoor({ note })} />
        <Photos node="場勘｜門檢查" label="門檢查照片" photos={door.photos || []} set={(photos: Photo[]) => updateDoor({ photos })} />
        {doorCombinedInvalid && <div className="form-error">請完成門框、門扇、廁所門框與空隙確認；有不合格時必須補充問題說明及照片。</div>}
        {doorResult === "不合格" && (!door.rationale.trim() || !door.photos?.length) && <div className="form-error">門檢查不合格時，必須說明如何改善並上傳至少 1 張照片。</div>}
        <div className="form-actions"><button type="button" className="primary" disabled={doorCombinedInvalid} onClick={() => { setSurveyDetail(null); if (doorFlowActive) { setDoorFlowActive(false); setDoorFlowResume((value) => value + 1); } }}>{doorFlowActive ? "下一項：其他異常" : "完成門與門檻檢查"}</button></div>
      </section></Modal>}
      {surveyDetail === "silicone" && <Modal close={() => setSurveyDetail(null)} title="矽利康施工檢查"><section className="survey-area-panel">
        <div className="panel-head"><div><h3>矽利康施工檢查</h3><p>此項已由驗收移至場勘，確認預定使用的矽利康是否與地板顏色一致。</p></div></div>
        <div className="completion-check"><b>是否跟地板顏色一致？</b><div><button type="button" className={silicone.matchesFloor === true ? "selected" : ""} onClick={() => setS({ ...s, siliconeInspection: { ...silicone, matchesFloor: true, otherColor: "" } })}>是</button><button type="button" className={silicone.matchesFloor === false ? "selected" : ""} onClick={() => setS({ ...s, siliconeInspection: { ...silicone, matchesFloor: false } })}>否</button></div></div>
        {silicone.matchesFloor === false && <Field label="其他顏色（必填）" value={silicone.otherColor} set={(otherColor: string) => setS({ ...s, siliconeInspection: { ...silicone, otherColor } })} />}
        <Field label="矽利康檢查備註" value={silicone.note} set={(note: string) => setS({ ...s, siliconeInspection: { ...silicone, note } })} />
        <Photos node="場勘｜矽利康施工" label="矽利康照片" photos={silicone.photos} set={(photos: Photo[]) => setS({ ...s, siliconeInspection: { ...silicone, photos } })} />
        {siliconeInvalid && <div className="form-error">請選擇矽利康是否與地板同色；選「否」時必須填寫其他顏色。</div>}
      </section></Modal>}
      {surveyDetail === "divider" && <Modal close={() => setSurveyDetail(null)} title="分隔條"><section className="survey-area-panel">
        <div className="panel-head"><div><h3>分隔條</h3><p>確認是否需要分隔條；待確認時可先保存並於之後補充。</p></div></div>
        <div className="survey-area-status">{(["是", "否", "待確認"] as const).map((needed) => <button type="button" key={needed} className={divider.needed === needed ? "primary" : "ghost"} onClick={() => setS({ ...s, dividerInspection: { ...divider, needed, ...(needed !== "是" ? { quantity: undefined, location: "" } : {}) } })}>{needed}</button>)}</div>
        {divider.needed === "是" && <div className="grid3"><Field label="分隔條數量" type="number" value={divider.quantity ?? ""} set={(value: string) => setS({ ...s, dividerInspection: { ...divider, quantity: Number(value) } })} /><Field label="分隔條位置" value={divider.location} set={(location: string) => setS({ ...s, dividerInspection: { ...divider, location } })} /></div>}
        <Field label="分隔條備註（選填）" value={divider.note} set={(note: string) => setS({ ...s, dividerInspection: { ...divider, note } })} />
        {divider.needed === "是" && <Photos node="場勘｜分隔條" label="分隔條照片" photos={divider.photos} set={(photos: Photo[]) => setS({ ...s, dividerInspection: { ...divider, photos } })} />}
        {dividerInvalid && <div className="form-error">需要分隔條時，必須填寫大於 0 的數量及位置。</div>}
      </section></Modal>}
      {surveyDetail === "parking" && <Modal close={() => setSurveyDetail(null)} title="停車"><section className="survey-area-panel">
        <div className="panel-head"><div><h3>停車</h3><p>記錄施工期間可使用的停車數量與位置。</p></div></div>
        <div className="grid3"><label className="field"><span>可停車數量（選填）</span><select value={parking.count} onChange={(event) => setS({ ...s, parking: { ...parking, count: event.target.value as NonNullable<Survey["parking"]>["count"] } })}><option value="">未記錄</option>{["0", "1", "2", "3", "4", "5台以上"].map((count) => <option key={count} value={count}>{count === "5台以上" ? count : `${count} 台`}</option>)}</select></label><Field label="停車位置說明" value={parking.location} set={(location: string) => setS({ ...s, parking: { ...parking, location } })} /><Field label="停車備註" value={parking.note || ""} set={(note: string) => setS({ ...s, parking: { ...parking, note } })} /></div>
        <Photos node="場勘｜停車" label="停車位置照片" photos={parking.photos} set={(photos: Photo[]) => setS({ ...s, parking: { ...parking, photos } })} />
      </section></Modal>}
      {surveyDetail === "staging" && <Modal close={() => setSurveyDetail(null)} title="放料區域"><section className="survey-area-panel">
        <div className="panel-head"><div><h3>放料區域</h3><p>記錄材料放置位置、現場限制與注意事項。</p></div></div>
        <div className="grid3"><Field label="位置" value={stagingArea.location} set={(location: string) => setS({ ...s, stagingArea: { ...stagingArea, location } })} /><Field label="備註" value={stagingArea.note} set={(note: string) => setS({ ...s, stagingArea: { ...stagingArea, note } })} /><Field label="注意事項" value={stagingArea.cautions} set={(cautions: string) => setS({ ...s, stagingArea: { ...stagingArea, cautions } })} /></div>
        <Photos node="場勘｜放料區域" label="放料區域照片" photos={stagingArea.photos} set={(photos: Photo[]) => setS({ ...s, stagingArea: { ...stagingArea, photos } })} />
      </section></Modal>}
      <Checklist
        node="場勘"
        items={surveyChecklistItems}
        set={(items) => setS({ ...s, items: s.items.map((existing) => items.find((item) => item.label === existing.label) || existing) })}
        showCompleteAll={false}
        onBeforeLast={() => { setDoorFlowActive(true); setSurveyDetail("door"); }}
        resumeAtLast={doorFlowResume}
        beforeLastItem={<button type="button" className={`inspection-tile ${doorCombinedInvalid ? "" : doorCombinedResult === "合格" ? "good" : "bad"}`} onClick={() => { setDoorFlowActive(false); setSurveyDetail("door"); }}><i>{doorCombinedInvalid ? "○" : doorCombinedResult === "合格" ? "✓" : "!"}</i><b>門與門檻</b><small>{doorCombinedInvalid ? "尚未完成" : `${doorCombinedResult} · ${doorMeasured ? `${door.thresholdCm} cm` : "未測量（選填）"}`}</small></button>}
        extraItems={<>
          <button type="button" className={`inspection-tile ${siliconeInvalid ? "" : "good"}`} onClick={() => setSurveyDetail("silicone")}><i>{siliconeInvalid ? "○" : "✓"}</i><b>矽利康施工</b><small>{siliconeInvalid ? "尚未完成" : silicone.matchesFloor ? "與地板同色" : `其他顏色：${silicone.otherColor}`}</small></button>
          <button type="button" className={`inspection-tile ${divider.needed === "待確認" ? "" : dividerInvalid ? "bad" : "good"}`} onClick={() => setSurveyDetail("divider")}><i>{divider.needed === "待確認" ? "○" : dividerInvalid ? "!" : "✓"}</i><b>分隔條</b><small>{divider.needed === "待確認" ? "待確認" : divider.needed === "否" ? "不需要" : dividerInvalid ? "資料未完成" : `需要 · ${divider.quantity} 個`}</small></button>
          <button type="button" className={`inspection-tile ${stagingArea.location || stagingArea.note || stagingArea.cautions || stagingArea.photos.length ? "good" : ""}`} onClick={() => setSurveyDetail("staging")}><i>{stagingArea.location || stagingArea.note || stagingArea.cautions || stagingArea.photos.length ? "✓" : "○"}</i><b>放料區域</b><small>{stagingArea.location || "尚未填寫"}</small></button>
          <button type="button" className={`inspection-tile signature-tile ${signaturesInvalid ? "" : "good"}`} onClick={() => setSurveyDetail("signatures")}><i><SignatureIcon /></i><b>場勘簽名</b><small>{surveySignatures.filter((signature) => signature.valid).length} / 2 位已簽名</small><em>查看全部紀錄</em></button>
          <button type="button" className={`inspection-tile parking-tile${parking.count ? " good" : ""}`} onClick={() => setSurveyDetail("parking")}><i><CarIcon /></i><b>停車</b><small>{parking.count ? parking.count === "5台以上" ? parking.count : `${parking.count} 台` : "未記錄"}</small></button>
        </>}
      />
      <div className="grid3">
        <Field
          label="場勘人員"
          value={s.person}
          set={(person: string) => setS({ ...s, person })}
        />
        <Field
          label="備註"
          value={s.note}
          set={(note: string) => setS({ ...s, note })}
        />
      </div>
      <Photos
        node="場勘｜整體現場"
        photos={s.photos}
        set={(photos: Photo[]) => setS({ ...s, photos })}
      />
      <div className="decision">
        <button
          className={s.decision === "可進場" ? "primary" : "ghost"}
          onClick={() => setS({ ...s, decision: "可進場" })}
        >
          ✓ 可進場
        </button>
        <button
          className={s.decision === "待改善" ? "danger" : "ghost"}
          onClick={() => setS({ ...s, decision: "待改善" })}
        >
          ⚠ 待改善
        </button>
      </div>
      {bad.length > 0 && s.decision === "可進場" && (
        <>
          <div className="warning">
            有 {bad.length} 項不合格，必須建立風險告知並簽名，才可強制進場。
          </div>
          <button className="ghost" onClick={() => setRisk(true)}>
            建立風險告知／強制進場
          </button>
        </>
      )}
      {surveyDetail === "signatures" && <Modal close={() => setSurveyDetail(null)} title="場勘檢查人員簽名"><section className="survey-area-panel">
        <div className="panel-head"><div><h3>場勘檢查人員簽名</h3><p>簽名代表已確認現場條件及本次場勘內容，至少需要 2 位人員簽名；日期與時間由系統自動記錄。</p></div><b>{surveySignatures.filter((signature) => signature.valid).length} / 2</b></div>
        <div className="completion-signatures">
          {surveySignatures.map((signature, index) => <div className="completion-sign-box" key={`${signature.at}-${index}`}><Signed s={signature} /></div>)}
        </div>
        <button type="button" className="ghost" onClick={() => setSurveySigning(true)}>＋ 新增場勘簽名</button>
        {signaturesInvalid && <div className="form-error">儲存場勘前，至少需要 2 位檢查人員完成簽名。</div>}
      </section></Modal>}
      {incomplete && <div className="form-error">仍有尚未檢查的項目。</div>}
      {invalidBad && (
        <div className="form-error">不合格項目必須填寫說明並上傳照片。</div>
      )}
      {risk && (
        <RiskModal
          bad={bad}
          close={() => setRisk(false)}
          save={(r) => {
            setS({ ...s, risk: r });
            setRisk(false);
          }}
        />
      )}
      {surveySigning && <Sign close={() => setSurveySigning(false)} save={(signature) => { setS({ ...s, surveySignatures: [...surveySignatures, signature] }); setSurveySigning(false); }} />}
      <div className="form-actions">
      <button className="ghost" type="button" onClick={saveDraft}>暫存未完成場勘</button>
      <button
        className="primary"
        disabled={
          !s.person ||
          incomplete ||
          doorInvalid ||
          siliconeInvalid ||
          dividerInvalid ||
          signaturesInvalid ||
          invalidBad ||
          (bad.length > 0 && s.decision === "可進場" && !s.risk)
        }
        onClick={() => setConfirming(true)}
      >
        進入最後確認
      </button>
      </div>
      {confirming && <Modal close={() => setConfirming(false)} title="最後確認｜場勘">
        <RecordConfirmation title="場勘資料" rows={[
          ["案場／戶別", `${project.name}｜${u.building} ${u.floor}-${u.number}`],
          ["預估施工坪數", `${u.estimated} 坪`],
          ["門檢查", `${door.thresholdCm || "—"} cm｜${doorResult}｜${door.rationale || "—"}`],
          ["停車", parking.count ? `${parking.count === "5台以上" ? parking.count : `${parking.count} 台`}｜${parking.location || "未填位置"}` : "未記錄（選填）"],
          ["放料區", stagingArea.location || "未填位置"],
          ["矽利康", silicone.matchesFloor === true ? "與地板同色" : `不同色：${silicone.otherColor || "未填"}`],
          ["分隔條", `${divider.needed}${divider.needed === "是" ? `｜${divider.quantity || 0} 支｜${divider.location}` : ""}`],
          ["檢查結果", s.items.map((item) => `${item.label}：${item.result}`).join("；")],
          ["簽名", `${surveySignatures.filter((signature) => signature.valid).length} 位`],
          ["最終判定", s.decision],
        ]} />
        <div className="form-actions"><button className="ghost" onClick={() => setConfirming(false)}>返回修改</button><button className="primary" onClick={save}>確認送出</button></div>
      </Modal>}
      {saved && <div className="save-success">{saved}</div>}
      <History
        title="歷次場勘"
        rows={u.surveys.map((x) => ({ a: x.date, b: x.person, c: `${x.draft ? "暫存" : "完成"} · ${x.decision} · 預估 ${u.estimated} 坪`, onOpen: () => { setS(x); setSaved("已開啟既有場勘，可查看或修改後重新儲存"); window.scrollTo({ top: 0, behavior: "smooth" }); } }))}
      />
    </div>
  );
}
function WorkTab({ u, patch, add }: { u: Unit; patch: any; add: any }) {
  const authUserId = useAuthOwner();
  const fallback: Work = {
      id: id(),
      date: day(),
      crew: readLocal(scopedKey("spc-last-crew", authUserId)),
      people: 1,
      area: u.estimated,
      content: "SPC 地板施工",
      abnormal: "",
      note: "",
      photos: [],
      items: [{ label: "施工品質／現場狀況", result: "", note: "", photos: [], value: "", unit: "" }],
      startedAt: stamp(),
    },
    [w, setW] = useState<Work>(() =>
      readDraft(draftKey(authUserId, "work", u.id), fallback),
    ),
    [saved, setSaved] = useState("");
  useOfflineDraftRestore(draftKey(authUserId, "work", u.id), setW);
  useEffect(() => {
    writeLocalDraft(draftKey(authUserId, "work", u.id), w, authUserId);
  }, [w, u.id, authUserId]);
  const saveDraft = () => {
    const draft = { ...w, draft: true };
    patch({ works: [draft, ...u.works.filter((record) => record.id !== w.id)] });
    writeLocalDraft(draftKey(authUserId, "work", u.id), draft, authUserId);
    queueRecordChange(authUserId, "work", u.id, draft);
    setSaved("✓ 施工草稿已暫存；上午暫存後，下午可繼續補寫");
  };
  const save = (done: boolean) => {
    const status: Status = done ? "待驗收" : "施工中",
      title = done ? "施工完成" : "新增施工紀錄";
    patch({
      works: [{ ...w, draft: false }, ...u.works.filter((record) => record.id !== w.id)],
      status,
      events: [
        {
          id: id(),
          at: stamp(),
          title,
          detail: done ? `${w.area}坪，進入待驗收` : `${w.area}坪／${w.crew}`,
          photos: w.photos,
        },
        ...u.events,
      ],
    });
    add(title, w.content, w.photos);
    localStorage.setItem(scopedKey("spc-last-crew", authUserId), w.crew);
    removeDurableDraft(draftKey(authUserId, "work", u.id));
    queueRecordChange(authUserId, "work", u.id, { ...w, draft: false }, done ? "complete" : "upsert");
    setSaved(
      done ? "✓ 施工完成紀錄已儲存，狀態已改為待驗收" : "✓ 施工紀錄已儲存成功",
    );
  };
  return (
    <div className="panel form">
      <div className="panel-head">
        <div>
          <h2>施工紀錄</h2>
          <p>基本資料會沿用，施工時間由系統自動記錄。</p>
        </div>
      </div>
      <InspectionGuide />
      <AutoRecord label="施工紀錄時間" at={w.startedAt || w.date} />
      {!["可進場", "施工中"].includes(u.status) && (
        <div className="warning">
          目前狀態不是「可進場／施工中」，請先完成前一節點。
        </div>
      )}
      <div className="grid3">
        <Field
          label="工班／施工人員"
          value={w.crew}
          set={(crew: string) => setW({ ...w, crew })}
        />
        <Field
          label="施工人數"
          type="number"
          value={w.people}
          set={(people: string) => setW({ ...w, people: Number(people) })}
        />
        <Field
          label="本次施工坪數"
          type="number"
          value={w.area}
          set={(area: string) => setW({ ...w, area: Number(area) })}
        />
        <Field
          label="異常狀況"
          value={w.abnormal}
          set={(abnormal: string) => setW({ ...w, abnormal })}
        />
        <Field
          label="備註"
          value={w.note}
          set={(note: string) => setW({ ...w, note })}
        />
      </div>
      <Photos
        node="施工"
        photos={w.photos}
        set={(photos: Photo[]) => setW({ ...w, photos })}
      />
      <Checklist node="施工" items={w.items || [{ label: "施工品質／現場狀況", result: "", note: "", photos: [] }]} set={(items) => setW({ ...w, items })} />
      <div className="decision">
        <button className="ghost" disabled={!w.crew} onClick={saveDraft}>暫存未完成施工</button>
        <button
          className="ghost"
          disabled={!w.crew}
          onClick={() => save(false)}
        >
          儲存並維持施工中
        </button>
        <button
          className="primary"
          disabled={!w.crew}
          onClick={() => save(true)}
        >
          施工完成 → 待驗收
        </button>
      </div>
      {saved && <div className="save-success">{saved}</div>}
      <History
        title="施工歷史（不覆蓋）"
        rows={u.works.map((x) => ({
          a: x.date,
          b: `${x.crew}／${x.people}人`,
          c: `${x.draft ? "暫存" : "完成"} · ${x.area}坪 ${x.content}`,
          onOpen: () => { setW(x); setSaved("已開啟既有施工紀錄，可查看或修改"); window.scrollTo({ top: 0, behavior: "smooth" }); },
        }))}
      />
    </div>
  );
}
function completionDefaults(a: Acceptance, u: Unit): NonNullable<Acceptance["completion"]> {
  return {
    department: a.completion?.department || "工程部",
    officePerson: a.completion?.officePerson || a.person,
    floorLevel: a.completion?.floorLevel || "",
    abnormalUnit: a.completion?.abnormalUnit || "",
    damagedMaterialType: a.completion?.damagedMaterialType || "",
    materialModel: a.completion?.materialModel || u.model,
    floorAbnormal: a.completion?.floorAbnormal ?? null,
    boardDamaged: a.completion?.boardDamaged ?? null,
    trashCleared: a.completion?.trashCleared ?? null,
    signatures: a.completion?.signatures || (a.signature ? { office: a.signature } : {}),
  };
}

function CompletionYesNo({ label, value, set }: { label: string; value: boolean | null; set: (value: boolean) => void }) {
  return <div className="completion-check"><b>{label}</b><div><button type="button" className={value === true ? "selected" : ""} onClick={() => set(true)}>✓ 是</button><button type="button" className={value === false ? "selected" : ""} onClick={() => set(false)}>✓ 否</button></div></div>;
}

function AcceptTab({ project, u, patch, add }: { project: Project; u: Unit; patch: any; add: any }) {
  const authUserId = useAuthOwner();
  const storedDraft = u.acceptances.find((item) => item.draft);
  const fallback: Acceptance = storedDraft || {
      id: id(),
      date: day(),
      person: readLocal(scopedKey("spc-last-acceptance-person", authUserId)),
      area: u.works.reduce((s, w) => s + w.area, 0) || u.estimated,
      result: "合格",
      items: acceptLabels.map((label) => ({
        label,
        result: "" as Choice,
        note: "",
        photos: [],
      })),
      photos: [],
      note: "",
      completion: {
        department: "工程部",
        officePerson: readLocal(scopedKey("spc-last-acceptance-person", authUserId)),
        floorLevel: "",
        abnormalUnit: "",
        damagedMaterialType: "",
        materialModel: u.model,
        floorAbnormal: null,
        boardDamaged: null,
        trashCleared: null,
        signatures: {},
      },
      recheck: u.status === "待複驗",
      startedAt: stamp(),
    };
  const [a, setA] = useState<Acceptance>(() => {
    const restored = readDraft(draftKey(authUserId, "accept", u.id), fallback);
    return restored.draft === false ? fallback : restored;
  });
  const setRestorableAcceptance = useRef((restored: Acceptance) => {
    if (restored.draft !== false) setA(restored);
  }).current;
  const [signRole, setSignRole] = useState<"installer" | "office" | "siteManager" | "supervisor" | null>(null);
  const [saved, setSaved] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [historyMode, setHistoryMode] = useState(false);
  const historyModeRef = useRef(false);
  const preHistoryAcceptanceRef = useRef<Acceptance | null>(null);
  const acceptanceDraftActiveRef = useRef(true);
  const skipNextDraftWrite = useRef(false);
  const pendingDraftWriteRef = useRef<Promise<void>>(Promise.resolve());
  useOfflineDraftRestore(draftKey(authUserId, "accept", u.id), setRestorableAcceptance, acceptanceDraftActiveRef);
  useEffect(() => {
    if (skipNextDraftWrite.current) {
      skipNextDraftWrite.current = false;
      return;
    }
    if (historyModeRef.current) return;
    if (!acceptanceDraftActiveRef.current) return;
    pendingDraftWriteRef.current = pendingDraftWriteRef.current.then(() => writeLocalDraft(draftKey(authUserId, "accept", u.id), a, authUserId));
  }, [a, u.id, authUserId]);
  const bad = a.items.filter((x) => x.result === "不合格"),
    incomplete = a.items.some((x) => !x.result),
    invalidBad = bad.some((x) => !x.note.trim() || !x.photos?.length),
    allPhotos = [...a.photos, ...a.items.flatMap((x) => x.photos || [])],
    saveDraft = () => {
      if (historyModeRef.current) return setSaved("歷史驗收只能正式保存；原本未完成草稿不會被覆蓋");
      const draft = { ...a, draft: true };
      patch({ acceptances: [draft, ...u.acceptances.filter((item) => item.id !== a.id)] });
      pendingDraftWriteRef.current = pendingDraftWriteRef.current.then(() => writeLocalDraft(draftKey(authUserId, "accept", u.id), draft, authUserId));
      queueRecordChange(authUserId, "accept", u.id, draft);
      setSaved("✓ 驗收草稿已暫存；重新整理或換裝置後可繼續填寫");
    },
    save = async () => {
      const savingHistory = historyModeRef.current;
      const completed: Acceptance = { ...a, draft: false };
      acceptanceDraftActiveRef.current = false;
      skipNextDraftWrite.current = true;
      const fail = a.result !== "合格" || bad.length > 0,
        status: Status = fail ? "驗收缺失" : "已驗收",
        newDef = fail
          ? bad.map((x) => ({
              id: id(),
              source: "驗收" as const,
              type: x.label,
              content: x.note,
              unit: "施工工班",
              due: "",
              status: "待改善" as const,
              before: x.photos || [],
              after: [],
              fix: "",
              completed: "",
            }))
          : [];
      patch({
        acceptances: [completed, ...u.acceptances.filter((item) => item.id !== completed.id)],
        status,
        defects: [...newDef, ...u.defects],
        events: [
          {
            id: id(),
            at: stamp(),
            title: completed.recheck ? "完成複驗" : "完成驗收",
            detail: `結果：${completed.result}`,
            photos: allPhotos,
          },
          ...u.events,
        ],
      });
      add(completed.recheck ? "完成複驗" : "完成驗收", completed.result, allPhotos);
      localStorage.setItem(scopedKey("spc-last-acceptance-person", authUserId), completed.person);
      setA(completed);
      queueRecordChange(authUserId, "accept", u.id, completed, "complete");
      await pendingDraftWriteRef.current;
      if (!savingHistory) await removeDurableDraft(draftKey(authUserId, "accept", u.id));
      if (savingHistory) {
        const resumeAcceptance = preHistoryAcceptanceRef.current;
        skipNextDraftWrite.current = true;
        historyModeRef.current = false;
        acceptanceDraftActiveRef.current = true;
        preHistoryAcceptanceRef.current = null;
        setHistoryMode(false);
        if (resumeAcceptance) setA(resumeAcceptance);
      }
      setSaved(`✓ ${completed.recheck ? "複驗" : "驗收"}結果已儲存成功`);
      setConfirming(false);
    };
  return (
    <div className="panel form">
      <div className="panel-head">
        <div>
          <h2>{a.recheck ? "複驗" : "完工驗收"}</h2>
          <p>基本資料與施工紀錄會自動帶入；戶別完成以逐項驗收結果為準，四人簽名統一於樓層驗收完成。</p>
        </div>
      </div>
      <InspectionGuide />
      <AutoRecord label={a.recheck ? "複驗開始時間" : "驗收開始時間"} at={a.startedAt || a.date} />
      <div className="summary">
        <span>
          實際施工坪數<b>{u.works.reduce((s, w) => s + w.area, 0)}</b>
        </span>
        <span>
          施工日期<b>{u.works.map((w) => w.date).join("、") || "—"}</b>
        </span>
        <span>
          施工照片<b>{u.works.reduce((n, w) => n + w.photos.length, 0)} 張</b>
        </span>
      </div>
      <Checklist
        className="acceptance-checklist"
        node={a.recheck ? "複驗" : "驗收"}
        items={a.items}
        set={(items) => setA({ ...a, items })}
      />
      <div className="grid3">
        <Field
          label="驗收人"
          value={a.person}
          set={(person: string) => setA({ ...a, person })}
        />
        <label className="field">
          <span>驗收結果</span>
          <select
            value={a.result}
            onChange={(e) => setA({ ...a, result: e.target.value as any })}
          >
            <option>合格</option>
            <option>部分合格</option>
            <option>不合格</option>
          </select>
        </label>
        <Field
          label="驗收備註"
          value={a.note}
          set={(note: string) => setA({ ...a, note })}
        />
      </div>
      <Photos
        node={a.recheck ? "複驗｜整體" : "驗收｜整體"}
        photos={a.photos}
        set={(photos: Photo[]) => setA({ ...a, photos })}
      />
      <section className="completion-entry">
        <div className="checklist-head"><div><h3>每日完工驗收表資料</h3><small>基本資料、驗收人、施工日期與板材型號會自動套用到三聯 PDF。</small></div></div>
        <div className="completion-checks">
          <CompletionYesNo label="地坪是否異常" value={a.completion?.floorAbnormal ?? null} set={(floorAbnormal) => setA({ ...a, completion: { ...completionDefaults(a, u), floorAbnormal } })} />
          <CompletionYesNo label="現場板材是否損壞" value={a.completion?.boardDamaged ?? null} set={(boardDamaged) => setA({ ...a, completion: { ...completionDefaults(a, u), boardDamaged } })} />
          <CompletionYesNo label="現場垃圾是否清運完畢" value={a.completion?.trashCleared ?? null} set={(trashCleared) => setA({ ...a, completion: { ...completionDefaults(a, u), trashCleared } })} />
        </div>
        {(a.completion?.floorAbnormal === true || a.completion?.boardDamaged === true) && <div className="completion-supplementary-fields">
          {a.completion?.floorAbnormal === true && <Field label="地坪異常位置／戶別" value={a.completion.abnormalUnit || ""} set={(abnormalUnit: string) => setA({ ...a, completion: { ...completionDefaults(a, u), abnormalUnit } })} />}
          {a.completion?.boardDamaged === true && <Field label="損壞板材種類" value={a.completion.damagedMaterialType || ""} set={(damagedMaterialType: string) => setA({ ...a, completion: { ...completionDefaults(a, u), damagedMaterialType } })} />}
        </div>}
        <div className="completion-signatures">
          {([['installer','施工人員'],['office','工務人員'],['siteManager','工地主任'],['supervisor','神銀主管']] as const).map(([key, label]) => {
            const signed = key === "office" ? a.completion?.signatures?.[key] || a.signature : a.completion?.signatures?.[key];
            return <div className="completion-sign-box" key={key}><b>{label}簽名</b>{signed?.valid ? <Signed s={signed} /> : <button className="ghost" onClick={() => setSignRole(key)}>觸控簽名</button>}</div>;
          })}
        </div>
      </section>
      {incomplete && <div className="form-error">仍有尚未檢查的項目。</div>}
      {invalidBad && (
        <div className="form-error">不合格項目必須填寫說明並上傳照片。</div>
      )}
      <div className="form-actions">
        <button className="ghost" type="button" disabled={historyMode} onClick={saveDraft}>{historyMode ? "歷史查看不覆蓋草稿" : "暫存未完成驗收"}</button>
        <button className="primary" disabled={!a.person || incomplete || invalidBad} onClick={() => setConfirming(true)}>進入最後確認</button>
      </div>
      {confirming && <Modal close={() => setConfirming(false)} title={`最後確認｜${a.recheck ? "複驗" : "驗收"}`}>
        <RecordConfirmation title="驗收資料" rows={[
          ["案場／戶別", `${project.name}｜${u.building} ${u.floor}-${u.number}`],
          ["SPC 型號", `${u.model}／${u.colorNo}`],
          ["施工坪數", `${a.area} 坪`],
          ["驗收人", a.person],
          ["逐項結果", a.items.map((item) => `${item.label}：${item.result}${item.value ? `（${item.value} ${item.unit || ""}）` : ""}${item.note ? `－${item.note}` : ""}`).join("；")],
          ["整體結果", a.result],
          ["備註", a.note || "無"],
          ["照片", `${allPhotos.length} 張`],
        ]} />
        <div className="form-actions"><button className="ghost" onClick={() => setConfirming(false)}>返回修改</button><button className="primary" onClick={save}>確認送出</button></div>
      </Modal>}
      {saved && <div className="save-success">{saved}</div>}
      {signRole && (
        <Sign
          close={() => setSignRole(null)}
          save={(signature) => {
            const completion = completionDefaults(a, u);
            setA({ ...a, signature: signRole === "office" ? signature : a.signature, completion: { ...completion, signatures: { ...completion.signatures, [signRole]: signature } } });
            setSignRole(null);
          }}
        />
      )}
      <History
        title="歷次驗收／複驗"
        rows={u.acceptances.map((x) => ({
          a: x.date,
          b: x.person,
          c: x.draft ? "驗收草稿（未完成）" : `${x.recheck ? "複驗" : "驗收"}：${x.result}`,
          onOpen: () => { if (!historyModeRef.current) preHistoryAcceptanceRef.current = a; historyModeRef.current = true; acceptanceDraftActiveRef.current = false; setHistoryMode(true); setA(x); setSaved("已開啟既有驗收紀錄，可查看或修改；未正式保存不會覆蓋原本草稿"); window.scrollTo({ top: 0, behavior: "smooth" }); },
        }))}
      />
    </div>
  );
}
function DefectsTab({ u, patch, add }: { u: Unit; patch: any; add: any }) {
  const complete = (d: Defect) => {
    const defectStatus: Defect["status"] =
        d.source === "場勘" ? "已完成" : "待複驗",
      defs = u.defects.map((x) =>
        x.id === d.id ? { ...x, status: defectStatus, completed: day() } : x,
      ),
      sameSource = defs.filter((x) => x.source === d.source),
      allReady =
        d.source === "場勘"
          ? sameSource.every((x) => x.status === "已完成")
          : sameSource.every((x) => ["待複驗", "已完成"].includes(x.status)),
      nextStatus: Status = allReady
        ? d.source === "場勘"
          ? "可進場"
          : "待複驗"
        : "改善中",
      nextText = allReady
        ? d.source === "場勘"
          ? "全部場勘缺失已改善，可進場"
          : "全部驗收缺失已改善，等待複驗"
        : "此項改善已儲存，仍有其他缺失待處理";
    patch({
      defects: defs,
      status: nextStatus,
      events: [
        {
          id: id(),
          at: stamp(),
          title: `${d.source}缺失改善完成`,
          detail: `${d.fix}｜${nextText}`,
          photos: d.after,
        },
        ...u.events,
      ],
    });
    add(`${d.source}缺失改善完成`, nextText, d.after);
  };
  return (
    <div className="panel form">
      <h2>缺失改善／複驗管理</h2>
      {u.defects.map((d) => {
        const submitted = d.status === "待複驗" || d.status === "已完成",
          otherPending = u.defects.some(
            (x) =>
              x.id !== d.id &&
              x.source === d.source &&
              (d.source === "場勘"
                ? x.status !== "已完成"
                : !["待複驗", "已完成"].includes(x.status)),
          ),
          target = d.source === "場勘" ? "可進場" : "待複驗";
        return (
          <div className="defect-card" key={d.id}>
            <div className="panel-head">
              <div>
                <small>
                  {d.source}缺失 · {d.type}
                </small>
                <h3>{d.content}</h3>
              </div>
              <select
                value={d.status}
                onChange={(e) => {
                  const status = e.target.value as Defect["status"],
                    defs = u.defects.map((x) =>
                      x.id === d.id ? { ...x, status } : x,
                    ),
                    us: Status =
                      status === "改善中"
                        ? "改善中"
                        : status === "待複驗"
                          ? "待複驗"
                          : u.status;
                  patch({ defects: defs, status: us });
                }}
              >
                <option>待改善</option>
                <option>改善中</option>
                <option>待複驗</option>
                <option>已完成</option>
              </select>
            </div>
            <div className="grid3">
              <Field
                label="責任單位／工班"
                value={d.unit}
                set={(unit: string) =>
                  patch({
                    defects: u.defects.map((x) =>
                      x.id === d.id ? { ...x, unit } : x,
                    ),
                  })
                }
              />
              <Field
                label="改善期限"
                type="date"
                value={d.due}
                set={(due: string) =>
                  patch({
                    defects: u.defects.map((x) =>
                      x.id === d.id ? { ...x, due } : x,
                    ),
                  })
                }
              />
              <Field
                label="改善內容"
                value={d.fix}
                set={(fix: string) =>
                  patch({
                    defects: u.defects.map((x) =>
                      x.id === d.id ? { ...x, fix } : x,
                    ),
                  })
                }
              />
              <Field
                label="改善備註"
                value={d.note || ""}
                set={(note: string) =>
                  patch({
                    defects: u.defects.map((x) =>
                      x.id === d.id ? { ...x, note } : x,
                    ),
                  })
                }
              />
            </div>
            <Photos
              node={`${d.source}缺失改善｜${d.type}`}
              label="改善後照片"
              photos={d.after}
              set={(after: Photo[]) =>
                patch({
                  defects: u.defects.map((x) =>
                    x.id === d.id ? { ...x, after } : x,
                  ),
                })
              }
            />
            {submitted ? (
              <div className="save-success">
                ✓ 改善結果已儲存{d.source === "場勘" ? "" : "，等待複驗"}
              </div>
            ) : (
              <button
                className="primary"
                disabled={!d.fix || !d.after.length}
                onClick={() => complete(d)}
              >
                {otherPending ? "儲存此項改善結果" : `儲存改善結果 → ${target}`}
              </button>
            )}
          </div>
        );
      })}
      {!u.defects.length && <p className="no-data">目前沒有缺失</p>}
    </div>
  );
}
function loadJournalPhotoDimensions(photo: Photo) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 4, height: image.naturalHeight || 3 });
    image.onerror = () => resolve({ width: 4, height: 3 });
    image.src = photo.data;
  });
}

async function buildJournalPhotoRun(photo: Photo, maxWidth: number, maxHeight: number, dimensions?: { width: number; height: number }) {
  try {
    const intrinsic = dimensions || await loadJournalPhotoDimensions(photo);
    const scale = Math.min(maxWidth / intrinsic.width, maxHeight / intrinsic.height);
    const width = Math.max(1, Math.round(intrinsic.width * scale));
    const height = Math.max(1, Math.round(intrinsic.height * scale));
    const response = await fetch(photo.data);
    const data = await response.arrayBuffer();
    const mime = response.headers.get("content-type") || (photo.data.startsWith("data:image/png") ? "image/png" : "image/jpeg");
    const type = mime.includes("png") ? "png" : "jpg";
    return new ImageRun({ data, type, transformation: { width, height }, altText: { title: photo.caption || "工作照片", description: photo.caption || "工作日誌照片", name: "工作照片" } });
  } catch {
    return null;
  }
}

const JOURNAL_PAGE_WIDTH = 9360;
const JOURNAL_NO_BORDERS = {
  top: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  left: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  insideHorizontal: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  insideVertical: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
};
type MeasuredJournalPhoto = JournalPhotoLayoutItem<Photo>;

async function buildJournalLogoRun() {
  try {
    const response = await fetch("/shen-yin-logo.png");
    return new ImageRun({ data: await response.arrayBuffer(), type: "png", transformation: { width: 120, height: 44 }, altText: { title: "神銀建材 Logo", description: "神銀建材 Logo", name: "神銀建材 Logo" } });
  } catch {
    return null;
  }
}

async function downloadWorkJournalDocx(project: Project, u: Unit, entry: DailyNote) {
  const PHOTO_PER_PAGE = 6;
  const sourcePhotos = (entry.photos || []).slice();
  const measuredPhotos: MeasuredJournalPhoto[] = await Promise.all(sourcePhotos.map(async (photo) => ({ value: photo, ...await loadJournalPhotoDimensions(photo) })));
  const photoPages = Array.from({ length: Math.ceil(measuredPhotos.length / PHOTO_PER_PAGE) }, (_, index) => measuredPhotos.slice(index * PHOTO_PER_PAGE, (index + 1) * PHOTO_PER_PAGE));
  const logo = await buildJournalLogoRun();
  const photoCell = (photo: ImageRun | null, width: number) => new TableCell({ borders: JOURNAL_NO_BORDERS, width: { size: width, type: WidthType.DXA }, margins: { top: 30, bottom: 30, left: 30, right: 30 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: photo ? [photo] : [new TextRun({ text: "圖片無法載入", color: "777777", size: 16, font: "Microsoft JhengHei" })] })] });
  const photoTable = async (rowPhotos: MeasuredJournalPhoto[], maxHeight: number, width = JOURNAL_PAGE_WIDTH) => {
    const columnWidth = Math.floor(width / rowPhotos.length);
    const availableWidth = Math.max(1, Math.floor(columnWidth / 15) - 4);
    const maxPhotoWidth = rowPhotos.length === 1 ? Math.min(440, availableWidth) : availableWidth;
    const runs = await Promise.all(rowPhotos.map((photo) => buildJournalPhotoRun(photo.value, maxPhotoWidth, maxHeight, photo)));
    return new Table({ alignment: AlignmentType.CENTER, borders: JOURNAL_NO_BORDERS, width: { size: width, type: WidthType.DXA }, columnWidths: rowPhotos.map(() => columnWidth), rows: [new TableRow({ cantSplit: true, children: runs.map((run) => photoCell(run, columnWidth)) })] });
  };
  const journalHeader = (pageBreakBefore = false) => new Table({
    alignment: AlignmentType.CENTER,
    borders: JOURNAL_NO_BORDERS,
    width: { size: JOURNAL_PAGE_WIDTH, type: WidthType.DXA },
    columnWidths: [3120, 3120, 3120],
    rows: [new TableRow({ cantSplit: true, children: [
      new TableCell({ borders: JOURNAL_NO_BORDERS, width: { size: 3120, type: WidthType.DXA }, children: [new Paragraph({ pageBreakBefore, alignment: AlignmentType.LEFT, children: logo ? [logo] : [] })] }),
      new TableCell({ borders: JOURNAL_NO_BORDERS, width: { size: 3120, type: WidthType.DXA }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "SPC 工程工作日誌", bold: true, size: 34, font: "Microsoft JhengHei" })] })] }),
      new TableCell({ borders: JOURNAL_NO_BORDERS, width: { size: 3120, type: WidthType.DXA }, children: [new Paragraph({})] }),
    ] })],
  });
  const meta = [
    ["案場名稱", project.name], ["完工日期", entry.date], ["戶別", `${u.building} ${u.floor}-${u.number}`],
    ["SPC 型號／色號", `${u.model}${u.colorNo ? `／${u.colorNo}` : ""}`], ["坪數", `${u.works.reduce((sum, work) => sum + Number(work.area || 0), 0) || u.estimated} 坪`],
    ["工作內容", entry.content || "—"], ["備註", entry.note || "無"],
  ];
  const infoChildren = meta.map(([label, value]) => new Paragraph({ spacing: { after: 105 }, children: [new TextRun({ text: `${label}：`, bold: true, size: 24, font: "Microsoft JhengHei" }), new TextRun({ text: value || "—", size: 24, font: "Microsoft JhengHei" })] }));
  const firstPagePhotos = photoPages[0] || [];
  const firstPhotoRun = firstPagePhotos[0] ? await buildJournalPhotoRun(firstPagePhotos[0].value, 320, 300, firstPagePhotos[0]) : null;
  const rightTopChildren = firstPhotoRun
    ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [firstPhotoRun] })]
    : [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "無工作照片", color: "777777", font: "Microsoft JhengHei" })] })];
  const children: Array<Paragraph | Table> = [
    journalHeader(),
    new Paragraph({ spacing: { after: 40 } }),
    new Table({ alignment: AlignmentType.CENTER, borders: JOURNAL_NO_BORDERS, width: { size: JOURNAL_PAGE_WIDTH, type: WidthType.DXA }, columnWidths: [4540, 4820], rows: [new TableRow({ cantSplit: true, children: [
      new TableCell({ borders: JOURNAL_NO_BORDERS, width: { size: 4540, type: WidthType.DXA }, margins: { top: 40, bottom: 40, left: 30, right: 90 }, children: infoChildren }),
      new TableCell({ borders: JOURNAL_NO_BORDERS, width: { size: 4820, type: WidthType.DXA }, margins: { top: 40, bottom: 40, left: 90, right: 30 }, children: rightTopChildren }),
    ] })] }),
  ];
  const firstPageRows = planJournalPhotoRows(firstPagePhotos.slice(1));
  const firstPageRowHeight = Math.min(360, Math.floor(570 / Math.max(1, firstPageRows.length)));
  for (const rowPhotos of firstPageRows) {
    children.push(await photoTable(rowPhotos, firstPageRowHeight));
  }
  for (const pagePhotos of photoPages.slice(1)) {
    children.push(journalHeader(true), new Paragraph({ spacing: { after: 100 } }));
    const followingRows = planJournalPhotoRows(pagePhotos);
    const followingRowHeight = Math.min(520, Math.floor(900 / Math.max(1, followingRows.length)));
    for (const rowPhotos of followingRows) {
      children.push(await photoTable(rowPhotos, followingRowHeight));
    }
  }
  const doc = new Document({ sections: [{ properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT }, margin: { top: 720, right: 720, bottom: 720, left: 720 } } }, children }] });
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.name}_${u.number}_${entry.date}_驗收日誌.docx`.replace(/[\\/:*?"<>|]/g, "_");
  document.body.appendChild(link);
  link.click();
  link.remove();
  revokeObjectUrlLater(url);
}

function JournalWordPreviewPhotoRows({ photos }: { photos: Photo[] }) {
  const previewPhotos = photos.slice(1, 6);
  const [measured, setMeasured] = useState<MeasuredJournalPhoto[]>(() => previewPhotos.map((photo) => ({ value: photo, width: 1, height: 1 })));
  useEffect(() => {
    let active = true;
    void Promise.all(previewPhotos.map(async (photo) => ({ value: photo, ...await loadJournalPhotoDimensions(photo) }))).then((next) => {
      if (active) setMeasured(next);
    });
    return () => { active = false; };
  }, [photos]);
  return <div className="word-preview-photo-layout">{planJournalPhotoRows(measured).map((row, rowIndex) => <div className="word-preview-photo-row" style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }} key={rowIndex}>{row.map(({ value: photo }) => <ZoomablePhoto key={photo.id} photo={photo} alt={photo.caption || "工作照片"} />)}</div>)}</div>;
}

function UnitJournalTab({ project, u, patch }: { project: Project; u: Unit; patch: (x: Partial<Unit>) => void }) {
  const authUserId = useAuthOwner();
  const blank = (): DailyNote => ({ id: id(), date: day(), content: "", pending: "", note: "", photos: [], createdAt: "", updatedAt: "", createdBy: "", draft: true });
  const storedDraft = liveEntities(u.journals).find((item) => item.draft);
  const [entry, setEntry] = useState<DailyNote>(() => readDraft(draftKey(authUserId, "unit-journal", u.id), storedDraft || blank()));
  const [saved, setSaved] = useState("");
  const [preview, setPreview] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const skipNextDraftWrite = useRef(false);
  const editingExisting = liveEntities(u.journals).some((item) => item.id === entry.id);
  useOfflineDraftRestore(draftKey(authUserId, "unit-journal", u.id), setEntry);
  useEffect(() => {
    if (skipNextDraftWrite.current) { skipNextDraftWrite.current = false; return; }
    writeLocalDraft(draftKey(authUserId, "unit-journal", u.id), entry, authUserId);
  }, [entry, u.id, authUserId]);
  const persist = async (draft: boolean) => {
    const { data } = await supabase.auth.getUser();
    const now = stamp();
    const record: DailyNote = { ...entry, draft, createdAt: entry.createdAt || now, updatedAt: now, createdBy: entry.createdBy || data.user?.email || "目前登入帳號" };
    patch({ journals: [record, ...u.journals.filter((item) => item.id !== entry.id)] });
    if (!draft) skipNextDraftWrite.current = true;
    setEntry(record);
    if (draft) writeLocalDraft(draftKey(authUserId, "unit-journal", u.id), record, authUserId);
    else {
      removeDurableDraft(draftKey(authUserId, "unit-journal", u.id));
    }
    queueRecordChange(authUserId, "unit-journal", u.id, record, draft ? "upsert" : "complete");
    setSaved(draft ? "✓ 驗收日誌已暫存，可稍後或換裝置繼續" : editingExisting ? "✓ 既有驗收日誌已更新" : "✓ 驗收日誌已完成並儲存");
  };
  const startNew = () => {
    const next = blank();
    setEntry(next);
    setSaved("");
    removeDurableDraft(draftKey(authUserId, "unit-journal", u.id));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return <div className="panel form">
    <div className="panel-head"><div><h2>驗收日誌</h2><p>流程：新增 → 暫存 → 查看 → 修改 → 完成；照片可產生 Word 報告。</p></div>{editingExisting && <button className="ghost" type="button" onClick={startNew}>新增驗收日誌</button>}</div>
    {editingExisting && <div className="warning">正在修改 {entry.date} 的既有驗收日誌；儲存會更新原紀錄。</div>}
    <div className="grid3"><Field label="日期／完工日期" type="date" value={entry.date} set={(date) => setEntry({ ...entry, date })} /><Field label="工作內容" value={entry.content} set={(content) => setEntry({ ...entry, content })} /><Field label="後續待處理" value={entry.pending} set={(pending) => setEntry({ ...entry, pending })} /><Field label="備註" value={entry.note} set={(note) => setEntry({ ...entry, note })} /></div>
    <div className="unit-journal-photos"><Photos node="戶別工作日誌" label="工作照片" photos={entry.photos} set={(photos) => setEntry({ ...entry, photos })} /></div>
    <div className="save-success">✓ 輸入內容會先保存在本機；按「暫存」後同步至資料庫</div>
    <div className="form-actions"><button className="ghost" onClick={() => persist(true)}>暫存</button><button className="primary" disabled={!entry.content.trim()} onClick={() => persist(false)}>完成日誌</button><button className="ghost" disabled={!entry.content.trim()} onClick={() => setPreview(true)}>預覽／產生 Word</button></div>
    {saved && <div className="save-success">{saved}</div>}
    {preview && <Modal close={() => setPreview(false)} title="Word 列印預覽"><div className="word-preview"><div className="word-preview-header"><CompanyLogo /><b>SPC 工程工作日誌</b><span aria-hidden="true" /></div><div className="word-preview-first-row"><div className="word-preview-meta"><b>案場名稱：{project.name}</b><span>完工日期：{entry.date}</span><span>戶別：{u.building} {u.floor}-{u.number}</span><span>型號：{u.model}／{u.colorNo}</span><span>坪數：{u.works.reduce((sum, work) => sum + Number(work.area || 0), 0) || u.estimated} 坪</span><span><b>工作內容：</b>{entry.content}</span><span><b>備註：</b>{entry.note || "無"}</span></div>{entry.photos[0] ? <ZoomablePhoto photo={entry.photos[0]} alt={entry.photos[0].caption || "工作照片"} /> : <span className="word-preview-empty">無工作照片</span>}</div><JournalWordPreviewPhotoRows photos={entry.photos} /></div><div className="form-actions"><button className="ghost" onClick={() => setPreview(false)}>返回修改</button><button className="primary" disabled={downloading} onClick={async () => { setDownloading(true); await downloadWorkJournalDocx(project, u, entry); setDownloading(false); }}>{downloading ? "產生中…" : "確認產生 Word"}</button></div></Modal>}
    <History actionLabel="查看／修改" title="驗收日誌紀錄" rows={liveEntities(u.journals).map((item) => ({ a: item.date, b: item.createdBy || "—", c: `${item.draft ? "暫存" : "完成"} · 最後修改 ${item.updatedAt || item.createdAt || "—"}`, onOpen: () => { setEntry(item); setSaved("已開啟既有驗收日誌，可查看、修改或再次產生 Word"); window.scrollTo({ top: 0, behavior: "smooth" }); } }))} />
  </div>;
}

function Journal({
  p,
  patch,
}: {
  p: Project;
  patch: (x: Partial<Project>) => void;
}) {
  const authUserId = useAuthOwner();
  const blank = (dateValue = day()): DailyNote => ({
      id: id(),
      date: dateValue,
      content: "",
      pending: "",
      note: "",
      photos: [] as Photo[],
      createdAt: "",
      updatedAt: "",
      createdBy: "",
      draft: true,
    }),
    [date, setDate] = useState(day()),
    [entry, setEntry] = useState<DailyNote>(() =>
      readDraft(draftKey(authUserId, "journal", p.id), blank()),
    ),
    [savedMessage, setSavedMessage] = useState(""),
    rows = p.units.flatMap((u) =>
      u.works.filter((w) => w.date === date).map((w) => ({ u, w })),
    ),
    notes = liveEntities(p.journals).sort((a, b) => b.date.localeCompare(a.date));
  const skipNextDraftWrite = useRef(false);
  useOfflineDraftRestore(draftKey(authUserId, "journal", p.id), setEntry);
  const editingExisting = p.journals.some((item) => item.id === entry.id),
    hasDraft =
    !!entry.content.trim() ||
    !!entry.pending.trim() ||
    !!entry.note.trim() ||
    entry.photos.length > 0;
  useEffect(() => {
    const key = draftKey(authUserId, "journal", p.id);
    if (skipNextDraftWrite.current) { skipNextDraftWrite.current = false; return; }
    if (hasDraft) writeLocalDraft(key, entry, authUserId);
    else localStorage.removeItem(key);
  }, [entry, hasDraft, p.id]);
  const save = async () => {
    if (!hasDraft) return;
    const existing = p.journals.find((item) => item.id === entry.id);
    const { data } = await supabase.auth.getUser();
    const now = stamp();
    const saved: DailyNote = {
      ...entry,
      draft: false,
      content: entry.content.trim() || "未填寫",
      createdAt: existing?.createdAt || entry.createdAt || now,
      createdBy: existing?.createdBy || entry.createdBy || data.user?.email || "目前登入帳號",
      updatedAt: now,
    };
    patch({ journals: [saved, ...p.journals.filter((item) => item.id !== saved.id)] });
    queueRecordChange(authUserId, "journal", p.id, saved, "complete");
    setDate(entry.date);
    skipNextDraftWrite.current = true;
    setEntry(saved);
    setSavedMessage(existing ? "✓ 既有今日日誌已更新" : "✓ 今日日誌已建立");
    removeDurableDraft(draftKey(authUserId, "journal", p.id));
  };
  const startNew = () => {
    setEntry(blank(date));
    setSavedMessage("");
    removeDurableDraft(draftKey(authUserId, "journal", p.id));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <div className="form">
      <section className="panel form journal-entry">
        <div className="panel-head">
          <div>
            <p className="eyebrow">人工輸入區</p>
            <h2>今日補充說明</h2>
            <p>補充全案事項或額外照片。</p>
          </div>
          {editingExisting && <button className="ghost" type="button" onClick={startNew}>新增今日日誌</button>}
        </div>
        {editingExisting && <div className="warning">正在修改 {entry.date} 的既有紀錄；儲存會更新原紀錄。</div>}
        <div className="grid3">
          <Field
            label="日期"
            type="date"
            value={entry.date}
            set={(date) => setEntry({ ...entry, date })}
          />
          <label className="field journal-wide">
            <span>當日工作／現場事項</span>
            <textarea
              value={entry.content}
              onChange={(e) => setEntry({ ...entry, content: e.target.value })}
              placeholder="例如：材料進場、全案協調、停工原因或現場處理事項"
            />
          </label>
          <label className="field">
            <span>後續待處理事項</span>
            <textarea
              value={entry.pending}
              onChange={(e) => setEntry({ ...entry, pending: e.target.value })}
              placeholder="例如：明日確認地坪改善進度"
            />
          </label>
          <label className="field">
            <span>補充備註</span>
            <textarea
              value={entry.note}
              onChange={(e) => setEntry({ ...entry, note: e.target.value })}
            />
          </label>
        </div>
        <Photos
          node="工作日誌｜今日補充"
          label="額外照片"
          photos={entry.photos}
          set={(photos) => setEntry({ ...entry, photos })}
        />
        <div className="save-success">
          ✓ 輸入中會自動暫存，重新整理後可恢復
        </div>
        <button
          className="primary save-journal"
          disabled={!hasDraft}
          onClick={() => void save()}
        >
          {editingExisting ? "儲存修改" : "儲存當日日誌"}
        </button>
        {savedMessage && <div className="save-success">{savedMessage}</div>}
      </section>
      <section className="panel form">
        <div className="panel-head">
          <div>
            <p className="eyebrow">來源：當日施工紀錄</p>
            <h2>系統自動彙整</h2>
            <p>自動帶入當日施工紀錄。</p>
          </div>
          <button className="primary" onClick={() => printWithLifecycleCleanup()}>
            匯出／列印
          </button>
        </div>
        <Field label="施工紀錄日期" type="date" value={date} set={setDate} />
        <h3>所有案場日誌</h3>
        {notes.map((x) => (
          <article className="daily-note" key={x.id}>
            <div className="panel-head">
              <div>
                <b>{x.date}｜當日日誌</b>
                <small>{x.createdAt}</small>
              </div>
              <div className="actions">
                <button className="ghost" type="button" onClick={() => { setEntry(x); setDate(x.date); setSavedMessage(`正在修改 ${x.date} 的既有紀錄`); window.scrollTo({ top: 0, behavior: "smooth" }); }}>查看／修改</button>
                <button
                  className="danger"
                  onClick={() => {
                    if (!confirm("刪除此筆當日日誌？")) return;
                    const deleted = tombstoneEntity(x, authUserId, stamp());
                    patch({ journals: p.journals.map((note) => note.id === x.id ? deleted : note) });
                    queueRecordChange(authUserId, "journal", p.id, deleted, "delete");
                  }}
                >
                  刪除
                </button>
              </div>
            </div>
            <p>{x.content}</p>
            {x.pending && (
              <p>
                <strong>後續待處理：</strong>
                {x.pending}
              </p>
            )}
            {x.note && (
              <p>
                <strong>備註：</strong>
                {x.note}
              </p>
            )}
            <PhotoGrid photos={x.photos} />
          </article>
        ))}
        {!notes.length && (
          <p className="no-data compact">尚無案場日誌</p>
        )}
        <h3>當日施工紀錄（系統自動帶入）</h3>
        <div className="journal-grid">
          {rows.map(({ u, w }) => (
            <article key={w.id}>
              <b>
                {u.building} {u.floor}-{u.number}
              </b>
              <p>
                {u.model}／{u.colorNo}
              </p>
              <span>
                {w.people}人 · {w.area}坪
              </span>
              <p>{w.content}</p>
              {w.abnormal && <strong>異常：{w.abnormal}</strong>}
              <PhotoGrid photos={w.photos} />
            </article>
          ))}
        </div>
        {!rows.length && <p className="no-data compact">此日期沒有施工紀錄</p>}
      </section>
    </div>
  );
}
type BillingUnitDraft = { rate: string; priced: boolean };

function Billing({ p, patch }: { p: Project; patch: any }) {
  const [y, setY] = useState(String(new Date().getFullYear())),
    [m, setM] = useState(String(new Date().getMonth() + 1).padStart(2, "0")),
    [shipmentPreview, setShipmentPreview] = useState(false),
    [shipmentExporting, setShipmentExporting] = useState(false),
    [editing, setEditing] = useState(false),
    [billingDrafts, setBillingDrafts] = useState<Record<string, BillingUnitDraft>>({}),
    [saveConfirmation, setSaveConfirmation] = useState(false),
    [billingMessage, setBillingMessage] = useState(""),
    ym = `${y}-${m}`,
    monthlyBillingRecords = buildAcceptanceExportRecords(p).filter((record) => record.exportDate.startsWith(ym)),
    monthlyUnitIds = new Set(monthlyBillingRecords.map((record) => record.unitId)),
    monthlyUnits = p.units.filter((unit) => monthlyUnitIds.has(unit.id)),
    billRecords = monthlyBillingRecords.filter((record) => {
      const unit = p.units.find((item) => item.id === record.unitId);
      return unit ? unit.status === "已驗收" || unit.status === "已計價" : false;
    }),
    billRows = billRecords.flatMap((record) => {
      const unit = p.units.find((item) => item.id === record.unitId);
      return unit ? [{ unit, record }] : [];
    }),
    shipmentRecords = monthlyBillingRecords,
    billSubtotal = billRecords.reduce((sum, record) => sum + record.amount, 0),
    printBilling = () => printWithLifecycleCleanup("printing-billing");
  const safeDraftRate = (value: string | number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    },
    draftFor = (unit: Unit): BillingUnitDraft => billingDrafts[unit.id] || {
      rate: String(unit.rate ?? ""),
      priced: unit.status === "已計價",
    },
    previewRows = billRows.map(({ unit, record }) => {
      const draft = draftFor(unit), rate = editing ? safeDraftRate(draft.rate) : Number(unit.rate || 0);
      return { unit, savedRecord: record, record: { ...record, unitPrice: rate, amount: Number((record.areaPing * rate).toFixed(0)) }, draft };
    }),
    previewSubtotal = previewRows.reduce((sum, row) => sum + row.record.amount, 0),
    billingChanges = previewRows.filter(({ unit, draft }) =>
      safeDraftRate(draft.rate) !== Number(unit.rate || 0) || draft.priced !== (unit.status === "已計價"),
    ),
    startEditing = () => {
      setBillingDrafts(Object.fromEntries(billRows.map(({ unit }) => [unit.id, {
        rate: String(unit.rate ?? ""),
        priced: unit.status === "已計價",
      }])));
      setBillingMessage("");
      setEditing(true);
    },
    cancelEditing = () => {
      setBillingDrafts({});
      setSaveConfirmation(false);
      setBillingMessage("");
      setEditing(false);
    },
    requestSave = () => {
      if (!billingChanges.length) return setBillingMessage("沒有需要保存的修改");
      setBillingMessage("");
      setSaveConfirmation(true);
    },
    confirmSave = () => {
      const changes = new Map(billingChanges.map((row) => [row.unit.id, row]));
      patch({
        units: p.units.map((unit) => {
          const changed = changes.get(unit.id);
          if (!changed) return unit;
          const rate = safeDraftRate(changed.draft.rate), newlyPriced = unit.status !== "已計價" && changed.draft.priced;
          return {
            ...unit,
            rate,
            ...(newlyPriced ? {
              status: "已計價",
              pricedAt: day(),
              events: [{ id: id(), at: stamp(), title: "月結已計價", detail: `金額 ${changed.record.amount}`, photos: [] }, ...unit.events],
            } : {}),
          };
        }),
      });
      setSaveConfirmation(false);
      setBillingDrafts({});
      setEditing(false);
    },
    changeBillingPeriod = (kind: "year" | "month", value: string) => {
      if (editing && billingChanges.length) {
        setBillingMessage("目前有尚未保存的修改，請先保存或取消修改後再切換月份。");
        return;
      }
      if (editing) cancelEditing();
      if (kind === "year") setY(value); else setM(value);
    };
  return (
    <div className="panel form billing-print-area">
      <div className="panel-head">
        <div>
          <h2>月結／計價總表</h2>
          <p>已驗收戶別自動進入，可人工確認單價與金額。</p>
        </div>
        <div className="form-actions billing-no-print">
          {!editing ? <button type="button" className="primary" onClick={startEditing}>編輯月結</button> : <>
            <button type="button" className="ghost" onClick={cancelEditing}>取消修改</button>
            <button type="button" className="primary" onClick={requestSave}>保存修改</button>
          </>}
        </div>
      </div>
      <div className="filters billing-no-print">
        <select value={y} onChange={(e) => changeBillingPeriod("year", e.target.value)}>
          <option>2026</option>
          <option>2027</option>
        </select>
        <select value={m} onChange={(e) => changeBillingPeriod("month", e.target.value)}>
          {Array.from({ length: 12 }, (_, i) =>
            String(i + 1).padStart(2, "0"),
          ).map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      {billingMessage && <div className="warning billing-no-print">{billingMessage}</div>}
      {editing && billingChanges.length > 0 && <div className="warning billing-no-print">目前有尚未保存的月結修改；匯出內容仍以已保存資料為準。</div>}
      <div className="billing-print-month">計價月份：{ym}</div>
      <section className="acceptance-exports billing-no-print">
        <div className="checklist-head"><div><h3>報表／匯出</h3><small>依目前月份與案場資料預覽、下載或列印報表。</small></div></div>
        <div className="export-cards">
          <button type="button" disabled={!billRecords.length} onClick={() => { const workbook = createReceivableWorkbook(p, billRecords, ym); saveReceivableWorkbook(workbook, `${ym}-${p.name}-SPC應收帳款明細表.xlsx`); }}><i className="excel">X</i><span><b>應收帳款 Excel</b><small>公司應收帳款明細表 · XLSX</small></span><em>下載 ›</em></button>
          <button type="button" onClick={() => exportCsv(p, billRecords, ym)}><i className="excel">C</i><span><b>CSV 匯出</b><small>月結戶別明細 · CSV</small></span><em>下載 ›</em></button>
          <button type="button" onClick={printBilling}><i>PDF</i><span><b>PDF／列印</b><small>列印目前月結頁面</small></span><em>列印 ›</em></button>
          <button type="button" onClick={() => setShipmentPreview(true)}><i className="excel">X</i><span><b>SPC 已出貨明細總表</b><small>Excel · 自動帶入驗收與施工資料</small></span><em>預覽 ›</em></button>
        </div>
      </section>
      <div className="summary">
        <span>
          施工戶數
          <b>
            {
              monthlyUnits.filter((unit) => unit.works.length > 0).length
            }
          </b>
        </span>
        <span>
          驗收戶數
          <b>
            {
              monthlyUnits.filter((unit) => unit.acceptances.some((acceptance) => !acceptance.draft)).length
            }
          </b>
        </span>
        <span>
          待驗收<b>{monthlyUnits.filter((unit) => unit.status === "待驗收").length}</b>
        </span>
        <span>
          缺失改善
          <b>
            {
              monthlyUnits.filter((unit) =>
                ["驗收缺失", "改善中", "待複驗"].includes(unit.status),
              ).length
            }
          </b>
        </span>
        <span>
          本月計價<b><span className="billing-screen-only">NT$ {(editing ? previewSubtotal : billSubtotal).toLocaleString()}</span><span className="billing-print-only">NT$ {billSubtotal.toLocaleString()}</span></b>
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>棟別</th>
              <th>樓層</th>
              <th>戶別</th>
              <th>型號／色號</th>
              <th>施工坪數</th>
              <th>驗收坪數</th>
              <th>單價</th>
              <th>金額</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody>
            {previewRows.map(({ unit: u, record, savedRecord, draft }) => (
              <tr key={u.id}>
                <td>{u.building}</td>
                <td>{u.floor}</td>
                <td>{u.number}</td>
                <td>
                  {u.model}／{u.colorNo}
                </td>
                <td>{u.works.reduce((s, w) => s + w.area, 0)}</td>
                <td>{record.areaPing}</td>
                <td>
                  <input
                    className="money"
                    type="number"
                    min="0"
                    step="any"
                    disabled={!editing}
                    value={editing ? draft.rate : u.rate}
                    onChange={(e) => setBillingDrafts((current) => ({ ...current, [u.id]: { ...draft, rate: e.target.value } }))}
                  />
                  <span className="billing-print-only">{Number(u.rate || 0).toLocaleString()}</span>
                </td>
                <td><span className="billing-screen-only">{record.amount.toLocaleString()}</span><span className="billing-print-only">{savedRecord.amount.toLocaleString()}</span></td>
                <td>
                  <span className="billing-screen-only">{editing && u.status !== "已計價" ? <label className="check"><input type="checkbox" checked={draft.priced} onChange={(e) => setBillingDrafts((current) => ({ ...current, [u.id]: { ...draft, priced: e.target.checked } }))} />標記已計價</label> : <span>{u.status}</span>}</span><span className="billing-print-only">{u.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {saveConfirmation && <Modal close={() => setSaveConfirmation(false)} title="確認保存月結修改">
        <div className="form">
          <div className="export-summary"><span>案場名稱<b>{p.name}</b></span><span>計價月份<b>{ym}</b></span><span>修改戶別數<b>{billingChanges.length}</b></span><span>保存後總額<b>NT$ {previewSubtotal.toLocaleString()}</b></span></div>
          <div className="table-wrap"><table><thead><tr><th>戶別</th><th>單價變更</th><th>狀態變更</th></tr></thead><tbody>{billingChanges.map(({ unit, draft }) => <tr key={unit.id}><td>{unit.building} {unit.floor} {unit.number}</td><td>{safeDraftRate(draft.rate) !== Number(unit.rate || 0) ? `${Number(unit.rate || 0).toLocaleString()} → ${safeDraftRate(draft.rate).toLocaleString()}` : "—"}</td><td>{unit.status !== "已計價" && draft.priced ? "改為已計價" : "—"}</td></tr>)}</tbody></table></div>
          <div className="form-actions"><button type="button" className="ghost" onClick={() => setSaveConfirmation(false)}>返回修改</button><button type="button" className="primary" onClick={confirmSave}>確認保存</button></div>
        </div>
      </Modal>}
      {shipmentPreview && <Modal close={() => setShipmentPreview(false)} title="SPC 已出貨明細總表｜匯出預覽">
        <div className="form export-preview">
          <Field label="匯出月份" type="month" value={ym} set={(value) => { const [year, month] = value.split("-"); if (year && month) { if (editing && billingChanges.length) setBillingMessage("目前有尚未保存的修改，請先保存或取消修改後再切換月份。"); else { if (editing) cancelEditing(); setY(year); setM(month); } } }} />
          <div className="export-summary"><span>案場<b>{p.name}</b></span><span>戶別筆數<b>{shipmentRecords.length}</b></span><span>總坪數<b>{shipmentRecords.reduce((sum, record) => sum + record.areaPing, 0).toFixed(2)}</b></span><span>總 m²<b>{shipmentRecords.reduce((sum, record) => sum + record.areaSquareMeters, 0).toFixed(2)}</b></span></div>
          {shipmentRecords.some((record) => record.areaPing <= 0) && <div className="warning">部分戶別坪數仍待補；檔案會清楚標記，不會自行填入未知數字。</div>}
          <div className="export-preview-table"><table><thead><tr><th>出貨日期</th><th>客戶名稱</th><th>商品</th><th>戶別</th><th>m²</th><th>片／件 *0.3025</th><th>單價／元</th><th>合計</th><th>廠商</th><th>進價／元</th><th>備註</th></tr></thead><tbody>{shipmentRecords.map((record) => <tr key={record.unitId}><td>{record.exportDate || "待補"}</td><td>{record.projectName}</td><td>{[record.model, record.colorNo].filter(Boolean).join(" ")}</td><td>{record.unitDisplay}</td><td>{record.areaSquareMeters.toFixed(2)}</td><td>{record.areaPing > 0 ? `${record.areaPing.toFixed(2)} 坪` : "待補"}</td><td>{record.unitPrice > 0 ? `${record.unitPrice.toLocaleString()} 元` : "待確認"}</td><td>{record.unitPrice > 0 ? record.amount.toLocaleString() : "待確認"}</td><td>{record.vendor || "—"}</td><td>—</td><td>{record.note || ""}</td></tr>)}</tbody></table></div>
          {!shipmentRecords.length && <div className="form-error">目前沒有符合條件的施工或驗收資料。</div>}
          <div className="form-actions"><button className="ghost" onClick={() => setShipmentPreview(false)}>返回修改</button><button className="primary" disabled={shipmentExporting || !shipmentRecords.length} onClick={async () => { setShipmentExporting(true); try { const workbook = createShipmentWorkbook(p, shipmentRecords, ym); saveShipmentWorkbook(workbook, `${ym}_${p.name}_SPC已出貨明細總表.xlsx`); } finally { setShipmentExporting(false); } }}>{shipmentExporting ? "產生中…" : "確認產生 Excel"}</button></div>
        </div>
      </Modal>}
    </div>
  );
}
type CompletionExportDraft = {
  department: string; officePerson: string; projectName: string; projectAddress: string;
  order: string; constructionDate: string; highlights: string; area: string; unitDisplay: string;
  floorAbnormal: boolean | null; abnormalUnit: string; boardDamaged: boolean | null;
  damagedMaterialType: string; trashCleared: boolean | null; materialModel: string;
  signatureNames: Record<"installer" | "office" | "siteManager" | "supervisor", string>;
};

function buildCompletionExportDraft(project: Project, unit: Unit, acceptance: Acceptance, completion: NonNullable<Acceptance["completion"]>): CompletionExportDraft {
  const constructionDate = unit.works.map((work) => work.date).filter(Boolean).join("、") || acceptance.date;
  return {
    department: completion.department,
    officePerson: completion.officePerson || acceptance.person,
    projectName: project.name,
    projectAddress: project.address,
    order: unit.order,
    constructionDate,
    highlights: completion.floorLevel || "",
    area: String(acceptance.area || unit.estimated || ""),
    unitDisplay: `${unit.building}${unit.floor}${unit.number}`,
    floorAbnormal: completion.floorAbnormal,
    abnormalUnit: completion.abnormalUnit,
    boardDamaged: completion.boardDamaged,
    damagedMaterialType: completion.damagedMaterialType,
    trashCleared: completion.trashCleared,
    materialModel: completion.materialModel || unit.model,
    signatureNames: {
      installer: completion.signatures.installer?.name || "",
      office: completion.signatures.office?.name || "",
      siteManager: completion.signatures.siteManager?.name || "",
      supervisor: completion.signatures.supervisor?.name || "",
    },
  };
}

function Sheet({ project, u }: { project: Project; u: Unit }) {
  const a = getLatestFinalAcceptance(u);
  if (!a) return <div className="panel empty"><h2>尚無正式驗收資料</h2><p>目前尚無正式驗收紀錄，完成驗收後即可產生電子驗收單。</p></div>;
  const floorRecord = (project.floorAcceptances || []).find((record) => record.building === u.building && record.floor === u.floor);
  const floorUnits = floorUnitsFor(project.units, u.building, u.floor);
  const resolved = resolveUnitSignatures(u, floorRecord, floorUnits);
  return <CompletionReport project={project} unit={u} acceptance={a} completion={completionDefaults(a, u)} signatures={resolved.signatures} signatureConflicts={resolved.conflicts} />;
}

function CompletionReport({ project, unit, acceptance, completion, signatures, signatureConflicts = [] }: { project: Project; unit: Unit; acceptance: Acceptance; completion: NonNullable<Acceptance["completion"]>; signatures?: NonNullable<Acceptance["completion"]>["signatures"]; signatureConflicts?: FloorSignatureRole[] }) {
  const reportSignatures = signatures || completion.signatures;
  const createDraft = () => {
    const draft = buildCompletionExportDraft(project, unit, acceptance, completion);
    return { ...draft, signatureNames: { ...draft.signatureNames, ...Object.fromEntries(floorSignatureRoles.map((role) => [role, reportSignatures[role]?.name || draft.signatureNames[role]])) } };
  };
  const [exportDraft, setExportDraft] = useState<CompletionExportDraft>(createDraft);
  const [stage, setStage] = useState<"preview" | "edit" | "confirm">("preview");
  const setText = (key: keyof CompletionExportDraft, value: string) => setExportDraft((current) => ({ ...current, [key]: value }));
  const setBoolean = (key: "floorAbnormal" | "boardDamaged" | "trashCleared", value: boolean | null) => setExportDraft((current) => ({ ...current, [key]: value }));
  const signatureLabels = { installer: "施工人員", office: "工務人員", siteManager: "工地主任", supervisor: "神銀主管" } as const;
  return <div className="completion-report-page">
    <div className="panel completion-report-toolbar">
      <div><p className="eyebrow">A4 三聯式文件</p><h2>每日完工驗收表</h2><p className="muted">三聯共用同一份匯出資料；文件修改不會寫回原始資料。</p></div>
      {stage === "preview" && <button className="primary" onClick={() => setStage("edit")}>編輯／確認驗收單</button>}
    </div>
    {stage === "edit" && <section className="panel form completion-export-editor">
      <div className="panel-head"><div><h2>編輯／確認驗收單</h2><p>所有修改只套用本次三聯匯出。</p></div><button className="ghost" type="button" onClick={() => setExportDraft(createDraft())}>還原自動資料</button></div>
      <div className="grid3">
        {([['department','部門別'],['officePerson','工務人員'],['projectName','案場名稱'],['projectAddress','案場地址'],['order','訂單編號'],['constructionDate','施工日期'],['highlights','其他重點列示'],['area','坪數確認'],['unitDisplay','戶別'],['abnormalUnit','地坪異常戶別'],['damagedMaterialType','損壞板材種類'],['materialModel','板材型號']] as const).map(([key,label]) => <Field key={key} label={label} value={exportDraft[key]} set={(value) => setText(key, value)} />)}
        <CompletionDraftBoolean label="地坪是否異常" value={exportDraft.floorAbnormal} set={(value) => setBoolean("floorAbnormal", value)} />
        <CompletionDraftBoolean label="現場板材是否損壞" value={exportDraft.boardDamaged} set={(value) => setBoolean("boardDamaged", value)} />
        <CompletionDraftBoolean label="現場垃圾是否清運完畢" value={exportDraft.trashCleared} set={(value) => setBoolean("trashCleared", value)} />
        {(Object.keys(signatureLabels) as Array<keyof typeof signatureLabels>).map((key) => <Field key={key} label={`${signatureLabels[key]}簽名人姓名`} value={exportDraft.signatureNames[key]} set={(value) => setExportDraft((current) => ({ ...current, signatureNames: { ...current.signatureNames, [key]: value } }))} />)}
      </div>
      <div className="form-actions"><button className="ghost" onClick={() => setStage("preview")}>取消</button><button className="primary" onClick={() => setStage("confirm")}>確認資料</button></div>
    </section>}
    {stage === "confirm" && <div className="panel completion-export-confirm"><div><h2>確認匯出</h2><p>請核對下方三聯內容；確認後才會開啟列印。</p></div><div className="actions"><button className="ghost" onClick={() => setStage("edit")}>返回修改</button><button className="primary" onClick={() => printWithLifecycleCleanup("printing-completion")}>確認匯出</button></div></div>}
    {!!signatureConflicts.length && <div className="warning">同樓層既有簽名資料不一致：{signatureConflicts.map((role) => signatureLabels[role]).join("、")}。系統未自動選用，請至樓層驗收重新確認。</div>}
    <div className="completion-paper">
      {(["第一聯：客戶存根聯", "第二聯：公司收執聯", "第三聯：廠商收執聯"] as const).map((copy) => <CompletionCopy key={copy} copy={copy} draft={exportDraft} signatures={reportSignatures} />)}
    </div>
  </div>;
}

function CompletionDraftBoolean({ label, value, set }: { label: string; value: boolean | null; set: (value: boolean | null) => void }) {
  return <label className="field"><span>{label}</span><select value={value === null ? "" : value ? "yes" : "no"} onChange={(event) => set(event.target.value === "" ? null : event.target.value === "yes")}><option value="">未勾選</option><option value="yes">是</option><option value="no">否</option></select></label>;
}

function CompletionCopy({ copy, draft, signatures }: { copy: string; draft: CompletionExportDraft; signatures: NonNullable<Acceptance["completion"]>["signatures"] }) {
  const yn = (value: boolean | null) => value === true ? "☑ 是　☐ 否" : value === false ? "☐ 是　☑ 否" : "☐ 是　☐ 否";
  return (
    <section className="completion-copy">
      <div className="completion-title"><div className="completion-logo"><CompanyLogo /></div><h1>每日完工驗收表</h1><span>{copy}</span></div>
      <table><tbody>
        <tr className="completion-basic-labels"><th colSpan={2}>部門別</th><th colSpan={2}>工務人員</th><th colSpan={2}>案場名稱</th><th colSpan={2}>案場地址</th></tr>
        <tr className="completion-basic-values"><td colSpan={2}>{draft.department}</td><td colSpan={2}>{draft.officePerson}</td><td colSpan={2}>{draft.projectName}</td><td colSpan={2}>{draft.projectAddress}</td></tr>
        <tr className="section-row"><th colSpan={8}>驗收前確認事項</th></tr>
        <tr className="completion-precheck-labels"><th colSpan={2}>訂單編號</th><th colSpan={2}>施工日期</th><th colSpan={4}>其他重點列示</th></tr>
        <tr className="completion-precheck-values"><td colSpan={2}>{draft.order}</td><td colSpan={2}>{draft.constructionDate}</td><td colSpan={4}>{draft.highlights}{draft.highlights ? "　" : ""}坪數確認：{draft.area}（坪）　戶別：{draft.unitDisplay}</td></tr>
        <tr><th colSpan={2}>確認項目</th><th colSpan={2}>狀態</th><th colSpan={2}>確認項目</th><th colSpan={2}>狀態</th></tr>
        <tr><td colSpan={2}>地坪是否異常</td><td colSpan={2} className="completion-check-value">{yn(draft.floorAbnormal)}</td><td colSpan={2}>地坪異常戶別</td><td colSpan={2}>{draft.abnormalUnit}</td></tr>
        <tr><td colSpan={2}>現場板材是否損壞</td><td colSpan={2} className="completion-check-value">{yn(draft.boardDamaged)}</td><td colSpan={2}>損壞板材種類</td><td colSpan={2}>{draft.damagedMaterialType}</td></tr>
        <tr><td colSpan={2}>現場垃圾是否清運完畢</td><td colSpan={2} className="completion-check-value">{yn(draft.trashCleared)}</td><td colSpan={2}>板材型號</td><td colSpan={2}>{draft.materialModel}</td></tr>
        <tr className="section-row"><th colSpan={8}>調查確認結果</th></tr>
        <tr>{([['installer','施工人員'],['office','工務人員'],['siteManager','工地主任'],['supervisor','神銀主管']] as const).map(([key,label]) => <th colSpan={2} key={key}>{label}簽名</th>)}</tr>
        <tr className="signature-row">{(["installer","office","siteManager","supervisor"] as const).map((key) => <td colSpan={2} key={key}>{signatures[key]?.data && <img src={signatures[key]!.data} alt={`${key}簽名`} />}<small>{draft.signatureNames[key]}</small></td>)}</tr>
      </tbody></table>
    </section>
  );
}
function Timeline({ u }: { u: Unit }) {
  return (
    <div className="panel timeline">
      <h2>完整工程 Timeline</h2>
      {u.events.map((e) => (
        <article key={e.id}>
          <i />
          <time>{e.at}</time>
          <b>{e.title}</b>
          <p>{e.detail}</p>
          <PhotoGrid photos={e.photos} />
        </article>
      ))}
    </div>
  );
}
function Checklist({
  items,
  set,
  node,
  showCompleteAll = true,
  extraItems,
  className = "",
  onBeforeLast,
  resumeAtLast = 0,
  beforeLastItem,
}: {
  items: CheckItem[];
  set: (x: CheckItem[]) => void;
  node: string;
  showCompleteAll?: boolean;
  extraItems?: any;
  className?: string;
  onBeforeLast?: () => void;
  resumeAtLast?: number;
  beforeLastItem?: any;
}) {
  const [active, setActive] = useState<number | null>(null),
    update = (i: number, x: Partial<CheckItem>) =>
      set(items.map((z, j) => (j === i ? { ...z, ...x } : z))),
    open = (i: number) => {
      if (!items[i].result) update(i, { result: "合格" });
      setActive(i);
    },
    all = () => {
      if (confirm("是否已檢查完成全部項目，確認無誤？"))
        set(items.map((x) => ({ ...x, result: "合格" as Choice })));
    },
    done = items.filter((x) => !!x.result).length,
    bad = items.filter((x) => x.result === "不合格"),
    current = active === null ? null : items[active],
    currentRequiresMeasurement = current?.requiresMeasurement === true && current.label !== "地坪平整度";
  useEffect(() => {
    if (resumeAtLast > 0 && items.length) open(items.length - 1);
  }, [resumeAtLast]);
  return (
    <div className={`checklist-block ${className}`.trim()}>
      <div className="inspection-steps">
        <span className={active === null ? "active" : "done"}>1 項目總覽</span>
        <span className={active !== null ? "active" : ""}>2 逐項檢查</span>
        <span className={bad.length ? "alert" : ""}>3 異常整理</span>
        <span>4 結果確認</span>
      </div>
      {active === null ? (
        <>
          <div className="checklist-head">
            <div>
              <b>檢查項目</b>
              <small>
                已完成 {done}／{items.length} 項
              </small>
            </div>
            {showCompleteAll && <button className="ghost" type="button" onClick={all}>
              全部合格
            </button>}
          </div>
          <div className="inspection-progress">
            <i
              style={{
                width: `${items.length ? (done / items.length) * 100 : 0}%`,
              }}
            />
          </div>
          <div className={`inspection-grid${extraItems ? " survey-section-grid" : ""}`}>
            {items.map((x, i) => {
              const tone =
                  x.result === "合格"
                    ? " good"
                    : x.result === "不合格"
                      ? " bad"
                      : x.result === "不適用"
                        ? " na"
                        : "",
                icon =
                  x.result === "合格"
                    ? "✓"
                    : x.result === "不合格"
                      ? "×"
                      : x.result === "不適用"
                        ? "—"
                        : "○";
              return <Fragment key={x.label}>
                {beforeLastItem && i === items.length - 1 ? beforeLastItem : null}
                <button
                  type="button"
                  className={`inspection-tile${tone}`}
                  onClick={() => open(i)}
                >
                  <i>{icon}</i>
                  <b>{x.label}</b>
                  <small>{x.result || "尚未檢查"}</small>
                </button>
              </Fragment>;
            })}
            {extraItems}
          </div>
          {bad.length > 0 && (
            <div className="issue-summary">
              <div>
                <b>本次異常</b>
                <span>{bad.length} 項</span>
              </div>
              {bad.map((x, i) => (
                <button
                  type="button"
                  key={x.label}
                  onClick={() => setActive(items.indexOf(x))}
                >
                  <span>
                    <b>{x.label}</b>
                    <small>
                      {x.note || "尚未填寫說明"}｜{x.photos?.length || 0} 張照片
                    </small>
                  </span>
                  <em>查看 ›</em>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        current && (
          <div
            className={`inspection-detail${current.result === "不合格" ? " bad" : current.result === "合格" ? " good" : ""}`}
          >
            <button
              type="button"
              className="back inspection-back"
              onClick={() => setActive(null)}
            >
              ‹ 返回項目總覽
            </button>
            <div className="inspection-detail-head">
              <div>
                <small>
                  第 {active + 1}／{items.length} 項
                </small>
                <h2>{current.label}</h2>
              </div>
              <span>{current.result || "尚未檢查"}</span>
            </div>
            <div className="result-actions">
              <button
                type="button"
                className={current.result === "合格" ? "selected good" : ""}
                onClick={() => update(active, { result: "合格" })}
              >
                ✓ 合格
              </button>
              <button
                type="button"
                className={current.result === "不合格" ? "selected bad" : ""}
                onClick={() => update(active, { result: "不合格" })}
              >
                × 有問題
              </button>
              <button
                type="button"
                className={current.result === "不適用" ? "selected na" : ""}
                onClick={() => update(active, { result: "不適用" })}
              >
                — 不適用
              </button>
            </div>
            {currentRequiresMeasurement && <div className="inspection-measure">
              <label className="field"><span>數值（需要時填寫）</span><input type="number" value={current.value || ""} onChange={(e) => update(active, { value: e.target.value })} placeholder="例如 1.2" /></label>
              <label className="field"><span>單位</span><select value={current.unit || ""} onChange={(e) => update(active, { unit: e.target.value })}><option value="">不需要</option><option>cm</option><option>mm</option><option>m</option><option>m²</option><option>坪</option><option>個</option></select></label>
            </div>}
            <label className="field">
              <span>
                {current.result === "不合格"
                  ? "問題說明（必填）"
                  : "補充說明（選填）"}
              </span>
              <textarea
                placeholder={
                  current.result === "不合格"
                    ? "請說明現場問題"
                    : "可補充現場狀況"
                }
                value={current.note}
                onChange={(e) => update(active, { note: e.target.value })}
              />
            </label>
            <Photos
              compact
              label={`${current.label}照片${current.result === "不合格" ? "（必填）" : ""}`}
              node={`${node}｜${current.label}`}
              photos={current.photos || []}
              set={(photos) => update(active, { photos })}
            />
            {current.result === "不合格" &&
              (!current.note.trim() || !current.photos?.length) && (
                <small className="field-error">
                  不合格必須填寫說明並上傳至少 1 張照片
                </small>
              )}
            <div className="inspection-nav">
              <button
                type="button"
                className="ghost"
                disabled={active === 0}
                onClick={() => setActive(Math.max(0, active - 1))}
              >
                上一項
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (onBeforeLast && active === items.length - 2) onBeforeLast();
                  else if (active < items.length - 1) open(active + 1);
                  else setActive(null);
                }}
              >
                {active < items.length - 1 ? "下一項" : "完成檢查"}
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
function History({
  title,
  rows,
  actionLabel = "查看",
}: {
  title: string;
  rows: { a: string; b: string; c: string; onOpen?: () => void }[];
  actionLabel?: string;
}) {
  return (
    <div>
      <h3>{title}</h3>
      {rows.map((r, i) => (
        <div className="history" key={i}>
          <b>{r.a}</b>
          <span>{r.b}</span>
          <span>{r.c}</span>
          {r.onOpen && <button className="ghost" type="button" onClick={r.onOpen}>{actionLabel}</button>}
        </div>
      ))}
    </div>
  );
}
function RecordConfirmation({ title, rows }: { title: string; rows: [string, string][] }) {
  return <section className="record-confirmation"><h3>{title}</h3>{rows.map(([label, value]) => <div key={label}><b>{label}</b><span>{value || "—"}</span></div>)}</section>;
}
function RiskModal({
  bad,
  close,
  save,
}: {
  bad: any[];
  close: () => void;
  save: (x: any) => void;
}) {
  const authUserId = useAuthOwner();
  const riskDraftKey = draftKey(authUserId, "risk", bad.map((x) => x.label).join("-") || "active");
  const [r, setR] = useState(() => readDraft(riskDraftKey, {
      items: bad.map((x) => x.label).join("、"),
      detail: "",
      reason: "",
      person: "",
      date: day(),
      signature: "",
      photos: [] as Photo[],
    })),
    [sign, setSign] = useState(false);
  useOfflineDraftRestore(riskDraftKey, setR);
  useEffect(() => { writeLocalDraft(riskDraftKey, { id: `risk-${bad.map((x) => x.label).join("-")}`, ...r }, authUserId); }, [riskDraftKey, r, bad, authUserId]);
  return (
    <Modal close={close} title="風險告知／強制進場">
      <div className="form">
        <Field
          label="不符合項目"
          value={r.items}
          set={(items: string) => setR({ ...r, items })}
        />
        <Field
          label="風險說明"
          value={r.detail}
          set={(detail: string) => setR({ ...r, detail })}
        />
        <Field
          label="要求進場原因"
          value={r.reason}
          set={(reason: string) => setR({ ...r, reason })}
        />
        <Field
          label="確認人"
          value={r.person}
          set={(person: string) => setR({ ...r, person })}
        />
        <Field
          label="確認日期"
          type="date"
          value={r.date}
          set={(date: string) => setR({ ...r, date })}
        />
        <Photos
          photos={r.photos}
          set={(photos: Photo[]) => setR({ ...r, photos })}
        />
        <button className="ghost" onClick={() => setSign(true)}>
          {r.signature ? "✓ 已簽名" : "電子簽名"}
        </button>
        <button
          className="danger"
          disabled={!r.detail || !r.reason || !r.person || !r.signature}
          onClick={() => {
            save(r);
            removeDurableDraft(riskDraftKey);
            void removeOfflineDraft(riskDraftKey);
          }}
        >
          確認風險並允許進場
        </button>
        {sign && (
          <Sign
            close={() => setSign(false)}
            save={(s) => {
              setR({ ...r, signature: s.data });
              setSign(false);
            }}
          />
        )}
      </div>
    </Modal>
  );
}
function Sign({ close, save }: { close: () => void; save: (x: any) => void }) {
  const c = useRef<HTMLCanvasElement>(null),
    down = useRef(false),
    [name, setName] = useState("");
  useEffect(() => {
    const x = c.current!,
      g = x.getContext("2d")!;
    g.lineWidth = 3;
    g.lineCap = "round";
    const pos = (e: PointerEvent) => {
      const r = x.getBoundingClientRect();
      return [
        ((e.clientX - r.left) * x.width) / r.width,
        ((e.clientY - r.top) * x.height) / r.height,
      ];
    };
    const a = (e: PointerEvent) => {
        down.current = true;
        const [p, q] = pos(e);
        g.beginPath();
        g.moveTo(p, q);
      },
      b = (e: PointerEvent) => {
        if (!down.current) return;
        const [p, q] = pos(e);
        g.lineTo(p, q);
        g.stroke();
      },
      z = () => (down.current = false);
    x.addEventListener("pointerdown", a);
    x.addEventListener("pointermove", b);
    x.addEventListener("pointerup", z);
    return () => {
      x.removeEventListener("pointerdown", a);
      x.removeEventListener("pointermove", b);
      x.removeEventListener("pointerup", z);
    };
  }, []);
  return (
    <Modal close={close} title="觸控電子簽名">
      <Field label="簽名人" value={name} set={setName} />
      <canvas className="sign-canvas" width="900" height="300" ref={c} />
      <button
        className="primary"
        disabled={!name}
        onClick={() =>
          save({ name, data: c.current!.toDataURL(), at: stamp(), valid: true })
        }
      >
        保存簽名
      </button>
    </Modal>
  );
}
function Modal({
  close,
  title,
  children,
}: {
  close: () => void;
  title: string;
  children: any;
}) {
  return (
    <div className="modal">
      <div className="modal-card">
        <div className="panel-head">
          <h2>{title}</h2>
          <button className="x" onClick={close}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
async function compress(f: File) {
  return new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onerror = no;
    r.onload = () => {
      const im = new Image();
      im.onerror = no;
      im.onload = () => {
        const s = Math.min(1, 1200 / Math.max(im.width, im.height)),
          c = document.createElement("canvas");
        c.width = im.width * s;
        c.height = im.height * s;
        c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
        ok(c.toDataURL("image/jpeg", 0.68));
      };
      im.src = r.result as string;
    };
    r.readAsDataURL(f);
  });
}
function Photos({
  photos,
  set,
  label = "現場照片",
  node = label,
  compact = false,
}: {
  photos: Photo[];
  set: (x: Photo[]) => void;
  label?: string;
  node?: string;
  compact?: boolean;
}) {
  const useEnvironmentCapture = shouldUseEnvironmentCapture();
  const [processing, setProcessing] = useState(false),
    [photoError, setPhotoError] = useState(""),
    handleSelectedFiles = async (files: FileList | null) => {
      const selectedFiles = [...(files || [])];
      setPhotoError("");
      if (!selectedFiles.length) return;
      setProcessing(true);
      const added: Photo[] = [];
      let failed = 0;
      for (const file of selectedFiles) {
        try {
          added.push({
            id: id(),
            data: await compress(file),
            node,
            date: stamp(),
            caption: "",
            includeReport: true,
          });
        } catch {
          failed += 1;
        }
      }
      if (added.length) set([...photos, ...added]);
      if (failed) {
        setPhotoError(
          added.length
            ? "部分照片無法讀取，請重新拍攝或從相簿選擇其他照片。"
            : "此圖片格式目前無法處理，請改用 JPEG / PNG 或重新拍照。",
        );
      }
      setProcessing(false);
    },
    handleInput = async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      try {
        await handleSelectedFiles(input.files);
      } finally {
        input.value = "";
      }
    };
  return (
    <div className={compact ? "photo-uploader compact" : "photo-uploader"}>
      <div className="photo-input-head">
        <b>＋ {label}</b>
        <small>自動記錄節點與時間；平板無法直接拍照時請使用相簿。</small>
      </div>
      <div className="photo-input-actions">
        <label className={`photo-source camera${processing ? " disabled" : ""}`} onClick={() => setPhotoError("")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4l1.5-2h5L16 7h4v12H4Z" /><circle cx="12" cy="13" r="4" /></svg>
          <span>拍照</span>
          <input
            className="visually-hidden-file"
            type="file"
            accept="image/*"
            {...(useEnvironmentCapture ? { capture: "environment" as const } : {})}
            disabled={processing}
            onChange={handleInput}
          />
        </label>
        <label className={`photo-source gallery${processing ? " disabled" : ""}`} onClick={() => setPhotoError("")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m4 17 5-5 4 4 2-2 5 4" /></svg>
          <span>從相簿選擇</span>
          <input
            className="visually-hidden-file"
            type="file"
            accept="image/*"
            multiple
            disabled={processing}
            onChange={handleInput}
          />
        </label>
      </div>
      {processing && <div className="photo-processing" role="status" aria-live="polite">照片處理中…</div>}
      {photoError && <div className="photo-error" role="alert">{photoError}</div>}
      <PhotoGrid photos={photos} set={set} />
    </div>
  );
}
function ZoomablePhoto({ photo, alt }: { photo: Photo; alt: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);
  return <>
    <img className="photo-zoom-trigger" alt={alt} src={photo.data} role="button" tabIndex={0} aria-label={`放大查看${alt}`} onClick={() => setOpen(true)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(true); } }} />
    {open && <div className="photo-lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={() => setOpen(false)}>
      <div className="photo-lightbox-content" onClick={(event) => event.stopPropagation()}>
        <button className="photo-lightbox-close" type="button" aria-label="關閉放大照片" onClick={() => setOpen(false)}>×</button>
        <img className="photo-lightbox-image" src={photo.data} alt={alt} />
        {photo.caption && <p>{photo.caption}</p>}
      </div>
    </div>}
  </>;
}
function PhotoGrid({
  photos,
  set,
}: {
  photos: Photo[];
  set?: (x: Photo[]) => void;
}) {
  return photos.length ? (
    <div className={set ? "photos photo-records" : "photos"}>
      {photos.map((x) =>
        set ? (
          <figure className="photo-record" key={x.id}>
            <ZoomablePhoto photo={x} alt={x.caption || "現場紀錄"} />
            <figcaption>
              <small>
                {x.node || "工程照片"} · {x.date || "未記錄時間"}
              </small>
              <input
                value={x.caption || ""}
                placeholder="照片說明"
                onChange={(e) =>
                  set(
                    photos.map((p) =>
                      p.id === x.id ? { ...p, caption: e.target.value } : p,
                    ),
                  )
                }
              />
              <label>
                <input
                  type="checkbox"
                  checked={x.includeReport !== false}
                  onChange={(e) =>
                    set(
                      photos.map((p) =>
                        p.id === x.id
                          ? { ...p, includeReport: e.target.checked }
                          : p,
                      ),
                    )
                  }
                />{" "}
                選入報告
              </label>
              <button
                type="button"
                onClick={() => set(photos.filter((p) => p.id !== x.id))}
              >
                移除
              </button>
            </figcaption>
          </figure>
        ) : (
          <figure key={x.id}>
            <ZoomablePhoto photo={x} alt={x.caption || "現場紀錄"} />
            {x.caption && <figcaption>{x.caption}</figcaption>}
          </figure>
        ),
      )}
    </div>
  ) : null;
}
function Field({
  label,
  value,
  set,
  type = "text",
  disabled = false,
}: {
  label: string;
  value: any;
  set?: (x: string) => void;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        disabled={disabled}
        type={type}
        value={value ?? ""}
        onChange={(e) => set?.(e.target.value)}
      />
    </label>
  );
}
function AreaDraftInput({
  value,
  unit,
  setArea,
}: {
  value: string;
  unit: AreaUnit;
  setArea: (value: string, unit: AreaUnit) => void;
}) {
  const switchUnit = (nextUnit: AreaUnit) => {
    if (nextUnit === unit) return;
    setArea(convertAreaInput(value, unit, nextUnit), nextUnit);
  };
  return (
    <label className="field">
      <span>預估施工坪數</span>
      <div className="area-input-row">
        <input type="number" min="0" step="0.01" value={value} onChange={(event) => setArea(event.target.value, unit)} />
        <select value={unit} onChange={(event) => switchUnit(event.target.value as AreaUnit)}>
          <option value="坪">坪</option>
          <option value="m²">m²</option>
        </select>
      </div>
    </label>
  );
}
function Tabs({
  value,
  set,
  items,
}: {
  value: string;
  set: (x: string) => void;
  items: string[][];
}) {
  return (
    <nav className="tabs">
      {items.map(([k, v]) => (
        <button
          key={k}
          className={value === k ? "active" : ""}
          onClick={() => set(k)}
        >
          {v}
        </button>
      ))}
    </nav>
  );
}
function Pill({ s }: { s: Status }) {
  return <span className={`pill ns${statuses.indexOf(s)}`}>{s}</span>;
}
function Stat({
  name,
  n,
  main = false,
}: {
  name: string;
  n: number;
  main?: boolean;
}) {
  return (
    <div className={main ? "stat main" : "stat"}>
      <small>{name}</small>
      <strong>{n}</strong>
    </div>
  );
}
function Signed({ s }: { s: any }) {
  return (
    <div className="signed">
      <img alt="簽名" src={s.data} />
      <div>
        <b>{s.name}</b>
        <p>{s.at}</p>
      </div>
    </div>
  );
}
function exportCsv(p: Project, records: ReturnType<typeof buildAcceptanceExportRecords>, month: string) {
  const esc = (x: any) => `"${String(x ?? "").replaceAll('"', '""')}"`,
    data = [
      [
        "建案",
        "棟別",
        "樓層",
        "戶別",
        "型號",
        "色號",
        "施工坪數",
        "驗收坪數",
        "單價",
        "金額",
        "狀態",
      ],
      ...records.map((record) => {
        const unit = p.units.find((item) => item.id === record.unitId);
        return [
          p.name,
          unit?.building || "",
          unit?.floor || "",
          unit?.number || "",
          record.model,
          record.colorNo,
          unit?.works.reduce((sum, work) => sum + Number(work.area || 0), 0) || 0,
          record.areaPing,
          record.unitPrice,
          record.amount,
          unit?.status || "",
        ];
      }),
    ]
      .map((r) => r.map(esc).join(","))
      .join("\n"),
    a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob(["\ufeff" + data], { type: "text/csv" }),
  );
  a.download = `${month}-${p.name}-月結.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  revokeObjectUrlLater(a.href);
}
