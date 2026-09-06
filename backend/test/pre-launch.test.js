#!/usr/bin/env node
/**
 * 上线前冒烟测试（虚拟数据驱动）
 *
 * 该脚本会：以 DB_DRIVER=memory 在内存载入一份模拟业务数据启动后端，
 * 然后通过真实 HTTP 请求验证关键链路：健康检查、各角色登录、数据隔离、
 * 统计接口、权限拦截。全部通过则退出码 0，任一失败则退出码 1。
 *
 * 运行：
 *   node test/pre-launch.test.js            # 默认端口 4123
 *   PORT=4200 node test/pre-launch.test.js  # 指定端口
 *   npm run test:pre-launch
 *
 * 注意：测试用的是「虚拟数据库」，不依赖 / 不污染磁盘数据（store.json / uploads）。
 */

const { spawn } = require('child_process');
const path = require('path');

const PORT = parseInt(process.env.PORT || process.env.TEST_PORT || '4123', 10);
const BASE = `http://127.0.0.1:${PORT}`;

// 清掉可能干扰本地请求的代理环境变量（sandbox 里有时设有 http_proxy）
function cleanEnv() {
  const env = { ...process.env, DB_DRIVER: 'memory', NODE_ENV: 'test', PORT: String(PORT) };
  ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].forEach(k => delete env[k]);
  return env;
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function req(relPath, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + relPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function waitHealth(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  serverProc.stdout.on('data', d => serverLog += d);
  serverProc.stderr.on('data', d => serverLog += d);

  const cleanup = () => { try { serverProc.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);

  console.log(`\n[pre-launch] 启动内存虚拟数据服务 (DB_DRIVER=memory) on ${BASE}`);
  const up = await waitHealth();
  if (!up) {
    console.error('服务未就绪，日志：\n' + serverLog);
    cleanup();
    process.exit(1);
  }

  try {
    // 1. 健康检查
    const h = await req('/api/health');
    check('健康检查 /api/health 返回 200', h.status === 200, `got ${h.status}`);

    // 2. 登录：各角色
    const adminLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
    const bizLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'biz_gdw', password: '123456' } });
    const expLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'expert01', password: '123456' } });
    check('admin 登录成功并拿到 token', adminLogin.status === 200 && !!adminLogin.data.token, `status ${adminLogin.status}`);
    check('biz_gdw 登录成功', bizLogin.status === 200 && !!bizLogin.data.token, `status ${bizLogin.status}`);
    check('expert01 登录成功', expLogin.status === 200 && !!expLogin.data.token, `status ${expLogin.status}`);

    // 3. 错误密码应被拒
    const bad = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
    check('错误密码登录被拒 (401)', bad.status === 401, `status ${bad.status}`);

    // 4. 未带 token 应被拒
    const noTok = await req('/api/projects');
    check('无 token 访问 /api/projects 被拒 (401)', noTok.status === 401, `status ${noTok.status}`);

    const at = adminLogin.data.token;
    const bt = bizLogin.data.token;
    const et = expLogin.data.token;

    // 5. 数据隔离：列表
    const adminProj = await req('/api/projects', { token: at });
    const bizProj = await req('/api/projects', { token: bt });
    const expProj = await req('/api/projects', { token: et });
    check('admin 可见全部 8 个项目', adminProj.status === 200 && adminProj.data.length === 8, `got ${adminProj.data && adminProj.data.length}`);
    check('biz_gdw 仅见本事业部 4 个项目', bizProj.status === 200 && bizProj.data.length === 4, `got ${bizProj.data && bizProj.data.length}`);
    check('expert01 仅见被分配的 3 个项目', expProj.status === 200 && expProj.data.length === 3, `got ${expProj.data && expProj.data.length}`);

    // 6. 数据隔离：详情越权拦截
    const adminDetail1 = await req('/api/projects/1', { token: at });
    const expDetail1 = await req('/api/projects/1', { token: et }); // expert01 被分配到项目1
    // biz_xt 是系统集成事业部，项目1 是电网事业部 → 403
    const bizXtLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'biz_xt', password: '123456' } });
    const xt = bizXtLogin.data.token;
    const bizXtDetail = await req('/api/projects/1', { token: xt });
    check('admin 可看项目1 详情 (200)', adminDetail1.status === 200, `status ${adminDetail1.status}`);
    check('expert01 可看被分配的项目1 详情 (200)', expDetail1.status === 200, `status ${expDetail1.status}`);
    check('跨事业部经办人看项目1 被拒 (403)', bizXtDetail.status === 403, `status ${bizXtDetail.status}`);
    check('expert01 看未分配的项目6 被拒 (403)', (await req('/api/projects/6', { token: et })).status === 403);

    // 7. 统计接口：月度趋势含 total_amount，总金额为正数
    const stats = await req('/api/stats/detailed', { token: at });
    check('统计接口返回 200', stats.status === 200, `status ${stats.status}`);
    if (stats.status === 200) {
      const d = stats.data;
      check('overview.total_amount > 0', d.overview && d.overview.total_amount > 0, `total=${d.overview && d.overview.total_amount}`);
      check('monthly_trend 为数组且非空', Array.isArray(d.monthly_trend) && d.monthly_trend.length > 0, `len=${d.monthly_trend && d.monthly_trend.length}`);
      const everyHasTotal = Array.isArray(d.monthly_trend) && d.monthly_trend.every(m => 'total_amount' in m);
      check('monthly_trend 每项均含 total_amount', everyHasTotal);
      check('departments 含 2 个事业部', Array.isArray(d.departments) && d.departments.length === 2, `len=${d.departments && d.departments.length}`);
    }

    // 8. 成本/评估接口（带 token 可访问）
    const cost = await req('/api/projects/1/cost', { token: at });
    check('项目1 成本接口可访问 (200)', cost.status === 200, `status ${cost.status}`);
    const est = await req('/api/projects/1/estimates', { token: at });
    check('项目1 评估接口可访问 (200)', est.status === 200, `status ${est.status}`);

    // 9. 报告生成（admin 可生成 HTML 摘要）
    const report = await req('/api/reports/generate', { token: at, method: 'POST', body: { type: 'summary', format: 'html' } });
    check('摘要报告生成成功 (200, 含 html)', report.status === 200 && typeof (report.data && report.data.content) === 'string', `status ${report.status}`);

    // 10. 工作流接口参数修复验证（原代码读错参数会恒返回 []）
    const wf = await req('/api/workflow/1', { token: at });
    check('工作流接口按 projectId 返回数组', wf.status === 200 && Array.isArray(wf.data), `status ${wf.status}`);

  } catch (e) {
    check('测试执行未抛异常', false, e.message);
  } finally {
    cleanup();
  }

  console.log(`\n[pre-launch] 结果：通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('✅ 全部通过，虚拟数据链路健康，可上线前验证。\n');
  process.exit(0);
}

main();
