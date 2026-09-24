# 消防疏散图应用 · Fire Evacuation Map (app-020)

数据模型与几何核心：毫米坐标存储；校验全部在浏览器本地完成，**数据不出浏览器**（无任何后端/联网上传），断网可用。

## 开发

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest 单元测试（疏散距离/覆盖/规则/台账/性能）
npm run build    # tsc 类型检查 + vite 构建到 dist/
```

## Docker

```bash
cd app-020
docker compose up -d --build
curl http://localhost:8100/healthz
docker compose down
```

- 多阶段构建：`node:20-alpine` 构建 → `nginx:1.27-alpine`，端口 `8100:80`
- nginx：SPA 回退、哈希资源 immutable、index.html no-cache、gzip、SVG 正确 MIME
- `client_max_body_size` 未配置也无妨：底图与照片仅存浏览器 IndexedDB，不上传

## 说明

- 疏散距离沿**走道路径**计算（Dijkstra，栅格 0.25m），不是直线距离；房间内取「最远点 → 房间门」直线段
- 灭火器覆盖用 0.5m 栅格采样近似，未覆盖面积 > max(2㎡, 5%) 判不合规
- 校验结果保存时记录当时使用的规则版本与依据文号，打印报告中可见
- 底图与检查照片压缩（长边 1600）后存 IndexedDB，不出浏览器、不入 git（`.gitignore` 已排除 `underlays/`、`photos/`、`exports/`）

## 维保账（「维保账」页 + 楼层设施属性面板）

- 每次检查登记**压力表读数（MPa）、外观、铅封、照片**（照片仍仅存本地 IndexedDB）
- 灭火器按**出厂日期 + 历次水压试验/换新记录**自动判定：
  - 干粉/洁净气体 10 年报废、每 2 年水压试验；CO₂ 10 年、5 年；水基 6 年、1 年
    （参考 GB 50444-2008、GA 95-2015，默认值见 `src/rules/defaults.ts`）
  - 换新时登记新具出厂日期，年限从新具重新起算
  - 到期前 **30 天**提前进待办，标明「**送检**」还是「**换新**」，逾期按剩余天数排序
- 维修/送检/换新记录**费用三件套（材料、人工、运输）**，更换的配件留下**配件号/型号**
- 费用按**楼栋 × 季度**汇总年度支出，另按**设施类型**排行（哪类最费钱），可导出 CSV
- 同一具设施的检查与维保记录在属性面板中按时间倒序串成**履历**
- **账实对账**：逐楼层登记账面在册数量（可「按图建账」初始化），与图上实布数量比对，
  对不上即点出**差几具、差在哪一层**（图上少摆/多摆）
