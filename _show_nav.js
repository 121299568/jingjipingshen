const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
const code = fs.readFileSync(path, 'utf8');

// Find nav section
const navStart = code.indexOf('<nav class="sidebar">');
if (navStart > 0) {
  const navEnd = code.indexOf('</nav>', navStart);
  const navSection = code.slice(navStart, navEnd + 6);
  console.log('=== Navigation Section ===');
  console.log(navSection);
}

// Find navigateTo function
const navFunc = code.indexOf('function navigateTo');
if (navFunc > 0) {
  const funcEnd = code.indexOf('}', code.indexOf('{', navFunc) + 1);
  console.log('\n=== navigateTo Function ===');
  console.log(code.slice(navFunc, funcEnd + 1));
}
