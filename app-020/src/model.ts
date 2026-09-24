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

/** 外观检查结论 */
export type AppearanceStatus = 'intact' | 'rust' | 'deformed' | 'label_lost' | 'damaged';

/** 铅封（保险销封签）状态 */
export type SealStatus = 'intact' | 'broken' | 'missing';

export type CheckRecord = {
  date: string; // YYYY-MM-DD
  status: CheckStatus;
  pressureMpa?: number; // 压力表读数（MPa），无压力表的设施不填
  appearance?: AppearanceStatus;
  seal?: SealStatus;
  photoKey?: string; // IndexedDB key，照片仅存本地
  note?: string;
};

/** 维保作业类型：日检 / 维修 / 水压试验（送检） / 再充装 / 换新 */
export type ServiceType = 'maintenance' | 'hydro_test' | 'recharge' | 'replacement';

/** 更换的配件（留下配件号，履历可追溯） */
export type ReplacedPart = {
  name: string; // 配件名称：压力表 / 喷管 / 瓶头阀 …
  partNo?: string; // 配件号 / 型号
  qty?: number;
};

export type ServiceCost = {
  material: number; // 材料（换新时含整具购置费）
  labor: number; // 人工
  transport: number; // 运输（送检往返等）
};

export type ServiceRecord = {
  id: string;
  date: string; // YYYY-MM-DD
  type: ServiceType;
  cost: ServiceCost;
  parts?: ReplacedPart[];
  vendor?: string; // 承修 / 送检单位
  reportNo?: string; // 水压试验报告号 / 合格证书号等
  /** 换新时新具的出厂日期 —— 此后水压试验/报废年限从新具重新起算 */
  newManufactureDate?: string;
  note?: string;
};

export type Facility = {
  id: string;
  kind: FacilityKind;
  x: number; // mm
  y: number; // mm
  code: string; // 楼层-类型-序号，如 3F-EX-01
  manufactureDate?: string; // 出厂日期 YYYY-MM-DD（灭火器年限计算起点）
  spec?: {
    extType?: 'dry_powder' | 'co2' | 'water';
    weightKg?: number;
  };
  checks: CheckRecord[];
  /** 维修 / 送检 / 换新履历（含费用与更换配件号） */
  services?: ServiceRecord[];
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
  /** 账面在册数量（按类型），用于与图上实布数量对账；未登记的类型不参与对账 */
  expectedCounts?: Partial<Record<FacilityKind, number>>;
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

export const APPEARANCE_LABELS: Record<AppearanceStatus, string> = {
  intact: '完好',
  rust: '锈蚀',
  deformed: '变形',
  label_lost: '标识脱落',
  damaged: '破损',
};

export const SEAL_LABELS: Record<SealStatus, string> = {
  intact: '完好',
  broken: '已拆封',
  missing: '缺失',
};

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  maintenance: '维修',
  hydro_test: '水压试验',
  recharge: '再充装',
  replacement: '换新',
};

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  ok: '正常',
  low_pressure: '压力不足',
  expired: '过期',
  damaged: '损坏',
  missing: '缺失',
};
