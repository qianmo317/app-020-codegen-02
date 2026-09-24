/** 全局数据模型 —— 坐标一律为毫米（mm），距离限值/实测为米（m） */
export type Pt = { x: number; y: number };

export type RoomUsage = 'office' | 'retail' | 'storage' | 'ward' | 'corridor' | 'other';

export type Room = {
  id: string;
  polygon: Pt[];
  name: string;
  usage: RoomUsage;
  areaM2: number;
  occupants?: number;
};

export type FacilityKind =
  | 'extinguisher'
  | 'hydrant'
  | 'exit_sign'
  | 'emergency_light'
  | 'exit'
  | 'sprinkler';

export type CheckStatus = 'ok' | 'low_pressure' | 'expired' | 'damaged' | 'missing';

/** 压力表读数分区（绿区正常 / 红区欠压需充压维修） */
export type PressureZone = 'green' | 'red' | 'na';
/** 外观与铅封检查结论 */
export type AppearanceState = 'intact' | 'rust' | 'deformed' | 'damaged';
export type SealState = 'intact' | 'broken' | 'missing';

export type CheckRecord = {
  date: string; // YYYY-MM-DD
  status: CheckStatus;
  photoKey?: string; // IndexedDB key，照片仅存本地
  note?: string;
  /** 压力：压力表读数 MPa（可空，如安全出口无压力表） */
  pressureMpa?: number;
  /** 压力：表针分区，默认不适用 */
  pressureZone?: PressureZone;
  /** 外观：完好 / 锈蚀 / 变形 / 破损 */
  appearance?: AppearanceState;
  /** 铅封：完好 / 断裂 / 缺失 */
  seal?: SealState;
};

/** 送检（水压试验）/ 维修 / 换新（报废处置） */
export type ServiceKind = 'hydro_test' | 'repair' | 'replace';
/** 水压试验结论（维修类可空） */
export type HydroResult = 'pass' | 'fail';

export type PartRecord = {
  /** 配件号（厂家料号），换新过的配件必须留号 */
  partNo: string;
  /** 配件名称，如 压力表 / 喷管 / 压把 / 密封件 */
  name?: string;
  /** 数量，默认 1 */
  qty?: number;
};

/** 费用分项（元）：材料、人工、运输；合计自动计算 */
export type Cost = {
  material: number;
  labor: number;
  transport: number;
};

export type ServiceRecord = {
  id: string;
  date: string; // YYYY-MM-DD
  kind: ServiceKind;
  /** 送检时的水压试验结论；fail 表示筒体不合格、应当报废换新 */
  hydroResult?: HydroResult;
  /** 维修/送检单位 */
  vendor?: string;
  /** 本次换下/换上的配件（留配件号） */
  parts?: PartRecord[];
  cost: Cost;
  note?: string;
};

export type Facility = {
  id: string;
  kind: FacilityKind;
  x: number; // mm
  y: number; // mm
  code: string; // 楼层-类型-序号，如 3F-EX-01
  spec?: {
    extType?: 'dry_powder' | 'co2' | 'water';
    weightKg?: number;
  };
  /** 出厂日期 YYYY-MM-DD —— 水压试验周期与报废年限的起算点 */
  manufactureDate?: string;
  /** 报废日期 YYYY-MM-DD：换新处置或被判报废后写入，此后不再安排检查/送检 */
  retiredDate?: string;
  checks: CheckRecord[];
  /** 维保账：送检 / 维修 / 换新记录（含费用与配件号） */
  services: ServiceRecord[];
};

export type Underlay = {
  key: string; // IndexedDB key
  wPx: number;
  hPx: number;
  offsetX: number; // mm，底图左上角在图纸坐标中的位置
  offsetY: number;
  scaleMmPerPx: number; // 仅影响底图显示，不影响校验
  opacity: number; // 0~1
  visible: boolean;
};

export type Floor = {
  id: string;
  buildingId: string;
  level: number; // 1,2,3... 地下为 -1,-2
  scaleMmPerUnit: number; // 兼容字段：毫米坐标存储，此值仅影响底图显示
  rooms: Room[];
  facilities: Facility[];
  exits: string[]; // kind === 'exit' 的设施 id
  /** 账面盘点数量（维保台账），按设施类型记；缺省类型视为与图上一致。用于账实对账 */
  ledgerCounts?: Partial<Record<FacilityKind, number>>;
  underlay?: Underlay;
  version: number; // 每次编辑 +1，用于触发校验
  lastValidation?: ValidationResult;
};

export type BuildingKind = 'office' | 'retail' | 'factory' | 'school';

export type Building = {
  id: string;
  name: string;
  kind: BuildingKind;
  floors: string[];
  createdAt: string;
};

export type RuleSet = {
  buildingKind: BuildingKind;
  maxTravelDistanceM: number;
  deadEndDistanceM: number;
  extinguisherRadiusM: number;
  exitMinAreaM2: number; // 超过此面积需 ≥2 个安全出口
  exitMaxOccupants: number; // 超过此人数需 ≥2 个安全出口
  source: string; // 依据文号，报告中打印
  version: number; // 规则版本，修改即 +1，校验结果记录当时版本
};

export type ValidationSeverity = 'error' | 'warning';

export type ValidationItem = {
  severity: ValidationSeverity;
  type: string;
  message: string;
  roomId?: string;
  facilityId?: string;
  point?: Pt; // 图纸定位点 mm
  value?: number; // 实测值（m / m²）
  limit?: number;
};

export type ValidationResult = {
  checkedAt: string;
  pass: boolean;
  items: ValidationItem[];
  travelWorstM: number | null;
  travelWorstPoint?: Pt | null;
  deadEndM: number | null;
  coverage: { uncoveredM2: number; totalM2: number; pass: boolean; samples: Pt[] } | null;
  exits: { present: number; required: number };
  rulesSnapshot: {
    buildingKind: BuildingKind;
    version: number;
    source: string;
    maxTravelDistanceM: number;
    deadEndDistanceM: number;
    extinguisherRadiusM: number;
  };
};

export const FACILITY_LABELS: Record<FacilityKind, string> = {
  extinguisher: '灭火器',
  hydrant: '消火栓',
  exit_sign: '疏散指示灯',
  emergency_light: '应急照明',
  exit: '安全出口',
  sprinkler: '喷淋',
};

export const FACILITY_CODES: Record<FacilityKind, string> = {
  extinguisher: 'EX',
  hydrant: 'HY',
  exit_sign: 'ES',
  emergency_light: 'EL',
  exit: 'EXIT',
  sprinkler: 'SP',
};

export const USAGE_LABELS: Record<RoomUsage, string> = {
  office: '办公',
  retail: '商业',
  storage: '仓库',
  ward: '病房',
  corridor: '走道',
  other: '其他',
};

export const PRESSURE_ZONE_LABELS: Record<PressureZone, string> = {
  green: '绿区（正常）',
  red: '红区（欠压）',
  na: '无表/不适用',
};

export const APPEARANCE_LABELS: Record<AppearanceState, string> = {
  intact: '完好',
  rust: '锈蚀',
  deformed: '变形',
  damaged: '破损',
};

export const SEAL_LABELS: Record<SealState, string> = {
  intact: '完好',
  broken: '断裂',
  missing: '缺失',
};

export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = {
  hydro_test: '送检（水压试验）',
  repair: '维修',
  replace: '换新（报废处置）',
};

export const HYDRO_RESULT_LABELS: Record<HydroResult, string> = {
  pass: '合格',
  fail: '不合格（筒体报废）',
};
