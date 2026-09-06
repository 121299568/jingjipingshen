const https = require('https');

console.log('=== Checking GitHub Pages Deployment ===\n');

https.get('https://121299568.github.io/jingjipingshen/frontend/index.html', res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Page size:', data.length, 'bytes');
    
    // Check for login-related code
    const checks = {
      'loginForm': data.includes('id="loginForm"'),
      'loginUser': data.includes('id="loginUser"'),
      'loginPass': data.includes('id="loginPass"'),
      'doLogin': data.includes('addEventListener(\'submit\''),
      'showMainApp': data.includes('function showMainApp'),
      'brackets_balanced': !data.includes('}}}}))))')
    };
    
    console.log('\nLogin functionality check:');
    Object.entries(checks).forEach(([key, value]) => {
      console.log(`  ${key}: ${value ? '✓' : '✗'}`);
    });
    
    // Check script structure
    const scriptMatch = data.match(/<script>([\s\S]*?)<\/script>/);
    if (scriptMatch) {
      const jsCode = scriptMatch[1];
      let braceDepth = 0;
      let parenDepth = 0;
      for (const ch of jsCode) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        else if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
      }
      console.log(`\nScript brackets: braces=${braceDepth}, parens=${parenDepth}`);
      console.log(braceDepth === 0 && parenDepth === 0 ? '✓ Syntax OK' : '✗ Syntax Error');
    }
  });
}).on('error', e => console.error('Error:', e.message));
