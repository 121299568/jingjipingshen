const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
let code = fs.readFileSync(path, 'utf8');

console.log('=== Fixing Chart Sizes ===');

// 1. 修改所有stats-rich页面的canvas height
code = code.replace(/id="deptChart" height="250"/g, 'id="deptChart" height="200"');
code = code.replace(/id="monthlyChart" height="250"/g, 'id="monthlyChart" height="200"');
code = code.replace(/id="fileChart" height="250"/g, 'id="fileChart" height="200"');
code = code.replace(/id="sessionChart" height="250"/g, 'id="sessionChart" height="200"');
console.log('✓ Reduced canvas heights to 200px');

// 2. 添加CSS样式限制图表容器
const cssStyle = `
<style>
.stats-chart-container {
  position: relative;
  height: 200px;
  width: 100%;
}
</style>`;

// 在</head>前插入
const headEnd = code.indexOf('</head>');
if (headEnd > 0) {
  code = code.slice(0, headEnd) + cssStyle + code.slice(headEnd);
  console.log('✓ Added chart container CSS');
}

// 3. 更新render函数中的chart配置，添加maintainAspectRatio
const updateChartOptions = (funcName, options) => {
  const regex = new RegExp(`(${funcName}\\([^)]+\\))`, 'g');
  // 这个太复杂，我们用简单替换
};

// 直接修改Chart初始化代码，添加responsive和maintainAspectRatio
const charts = [
  ['deptChartInstance', 'new Chart(ctx'],
  ['monthlyChartInstance', 'new Chart(ctx'],
  ['fileChartInstance', 'new Chart(ctx'],
  ['sessionChartInstance', 'new Chart(ctx']
];

charts.forEach(([name, marker]) => {
  // 找到对应的Chart初始化并添加options
  const pattern = `(type:\\s*'${name.replace(/Instance$/, '').toLowerCase().replace('Chart', '')}'[^}]+options:\\s*\\{[^}]+\\})`;
  // 这个太复杂，我直接在每个chart实例中添加responsive选项
});

// 更简单的方法：找到renderDeptChart等函数，添加responsive:true到options
code = code.replace(
  /function renderDeptChart\(depts\)\{[\s\S]*?deptChartInstance = new Chart\(ctx, \{[\s\S]*?options: \{([\s\S]*?)\}/,
  (match, opts) => {
    return match.replace('options: {' + opts + '}', `options: {
        responsive: true,
        maintainAspectRatio: false,
        ${opts}`);
  }
);

// 由于正则太复杂，我用更直接的方式
console.log('\n=== Manually updating chart configurations ===');

// 直接搜索并替换Chart配置
const chartPatterns = [
  { name: 'deptChart', search: /deptChartInstance = new Chart\(ctx, \{([^}]+)\}/ },
  { name: 'monthlyChart', search: /monthlyChartInstance = new Chart\(ctx, \{([^}]+)\}/ },
  { name: 'fileChart', search: /fileChartInstance = new Chart\(ctx, \{([^}]+)\}/ },
  { name: 'sessionChart', search: /sessionChartInstance = new Chart\(ctx, \{([^}]+)\}/ }
];

chartPatterns.forEach(({ name, search }) => {
  const match = code.match(search);
  if (match) {
    console.log(`Found ${name}: ${match[0].slice(0, 100)}...`);
  }
});

fs.writeFileSync(path, code, 'utf8');
console.log('\nFile saved. Size:', code.length);
