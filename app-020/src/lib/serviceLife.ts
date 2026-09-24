/**
 * 灭火器生命周期：按出厂日期与检修（送检）记录，判定是否到了水压试验或报废年限。
 *
 * 规则依据 GA 95-2015《灭火器维修》、GB 50444-2008《建筑灭火器配置验收及检查规范》：
 * - 出厂满 5 年首次水压试验，此后每 2 年一次；最近一次送检合格日期作为新一轮起算点；
 * - 水压试验不合格（或筒体严重锈蚀/变形）即报废；
 * - 报废年限：干粉 10 年、二氧化碳 12 年、水基 6 年（自出厂日期起算）。
 * 到期前 upcomingLeadDays 天即进入待办（提前列进待办，标明送检 / 换新）。
 */
import type { Facility, ServiceRecord } from '../model';
import { EXTINGUISHER_RULES } from '../rules/defaults';

const DAY_MS = 24 * 3600 * 1000;

export type LifecycleAction = 'hydro_test' | 'replace';
export type LifecycleState =
  | 'none' // 无需处理
  | 'hydro_upcoming' // 临近水压试验（提前预警）
  | 'hydro_due' // 已到水压试验期限 → 送检
  | 'replace_upcoming' // 临近报废（提前预警）
  | 'replace_due' // 已到报废年限 → 换新
  | 'hydro_failed' // 最近一次水压试验不合格 → 换新
  | 'retired'; // 已报废/换新处置

export type LifecycleInfo = {
  state: LifecycleState;
  /** 待办动作：送检 / 换新；无需处理或已处置时为 null */
  action: LifecycleAction | null;
  /** 是否进入待办（提前预警或已到期） */
  todo: boolean;
  /** 提前预警（尚未到期但在 leadDays 内） */
  upcoming: boolean;
  /** 已到期（超过应办日期） */
  due: boolean;
  /** 应办日期 YYYY-MM-DD（下次送检 / 报废日期），无出厂日期时为 null */
  dueDate: string | null;
  /** 距应办日期天数（负=已逾期），无日期时为 null */
  daysLeft: number | null;
  /** 报废日期（出厂 + 报废年限） */
  scrapDate: string | null;
  /** 最近一次水压试验记录 */
  lastHydro: ServiceRecord | null;
  /** 结论说明（账上与报告直接展示） */
  message: string;
};

function parseDate(ds: string): number {
  return new Date(`${ds}T00:00:00`).getTime();
}

function toLocalDate(ts: number): string {
  const d = new Date(ts);
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 报废日期（出厂日期 + 对应类型报废年限），无出厂日期返回 null */
export function scrapDateOf(fac: {
  spec?: Facility['spec'];
  manufactureDate?: string;
}): string | null {
  if (!fac.manufactureDate) return null;
  const years = EXTINGUISHER_RULES.scrapYears[fac.spec?.extType ?? 'dry_powder'] ?? 10;
  const d = new Date(`${fac.manufactureDate}T00:00:00`);
  d.setFullYear(d.getFullYear() + years);
  return toLocalDate(d.getTime());
}

export type LifecycleInput = {
  kind: Facility['kind'];
  spec?: Facility['spec'];
  manufactureDate?: string;
  retiredDate?: string;
  services?: ServiceRecord[];
};

/**
 * 灭火器生命周期判定。非灭火器一律返回 state='none'。
 */
export function extinguisherLifecycle(fac: LifecycleInput, now: number = Date.now()): LifecycleInfo {
  const NONE: LifecycleInfo = {
    state: 'none', action: null, todo: false, upcoming: false, due: false,
    dueDate: null, daysLeft: null, scrapDate: null, lastHydro: null, message: '',
  };
  if (fac.kind !== 'extinguisher') return NONE;

  const hydroRecs = (fac.services ?? [])
    .filter((s) => s.kind === 'hydro_test')
    .sort((a, b) => b.date.localeCompare(a.date));
  const lastHydro = hydroRecs[0] ?? null;
  const scrapDate = scrapDateOf(fac);

  // 已处置（换新并登记 retiredDate）
  if (fac.retiredDate) {
    return {
      ...NONE, state: 'retired', scrapDate, lastHydro,
      message: `该具已于 ${fac.retiredDate} 报废/换新处置`,
    };
  }

  // 无出厂日期：无法起算年限（账上提示补登，不产生待办）
  if (!fac.manufactureDate || !scrapDate) {
    return { ...NONE, lastHydro, message: '未登记出厂日期，无法判定水压试验/报废年限' };
  }

  const leadMs = EXTINGUISHER_RULES.upcomingLeadDays * DAY_MS;
  const scrapTs = parseDate(scrapDate);

  // 最近一次水压试验不合格 → 必须换新（最高优先，即使年限未到）
  if (lastHydro?.hydroResult === 'fail') {
    return {
      ...NONE, state: 'hydro_failed', action: 'replace', todo: true,
      upcoming: false, due: true, dueDate: lastHydro.date, daysLeft: Math.floor((parseDate(lastHydro.date) - now) / DAY_MS),
      scrapDate, lastHydro,
      message: `${lastHydro.date} 水压试验不合格，筒体应报废换新`,
    };
  }

  // 下次水压试验应办日期：
  // 有送检记录（fail 已在上面提前返回）→ 最近一次送检 + 间隔年；否则 → 出厂 + 首检年数
  let hydroDueTs: number;
  if (lastHydro) {
    const d = new Date(`${lastHydro.date}T00:00:00`);
    d.setFullYear(d.getFullYear() + EXTINGUISHER_RULES.hydroIntervalYears);
    hydroDueTs = d.getTime();
  } else {
    const d = new Date(`${fac.manufactureDate}T00:00:00`);
    d.setFullYear(d.getFullYear() + EXTINGUISHER_RULES.firstHydroYears);
    hydroDueTs = d.getTime();
  }
  // 报废年限之后不再安排送检
  if (hydroDueTs > scrapTs) hydroDueTs = Infinity;

  // 报废优先：到期或临期（剩余寿命不足以再撑一个送检周期时，直接提示换新）
  const scrapLeft = scrapTs - now;
  if (scrapLeft <= 0) {
    return {
      ...NONE, state: 'replace_due', action: 'replace', todo: true,
      upcoming: false, due: true, dueDate: scrapDate, daysLeft: Math.floor(scrapLeft / DAY_MS),
      scrapDate, lastHydro,
      message: `已达报废年限（应于 ${scrapDate} 前报废换新）`,
    };
  }
  if (scrapLeft <= leadMs) {
    return {
      ...NONE, state: 'replace_upcoming', action: 'replace', todo: true,
      upcoming: true, due: false, dueDate: scrapDate, daysLeft: Math.floor(scrapLeft / DAY_MS),
      scrapDate, lastHydro,
      message: `${Math.ceil(scrapLeft / DAY_MS)} 天后到报废年限（${scrapDate}），请安排换新`,
    };
  }

  // 水压试验
  if (hydroDueTs !== Infinity) {
    const hydroLeft = hydroDueTs - now;
    if (hydroLeft <= 0) {
      return {
        ...NONE, state: 'hydro_due', action: 'hydro_test', todo: true,
        upcoming: false, due: true, dueDate: toLocalDate(hydroDueTs), daysLeft: Math.floor(hydroLeft / DAY_MS),
        scrapDate, lastHydro,
        message: `已到水压试验期限（应于 ${toLocalDate(hydroDueTs)} 前送检）`,
      };
    }
    if (hydroLeft <= leadMs) {
      return {
        ...NONE, state: 'hydro_upcoming', action: 'hydro_test', todo: true,
        upcoming: true, due: false, dueDate: toLocalDate(hydroDueTs), daysLeft: Math.floor(hydroLeft / DAY_MS),
        scrapDate, lastHydro,
        message: `${Math.ceil(hydroLeft / DAY_MS)} 天后到水压试验期限（${toLocalDate(hydroDueTs)}），请提前安排送检`,
      };
    }
    return {
      ...NONE, dueDate: toLocalDate(hydroDueTs), daysLeft: Math.floor(hydroLeft / DAY_MS),
      scrapDate, lastHydro,
      message: `下次水压试验 ${toLocalDate(hydroDueTs)}，报废年限 ${scrapDate}`,
    };
  }

  return { ...NONE, scrapDate, lastHydro, message: `报废年限 ${scrapDate}（之后无需再送检）` };
}
