/**
 * 维保账：待办、费用汇总、设施历史、账实对账。
 * 全部为纯函数（数据来自 store 的 buildings/floors），便于单测。
 */
import type {
  Building,
  CheckRecord,
  Cost,
  Facility,
  FacilityKind,
  Floor,
  ServiceRecord,
} from '../model';
import { FACILITY_LABELS } from '../model';
import { checkDueInfo } from './engine';
import { extinguisherLifecycle } from './serviceLife';

export const costTotal = (c: Cost): number =>
  (Number(c.material) || 0) + (Number(c.labor) || 0) + (Number(c.transport) || 0);

/** 季度标签，如 2026Q3（月份 1-12 → Q1-Q4） */
export function quarterOf(date: string): string {
  const m = Number(date.slice(5, 7)) || 1;
  return `${date.slice(0, 4)}Q${Math.min(4, Math.ceil(m / 3))}`;
}

export type EnrichedService = ServiceRecord & {
  facilityId: string;
  facilityCode: string;
  kind: ServiceRecord['kind'];
  facilityKind: FacilityKind;
  floorId: string;
  floorLevel: number;
  buildingId: string;
  buildingName: string;
  total: number;
};

export type CostSummary = {
  /** 全部维保记录（带楼栋/楼层/设施归属与合计） */
  services: EnrichedService[];
  /** 按楼栋 × 季度汇总 */
  byBuildingQuarter: {
    buildingId: string;
    buildingName: string;
    quarters: { quarter: string; material: number; labor: number; transport: number; total: number }[];
    yearTotal: number;
  }[];
  /** 按设施类型汇总（看得出哪一类最费钱），按金额降序 */
  byFacilityKind: { facilityKind: FacilityKind; label: string; total: number; count: number }[];
  grandTotal: number;
};

export function summarizeCosts(
  buildings: Building[],
  floors: Record<string, Floor>,
  opts: { year?: string } = {},
): CostSummary {
  const services: EnrichedService[] = [];
  for (const b of buildings) {
    for (const fid of b.floors) {
      const floor = floors[fid];
      if (!floor) continue;
      for (const fac of floor.facilities) {
        for (const s of fac.services ?? []) {
          if (opts.year && !s.date.startsWith(opts.year)) continue;
          services.push({
            ...s,
            facilityId: fac.id,
            facilityCode: fac.code,
            facilityKind: fac.kind,
            floorId: floor.id,
            floorLevel: floor.level,
            buildingId: b.id,
            buildingName: b.name,
            total: costTotal(s.cost),
          });
        }
      }
    }
  }

  // 楼栋 × 季度
  const bq = new Map<string, Map<string, Cost & { total: number }>>();
  for (const s of services) {
    let bMap = bq.get(s.buildingId);
    if (!bMap) bq.set(s.buildingId, (bMap = new Map()));
    const q = quarterOf(s.date);
    const cur = bMap.get(q) ?? { material: 0, labor: 0, transport: 0, total: 0 };
    cur.material += s.cost.material || 0;
    cur.labor += s.cost.labor || 0;
    cur.transport += s.cost.transport || 0;
    cur.total += s.total;
    bMap.set(q, cur);
  }
  const byBuildingQuarter = buildings.map((b) => {
    const qMap = bq.get(b.id);
    const quarters = [...(qMap?.keys() ?? [])].sort().map((quarter) => ({
      quarter,
      ...(qMap!.get(quarter)!),
    }));
    const yearTotal = quarters.reduce((sum, q) => sum + q.total, 0);
    return { buildingId: b.id, buildingName: b.name, quarters, yearTotal };
  }).filter((x) => x.quarters.length > 0);

  // 设施类型
  const kindMap = new Map<FacilityKind, { total: number; count: number }>();
  for (const s of services) {
    const cur = kindMap.get(s.facilityKind) ?? { total: 0, count: 0 };
    cur.total += s.total;
    cur.count += 1;
    kindMap.set(s.facilityKind, cur);
  }
  const byFacilityKind = [...kindMap.entries()]
    .map(([facilityKind, v]) => ({
      facilityKind,
      label: FACILITY_LABELS[facilityKind],
      total: v.total,
      count: v.count,
    }))
    .sort((a, b2) => b2.total - a.total);

  return {
    services,
    byBuildingQuarter,
    byFacilityKind,
    grandTotal: services.reduce((s, x) => s + x.total, 0),
  };
}

// ---------- 设施历史时间线 ----------

export type TimelineEvent = {
  date: string;
  type: 'check' | 'service' | 'manufacture' | 'retire';
  check?: CheckRecord;
  service?: ServiceRecord;
  title: string;
  detail?: string;
};

/** 同一具设施的全部历史按时间正序串起来（出厂 → 检查 → 送检/维修/换新 → 报废） */
export function facilityTimeline(fac: Facility): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (fac.manufactureDate) {
    events.push({ date: fac.manufactureDate, type: 'manufacture', title: '出厂' });
  }
  for (const c of fac.checks) {
    events.push({
      date: c.date,
      type: 'check',
      check: c,
      title: `巡检：${c.status}`,
      detail: [
        c.pressureMpa != null ? `压力 ${c.pressureMpa}MPa` : '',
        c.appearance ? `外观 ${c.appearance}` : '',
        c.seal ? `铅封 ${c.seal}` : '',
        c.note ?? '',
      ].filter(Boolean).join(' · '),
    });
  }
  for (const s of fac.services ?? []) {
    const parts = (s.parts ?? []).map((p) => `${p.name ?? '配件'} ${p.partNo}${p.qty && p.qty > 1 ? ` ×${p.qty}` : ''}`).join('；');
    events.push({
      date: s.date,
      type: 'service',
      service: s,
      title: s.kind === 'hydro_test' ? `送检（${s.hydroResult ?? '—'}）` : s.kind === 'repair' ? '维修' : '换新',
      detail: [parts, s.vendor ? `单位：${s.vendor}` : '', `费用 ¥${costTotal(s.cost)}`, s.note ?? '']
        .filter(Boolean).join(' · '),
    });
  }
  if (fac.retiredDate) {
    events.push({ date: fac.retiredDate, type: 'retire', title: '报废/退役' });
  }
  // 同日：出厂 → 检查 → 检修 → 退役
  const order: Record<TimelineEvent['type'], number> = { manufacture: 0, check: 1, service: 2, retire: 3 };
  return events.sort((a, b2) => a.date.localeCompare(b2.date) || order[a.type] - order[b2.type]);
}

// ---------- 待办 ----------

export type TodoItem = {
  buildingId: string;
  buildingName: string;
  floorId: string;
  floorLevel: number;
  facilityId: string;
  facilityCode: string;
  facilityKind: FacilityKind;
  reason: 'check_overdue' | 'check_missing' | 'facility_defect' | 'hydro' | 'scrap';
  /** 待办动作（送检 / 换新 / 检查 / 整改） */
  action: string;
  dueDate: string | null;
  daysLeft: number | null;
  /** 已到期（超过应办日期） */
  due: boolean;
  /** 提前预警（尚未到期） */
  upcoming: boolean;
  message: string;
};

const CHECK_ACTION: Record<TodoItem['reason'], string> = {
  check_overdue: '巡检',
  check_missing: '补登检查',
  facility_defect: '整改/维修',
  hydro: '送检',
  scrap: '换新',
};

/**
 * 全楼待办：检查过期/缺失/损坏 + 灭火器水压试验、报废换新（含提前预警）。
 * 已报废（retiredDate）的设施不再产生待办。排序按紧急程度：已到期按应办日期升序，
 * 预警项排在到期项之后。
 */
export function collectTodos(
  buildings: Building[],
  floors: Record<string, Floor>,
  now: number = Date.now(),
): TodoItem[] {
  const todos: TodoItem[] = [];
  for (const b of buildings) {
    for (const fid of b.floors) {
      const floor = floors[fid];
      if (!floor) continue;
      for (const fac of floor.facilities) {
        if (fac.retiredDate) continue;
        const base = {
          buildingId: b.id,
          buildingName: b.name,
          floorId: floor.id,
          floorLevel: floor.level,
          facilityId: fac.id,
          facilityCode: fac.code,
          facilityKind: fac.kind,
        };

        // 灭火器水压试验 / 报废
        if (fac.kind === 'extinguisher') {
          const life = extinguisherLifecycle(fac, now);
          if (life.todo && life.action) {
            todos.push({
              ...base,
              reason: life.action === 'hydro_test' ? 'hydro' : 'scrap',
              action: CHECK_ACTION[life.action === 'hydro_test' ? 'hydro' : 'scrap'],
              dueDate: life.dueDate,
              daysLeft: life.daysLeft,
              due: life.due,
              upcoming: life.upcoming,
              message: life.message,
            });
          }
        }

        // 巡检到期 / 缺失 / 缺陷
        const info = checkDueInfo(fac, now);
        if (info.defect) {
          todos.push({
            ...base,
            reason: 'facility_defect',
            action: CHECK_ACTION.facility_defect,
            dueDate: null,
            daysLeft: null,
            due: true,
            upcoming: false,
            message: '最近巡检状态为损坏/缺失，需整改或维修',
          });
        } else if (info.missing) {
          todos.push({
            ...base,
            reason: 'check_missing',
            action: CHECK_ACTION.check_missing,
            dueDate: null,
            daysLeft: null,
            due: true,
            upcoming: false,
            message: '未登记任何巡检记录',
          });
        } else if (info.overdue) {
          todos.push({
            ...base,
            reason: 'check_overdue',
            action: CHECK_ACTION.check_overdue,
            dueDate: info.dueDate,
            daysLeft: info.dueDate ? Math.round((new Date(`${info.dueDate}T00:00:00`).getTime() - now) / 86400000) : null,
            due: true,
            upcoming: false,
            message: `巡检已过期（应检日期 ${info.dueDate}）`,
          });
        }
      }
    }
  }
  // 已到期（含损坏/缺检）在前，按应办日期升序；预警项按剩余天数升序排在其后
  todos.sort((a, b2) => {
    if (a.upcoming !== b2.upcoming) return a.upcoming ? 1 : -1;
    return (a.dueDate ?? '9999').localeCompare(b2.dueDate ?? '9999');
  });
  return todos;
}

// ---------- 账实对账 ----------

export type KindDiff = {
  kind: FacilityKind;
  label: string;
  ledger: number;
  onMap: number;
  /** 账 − 图：正=账上多（图上少摆），负=账上少（图上多摆） */
  diff: number;
};

export type FloorReconcile = {
  buildingId: string;
  buildingName: string;
  floorId: string;
  floorLevel: number;
  kindDiffs: KindDiff[];
  /** 账上总数 / 图上总数（仅对登记过账面数的类型合计） */
  ledgerTotal: number;
  onMapTotal: number;
  diffTotal: number;
  matched: boolean;
};

/**
 * 单层账实对账：账面盘点数（floor.ledgerCounts）vs 图上实际布置数。
 * 未登记账面数的类型视为「与图上一致」（不参与差异），避免无数据时整层报差。
 */
export function reconcileFloor(building: Building, floor: Floor): FloorReconcile {
  const counts = new Map<FacilityKind, number>();
  for (const fac of floor.facilities) counts.set(fac.kind, (counts.get(fac.kind) ?? 0) + 1);
  const kindDiffs: KindDiff[] = [];
  for (const [kindStr, ledgerRaw] of Object.entries(floor.ledgerCounts ?? {})) {
    const ledger = Number(ledgerRaw);
    if (!Number.isFinite(ledger)) continue;
    const kind = kindStr as FacilityKind;
    const onMap = counts.get(kind) ?? 0;
    kindDiffs.push({
      kind,
      label: FACILITY_LABELS[kind] ?? kind,
      ledger,
      onMap,
      diff: ledger - onMap,
    });
  }
  kindDiffs.sort((a, b2) => Math.abs(b2.diff) - Math.abs(a.diff) || a.label.localeCompare(b2.label));
  const ledgerTotal = kindDiffs.reduce((s, k) => s + k.ledger, 0);
  const onMapTotal = kindDiffs.reduce((s, k) => s + k.onMap, 0);
  const diffTotal = ledgerTotal - onMapTotal;
  return {
    buildingId: building.id,
    buildingName: building.name,
    floorId: floor.id,
    floorLevel: floor.level,
    kindDiffs,
    ledgerTotal,
    onMapTotal,
    diffTotal,
    matched: kindDiffs.every((k) => k.diff === 0),
  };
}

/** 全楼对账：只把有差异的楼层点出来（差几具、差在哪一层、哪一类） */
export function reconcileAll(buildings: Building[], floors: Record<string, Floor>): FloorReconcile[] {
  const out: FloorReconcile[] = [];
  for (const b of buildings) {
    for (const fid of b.floors) {
      const floor = floors[fid];
      if (!floor) continue;
      const r = reconcileFloor(b, floor);
      if (!r.matched) out.push(r);
    }
  }
  out.sort(
    (a, b2) =>
      Math.abs(b2.diffTotal) - Math.abs(a.diffTotal) ||
      a.buildingName.localeCompare(b2.buildingName) ||
      a.floorLevel - b2.floorLevel,
  );
  return out;
}
