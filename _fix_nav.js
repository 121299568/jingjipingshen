const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
let htmlCode = fs.readFileSync(path, 'utf8');

// 查找现有的统计导航项
const statsNavMatch = htmlCode.match(/<button[^>]*data-page=['"]stats[^"]*['"][^>]*>[\s\S]*?<\/button>/);
if (statsNavMatch) {
  console.log('Found stats nav:', statsNavMatch[0].slice(0, 100));
}

// 在统计数据导航后添加新的综合分析导航
const oldStatsNav = "<button class='nav-item' data-page='stats'><i class='bi bi-graph-up'></i> 统计分析</button>";
const newNavHtml = `
      <button class='nav-item' data-page='stats'><i class='bi bi-graph-up'></i> 统计分析</button>
      <button class='nav-item' data-page='stats-rich'><i class='bi bi-bar-chart-fill'></i> 综合分析</button>`;

if (htmlCode.includes(oldStatsNav)) {
  htmlCode = htmlCode.replace(oldStatsNav, newNavHtml);
  console.log('Added stats-rich navigation');
} else {
  // 尝试其他模式
  const altPattern = /data-page=['"]stats[^"]*['"]/;
  if (altPattern.test(htmlCode)) {
    const match = htmlCode.match(altPattern);
    console.log('Found pattern at:', match.index);
    // 在这个匹配后面插入
    const insertPos = match.index + match[0].length;
    htmlCode = htmlCode.slice(0, insertPos) + 
      "'></button><button class='nav-item' data-page='stats-rich'><i class='bi bi-bar-chart-fill'></i> 综合分析</button>" +
      htmlCode.slice(insertPos);
    console.log('Added via alternative method');
  } else {
    console.log('Stats nav not found, searching...');
    const lines = htmlCode.split('\n');
    lines.forEach((l, i) => {
      if (l.includes('stats') && l.includes('nav-item')) {
        console.log(`Line ${i+1}: ${l.trim().slice(0, 80)}`);
      }
    });
  }
}

// 确保navigateTo函数包含新页面
const navigateCase = "case 'stats':loadStats();break;";
if (!htmlCode.includes("case 'stats-rich'")) {
  if (htmlCode.includes(navigateCase)) {
    htmlCode = htmlCode.replace(navigateCase, `${navigateCase}\n    case 'stats-rich':loadStatsRich();break;`);
    console.log('Added stats-rich to navigateTo');
  } else {
    // 查找所有case语句并添加
    const casesMatch = htmlCode.match(/case ['"]\w+['"]:[^;]+;/g);
    if (casesMatch && casesMatch.length > 0) {
      const lastCase = casesMatch[casesMatch.length - 1];
      console.log('Last case:', lastCase);
      const insertAfter = htmlCode.lastIndexOf(lastCase);
      if (insertAfter > 0) {
        htmlCode = htmlCode.slice(0, insertAfter + lastCase.length) + 
          "\n    case 'stats-rich':loadStatsRich();break;" + 
          htmlCode.slice(insertAfter + lastCase.length);
        console.log('Added after last case');
      }
    }
  }
}

fs.writeFileSync(path, htmlCode, 'utf8');
console.log('Final check:');
console.log('  stats-rich nav:', htmlCode.includes("data-page='stats-rich'"));
console.log('  loadStatsRich call:', htmlCode.includes("loadStatsRich()"));
console.log('  page-stats-rich div:', htmlCode.includes('id="page-stats-rich"'));
