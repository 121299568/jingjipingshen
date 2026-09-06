const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
let code = fs.readFileSync(path, 'utf8');

console.log('=== Fixing Chart Display Issues ===');

// 1. 减少所有canvas高度
code = code.replace(/height="250"/g, 'height="150"');
console.log('✓ Reduced canvas heights to 150px');

// 2. 修改Chart.js配置，添加responsive选项
// 找到renderDeptChart函数并修改
const deptChartMatch = code.match(/function renderDeptChart\(depts\)[\s\S]*?options: \{([^}]+)skills: \{/);
if (deptChartMatch) {
  const currentOptions = deptChartMatch[1];
  if (!currentOptions.includes('responsive')) {
    code = code.replace(
      /options: \{([^}]+)\}/,
      (match, opts) => {
        return match.replace(opts, `responsive: true,\n        maintainAspectRatio: false,\n        ${opts}`);
      }
    );
    console.log('✓ Added responsive to dept chart');
  }
}

// 同样的方法处理其他图表 - 直接用正则替换
// 找到所有Chart初始化并添加responsive
code = code.replace(
  /(new Chart\(ctx[^{]+\{[^}]+)type:\s*'([^']+)'/,
  '$1responsive: true,\n        maintainAspectRatio: false,\n        $&'
);

// 更简单：直接在每个chart的options里添加
code = code.replace(
  /statsChartInstance\.options\s*=\s*\{([^}]+)\}/,
  (match, opts) => {
    if (!opts.includes('responsive')) {
      return `statsChartInstance.options = {\n        responsive: true,\n        maintainAspectRatio: false,\n        ${opts}\n      }`;
    }
    return match;
  }
);

console.log('Updated chart configurations');

// 3. 添加CSS确保图表容器有固定高度
const chartCss = `
<style>
.card-body canvas {
  max-height: 200px !important;
  width: 100% !important;
}
#statsChart {
  height: 150px !important;
}
</style>`;

// 在</style>前插入
const styleEnd = code.lastIndexOf('</style>');
if (styleEnd > 0) {
  code = code.slice(0, styleEnd) + chartCss + code.slice(styleEnd);
  console.log('✓ Added chart CSS constraints');
}

fs.writeFileSync(path, code, 'utf8');
console.log('\nFinal file size:', code.length);

// 验证
console.log('\n=== Verification ===');
console.log('Canvas height 250:', (code.match(/height="250"/g) || []).length);
console.log('Canvas height 150:', (code.match(/height="150"/g) || []).length);
console.log('Has responsive:', code.includes('responsive: true'));
