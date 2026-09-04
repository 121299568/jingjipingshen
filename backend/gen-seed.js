// 从真实Excel生成seed数据
const { parseProjectExcel } = require('C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/backend/parse-excel.js');
const fs = require('fs');
const dir = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/backend/data';
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const r = parseProjectExcel('C:/Users/12129/Downloads/34-国网山东德州乐陵市供电公司物资供应中心分办公区信息机房及附属设施维修施工).xlsx');
const seed = {
  source_file: '34-国网山东德州乐陵市供电公司物资供应中心分办公区信息机房及附属设施维修施工.xlsx',
  project: r.project,
  cost_summary: r.cost_summary,
  work_items: r.work_items,
  procurement_items: r.procurement_items,
  travel_items: r.travel_items
};
fs.writeFileSync('C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/backend/data/seed-project.json', JSON.stringify(seed, null, 2), 'utf8');
console.log('seed written', seed.work_items.length, 'work items,', seed.procurement_items.length, 'procurement items');
