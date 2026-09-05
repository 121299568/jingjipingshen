const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
let htmlCode = fs.readFileSync(path, 'utf8');

console.log('Current file length:', htmlCode.length);

// Find the exact location of stats nav button
const statsBtnPattern = /<button[^>]*data-page=['"]stats[^"]*['"][^>]*>[\s\S]*?<\/button>/g;
const statsButtons = htmlCode.match(statsBtnPattern) || [];
console.log('Found', statsButtons.length, 'stats-related buttons');
statsButtons.forEach((btn, i) => console.log(`  ${i+1}:`, btn.slice(0, 80)));

// Insert after the last stats button or before the next nav item
let insertPos = -1;
for (let i = statsButtons.length - 1; i >= 0; i--) {
  const pos = htmlCode.lastIndexOf(statsButtons[i]);
  if (pos > insertPos) insertPos = pos + statsButtons[i].length;
}

if (insertPos > 0) {
  const newBtn = "<button class='nav-item' data-page='stats-rich'><i class='bi bi-bar-chart-fill'></i> 综合分析</button>";
  htmlCode = htmlCode.slice(0, insertPos) + '\n      ' + newBtn + htmlCode.slice(insertPos);
  console.log('Inserted nav button at position', insertPos);
} else {
  // Fallback: insert before </nav>
  const navEnd = htmlCode.indexOf('</nav>');
  if (navEnd > 0) {
    const newBtn = "<button class='nav-item' data-page='stats-rich'><i class='bi bi-bar-chart-fill'></i> 综合分析</button>";
    htmlCode = htmlCode.slice(0, navEnd) + '\n      ' + newBtn + htmlCode.slice(navEnd);
    console.log('Inserted before </nav>');
  }
}

// Fix navigateTo
if (!htmlCode.includes("case 'stats-rich':loadStatsRich();break;")) {
  const statsCase = "case 'stats':loadStats();break;";
  if (htmlCode.includes(statsCase)) {
    htmlCode = htmlCode.replace(statsCase, `${statsCase}\n    case 'stats-rich':loadStatsRich();break;`);
    console.log('Added stats-rich to navigateTo');
  } else {
    // Try to find any case statement
    const casesMatch = htmlCode.match(/case ['"]\w+['"]:[^;]+;/g);
    if (casesMatch && casesMatch.length > 0) {
      const lastCase = casesMatch[casesMatch.length - 1];
      const lastPos = htmlCode.lastIndexOf(lastCase);
      if (lastPos > 0) {
        htmlCode = htmlCode.slice(0, lastPos + lastCase.length) + 
          "\n    case 'stats-rich':loadStatsRich();break;" + 
          htmlCode.slice(lastPos + lastCase.length);
        console.log('Added after last case');
      }
    }
  }
}

fs.writeFileSync(path, htmlCode, 'utf8');
console.log('\nFinal check:');
console.log('  File size:', htmlCode.length);
console.log('  Has stats-rich nav:', htmlCode.includes("data-page='stats-rich'"));
console.log('  Has stats-rich case:', htmlCode.includes("case 'stats-rich':loadStatsRich()"));
