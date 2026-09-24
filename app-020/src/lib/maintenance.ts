/**
 * 维保账领域逻辑（纯函数）：
 * 1) 灭火器水压试验 / 报废年限判定（出厂日期 + 换新 + 历次送检记录）；
 * 2) 到期待办（提前 30 天，标明「送检」还是「换新」）；
 * 3) 同一具设施的履历时间线（检查 + 维修/送检/换新，含更换配件号）；
 * 4) 费用按楼栋、按季度汇总；
 * 5) 账面数量与图上实布数量对账。
 */
import type {
  Building,
  CheckRecord,
  Facility,
  FacilityKind,
  Floor,
  ServiceRecord,
} from '../model';
import { EXTINGUISHER_LIFE, LIFE_LEAD_DAYS } from '../rules/defaults';

export type ExtType = 'dry_powder' | 'co2' | 'water';

export type LifeInfo = {
  /** 寿命起算日：取最近一次换新时登记的新具出厂日期，否则为原出厂日期 */
  basisDate: string | null;
  scrapDate: string | null; // 应报废日期（basis + 报废年限）
  hydroDueDate: string | null; // 下次水压试验到期日
  lastHydroDate: string | null; // 最近一次水压试验日期
  /** 已超过报废日期：必须换新 */
  scrapOverdue: boolean;
  /** 已超过水压试验日期：必须送检 */
  hydroOverdue: boolean;
  /** 距报废期限 ≤ 提前量（但尚未到）：提前列入待办 */
  scrapSoon: boolean;
  /** 距水压试验期限 ≤ 提前量：提前列入待办 */
  hydroSoon: boolean;
  hydroIntervalYears: number;
  scrapYears: number;
};

const DAY_MS = 86400000;
const p2 = (v: number) => String(v).padStart(2, '0');

function toLocalDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function addYears(dateStr: string, years: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setFullYear(d.getFullYear() + years);
  return toLocalDate(d.getTime());
}

/** 季度 1~4（按本地月份） */
export function quarterOf(dateStr: string): number {
  return Math.floor((Number(dateStr.slice(5, 7)) - 1) / 3) + 1;
}

export function yearOf(dateStr: string): number {
  return Number(dateStr.slice(0, 4));
}

function servicesOf(fac: Facility): ServiceRecord[] {
  return fac.services ?? [];
}

/** 寿命判定所需的最小设施字段（便于测试与引擎侧直接调用） */
export type LifeFacility = Pick<Facility, 'kind' | 'manufactureDate' | 'services' | 'spec'>;

/**
 * 灭火器年限判定。
 * 换新（replacement）登记了新具出厂日期时，全部期限从新具重新起算；
 * 水压试验基准日 = 新寿命起点后的最近一次 hydro_test，未送检过则从寿命起点起算。
 */
export function extinguisherLife(
  fac: LifeFacility,
  now: number = Date.now(),
  leadDays: number = LIFE_LEAD_DAYS,
): LifeInfo | null {
  if (fac.kind !== 'extinguisher') return null;
  const extType: ExtType = fac.spec?.extType ?? 'dry_powder';
  const rule = EXTINGUISHER_LIFE[extType];
  const services = fac.services ?? [];

  // 寿命起点：最近一次换新时登记的新出厂日期 > 原始出厂日期
  let basis = fac.manufactureDate ?? null;
  for (const s of services) {
    if (s.type === 'replacement' && s.newManufactureDate && (!basis || s.newManufactureDate >= basis)) {
      basis = s.newManufactureDate;
    }
  }
  if (!basis) {
    return {
      basisDate: null,
      scrapDate: null,
      hydroDueDate: null,
      lastHydroDate: null,
      scrapOverdue: false,
      hydroOverdue: false,
      scrapSoon: false,
      hydroSoon: false,
      hydroIntervalYears: rule.hydroIntervalYears,
      scrapYears: rule.scrapYears,
    };
  }

  const scrapDate = addYears(basis, rule.scrapYears);
  // 新寿命起点之后的水压试验记录（换新前的旧记录不参与新具周期）
  const hydros = services
    .filter((s) => s.type === 'hydro_test' && s.date >= basis)
    .map((s) => s.date)
    .sort();
  const lastHydroDate = hydros.length ? hydros[hydros.length - 1] : null;
  const hydroBase = lastHydroDate ?? basis;
  // 理论上的下次试压日；若落在报废日之后（瓶即将报废、不必再试），仍保留日期用于展示，
  // 待办逻辑中报废优先，不会重复产生送检项。
  const hydroDueDate = addYears(hydroBase, rule.hydroIntervalYears);

  const today = toLocalDate(now);
  const scrapOverdue = scrapDate < today;
  const hydroOverdue = hydroDueDate !== null && hydroDueDate < today;
  const withinLead = (target: string) => {
    const days = (new Date(`${target}T00:00:00`).getTime() - now) / DAY_MS;
    return days >= 0 && days <= leadDays;
  };
  return {
    basisDate: basis,
    scrapDate,
    hydroDueDate,
    lastHydroDate,
    scrapOverdue,
    hydroOverdue,
    scrapSoon: !scrapOverdue && withinLead(scrapDate),
    hydroSoon: !hydroOverdue && hydroDueDate !== null && withinLead(hydroDueDate),
    hydroIntervalYears: rule.hydroIntervalYears,
    scrapYears: rule.scrapYears,
  };
}

// ---------- 待办 ----------

export type TodoAction = 'hydro_test' | 'replace' | 'repair';

export type MaintenanceTodo = {
  buildingId: string;
  buildingName: string;
  floorId: string;
  floorLevel: number;
  facilityId: string;
  facilityCode: string;
  kind: FacilityKind;
  action: TodoAction;
  reason: string;
  dueDate: string | null; // 期限（试压到期日 / 报废日）
  overdue: boolean;
  /** 还有多少天到期（负数为已过期天数），无期限为 null */
  daysLeft: number | null;
};

/**
 * 汇总单栋建筑（或全部建筑）的维保待办：
 * - 日常检查发现 damaged/missing → 维修/补齐；
 * - 水压试验到期（含提前量）→ 送检；
 * - 到报废年限（含提前量）→ 换新；报废优先于送检。
 */
export function maintenanceTodos(
  buildings: Building[],
  floors: Record<string, Floor>,
  now: number = Date.now(),
  leadDays: number = LIFE_LEAD_DAYS,
): MaintenanceTodo[] {
  const todos: MaintenanceTodo[] = [];
  for (const b of buildings) {
    for (const fid of b.floors) {
      const floor = floors[fid];
      if (!floor) continue;
      for (const fac of floor.facilities) {
        // 日常检查缺陷
        const last = [...fac.checks].sort((a, c) => c.date.localeCompare(a.date))[0];
        if (last && (last.status === 'damaged' || last.status === 'missing')) {
          todos.push({
            buildingId: b.id,
            buildingName: b.name,
            floorId: floor.id,
            floorLevel: floor.level,
            facilityId: fac.id,
            facilityCode: fac.code,
            kind: fac.kind,
            action: 'repair',
            reason: `最近检查（${last.date}）状态为「${last.status === 'damaged' ? '损坏' : '现场缺失'}」`,
            dueDate: null,
            overdue: true,
            daysLeft: null,
          });
        }
        if (fac.kind !== 'extinguisher') continue;
        const life = extinguisherLife(fac, now, leadDays);
        if (!life) continue;
        if (!life.basisDate) {
          todos.push({
            buildingId: b.id,
            buildingName: b.name,
            floorId: floor.id,
            floorLevel: floor.level,
            facilityId: fac.id,
            facilityCode: fac.code,
            kind: fac.kind,
            action: 'replace',
            reason: '未登记出厂日期，无法判定水压试验/报废年限，请核对铭牌补登',
            dueDate: null,
            overdue: false,
            daysLeft: null,
          });
          continue;
        }
        if (life.scrapOverdue || life.scrapSoon) {
          const days = life.scrapDate ? daysBetween(now, life.scrapDate) : null;
          todos.push({
            buildingId: b.id,
            buildingName: b.name,
            floorId: floor.id,
            floorLevel: floor.level,
            facilityId: fac.id,
            facilityCode: fac.code,
            kind: fac.kind,
            action: 'replace',
            reason: life.scrapOverdue
              ? `已到 ${life.scrapYears} 年报废年限（${life.basisDate} 出厂，应于 ${life.scrapDate} 报废）`
              : `${life.scrapDate} 到 ${life.scrapYears} 年报废年限，提前安排换新`,
            dueDate: life.scrapDate,
            overdue: life.scrapOverdue,
            daysLeft: days,
          });
        } else if (life.hydroOverdue || life.hydroSoon) {
          const days = life.hydroDueDate ? daysBetween(now, life.hydroDueDate) : null;
          todos.push({
            buildingId: b.id,
            buildingName: b.name,
            floorId: floor.id,
            floorLevel: floor.level,
            facilityId: fac.id,
            facilityCode: fac.code,
            kind: fac.kind,
            action: 'hydro_test',
            reason: life.hydroOverdue
              ? `水压试验已到期（上次：${life.lastHydroDate ?? life.basisDate}，应于 ${life.hydroDueDate} 前送检）`
              : `${life.hydroDueDate} 到水压试验日期（每 ${life.hydroIntervalYears} 年一次），提前安排送检`,
            dueDate: life.hydroDueDate,
            overdue: life.hydroOverdue,
            daysLeft: days,
          });
        }
      }
    }
  }
  // 排序：已过期在前；同为待办按处理优先级（换新 > 送检 > 维修），再按剩余天数升序；
  // 无期限的维修项在同优先级内排最前
  const actionRank: Record<TodoAction, number> = { replace: 0, hydro_test: 1, repair: 2 };
  todos.sort((a, c) => {
    if (a.overdue !== c.overdue) return a.overdue ? -1 : 1;
    if (actionRank[a.action] !== actionRank[c.action]) return actionRank[a.action] - actionRank[c.action];
    if (a.daysLeft === null && c.daysLeft === null) return 0;
    if (a.daysLeft === null) return -1;
    if (c.daysLeft === null) return 1;
    return a.daysLeft - c.daysLeft;
  });
  return todos;
}

function daysBetween(now: number, target: string): number {
  return Math.round((new Date(`${target}T00:00:00`).getTime() - now) / DAY_MS);
}

// ---------- 履历时间线 ----------

export type TimelineEntry =
  | {
      kind: 'check';
      date: string;
      check: CheckRecord;
      checkIndex: number;
      status: string;
      pressureMpa?: number;
      appearance?: string;
      seal?: string;
      note?: string;
      photoKey?: string;
    }
  | {
      kind: 'service';
      date: string;
      ref: ServiceRecord;
      serviceType: ServiceRecord['type'];
      totalCost: number;
      parts: NonNullable<ServiceRecord['parts']>;
      vendor?: string;
      reportNo?: string;
      newManufactureDate?: string;
      note?: string;
    };

/** 同一具设施的检查与维保记录按时间倒序串起来（含更换配件号、费用） */
export function facilityTimeline(fac: Facility): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  fac.checks.forEach((c, checkIndex) => {
    entries.push({
      kind: 'check',
      date: c.date,
      check: c,
      checkIndex,
      status: c.status,
      pressureMpa: c.pressureMpa,
      appearance: c.appearance,
      seal: c.seal,
      note: c.note,
      photoKey: c.photoKey,
    });
  });
  for (const s of servicesOf(fac)) {
    entries.push({
      kind: 'service',
      date: s.date,
      ref: s,
      serviceType: s.type,
      totalCost: serviceCostTotal(s),
      parts: s.parts ?? [],
      vendor: s.vendor,
      reportNo: s.reportNo,
      newManufactureDate: s.newManufactureDate,
      note: s.note,
    });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

export function serviceCostTotal(s: ServiceRecord): number {
  return s.cost.material + s.cost.labor + s.cost.transport;
}

// ---------- 费用汇总 ----------

export type BuildingQuarterCost = {
  buildingId: string;
  buildingName: string;
  q1: number;
  q2: number;
  q3: number;
  q4: number;
  yearTotal: number;
};

export type KindCost = {
  kind: FacilityKind;
  total: number;
  material: number;
  labor: number;
  transport: number;
  count: number; // 产生费用的维保笔数
};

export type CostSummary = {
  year: number;
  total: number;
  byBuilding: BuildingQuarterCost[];
  byKind: KindCost[];
};

type CostRow = {
  building: Building;
  fac: Facility;
  service: ServiceRecord;
};

function costRows(buildings: Building[], floors: Record<string, Floor>): CostRow[] {
  const rows: CostRow[] = [];
  for (const b of buildings) {
    for (const fid of b.floors) {
      const floor = floors[fid];
      if (!floor) continue;
      for (const fac of floor.facilities) {
        for (const s of servicesOf(fac)) rows.push({ building: b, fac, service: s });
      }
    }
  }
  return rows;
}

/** 按楼栋 × 季度汇总指定年度费用；另给出按设施类型的年度排行 */
export function summarizeCosts(
  buildings: Building[],
  floors: Record<string, Floor>,
  year: number,
): CostSummary {
  const rows = costRows(buildings, floors).filter((r) => yearOf(r.service.date) === year);

  const byBuilding: BuildingQuarterCost[] = buildings.map((b) => ({
    buildingId: b.id,
    buildingName: b.name,
    q1: 0,
    q2: 0,
    q3: 0,
    q4: 0,
    yearTotal: 0,
  }));
  const bIndex = new Map(byBuilding.map((x) => [x.buildingId, x]));

  const kindMap = new Map<FacilityKind, KindCost>();
  let total = 0;
  for (const r of rows) {
    const amt = serviceCostTotal(r.service);
    total += amt;
    const bq = bIndex.get(r.building.id);
    if (bq) {
      const q = quarterOf(r.service.date);
      if (q === 1) bq.q1 += amt;
      else if (q === 2) bq.q2 += amt;
      else if (q === 3) bq.q3 += amt;
      else bq.q4 += amt;
      bq.yearTotal += amt;
    }
    let kc = kindMap.get(r.fac.kind);
    if (!kc) {
      kc = { kind: r.fac.kind, total: 0, material: 0, labor: 0, transport: 0, count: 0 };
      kindMap.set(r.fac.kind, kc);
    }
    kc.total += amt;
    kc.material += r.service.cost.material;
    kc.labor += r.service.cost.labor;
    kc.transport += r.service.cost.transport;
    kc.count += 1;
  }
  const byKind = [...kindMap.values()].sort((a, b) => b.total - a.total);
  byBuilding.sort((a, b) => b.yearTotal - a.yearTotal);
  return { year, total, byBuilding, byKind };
}

/** 数据中出现过费用的年份（升序），供年度切换；无记录时返回当前年 */
export function costYears(buildings: Building[], floors: Record<string, Floor>): number[] {
  const years = new Set<number>();
  for (const r of costRows(buildings, floors)) years.add(yearOf(r.service.date));
  if (!years.size) years.add(new Date().getFullYear());
  return [...years].sort((a, b) => a - b);
}

// ---------- 账实对账 ----------

export type ReconcileItem = {
  buildingId: string;
  buildingName: string;
  floorId: string;
  floorLevel: number;
  kind: FacilityKind;
  expected: number; // 账面数量
  actual: number; // 图上实布数量
  diff: number; // 账面 - 实布：>0 图上少摆，<0 图上多摆
};

/**
 * 账实对账：逐楼层逐类型比对「账面在册数量（expectedCounts）」与图上实布数量。
 * 仅对登记过账面数量的类型报警，差几具、差在哪一层逐项列出。
 */
export function reconcileFloorCounts(
  buildings: Building[],
  floors: Record<string, Floor>,
): ReconcileItem[] {
  const out: ReconcileItem[] = [];
  for (const b of buildings) {
    for (const fid of b.floors) {
      const floor = floors[fid];
      if (!floor || !floor.expectedCounts) continue;
      for (const [kindStr, expected] of Object.entries(floor.expectedCounts)) {
        if (expected == null) continue;
        const kind = kindStr as FacilityKind;
        const actual = floor.facilities.filter((f) => f.kind === kind).length;
        const diff = expected - actual;
        if (diff !== 0) {
          out.push({
            buildingId: b.id,
            buildingName: b.name,
            floorId: floor.id,
            floorLevel: floor.level,
            kind,
            expected,
            actual,
            diff,
          });
        }
      }
    }
  }
  out.sort((a, b) => a.buildingName.localeCompare(b.buildingName, 'zh') || a.floorLevel - b.floorLevel);
  return out;
}
