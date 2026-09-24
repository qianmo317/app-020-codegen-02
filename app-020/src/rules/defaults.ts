import type { BuildingKind, RuleSet } from '../model';

/**
 * 默认规则集（参考值，均标注依据，可在 /rules 页面按项目实际调整；修改后版本号 +1）。
 * 说明：
 * - 疏散距离：GB 50016-2014(2018年版) 表 5.5.17（民用建筑）与 3.7.4（厂房）；
 *   袋形走道两侧或尽端的疏散门至最近安全出口距离按同一表取值。
 * - 灭火器保护半径：GB 50140-2005 按火灾类别与危险等级的最大保护距离折算，此处为可配置参考值。
 */
export const DEFAULT_RULES: Record<BuildingKind, RuleSet> = {
  office: {
    buildingKind: 'office',
    maxTravelDistanceM: 40,
    deadEndDistanceM: 22,
    extinguisherRadiusM: 20,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    source: 'GB 50016-2014(2018年版) 表5.5.17；GB 50140-2005',
    version: 1,
  },
  retail: {
    buildingKind: 'retail',
    maxTravelDistanceM: 30,
    deadEndDistanceM: 20,
    extinguisherRadiusM: 20,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    source: 'GB 50016-2014(2018年版) 表5.5.17（商店建筑）；GB 50140-2005',
    version: 1,
  },
  factory: {
    buildingKind: 'factory',
    maxTravelDistanceM: 30,
    deadEndDistanceM: 20,
    extinguisherRadiusM: 12,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    source: 'GB 50016-2014(2018年版) 3.7.4（厂房疏散距离）；GB 50140-2005',
    version: 1,
  },
  school: {
    buildingKind: 'school',
    maxTravelDistanceM: 35,
    deadEndDistanceM: 22,
    extinguisherRadiusM: 20,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    source: 'GB 50099-2011、GB 50016-2014(2018年版) 表5.5.17；GB 50140-2005',
    version: 1,
  },
};

/** 人员密度估算（㎡/人），未填写人数的房间按此估算 —— 仅用于出口数量校验 */
export const OCCUPANCY_DENSITY_M2_PER_PERSON: Record<string, number> = {
  office: 10,
  retail: 3,
  storage: 50,
  ward: 8,
  corridor: 0, // 走道不计停留人数
  other: 20,
};

/** 检查周期（天），用于「下次检查日期」与过期判定 */
export const CHECK_INTERVAL_DAYS: Record<string, number> = {
  extinguisher: 30,
  hydrant: 30,
  exit_sign: 90,
  emergency_light: 90,
  exit: 180,
  sprinkler: 180,
};

/**
 * 灭火器寿命规则（天）：
 * - 报废年限：干粉/二氧化碳 10 年，水基（清水/泡沫）6 年；
 * - 水压试验周期：干粉、洁净气体 5 年（干粉灭火器维修后每 2 年一次水压试验的常见做法取 2 年的
 *   从严口径），水基 1 年，二氧化碳 5 年。
 * 依据：GB 50444-2008《建筑灭火器配置验收及检查规范》、GA 95-2015《灭火器维修》。
 * 数值为参考默认值，可按当地监管要求在本文件调整。
 */
export type ExtinguisherLifeRule = {
  scrapYears: number;
  hydroIntervalYears: number;
};

export const EXTINGUISHER_LIFE: Record<'dry_powder' | 'co2' | 'water', ExtinguisherLifeRule> = {
  dry_powder: { scrapYears: 10, hydroIntervalYears: 2 },
  co2: { scrapYears: 10, hydroIntervalYears: 5 },
  water: { scrapYears: 6, hydroIntervalYears: 1 },
};

/** 到期提前量（天）：距水压试验/报废期限在此窗口内即列入待办 */
export const LIFE_LEAD_DAYS = 30;
