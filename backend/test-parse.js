const r = require('C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/backend/parse-excel.js')
  .parseProjectExcel('C:/Users/12129/Downloads/34-国网山东德州乐陵市供电公司物资供应中心分办公区信息机房及附属设施维修施工).xlsx');
console.log('PROJECT', JSON.stringify(r.project, null, 1));
console.log('SUMMARY', JSON.stringify(r.cost_summary, null, 1));
console.log('WORK', r.work_items.length, 'PROC', r.procurement_items.length, 'TRAVEL', r.travel_items.length);
console.log('--- SUBCONTRACT ---');
r.work_items.filter(w => w.category === 'subcontract').forEach(w =>
  console.log(' ', w.work_item, 'days=', w.person_days, 'exp=', JSON.stringify(w.expert_days), 'avg=', w.expert_days_avg, 'adj=', w.adjusted_cost));
console.log('--- WORK all ---');
r.work_items.forEach(w => console.log(`[${w.category}] ${w.work_task}/${w.work_item} person=${w.person} days=${w.person_days} cost=${w.cost} row=${w.row}`));
console.log('--- PROC sample ---');
r.procurement_items.slice(0, 4).forEach(p => console.log(`(${p.type}) ${p.name} qty=${p.quantity} price=${p.unit_price} sub=${p.subtotal} row=${p.row}`));
console.log('PROC total', r.procurement_items.reduce((a, b) => a + (b.subtotal || 0), 0));
console.log('WARN', JSON.stringify(r.warnings));
