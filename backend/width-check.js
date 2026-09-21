// 专家评估页列宽验算：从 expert.html 读真实列宽，折算成像素核对「够用就行」。
// 百分比会随表格宽度缩放，所以按最窄场景（table min-width）验算；更宽只会更宽松。
// 口径：td 左右内边距共 14px，用「内容可用宽 = 列宽 - 14」与内容实际需求比对。
// 用法：node width-check.js   （本地 lnsoft-patch/、仓库 backend/、部署机直跑目录都能跑）
const fs = require('fs');
function pick(cands) {
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  throw new Error('找不到 expert.html，试过：' + cands.join(' , '));
}
const html = fs.readFileSync(pick([
  __dirname + '/frontend/expert.html', __dirname + '/../frontend/expert.html',
  '/opt/jingjipingshen/frontend/expert.html',
  'C:/Users/12129/WorkBuddy/mjumju正式版/lnsoft-patch/frontend/expert.html',
]), 'utf8');

const MIN = parseFloat((html.match(/table\{[^}]*min-width:(\d+)px/) || [])[1]);
const widths = [...html.matchAll(/<col style="width:([\d.]+)%">/g)].map(m => parseFloat(m[1])).slice(0, 7);
const NAMES = ['任务', '工作项', '说明', '原人天', '原费用', '我的评估人天', '状态'];
// 每列内容的最小需求（px）：表头字数×字号，或典型内容宽度；文本三列不设上限
const NEED = [0, 0, 0, 36, 73, 78, 33];
const NOTE = ['', '', '', '表头「原人天」3字', '百万级金额 ¥2,700,000', '表头 6 字 / 步进器 − 输入 +', '「已提交」3 字'];
const PAD = 14;

if (!MIN || widths.length !== 7) { console.error('✗ 未能从 expert.html 解析出 min-width 或 7 列宽度'); process.exit(2); }
const sum = widths.reduce((a, b) => a + b, 0);
console.log('数据来源：' + pick([
  __dirname + '/frontend/expert.html', __dirname + '/../frontend/expert.html',
  '/opt/jingjipingshen/frontend/expert.html',
  'C:/Users/12129/WorkBuddy/mjumju正式版/lnsoft-patch/frontend/expert.html',
]));
console.log('table min-width = ' + MIN + 'px，列宽合计 = ' + sum.toFixed(1) + '%' +
  (Math.abs(sum - 100) > 0.01 ? '  ⚠ 不等于 100%' : ''));

let bad = 0;
for (const T of [MIN, 1218]) {
  console.log('\n── 表格宽度 ' + T + 'px' + (T === MIN ? '（最窄场景）' : '（1240 容器下的常规宽度）'));
  widths.forEach((pct, i) => {
    const px = pct / 100 * T, usable = px - PAD, need = NEED[i];
    let tail = '';
    if (need) {
      const ok = usable >= need;
      if (!ok) bad++;
      tail = '   可用 ' + usable.toFixed(1) + ' / 需要 ' + need + 'px  ' +
        (ok ? '✓ 余 ' + (usable - need).toFixed(1) : '✗ 差 ' + (need - usable).toFixed(1)) + '　(' + NOTE[i] + ')';
    }
    console.log('   ' + NAMES[i].padEnd(12) + String(pct).padStart(5) + '%  = ' + px.toFixed(1).padStart(6) + 'px' + tail);
  });
}
console.log('\n结论：' + (bad ? '✗ 有 ' + bad + ' 处不足，请调宽对应列或提高 min-width' : '✓ 两档宽度下四列窄列都够用'));
process.exit(bad ? 1 : 0);
