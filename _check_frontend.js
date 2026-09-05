const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
const code = fs.readFileSync(path, 'utf8');

console.log('=== Checking stats-rich page ===');
console.log('page-stats-rich exists:', code.includes('id="page-stats-rich"'));
console.log('loadStatsRich function:', code.includes('function loadStatsRich'));
console.log('statsReportType select:', code.includes('id="statsReportType"'));
console.log('deptChart canvas:', code.includes('id="deptChart"'));
console.log('monthlyChart canvas:', code.includes('id="monthlyChart"'));
console.log('fileChart canvas:', code.includes('id="fileChart"'));
console.log('sessionChart canvas:', code.includes('id="sessionChart"'));
console.log('statTotalProjects element:', code.includes('id="statTotalProjects"'));

console.log('\n=== Checking navigation ===');
console.log('stats-rich nav item:', code.includes("data-page='stats-rich'"));
console.log('stats nav item:', code.includes("data-page='stats'"));

console.log('\n=== Checking navigateTo cases ===');
const cases = code.match(/case ['"]stats[^:]+:/g) || [];
cases.forEach(c => console.log(' ', c));

console.log('\n=== File size ===');
console.log('Total length:', code.length);
