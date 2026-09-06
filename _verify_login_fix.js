const fs = require('fs');
const path = 'C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html';
const code = fs.readFileSync(path, 'utf8');

console.log('=== Login Fix Verification ===\n');
console.log('File size:', code.length);

// Check script structure
const scriptMatch = code.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const jsCode = scriptMatch[1];
  console.log('\nJavaScript length:', jsCode.length);
  
  // Calculate bracket balance
  let braceDepth = 0;
  let parenDepth = 0;
  for (const ch of jsCode) {
    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
  }
  
  console.log(`Bracket balance: braces=${braceDepth}, parens=${parenDepth}`);
  
  if (braceDepth === 0 && parenDepth === 0) {
    console.log('\n✓ JavaScript syntax is balanced');
  } else {
    console.log('\n✗ JavaScript syntax has errors');
  }
  
  // Check for login code
  const hasLoginListener = jsCode.includes("document.getElementById('loginForm').addEventListener('submit'");
  const hasShowMainApp = jsCode.includes('function showMainApp');
  
  console.log('\nLogin functionality:');
  console.log('  Has login listener:', hasLoginListener);
  console.log('  Has showMainApp:', hasShowMainApp);
  
  // Show login handler context
  if (hasLoginListener) {
    const loginIdx = jsCode.indexOf("document.getElementById('loginForm').addEventListener('submit'");
    const context = jsCode.slice(loginIdx, loginIdx + 400);
    console.log('\nLogin handler preview:');
    console.log(context);
  }
}
