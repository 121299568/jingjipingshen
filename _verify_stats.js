const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
const code = fs.readFileSync(path, 'utf8');

console.log('=== Final Check ===');
console.log('page-stats-rich exists:', code.includes('id="page-stats-rich"'));
console.log('stats-rich nav item:', code.includes("data-page='stats-rich'"));
console.log('loadStatsRich function:', code.includes('function loadStatsRich'));
console.log('loadStatsRich call:', code.includes('loadStatsRich()'));
console.log('Chart instances:', (code.match(/Chart\(/g) || []).length);

// Check for all chart canvases
const charts = ['deptChart', 'monthlyChart', 'fileChart', 'sessionChart'];
charts.forEach(c => console.log(`${c}:`, code.includes(`id="${c}"`)));

// Check navigateTo
const hasStatsRichCase = code.includes("case 'stats-rich':loadStatsRich();break;");
console.log('navigateTo has stats-rich case:', hasStatsRichCase);

// Count total lines
console.log('Total lines:', code.split('\n').length);
console.log('File size:', code.length, 'bytes');
