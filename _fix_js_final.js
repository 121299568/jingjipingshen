const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
let code = fs.readFileSync(path, 'utf8');

console.log('=== Comprehensive Syntax Fix ===\n');

// 找到inline script标签
const inlineScriptMatch = code.match(/<script>([\s\S]*?)<\/script>/);
if (!inlineScriptMatch) {
  console.log('No inline script found');
  process.exit(1);
}

let jsCode = inlineScriptMatch[1];
console.log('Original JS length:', jsCode.length);

// 移除末尾所有多余的括号（贪婪匹配）
let prevLength = jsCode.length + 1;
while (jsCode.length < prevLength) {
  prevLength = jsCode.length;
  // 尝试移除末尾的 } 或 )
  if (jsCode.endsWith('}')) {
    jsCode = jsCode.slice(0, -1);
  } else if (jsCode.endsWith(')')) {
    jsCode = jsCode.slice(0, -1);
  } else {
    break;
  }
}
console.log('After removing trailing brackets:', jsCode.length);

// 重新计算深度
let braceDepth = 0;
let parenDepth = 0;
for (const ch of jsCode) {
  if (ch === '{') braceDepth++;
  else if (ch === '}') braceDepth--;
  else if (ch === '(') parenDepth++;
  else if (ch === ')') parenDepth--;
}

console.log(`Current depth: braces=${braceDepth}, parens=${parenDepth}`);

// 添加缺失的括号
if (braceDepth > 0) {
  jsCode += '\n' + '}'.repeat(braceDepth);
  console.log(`Added ${braceDepth} closing braces`);
}
if (parenDepth > 0) {
  jsCode += ')'.repeat(parenDepth);
  console.log(`Added ${parenDepth} closing parens`);
}

// 最终验证
let finalBrace = 0, finalParen = 0;
for (const ch of jsCode) {
  if (ch === '{') finalBrace++;
  else if (ch === '}') finalBrace--;
  else if (ch === '(') finalParen++;
  else if (ch === ')') finalParen--;
}

console.log(`Final depth: braces=${finalBrace}, parens=${finalParen}`);

if (finalBrace === 0 && finalParen === 0) {
  const newCode = code.replace(inlineScriptMatch[0], `<script>${jsCode}</script>`);
  fs.writeFileSync(path, newCode, 'utf8');
  console.log('\n✓ Successfully fixed and saved!');
} else {
  console.log('\n✗ Still unbalanced after fix');
}
