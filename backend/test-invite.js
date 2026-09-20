// 专家定向免登录评估链接 —— 端到端回归测试（用完即清，不污染真实数据）
const XLSX = require('/opt/jingjipingshen/backend/node_modules/xlsx');
const fs = require('fs'), http = require('http'), crypto = require('crypto'), { execSync } = require('child_process');

const env = fs.readFileSync('/opt/jingjipingshen/backend/.env', 'utf8');
const SEC = (env.match(/JWT_SECRET=(\S+)/) || [])[1] || '';
const body = Buffer.from(JSON.stringify({ id: 1, username: 'admin', role: 'admin', exp: Date.now() + 3600e3 })).toString('base64url');
const TOKEN = body + '.' + crypto.createHmac('sha256', SEC).update(body).digest('base64url');

const MYSQL = `mysql -N -u review_app -p'Kton01DYIWsS6kuQRGt4YYTJ' economic_review -e`;
function sql(q) { return execSync(`${MYSQL} "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }); }

function req(method, path, payload, opts) {
  return new Promise((res, rej) => {
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const headers = Object.assign({}, opts && opts.headers);
    if (!opts || opts.auth !== false) headers.Authorization = 'Bearer ' + TOKEN;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port: 3000, path, method, headers }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) { j = d; } res({ code: resp.statusCode, body: j }); });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
function upload(path, filePath, fields) {
  return new Promise((res, rej) => {
    const boundary = '----b' + Date.now();
    let pre = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="s.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n');
    let tail = Buffer.from('\r\n');
    for (const k in fields) tail = Buffer.concat([tail, Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n')]);
    tail = Buffer.concat([tail, Buffer.from('--' + boundary + '--\r\n')]);
    const payload = Buffer.concat([pre, fs.readFileSync(filePath), tail]);
    const r = http.request({ host: '127.0.0.1', port: 3000, path, method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length } }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) { j = d; } res({ code: resp.statusCode, body: j }); });
    });
    r.on('error', rej); r.write(payload); r.end();
  });
}
function buildXlsx(rows) {
  const head = ['序号', '项目编号', '项目名称', '项目承建部门', '项目类型', '合同额（元）', '内部信息系统填报预估成本（元）', '限制分包', '专业分包范围'];
  const data = [['2026年测试批'], head, ...rows.map((r, i) => [i + 1, ...r])];
  const ws = XLSX.utils.aoa_to_sheet(data), wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '汇总表');
  const p = '/tmp/inv_' + Date.now() + '.xlsx'; XLSX.writeFile(wb, p); return p;
}

let pass = 0, fail = 0;
function check(name, ok, extra) { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra && !ok ? '  → ' + extra : '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 清理所有测试批次痕迹（含失败运行留下的）
function cleanupTest() {
  const sids = sql(`SELECT id FROM reviewSessions WHERE name='__INVITE_TEST__';`).trim().split('\n').filter(Boolean);
  if (!sids.length) return 'no-temp-session';
  const S = sids.join(',');
  const pids = sql(`SELECT id FROM projects WHERE session_id IN (${S});`).trim().split('\n').filter(Boolean).join(',') || '0';
  ['workflowLogs', 'confirmations', 'expertEstimates', 'workItems', 'procurementItems', 'travelItems']
    .forEach(t => sql(`DELETE FROM ${t} WHERE project_id IN (${pids});`));
  sql(`DELETE FROM files WHERE project_id IN (${pids}) OR JSON_EXTRACT(extra,'$.import_session_id') IN (${S});`);
  sql(`DELETE FROM expertInvites WHERE session_id IN (${S});`);
  sql(`DELETE FROM sessionAssignments WHERE session_id IN (${S});`);
  sql(`DELETE FROM projects WHERE session_id IN (${S});`);
  sql(`DELETE FROM reviewSessions WHERE id IN (${S});`);
  sql(`DELETE FROM users WHERE real_name='外部测试专家' OR username LIKE 'ext_%';`);
  return 'cleaned sessions ' + S;
}

(async () => {
  console.log('前置清理：' + cleanupTest());
  // 0) 云文档状态接口（配置与否都算正常，只看形状是否可用）
  let r = await req('GET', '/api/kdocs/status');
  check('云文档状态接口可用（configured 为布尔且未配置时给出缺失项）',
    r.code === 200 && typeof r.body.configured === 'boolean'
      && (r.body.configured === true || (Array.isArray(r.body.missing) && r.body.missing.length > 0)),
    JSON.stringify(r.body).slice(0, 160));

  // 1) 建临时批次 + 1 个项目
  const f = buildXlsx([['P-INV-1', '端到端测试项目', '测试事业部', '数字化类项目', 100000, '20000', '否', '测试']]);
  r = await upload('/api/sessions/import-summary', f, { mode: 'create', session_name: '__INVITE_TEST__' });
  const sid = r.body && r.body.session_id;
  let pid = 0;
  for (let i = 0; i < 8 && !pid; i++) { await sleep(600); pid = parseInt(sql(`SELECT id FROM projects WHERE session_id=${sid} LIMIT 1;`).trim(), 10) || 0; }
  check('临时批次与项目已创建', r.code === 200 && !!sid && !!pid, JSON.stringify(r.body) + ' pid=' + pid);

  // 2) 直接落两条工作项（外包 + 分包），重启让内存重载
  sql(`INSERT INTO workItems (project_id,category,work_task,work_item,person_days,cost,unit_price,extra) VALUES (${pid},'outsourcing','任务A','外包工作项A',2,4000,2000,'{"description":"外包说明A","person":"张三"}'),(${pid},'subcontract','任务B','分包工作项B',3,6000,2000,'{"description":"分包说明B","person":"李四"}');`);
  execSync('pm2 restart jingjipingshen > /dev/null 2>&1');
  for (let i = 0; i < 20; i++) { await sleep(1000); try { const h = await req('GET', '/api/kdocs/status'); if (h.code === 200) break; } catch (_) {} }
  let wiIds = [];
  for (let i = 0; i < 5 && wiIds.length !== 2; i++) {
    try { r = await req('GET', `/api/projects/${pid}/cost`); wiIds = (r.body.work_items || []).map(w => w.id); } catch (_) { }
    if (wiIds.length !== 2) await sleep(1000);
  }
  check('工作项已就绪（2 条）', wiIds.length === 2, 'work_items=' + wiIds.length);

  // 3) 生成外部专家定向链接（现返回短链，长链留作兜底）
  r = await req('POST', `/api/sessions/${sid}/expert-invites`, { days: 30, experts: [{ real_name: '外部测试专家', contact: '13800000000' }] });
  const inv = (r.body.invites || [])[0] || {};
  const shortLink = inv.link || '', longLink = inv.long_link || '';
  const code = (shortLink.match(/\/e\/([A-Za-z0-9_-]+)/) || [])[1] || '';
  const tk = longLink.split('k=')[1] || '';
  check('生成短链（形如 /e/<code>，地址里不含令牌）',
    r.code === 200 && !!code && !/\?k=/.test(shortLink), shortLink);
  check('同时返回长链兜底（含令牌，兼容旧链接）', tk.length > 30, longLink.slice(0, 48));
  check('默认有效期 30 天', r.body.days === 30 && !!inv.expires_at, JSON.stringify(inv));

  const Public = (p, payload) => req(p.startsWith('POST') ? 'POST' : 'GET', p.replace(/^POST /, ''), payload, { auth: false });
  // 4) 免登录拉取批次信息
  r = await Public('/api/expert-invite/' + tk);
  check('免登录可读取（无需 JWT）', r.code === 200 && r.body.expert_name === '外部测试专家', JSON.stringify(r.body).slice(0, 160));
  check('专家只看到自己范围内的项目（1 个）', (r.body.projects || []).length === 1, JSON.stringify(r.body.projects));

  // 5) 明细：不应包含其他专家填值
  r = await Public(`/api/expert-invite/${tk}/projects/${pid}`);
  const items = r.body.items || [];
  check('明细只含外包/分包两类（2 项）', items.length === 2 && items.every(i => ['outsourcing', 'subcontract'].indexOf(i.category) >= 0), JSON.stringify(items.map(i => i.category)));
  check('明细不含其他专家数据字段', items.length > 0 && !('expert_days_list' in items[0]) && !('expert_days_avg' in items[0]), Object.keys(items[0] || {}).join(','));
  check('未提交时 my_days 为空', items.every(i => i.my_days === null));

  // 5b) 短链落地页与短链接口
  r = await Public('/e/' + code);
  check('短链落地页直接返回评估页（200，不跳转）',
    r.code === 200 && typeof r.body === 'string' && /专家工作量评估/.test(r.body) && /\/api\/e\//.test(r.body),
    String(r.body).slice(0, 80));
  r = await Public('/api/e/' + code);
  check('短链接口免登录可读取', r.code === 200 && r.body.expert_name === '外部测试专家', JSON.stringify(r.body).slice(0, 120));
  check('短链接口不泄漏长令牌', !JSON.stringify(r.body).includes(tk.replace(/^(.{8}).*/, '$1')));
  r = await Public(`/api/e/${code}/projects/${pid}`);
  check('短链项目明细可用（2 项）', r.code === 200 && (r.body.items || []).length === 2, 'code=' + r.code);
  r = await Public('/api/e/zzzznotexist');
  check('不存在的短码被拒（410）', r.code === 410, 'code=' + r.code);
  r = await Public('/e/ok');
  check('非法短码不吐页面（404）', r.code === 404, 'code=' + r.code);

  // 6) 提交评估
  r = await Public('POST /api/expert-invite/' + tk + '/estimates', { project_id: pid, items: [{ work_item_id: wiIds[0], days: 3.5 }, { work_item_id: wiIds[1], days: 1.5 }] });
  check('提交 2 项评估成功', r.code === 200 && r.body.saved === 2, JSON.stringify(r.body));

  // 6b) 短链提交同样可用（幂等：同值覆盖）
  r = await Public('POST /api/e/' + code + '/estimates', { project_id: pid, items: [{ work_item_id: wiIds[0], days: 3.5 }] });
  check('短链提交评估可用', r.code === 200 && r.body.saved === 1, JSON.stringify(r.body));

  // 7) 重新读取，应显示自己的人天
  r = await Public(`/api/expert-invite/${tk}/projects/${pid}`);
  check('回读可见自己的填报值', (r.body.items || []).every(i => i.my_days != null), JSON.stringify((r.body.items || []).map(i => i.my_days)));
  check('项目状态标记为已提交', r.body.project && r.body.project.submitted === true, JSON.stringify(r.body.project));

  // 8) 落库校验：expertEstimates 与 workItems 汇总（save() 异步刷库，稍等再查）
  await sleep(2000);
  const estRows = sql(`SELECT COUNT(*) FROM expertEstimates WHERE project_id=${pid};`).trim();
  check('评估已写入 expertEstimates（2 行）', estRows === '2', 'rows=' + estRows);
  const rollup = sql(`SELECT expert_days_avg, adjusted_cost FROM workItems WHERE project_id=${pid} AND category='outsourcing';`).trim().split(/\s+/);
  check('工作项 5 人汇总已刷新（均值 3.5 × 单价 2000）', rollup[0] === '3.5' && rollup[1] === '7000', rollup.join('/'));

  // 9) 汇总页联动
  r = await req('GET', `/api/sessions/${sid}/workload-summary`);
  const pj = (r.body.projects || [])[0] || {};
  check('工作量评估汇总页已联动（含 1 位评估人）', r.code === 200 && (r.body.evaluators || []).length === 1, JSON.stringify(r.body.evaluators));
  check('该项目在汇总里体现评估结果', !!pj.project_id, JSON.stringify(pj).slice(0, 120));

  // 10) 负向：越界项目 / 非法人天 / 撤销后访问 / 伪造令牌
  r = await Public('POST /api/expert-invite/' + tk + '/estimates', { project_id: 999999, items: [{ work_item_id: wiIds[0], days: 1 }] });
  check('越界项目被拒（403）', r.code === 403, 'code=' + r.code);
  r = await Public('POST /api/expert-invite/' + tk + '/estimates', { project_id: pid, items: [{ work_item_id: wiIds[0], days: -5 }] });
  check('非法人天被拒（400）', r.code === 400, 'code=' + r.code + ' ' + JSON.stringify(r.body));
  r = await Public('/api/expert-invite/' + 'x'.repeat(43));
  check('伪造令牌被拒（410）', r.code === 410, 'code=' + r.code);
  r = await req('POST', `/api/expert-invites/${inv.invite_id}/revoke`, {});
  check('撤销接口可用', r.code === 200 && r.body.state === 'revoked', JSON.stringify(r.body));
  r = await Public('/api/expert-invite/' + tk);
  check('撤销后链接失效（410）', r.code === 410 && /撤销/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await Public('/api/e/' + code);
  check('撤销后短链同时失效（410）', r.code === 410 && /撤销/.test(r.body.error || ''), JSON.stringify(r.body));

  console.log('\n结果：PASS=' + pass + ' FAIL=' + fail);
  await sleep(1200);
  console.log('收尾清理：' + cleanupTest());
  execSync('pm2 restart jingjipingshen > /dev/null 2>&1; sleep 2');
  fs.unlinkSync(f);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(2); });
