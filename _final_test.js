const http = require('http');
const https = require('https');

function req(method, url, body, tok) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    const headers = tok ? { Authorization: 'Bearer ' + tok } : {};
    let payload = null;
    if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    
    const r = lib.request(url, { method, headers }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d.slice(0, 300) }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  // Test local server
  console.log('=== Local Server Test ===');
  const t = await req('POST', 'http://localhost:3000/api/auth/login', { username: 'admin', password: 'admin123' });
  console.log('Login:', t.data.token ? 'OK' : t.data.error);
  
  const stats = await req('GET', 'http://localhost:3000/api/stats/detailed', null, t.data.token);
  console.log('Stats API:', stats.status === 200 ? '✓ OK' : '✗ FAILED');
  if (stats.status === 200) {
    console.log('  Projects:', stats.data.overview.total_projects);
    console.log('  Sessions:', stats.data.overview.total_sessions);
    console.log('  Departments:', stats.data.departments.map(d => d.name).join(', '));
  }
  
  // Test GitHub Pages HTML
  console.log('\n=== GitHub Pages Test ===');
  try {
    const page = await new Promise((resolve, reject) => {
      https.get('https://121299568.github.io/jingjipingshen/frontend/index.html', res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
      }).on('error', reject);
    });
    
    console.log('Page size:', page.length, 'bytes');
    console.log('Has stats-rich page:', page.includes('id="page-stats-rich"'));
    console.log('Has loadStatsRich:', page.includes('function loadStatsRich'));
    console.log('Has stats-rich nav:', page.includes("data-page='stats-rich'"));
    console.log('Has Chart.js calls:', (page.match(/new Chart/g) || []).length);
  } catch(e) {
    console.log('GitHub Pages error:', e.message);
  }
})();
