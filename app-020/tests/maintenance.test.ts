/**
 * 维保账验收用例，覆盖需求逐条：
 * 1) 按出厂日期 + 检修记录判定水压试验 / 报废年限；
 * 2) 到期（含提前 30 天）进入待办并标明「送检」还是「换新」；
 * 3) 换新/维修费用（材料、人工、运输）按楼栋与季度汇总、按设施类型排行；
 * 4) 同一具设施的履历按时间串起来，换配件留下配件号；
 * 5) 账面数量与图上实布对账，差几具、差在哪一层。
 */
import { describe, it, expect } from 'vitest';
import type { Building, Facility, FacilityKind, Floor, ServiceRecord } from '../src/model';
import {
  extinguisherLife,
  maintenanceTodos,
  facilityTimeline,
  summarizeCosts,
  reconcileFloorCounts,
  addYears,
  quarterOf,
  type LifeInfo,
} from '../src/lib/maintenance';

const DAY = 86400000;
const p2 = (v: number) => String(v).padStart(2, '0');
/** 以「今天」为基准偏移 offsetDays 天的本地日期 */
function dateFromNow(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * DAY);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function yearsFromNow(offsetYears: number): string {
  return addYears(`${new Date().getFullYear()}-06-15`, offsetYears);
}

function fac(partial: Partial<Facility> & Pick<Facility, 'kind'>): Facility {
  return {
    id: partial.id ?? 'fac1',
    kind: partial.kind,
    x: 0,
    y: 0,
    code: partial.code ?? '1F-EX-01',
    manufactureDate: partial.manufactureDate,
    spec: partial.spec,
    checks: partial.checks ?? [],
    services: partial.services ?? [],
  };
}

function svc(partial: Partial<ServiceRecord> & Pick<ServiceRecord, 'date' | 'type'>): ServiceRecord {
  return {
    id: partial.id ?? `svc-${Math.random().toString(36).slice(2, 7)}`,
    date: partial.date,
    type: partial.type,
    cost: partial.cost ?? { material: 0, labor: 0, transport: 0 },
    parts: partial.parts,
    vendor: partial.vendor,
    reportNo: partial.reportNo,
    newManufactureDate: partial.newManufactureDate,
    note: partial.note,
  };
}

/** 一层楼 + 一栋楼的最小夹具 */
function world(facs: Facility[], floorId = 'f1', buildingName = '测试楼'): {
  buildings: Building[];
  floors: Record<string, Floor>;
  building: Building;
  floor: Floor;
} {
  const floor: Floor = {
    id: floorId,
    buildingId: 'b1',
    level: 1,
    scaleMmPerUnit: 1,
    rooms: [],
    facilities: facs,
    exits: facs.filter((f) => f.kind === 'exit').map((f) => f.id),
    expectedCounts: undefined,
    version: 0,
  };
  const building: Building = { id: 'b1', name: buildingName, kind: 'office', floors: [floorId], createdAt: '' };
  return { buildings: [building], floors: { [floorId]: floor }, building, floor };
}

// ---------- 年限判定 ----------

describe('extinguisherLife（水压试验 / 报废年限）', () => {
  it('M1 干粉出厂 10 年 → 报废逾期；水基 6 年；CO2 试压周期 5 年', () => {
    const powder = fac({ kind: 'extinguisher', manufactureDate: yearsFromNow(-10), spec: { extType: 'dry_powder' } });
    const lp = extinguisherLife(powder)!;
    expect(lp.scrapOverdue).toBe(true);
    expect(lp.hydroDueDate).not.toBeNull();
    expect(lp.scrapYears).toBe(10);

    const water = fac({ kind: 'extinguisher', manufactureDate: yearsFromNow(-6), spec: { extType: 'water' } });
    const lw = extinguisherLife(water)!;
    expect(lw.scrapOverdue).toBe(true);
    expect(lw.scrapYears).toBe(6);
    expect(lw.hydroIntervalYears).toBe(1);

    // CO2 出厂 6 年、未试压：试压（5 年）逾期但未到 10 年报废
    const co2 = fac({ kind: 'extinguisher', manufactureDate: yearsFromNow(-6), spec: { extType: 'co2' } });
    const lc = extinguisherLife(co2)!;
    expect(lc.hydroOverdue).toBe(true);
    expect(lc.scrapOverdue).toBe(false);
  });

  it('M2 最近一次水压试验后重新起算试压周期，报废年限不变', () => {
    const made = yearsFromNow(-8); // 干粉：距报废还有 2 年
    const lastHydro = dateFromNow(-30); // 1 个月前送检
    const f = fac({
      kind: 'extinguisher',
      manufactureDate: made,
      spec: { extType: 'dry_powder' },
      services: [svc({ date: lastHydro, type: 'hydro_test', reportNo: 'HT-2026-001' })],
    });
    const life = extinguisherLife(f)!;
    expect(life.lastHydroDate).toBe(lastHydro);
    expect(life.hydroDueDate).toBe(addYears(lastHydro, 2));
    expect(life.hydroOverdue).toBe(false);
    expect(life.scrapDate).toBe(addYears(made, 10));
    expect(life.scrapOverdue).toBe(false);
  });

  it('M3 换新登记新出厂日期后，全部期限从新具重新起算（旧试压记录不再参与）', () => {
    const oldMade = yearsFromNow(-11);
    const replaceDate = dateFromNow(-200);
    const newMade = yearsFromNow(0).replace('06-15', '01-10'); // 今年新具
    const f = fac({
      kind: 'extinguisher',
      manufactureDate: oldMade,
      spec: { extType: 'dry_powder' },
      services: [
        svc({ date: yearsFromNow(-3), type: 'hydro_test' }), // 旧瓶试压，新具不采用
        svc({ date: replaceDate, type: 'replacement', cost: { material: 220, labor: 30, transport: 20 }, newManufactureDate: newMade }),
      ],
    });
    const life = extinguisherLife(f)!;
    expect(life.basisDate).toBe(newMade);
    expect(life.scrapDate).toBe(addYears(newMade, 10));
    expect(life.scrapOverdue).toBe(false);
    expect(life.lastHydroDate).toBeNull(); // 新具还没送检过
    expect(life.hydroDueDate).toBe(addYears(newMade, 2));
  });

  it('M4 距期限 30 天内 → soon；超 30 天不提示；已过期 → overdue', () => {
    // 距试压到期 20 天：干粉出厂 1 年 345 天 ≈ 距 2 年试压还有 20 天
    const soonHydro = fac({
      kind: 'extinguisher',
      manufactureDate: dateFromNow(-(2 * 365 - 20)),
      spec: { extType: 'dry_powder' },
    });
    expect(extinguisherLife(soonHydro)!.hydroSoon).toBe(true);
    expect(extinguisherLife(soonHydro)!.hydroOverdue).toBe(false);

    // 距试压到期还有半年：不进提前窗口
    const later = fac({
      kind: 'extinguisher',
      manufactureDate: dateFromNow(-(2 * 365 - 180)),
      spec: { extType: 'dry_powder' },
    });
    const li = extinguisherLife(later)!;
    expect(li.hydroSoon).toBe(false);
    expect(li.hydroOverdue).toBe(false);

    // 超过试压日 10 天
    const overdue = fac({
      kind: 'extinguisher',
      manufactureDate: dateFromNow(-(2 * 365 + 10)),
      spec: { extType: 'dry_powder' },
    });
    expect(extinguisherLife(overdue)!.hydroOverdue).toBe(true);
  });

  it('M5 无出厂日期 → basisDate 为 null 且不误判任何期限', () => {
    const life: LifeInfo = extinguisherLife(fac({ kind: 'extinguisher', spec: { extType: 'dry_powder' } }))!;
    expect(life.basisDate).toBeNull();
    expect(life.scrapDate).toBeNull();
    expect(life.hydroDueDate).toBeNull();
    expect(life.scrapOverdue).toBe(false);
    expect(life.hydroOverdue).toBe(false);
  });

  it('M6 非灭火器不参与年限判定', () => {
    expect(extinguisherLife(fac({ kind: 'hydrant', manufactureDate: yearsFromNow(-30) }))).toBeNull();
  });
});

// ---------- 待办 ----------

describe('maintenanceTodos（送检 / 换新 / 维修待办）', () => {
  it('T1 试压逾期 → 送检；报废逾期 → 换新；换新优先级高于送检', () => {
    const hydro = fac({
      id: 'f-hydro',
      code: '1F-EX-01',
      kind: 'extinguisher',
      manufactureDate: yearsFromNow(-6),
      spec: { extType: 'co2' },
    });
    const scrap = fac({
      id: 'f-scrap',
      code: '1F-EX-02',
      kind: 'extinguisher',
      manufactureDate: yearsFromNow(-11),
      spec: { extType: 'dry_powder' },
    });
    const w = world([hydro, scrap]);
    const todos = maintenanceTodos(w.buildings, w.floors);
    const tHydro = todos.find((t) => t.facilityId === 'f-hydro')!;
    const tScrap = todos.find((t) => t.facilityId === 'f-scrap')!;
    expect(tHydro.action).toBe('hydro_test');
    expect(tHydro.overdue).toBe(true);
    expect(tScrap.action).toBe('replace');
    expect(tScrap.overdue).toBe(true);
    // 排序：已逾期且剩余天数更少（报废 10 年）在前
    expect(todos[0].facilityId).toBe('f-scrap');
  });

  it('T2 距报废 20 天 → 提前列入待办并标明换新；同具不会同时出现送检+换新两条', () => {
    const soon = fac({
      id: 'f-soon',
      kind: 'extinguisher',
      manufactureDate: dateFromNow(-(10 * 365 - 20)),
      spec: { extType: 'dry_powder' },
    });
    const w = world([soon]);
    const todos = maintenanceTodos(w.buildings, w.floors);
    const mine = todos.filter((t) => t.facilityId === 'f-soon');
    expect(mine).toHaveLength(1);
    expect(mine[0].action).toBe('replace');
    expect(mine[0].overdue).toBe(false);
    expect(mine[0].daysLeft).toBeGreaterThan(0);
    expect(mine[0].daysLeft).toBeLessThanOrEqual(30);
  });

  it('T3 检查为损坏/缺失 → 维修待办；正常设施不产生待办', () => {
    const damaged = fac({
      id: 'f-damaged',
      code: '1F-HY-01',
      kind: 'hydrant',
      checks: [{ date: dateFromNow(-2), status: 'damaged' }],
    });
    const ok = fac({
      id: 'f-ok',
      code: '1F-EX-09',
      kind: 'extinguisher',
      manufactureDate: dateFromNow(-200),
      spec: { extType: 'dry_powder' },
      checks: [{ date: dateFromNow(-1), status: 'ok' }],
    });
    const w = world([damaged, ok]);
    const todos = maintenanceTodos(w.buildings, w.floors);
    expect(todos.find((t) => t.facilityId === 'f-damaged')?.action).toBe('repair');
    expect(todos.find((t) => t.facilityId === 'f-ok')).toBeUndefined();
  });

  it('T4 缺出厂日期的灭火器 → 提示补登的换新型待办', () => {
    const nodata = fac({ id: 'f-nod', kind: 'extinguisher', spec: { extType: 'co2' } });
    const w = world([nodata]);
    const t = maintenanceTodos(w.buildings, w.floors).find((x) => x.facilityId === 'f-nod')!;
    expect(t.action).toBe('replace');
    expect(t.dueDate).toBeNull();
  });
});

// ---------- 履历 ----------

describe('facilityTimeline（同一具设施的历史记录）', () => {
  it('H1 检查与维保按时间倒序混排；换配件留下配件号；费用随行可见', () => {
    const f = fac({
      kind: 'extinguisher',
      manufactureDate: yearsFromNow(-3),
      checks: [
        { date: '2026-03-01', status: 'ok', pressureMpa: 1.2, appearance: 'intact', seal: 'intact' },
        { date: '2026-01-05', status: 'low_pressure', pressureMpa: 0.6, appearance: 'rust', seal: 'broken' },
      ],
      services: [
        svc({
          date: '2026-01-10',
          type: 'maintenance',
          cost: { material: 80, labor: 40, transport: 15 },
          parts: [{ name: '压力表', partNo: 'PG-M10-1.6', qty: 1 }],
        }),
      ],
    });
    const tl = facilityTimeline(f);
    expect(tl.map((e) => e.date)).toEqual(['2026-03-01', '2026-01-10', '2026-01-05']);
    expect(tl[0].kind).toBe('check');
    expect(tl[1].kind).toBe('service');
    const svcEntry = tl[1] as Extract<(typeof tl)[number], { kind: 'service' }>;
    expect(svcEntry.totalCost).toBe(135);
    expect(svcEntry.parts[0]).toMatchObject({ name: '压力表', partNo: 'PG-M10-1.6' });
    const checkEntry = tl[2] as Extract<(typeof tl)[number], { kind: 'check' }>;
    expect(checkEntry.pressureMpa).toBe(0.6);
    expect(checkEntry.appearance).toBe('rust');
    expect(checkEntry.seal).toBe('broken');
  });
});

// ---------- 费用汇总 ----------

describe('summarizeCosts（按楼栋、按季度、按类型）', () => {
  it('C1 费用拆材料/人工/运输，按楼栋×季度与设施类型汇总，只统计选定年度', () => {
    // A 楼两具：Q1 维修 + Q3 换新；B 楼一具：去年 Q2（不应计入今年）
    const a1 = fac({
      id: 'a1', code: '1F-EX-01', kind: 'extinguisher',
      services: [
        svc({ date: `${new Date().getFullYear()}-02-01`, type: 'maintenance', cost: { material: 80, labor: 40, transport: 15 } }), // 135 Q1
        svc({ date: `${new Date().getFullYear()}-07-01`, type: 'replacement', cost: { material: 220, labor: 30, transport: 20 } }), // 270 Q3
      ],
    });
    const a2 = fac({
      id: 'a2', code: '1F-HY-01', kind: 'hydrant',
      services: [svc({ date: `${new Date().getFullYear()}-04-01`, type: 'maintenance', cost: { material: 0, labor: 100, transport: 0 } })], // 100 Q2
    });
    const b1 = fac({
      id: 'b1', code: '1F-EX-01', kind: 'extinguisher',
      services: [svc({ date: `${new Date().getFullYear() - 1}-05-01`, type: 'hydro_test', cost: { material: 10, labor: 10, transport: 10 } })],
    });
    const fA: Floor = { id: 'fA', buildingId: 'bA', level: 1, scaleMmPerUnit: 1, rooms: [], facilities: [a1, a2], exits: [], version: 0 };
    const fB: Floor = { id: 'fB', buildingId: 'bB', level: 1, scaleMmPerUnit: 1, rooms: [], facilities: [b1], exits: [], version: 0 };
    const buildings: Building[] = [
      { id: 'bA', name: 'A楼', kind: 'office', floors: ['fA'], createdAt: '' },
      { id: 'bB', name: 'B楼', kind: 'office', floors: ['fB'], createdAt: '' },
    ];
    const floors = { fA, fB };

    const year = new Date().getFullYear();
    const s = summarizeCosts(buildings, floors, year);
    expect(s.total).toBe(135 + 270 + 100); // 去年的 30 不计入
    const rowA = s.byBuilding.find((b) => b.buildingId === 'bA')!;
    expect(rowA.q1).toBe(135);
    expect(rowA.q2).toBe(100);
    expect(rowA.q3).toBe(270);
    expect(rowA.q4).toBe(0);
    expect(rowA.yearTotal).toBe(505); // 这一年在这一栋楼上花了多少
    const rowB = s.byBuilding.find((b) => b.buildingId === 'bB')!;
    expect(rowB.yearTotal).toBe(0);
    // 哪一类最费钱：灭火器 405 > 消火栓 100
    expect(s.byKind[0].kind).toBe('extinguisher');
    expect(s.byKind[0].total).toBe(405);
    expect(s.byKind[0]).toMatchObject({ material: 300, labor: 70, transport: 35, count: 2 });
    const hydrant = s.byKind.find((k) => k.kind === 'hydrant')!;
    expect(hydrant.total).toBe(100);
    expect(hydrant.labor).toBe(100);
  });

  it('C2 quarterOf 季度边界正确', () => {
    expect(quarterOf('2026-01-31')).toBe(1);
    expect(quarterOf('2026-04-01')).toBe(2);
    expect(quarterOf('2026-12-31')).toBe(4);
  });
});

// ---------- 账实对账 ----------

describe('reconcileFloorCounts（账面数量 vs 图上实布）', () => {
  it('R1 账面 4 具图上 3 具 → 差 +1；账实一致不报警；多摆为负数；带楼层定位', () => {
    const kinds: FacilityKind[] = ['extinguisher', 'extinguisher', 'extinguisher', 'hydrant', 'hydrant'];
    const facs = kinds.map((k, i) => fac({ id: `f${i}`, kind: k, code: `c${i}` }));
    const w = world(facs);
    w.floor.level = 3;
    // 账面：灭火器 4（图上 3，少 1）；消火栓 2（图上 2，一致）；应急照明 0（图上 0，一致，不产生行）
    w.floor.expectedCounts = { extinguisher: 4, hydrant: 2, emergency_light: 0 };
    const diffs = reconcileFloorCounts(w.buildings, w.floors);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      kind: 'extinguisher',
      expected: 4,
      actual: 3,
      diff: 1,
      floorLevel: 3,
      buildingName: '测试楼',
    });
  });

  it('R2 图上多摆（账面 1、图上 2）→ diff 为 -1；未登记账面数量的楼层静默', () => {
    const f1 = fac({ id: 'x1', kind: 'sprinkler', code: '1F-SP-01' });
    const f2 = fac({ id: 'x2', kind: 'sprinkler', code: '1F-SP-02' });
    const w = world([f1, f2]);
    w.floor.expectedCounts = { sprinkler: 1 };
    const diffs = reconcileFloorCounts(w.buildings, w.floors);
    expect(diffs[0].diff).toBe(-1);
    expect(diffs[0].actual).toBe(2);

    // 另一栋完全没建账的楼
    const w2 = world([fac({ id: 'y1', kind: 'exit', code: '1F-EXIT-01' })], 'f2', '无账楼');
    const mergedBuildings = [...w.buildings, ...w2.buildings];
    const mergedFloors = { ...w.floors, ...w2.floors };
    const all = reconcileFloorCounts(mergedBuildings, mergedFloors);
    expect(all.filter((d) => d.buildingName === '无账楼')).toHaveLength(0);
    expect(all).toHaveLength(1);
  });
});
