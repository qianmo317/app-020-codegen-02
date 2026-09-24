/**
 * 维保账 · 灭火器生命周期（水压试验 / 报废年限）验收用例。
 * 依据 GA 95-2015《灭火器维修》：出厂满 5 年首检、此后每 2 年送检；
 * 干粉/洁净气体 10 年、CO₂ 12 年、水基 6 年报废；试验不合格即报废。
 */
import { describe, it, expect } from 'vitest';
import { extinguisherLifecycle, scrapDateOf } from '../src/lib/serviceLife';
import { EXTINGUISHER_RULES } from '../src/rules/defaults';
import type { Facility } from '../src/model';

const DAY = 86400000;
const today = new Date();
const p2 = (v: number) => String(v).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** n 年前的今天（按本地日历加/减整年） */
const yearsAgo = (n: number) => {
  const d = new Date(today);
  d.setFullYear(d.getFullYear() - n);
  return fmt(d);
};
/** 给定日期 + n 天 */
const plusDays = (ds: string, n: number) => fmt(new Date(new Date(`${ds}T00:00:00`).getTime() + n * DAY));
/** 给定日期 + n 年 */
const plusYears = (ds: string, n: number) => {
  const d = new Date(`${ds}T00:00:00`);
  d.setFullYear(d.getFullYear() + n);
  return fmt(d);
};

const ext = (over: Partial<Facility>): Facility => ({
  id: 'x',
  kind: 'extinguisher',
  x: 0,
  y: 0,
  code: '1F-EX-01',
  checks: [],
  services: [],
  spec: { extType: 'dry_powder', weightKg: 4 },
  ...over,
});

describe('extinguisherLifecycle（水压试验 / 报废判定）', () => {
  it('M1 出厂未满 5 年 → 无待办，下次送检日期 = 出厂 + 5 年', () => {
    const info = extinguisherLifecycle(ext({ manufactureDate: yearsAgo(3) }));
    expect(info.todo).toBe(false);
    expect(info.action).toBeNull();
    expect(info.dueDate).toBe(plusYears(yearsAgo(3), 5));
    expect(info.scrapDate).toBe(plusYears(yearsAgo(3), 10));
  });

  it('M2 出厂满 5 年且无送检记录 → 到期送检', () => {
    const info = extinguisherLifecycle(ext({ manufactureDate: yearsAgo(6) }));
    expect(info.state).toBe('hydro_due');
    expect(info.action).toBe('hydro_test');
    expect(info.todo).toBe(true);
    expect(info.due).toBe(true);
    expect(info.dueDate).toBe(plusYears(yearsAgo(6), 5));
  });

  it('M3 距首次送检期限 ≤30 天 → 提前预警「送检」但未到期', () => {
    // 出厂日期设为 5 年前的 20 天后 → 距今还有 20 天到期
    const mfg = plusDays(yearsAgo(5), 20);
    const info = extinguisherLifecycle(ext({ manufactureDate: mfg }));
    expect(info.state).toBe('hydro_upcoming');
    expect(info.action).toBe('hydro_test');
    expect(info.todo).toBe(true);
    expect(info.upcoming).toBe(true);
    expect(info.due).toBe(false);
    expect(info.daysLeft).toBeGreaterThan(0);
    expect(info.daysLeft).toBeLessThanOrEqual(EXTINGUISHER_RULES.upcomingLeadDays);
  });

  it('M4 送检合格后周期重置：下次送检 = 最近送检 + 2 年', () => {
    const mfg = yearsAgo(8);
    // 1 年前送检合格（此时出厂 7 年，已过首检 5 年）
    const hydroDate = plusDays(yearsAgo(1), 0);
    const info = extinguisherLifecycle(
      ext({
        manufactureDate: mfg,
        services: [
          { id: 's1', date: hydroDate, kind: 'hydro_test', hydroResult: 'pass', cost: { material: 0, labor: 0, transport: 0 } },
        ],
      }),
    );
    expect(info.dueDate).toBe(plusYears(hydroDate, 2));
    expect(info.todo).toBe(false);
  });

  it('M5 送检周期已过 2 年 → 再次到期送检', () => {
    const info = extinguisherLifecycle(
      ext({
        manufactureDate: yearsAgo(10),
        services: [
          { id: 's1', date: yearsAgo(3), kind: 'hydro_test', hydroResult: 'pass', cost: { material: 0, labor: 0, transport: 0 } },
        ],
      }),
    );
    // 出厂 10 年的干粉：报废优先于送检
    expect(info.action).toBe('replace');
  });

  it('M6 干粉满 10 年 → 到期换新（报废）', () => {
    const info = extinguisherLifecycle(ext({ manufactureDate: yearsAgo(10) }));
    expect(info.state).toBe('replace_due');
    expect(info.action).toBe('replace');
    expect(info.due).toBe(true);
  });

  it('M7 CO₂ 满 10 年未报废（12 年），但已到送检期', () => {
    const info = extinguisherLifecycle(ext({ manufactureDate: yearsAgo(10), spec: { extType: 'co2', weightKg: 5 } }));
    expect(info.scrapDate).toBe(plusYears(yearsAgo(10), 12));
    expect(info.action).toBe('hydro_test');
  });

  it('M8 CO₂ 满 12 年 → 到期换新；水基 6 年即报废', () => {
    const co2 = extinguisherLifecycle(ext({ manufactureDate: yearsAgo(12), spec: { extType: 'co2', weightKg: 5 } }));
    expect(co2.action).toBe('replace');
    expect(co2.state).toBe('replace_due');
    const water = extinguisherLifecycle(ext({ manufactureDate: yearsAgo(6), spec: { extType: 'water', weightKg: 6 } }));
    expect(water.action).toBe('replace');
  });

  it('M9 距报废期 ≤30 天 → 提前预警「换新」', () => {
    const mfg = plusDays(yearsAgo(10), 20); // 10 年报废期还剩 20 天
    const info = extinguisherLifecycle(ext({ manufactureDate: mfg }));
    expect(info.state).toBe('replace_upcoming');
    expect(info.action).toBe('replace');
    expect(info.upcoming).toBe(true);
  });

  it('M10 水压试验不合格（哪怕年限未到）→ 立即换新', () => {
    const info = extinguisherLifecycle(
      ext({
        manufactureDate: yearsAgo(3),
        services: [
          { id: 's1', date: plusDays(new Date().toISOString().slice(0, 10), -10), kind: 'hydro_test', hydroResult: 'fail', cost: { material: 0, labor: 0, transport: 0 } },
        ],
      }),
    );
    expect(info.state).toBe('hydro_failed');
    expect(info.action).toBe('replace');
    expect(info.todo).toBe(true);
  });

  it('M11 已登记换新/报废日期 → 不再有待办', () => {
    const info = extinguisherLifecycle(ext({ manufactureDate: yearsAgo(12), retiredDate: yearsAgo(0) }));
    expect(info.state).toBe('retired');
    expect(info.todo).toBe(false);
  });

  it('M12 无出厂日期 → 不算到期（提示补登）', () => {
    const info = extinguisherLifecycle(ext({}));
    expect(info.todo).toBe(false);
    expect(info.dueDate).toBeNull();
  });

  it('M13 非灭火器不参与生命周期判定', () => {
    const info = extinguisherLifecycle({ kind: 'hydrant' });
    expect(info.state).toBe('none');
  });

  it('M14 scrapDateOf 按类型取报废年限', () => {
    expect(scrapDateOf({ manufactureDate: '2016-03-10', spec: { extType: 'dry_powder' } })).toBe('2026-03-10');
    expect(scrapDateOf({ manufactureDate: '2016-03-10', spec: { extType: 'co2' } })).toBe('2028-03-10');
    expect(scrapDateOf({ manufactureDate: '2020-03-10', spec: { extType: 'water' } })).toBe('2026-03-10');
    expect(scrapDateOf({})).toBeNull();
  });
});
