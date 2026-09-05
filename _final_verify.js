const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
const code = fs.readFileSync(path, 'utf8');

console.log('=== Verification ===');
console.log('File size:', code.length);
console.log('page-stats-rich:', code.includes('id="page-stats-rich"'));
console.log('stats-rich nav:', code.includes("data-page='stats-rich'"));
console.log('loadStatsRich func:', code.includes('function loadStatsRich'));
console.log('loadStatsRich call:', code.includes('loadStatsRich()'));
console.log('stats-rich case:', code.includes("case 'stats-rich'"));
console.log('deptChart:', code.includes('id="deptChart"'));
console.log('monthlyChart:', code.includes('id="monthlyChart"'));
console.log('fileChart:', code.includes('id="fileChart"'));
console.log('sessionChart:', code.includes('id="sessionChart"'));
