const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
const code = fs.readFileSync(path, 'utf8');

// 查找所有chart相关的canvas和配置
console.log('=== Current Chart Configuration ===');

// 找canvas元素
const canvasMatches = code.match(/<canvas[^>]*>/g) || [];
canvasMatches.forEach((c, i) => console.log(`Canvas ${i+1}:`, c));

// 找Chart初始化代码
const chartInitMatches = code.match(/new Chart\([^)]+\)/g) || [];
chartInitMatches.forEach((c, i) => console.log(`Chart ${i+1}:`, c.slice(0, 150)));

// 找height属性
const heightMatches = code.match(/height="\d+"/g) || [];
heightMatches.forEach(h => console.log('Height:', h));
