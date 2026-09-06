const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
let code = fs.readFileSync(path, 'utf8');

console.log('=== Deep Analysis of JavaScript Syntax ===\n');

// 找到所有script标签
const scriptRegex = /<script[^>]*>[\s\S]*?<\/script>/g;
let match;
let scriptIndex = 0;

while ((match = scriptRegex.exec(code)) !== null) {
  scriptIndex++;
  const isExternal = match[0].includes('src=');
  
  if (!isExternal) {
    const jsCode = match[0].replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    console.log(`Script ${scriptIndex}: ${jsCode.length} chars`);
    
    // 计算括号深度
    let braceDepth = 0;
    let parenDepth = 0;
    let inString = false;
    let stringChar = '';
    let escapeNext = false;
    let line = 1;
    
    for (let i = 0; i < jsCode.length; i++) {
      const ch = jsCode[i];
      
      if (ch === '\n') { line++; continue; }
      
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\') { escapeNext = true; continue; }
      
      if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (inString && ch === stringChar) {
        inString = false;
        continue;
      }
      if (inString) continue;
      
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      
      // 检查负深度
      if (braceDepth < 0) {
        console.log(`  ✗ Extra '}' at line ${line}, pos ${i}`);
      }
      if (parenDepth < 0) {
        console.log(`  ✗ Extra ')' at line ${line}, pos ${i}`);
      }
    }
    
    console.log(`  Final: braces=${braceDepth}, parens=${parenDepth}`);
    
    if (braceDepth > 0) {
      console.log(`  Need to add ${braceDepth} closing braces`);
      // 在</script>前添加缺失的括号
      const scriptEndPos = match.index + match[0].length - '</script>'.length;
      const insertPos = scriptEndPos;
      code = code.slice(0, insertPos) + '\n' + '}'.repeat(braceDepth) + code.slice(insertPos);
      console.log('  ✓ Added missing braces');
    }
    
    if (parenDepth > 0) {
      console.log(`  Need to add ${parenDepth} closing parentheses`);
      // 在</script>前添加缺失的括号
      const scriptEndPos = code.lastIndexOf('</script>');
      code = code.slice(0, scriptEndPos) + ')'.repeat(parenDepth) + code.slice(scriptEndPos);
      console.log('  ✓ Added missing parens');
    }
  }
}

// 保存修改
fs.writeFileSync(path, code, 'utf8');
console.log('\n✓ File updated. New size:', code.length);

// 验证最终状态
const finalMatch = code.match(/<script>([\s\S]*?)<\/script>/);
if (finalMatch) {
  const finalJs = finalMatch[1];
  let finalBrace = 0, finalParen = 0;
  for (const ch of finalJs) {
    if (ch === '{') finalBrace++;
    else if (ch === '}') finalBrace--;
    else if (ch === '(') finalParen++;
    else if (ch === ')') finalParen--;
  }
  console.log(`\nFinal verification: braces=${finalBrace}, parens=${finalParen}`);
  console.log(finalBrace === 0 && finalParen === 0 ? '✓ All balanced!' : '✗ Still unbalanced');
}
