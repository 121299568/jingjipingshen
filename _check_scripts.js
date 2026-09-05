const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Program Files/AgnesCode/resources/slide_export_runtime/node/node.exe';
const html = fs.readFileSync('C:/Users/12129/.agnes/temporary/2026-08-29/20260829_2/work/jingjipingshen/frontend/index.html', 'utf8');
const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
let m, i = 0, fail = 0;
while ((m = re.exec(html)) !== null) {
  i++;
  const block = m[1];
  if (!block.trim()) continue;
  const tmp = path.join(__dirname, `_chk_${i}.js`);
  fs.writeFileSync(tmp, block, 'utf8');
  let out = '';
  try { execSync(`"${NODE}" --check "${tmp}"`); }
  catch (e) { out = ((e.stdout || '') + (e.stderr || '')).toString(); fail++; }
  console.log(`block ${i} len=${block.length}: ${out ? out.trim() : 'OK'}`);
  fs.unlinkSync(tmp);
}
process.exit(fail ? 1 : 0);
