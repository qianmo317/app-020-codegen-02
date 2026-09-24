/**
 * 维保账验收：费用按楼栋/季度/设施类型汇总、设施历史时间线、待办、账实对账。
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeCosts,
  quarterOf,
  facilityTimeline,
  collectTodos,
  reconcileFloor,
  reconcileAll,
  costTotal,
} from '../src/lib/maintenance';
import type { Building, Floor, Facility, FacilityKind } from '../src/model';
import { uid } from '../src/store/id';

const svc = (s: Partial<Facility['services'][number]> & Pick<Facility['services'][number], 'date' | 'kind'>): Facility['services'][number] => ({
  id: uid(),
  cost: { material: 0, labor: 0, transport: 0 },
  ...s,
});

const fac = (
  kind: FacilityKind,
  code: string,
  over: Partial<Facility> = {},
): Facility => ({ id: uid(), kind, x: 0, y: 0, code, checks: [], services: [], ...over });

function mkBuilding(name: string, floors: Floor[]): { building: Building; floorMap: Record<string, Floor> } {
  const building: Building = { id: uid(), name, kind: 'office', floors: floors.map((f) => f.id), createdAt: '' };
  for (const f of floors) f.buildingId = building.id;
  const floorMap = Object.fromEntries(floors.map((f) => [f.id, f]));
  return { building, floorMap };
}

const mkFloorObj = (level: number, facilities: Facility[], ledgerCounts?: Floor['ledgerCounts']): Floor => ({
  id: uid(),
  buildingId: '',
  level,
  scaleMmPerUnit: 1,
  rooms: [],
  facilities,
  exits: [],
  ledgerCounts,
  version: 0,
});

describe('费用：材料 + 人工 + 运输', () => {
  it('C1 costTotal 三项合计', () => {
    expect(costTotal({ material: 120.5, labor: 80, transport: 20 })).toBe(220.5);
    expect(costTotal({ material: NaN, labor: 0, transport: 0 })).toBe(0);
  });

  it('C2 quarterOf 月份落季度', () => {
    expect(quarterOf('2026-01-05')).toBe('2026Q1');
    expect(quarterOf('2026-04-01')).toBe('2026Q2');
    expect(quarterOf('2026-09-30')).toBe('2026Q3');
    expect(quarterOf('2026-12-31')).toBe('2026Q4');
  });
});

describe('summarizeCosts（按楼栋 × 季度、按设施类型）', () => {
  it('C3 同一栋楼同一季度费用合并；看得出这一年这栋楼花了多少', () => {
    const f1 = fac('extinguisher', '1F-EX-01', {
      services: [
        svc({ date: '2026-02-10', kind: 'repair', cost: { material: 100, labor: 50, transport: 10 } }),
        svc({ date: '2026-03-20', kind: 'hydro_test', hydroResult: 'pass', cost: { material: 0, labor: 60, transport: 20 } }),
      ],
    });
    const f2 = fac('hydrant', '1F-HY-01', {
      services: [svc({ date: '2026-08-01', kind: 'repair', cost: { material: 200, labor: 0, transport: 0 } })],
    });
    const { building, floorMap } = mkBuilding('A栋', [mkFloorObj(1, [f1, f2])]);
    const sum = summarizeCosts([building], floorMap, { year: '2026' });

    const a = sum.byBuildingQuarter.find((x) => x.buildingName === 'A栋')!;
    const q1 = a.quarters.find((q) => q.quarter === '2026Q1')!;
    expect(q1.total).toBe(240); // 100+50+10+0+60+20
    expect(q1.material).toBe(100);
    expect(q1.labor).toBe(110);
    expect(q1.transport).toBe(30);
    expect(a.quarters.find((q) => q.quarter === '2026Q3')!.total).toBe(200);
    expect(a.yearTotal).toBe(440);
    expect(sum.grandTotal).toBe(440);
  });

  it('C4 按设施类型汇总，最费钱的类型排第一', () => {
    const exts = [
      fac('extinguisher', 'EX1', { services: [svc({ date: '2026-05-01', kind: 'replace', cost: { material: 300, labor: 0, transport: 0 } })] }),
      fac('extinguisher', 'EX2', { services: [svc({ date: '2026-06-01', kind: 'replace', cost: { material: 350, labor: 0, transport: 0 } })] }),
    ];
    const hyd = fac('hydrant', 'HY1', { services: [svc({ date: '2026-05-01', kind: 'repair', cost: { material: 100, labor: 0, transport: 0 } })] });
    const { building, floorMap } = mkBuilding('B栋', [mkFloorObj(1, [...exts, hyd])]);
    const sum = summarizeCosts([building], floorMap);
    expect(sum.byFacilityKind[0].label).toBe('灭火器');
    expect(sum.byFacilityKind[0].total).toBe(650);
    expect(sum.byFacilityKind[0].count).toBe(2);
    expect(sum.byFacilityKind[1].total).toBe(100);
  });

  it('C5 按年过滤：2025 的记录不计入 2026 汇总', () => {
    const f1 = fac('extinguisher', 'EX1', {
      services: [
        svc({ date: '2025-12-31', kind: 'repair', cost: { material: 999, labor: 0, transport: 0 } }),
        svc({ date: '2026-01-02', kind: 'repair', cost: { material: 1, labor: 0, transport: 0 } }),
      ],
    });
    const { building, floorMap } = mkBuilding('C栋', [mkFloorObj(1, [f1])]);
    expect(summarizeCosts([building], floorMap, { year: '2026' }).grandTotal).toBe(1);
  });
});

describe('facilityTimeline（同一具设施的历史按时间串起来）', () => {
  it('H1 出厂 → 巡检 → 送检（带配件号）→ 换新 全链路按日期正序', () => {
    const f = fac('extinguisher', 'EX1', {
      manufactureDate: '2020-01-01',
      checks: [
        { date: '2026-03-01', status: 'ok', pressureMpa: 1.2, pressureZone: 'green', appearance: 'intact', seal: 'intact' },
        { date: '2025-06-01', status: 'low_pressure' },
      ],
      services: [
        svc({
          date: '2025-07-01', kind: 'repair',
          parts: [{ partNo: 'PB-G-77', name: '压力表', qty: 1 }],
          cost: { material: 40, labor: 30, transport: 0 },
        }),
        svc({ date: '2030-01-05', kind: 'replace', cost: { material: 500, labor: 0, transport: 0 } }),
      ],
    });
    const tl = facilityTimeline(f);
    expect(tl.map((e) => e.type)).toEqual(['manufacture', 'check', 'service', 'check', 'service']);
    expect(tl.map((e) => e.date)).toEqual(['2020-01-01', '2025-06-01', '2025-07-01', '2026-03-01', '2030-01-05']);
    const repair = tl.find((e) => e.service?.parts?.length)!;
    expect(repair.detail).toContain('PB-G-77');
    const check = tl.find((e) => e.type === 'check' && e.date === '2026-03-01')!;
    expect(check.detail).toContain('压力 1.2MPa');
    expect(check.detail).toContain('铅封');
  });

  it('H2 换新记录带 retiredDate 时末尾出现退役事件', () => {
    const f = fac('extinguisher', 'EX', {
      manufactureDate: '2016-01-01',
      retiredDate: '2026-02-01',
      services: [svc({ date: '2026-02-01', kind: 'replace', cost: { material: 1, labor: 0, transport: 0 } })],
    });
    const tl = facilityTimeline(f);
    expect(tl[tl.length - 1].type).toBe('retire');
  });
});

describe('collectTodos（待办：送检 / 换新 / 巡检）', () => {
  it('T1 到报废年限的灭火器进待办且标明「换新」', () => {
    const old = fac('extinguisher', 'EX-OLD', { manufactureDate: '2015-01-01' });
    const young = fac('extinguisher', 'EX-NEW', { manufactureDate: '2024-01-01' });
    const { building, floorMap } = mkBuilding('D栋', [mkFloorObj(1, [old, young])]);
    const todos = collectTodos([building], floorMap, new Date('2026-09-01T00:00:00').getTime());
    const t = todos.find((x) => x.facilityId === old.id)!;
    expect(t.action).toBe('换新');
    expect(t.reason).toBe('scrap');
    expect(t.due).toBe(true);
    // 新的不该有生命周期待办（无检查记录 → 只会有 check_missing）
    expect(todos.filter((x) => x.facilityId === young.id).map((x) => x.reason)).toEqual(['check_missing']);
  });

  it('T2 到水压试验期限标明「送检」，且待办带楼栋/楼层/编号', () => {
    const f = fac('extinguisher', '2F-EX-09', { manufactureDate: '2019-01-01' });
    const { building, floorMap } = mkBuilding('E栋', [mkFloorObj(2, [f])]);
    const todos = collectTodos([building], floorMap, new Date('2026-09-01T00:00:00').getTime());
    const t = todos.find((x) => x.reason === 'hydro')!;
    expect(t.action).toBe('送检');
    expect(t.buildingName).toBe('E栋');
    expect(t.floorLevel).toBe(2);
    expect(t.facilityCode).toBe('2F-EX-09');
  });

  it('T3 已换新退役的设施不再产生任何待办（补一条近期检查排除缺检）', () => {
    const f = fac('extinguisher', 'EX', {
      manufactureDate: '2010-01-01',
      retiredDate: '2026-01-01',
      checks: [{ date: '2026-08-01', status: 'ok' }],
    });
    const { building, floorMap } = mkBuilding('F栋', [mkFloorObj(1, [f])]);
    const todos = collectTodos([building], floorMap, new Date('2026-09-01T00:00:00').getTime());
    expect(todos).toHaveLength(0);
  });
});

describe('账实对账（账面数 vs 图上数）', () => {
  it('R1 账上比图上多 → diff 为正，指出楼层与类型、差几具', () => {
    const f1 = fac('extinguisher', 'EX1');
    const f2 = fac('extinguisher', 'EX2');
    const h = fac('hydrant', 'HY1');
    const floor = mkFloorObj(3, [f1, f2, h], { extinguisher: 3, hydrant: 1 });
    const { building } = mkBuilding('G栋', [floor]);
    const r = reconcileFloor(building, floor);
    expect(r.matched).toBe(false);
    const extDiff = r.kindDiffs.find((k) => k.kind === 'extinguisher')!;
    expect(extDiff.ledger).toBe(3);
    expect(extDiff.onMap).toBe(2);
    expect(extDiff.diff).toBe(1); // 差 1 具
    expect(r.diffTotal).toBe(1);
  });

  it('R2 图上比账上多 → diff 为负', () => {
    const floor = mkFloorObj(1, [fac('extinguisher', 'A'), fac('extinguisher', 'B')], { extinguisher: 1 });
    const { building } = mkBuilding('H栋', [floor]);
    const r = reconcileFloor(building, floor);
    expect(r.kindDiffs[0].diff).toBe(-1);
    expect(r.matched).toBe(false);
  });

  it('R3 全部对得上 → matched，不进差异清单', () => {
    const floor = mkFloorObj(1, [fac('extinguisher', 'A'), fac('hydrant', 'H')], { extinguisher: 1, hydrant: 1 });
    const { building } = mkBuilding('I栋', [floor]);
    const r = reconcileFloor(building, floor);
    expect(r.matched).toBe(true);
    expect(r.kindDiffs.every((k) => k.diff === 0)).toBe(true);
  });

  it('R4 未登记账面数的类型不参与对账（无数据不误报）', () => {
    const floor = mkFloorObj(1, [fac('sprinkler', 'SP1'), fac('sprinkler', 'SP2')], {});
    const { building } = mkBuilding('J栋', [floor]);
    expect(reconcileFloor(building, floor).matched).toBe(true);
  });

  it('R5 reconcileAll 只点出有差异的楼层，按差额大小排序', () => {
    const good = mkFloorObj(1, [fac('extinguisher', 'A')], { extinguisher: 1 });
    const bad1 = mkFloorObj(2, [fac('extinguisher', 'B')], { extinguisher: 3 }); // 差 2
    const bad2 = mkFloorObj(3, [fac('hydrant', 'C')], { hydrant: 2 }); // 差 1
    const { building, floorMap } = mkBuilding('K栋', [good, bad1, bad2]);
    const diffs = reconcileAll([building], floorMap);
    expect(diffs.map((d) => d.floorLevel)).toEqual([2, 3]);
    expect(diffs[0].kindDiffs[0].label).toBe('灭火器');
  });
});
