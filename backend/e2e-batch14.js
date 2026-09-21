// 第十四批全流程端到端测试：分派专家 → 生成邀请短链 → 专家打分 → 校验汇总口径
// 打分策略：每位专家一律按「原人天 × 0.9」提交，因此期望值可手算：
//   被评估工作项 调整后费用 = 0.9 × 原费用
//   项目 评估后成本 = 原总成本 − 0.1 ×(外包+分包工作项原费用合计)
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const TOKEN = process.argv[2] || '';
const SID = 8;
const FACTOR = 0.9;

let pass = 0, fail = 0;
const ck = (n, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (!ok && extra !== undefined ? '  → ' + extra : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, method, body, auth) {
  const h = { 'Content-Type': 'application/json' };
  if (auth) h.Authorization = 'Bearer ' + auth;
  const r = await fetch(BASE + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
  let d = {}; try { d = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error((method || 'GET') + ' ' + path + ' → ' + r.status + ' ' + (d.error || ''));
  return d;
}

(async () => {
  // ---------- 1. 分派评审人员 ----------
  const asg = await api('/api/sessions/' + SID + '/assign', 'POST', { expert_ids: [10], accountant_ids: [6] }, TOKEN);
  ck('1 分派评审人员（专家#10 + 会计师#6）', (asg.assignments || []).length === 2, JSON.stringify(asg).slice(0, 120));

  // ---------- 2. 生成邀请短链 ----------
  const inv = await api('/api/sessions/' + SID + '/expert-invites', 'POST',
    { experts: [{ user_id: 10 }, { user_id: 6 }], days: 30, perm: 'estimate' }, TOKEN);
  const invList = Array.isArray(inv) ? inv : (inv.results || inv.invites || []);
  ck('2 生成 2 条专家邀请短链', invList.length === 2, JSON.stringify(inv).slice(0, 200));
  const codes = invList.map(x => x.short_code || (x.invite && x.invite.short_code)).filter(Boolean);
  ck('2 每条邀请都带 6 位短码', codes.length === 2 && codes.every(c => /^[23456789abcdefghjkmnpqrstuvwxyz]{4,16}$/.test(c)), codes.join(','));

  // ---------- 3. 专家打分 ----------
  let submittedItems = 0, submittedProjects = 0;
  for (const code of codes) {
    const info = await api('/api/e/' + code);
    const need = (info.projects || []).filter(p => p.needs_estimate);
    console.log('   专家短链 ' + code + '：可见项目 ' + (info.projects || []).length + ' 个，需评估 ' + need.length + ' 个');
    for (const p of need) {
      const det = await api('/api/e/' + code + '/projects/' + p.id);
      const items = (det.items || []).map(w => ({
        work_item_id: w.id,
        days: Math.round((Number(w.person_days) || 0) * FACTOR * 100) / 100
      })).filter(x => x.days > 0);
      if (!items.length) continue;
      const r = await api('/api/e/' + code + '/estimates', 'POST', { project_id: p.id, items });
      submittedItems += (r.saved || items.length);
      submittedProjects++;
    }
  }
  ck('3 专家打分提交成功（覆盖多个项目）', submittedProjects > 0 && submittedItems > 0, '项目' + submittedProjects + ' 项' + submittedItems);
  await sleep(1500); // 等待异步落库

  // ---------- 4. 校验汇总口径 ----------
  const sum = await api('/api/sessions/' + SID + '/workload-summary', 'GET', null, TOKEN);
  const ps = sum.projects || [];
  ck('4 汇总接口返回全部项目', ps.length > 0, ps.length);
  ck('4 批次级带评估后成本与核减', typeof sum.batch_total_adjusted_cost === 'number' && typeof sum.batch_expert_reduction === 'number',
    'adjusted=' + sum.batch_total_adjusted_cost + ' reduction=' + sum.batch_expert_reduction);

  let checked = 0, bad = [];
  for (const p of ps) {
    if (!(p.evaluated_count > 0)) continue;
    const d = await api('/api/projects/' + p.project_id + '/expert-scores', 'GET', null, TOKEN);
    const wis = d.work_items || [];
    // 被评估项（有专家人天）的期望：0.9 × 原费用；未评估项保持原费用
    let expectAdj = 0;
    wis.forEach(w => {
      const evaluated = (w.expert_count || 0) > 0;
      expectAdj += evaluated ? (Number(w.cost) || 0) * FACTOR : (Number(w.cost) || 0);
    });
    expectAdj = Math.round(expectAdj * 100) / 100;
    const stAdj = Math.round((d.stats.total_adjusted_cost || 0) * 100) / 100;
    // 逐项 adjusted = 平均人天 ×(cost/person_days) 是浮点连乘，261 项累加会有几分钱误差，
    // 因此按相对误差判定（<0.001%），不按绝对 1 元判定
    const tol = Math.max(0.05, Math.abs(expectAdj) * 1e-5);
    if (Math.abs(expectAdj - stAdj) > tol) bad.push({ id: p.project_id, expect: expectAdj, got: stAdj, diff: Math.round((expectAdj - stAdj) * 100) / 100 });
    // 项目级：评估后总成本 = 原总成本 −(工作项原合计) +(工作项评估后合计)
    const origWI = Math.round(wis.reduce((s, w) => s + (Number(w.cost) || 0), 0) * 100) / 100;
    const expectTotal = Math.round(((p.total_cost || 0) - origWI + expectAdj) * 100) / 100;
    if (Math.abs(expectTotal - (p.adjusted_total_cost || 0)) > Math.max(0.05, Math.abs(expectTotal) * 1e-5)) bad.push({ id: p.project_id, name: '项目级', expect: expectTotal, got: p.adjusted_total_cost });
    checked++;
    if (checked <= 3) {
      console.log('   项目#' + p.project_id + ' 原总成本=' + p.total_cost + ' → 评估后=' + p.adjusted_total_cost + ' 核减=' + p.expert_reduction + '（进度 ' + p.evaluated_count + '/' + p.work_item_count + '）');
    }
  }
  ck('4 每个已评估项目的「评估后成本/核减」与手算一致', bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  ck('4 至少校验了若干个已评估项目', checked > 0, checked);

  // ---------- 5. 打分明细可读性 ----------
  const sample = ps.find(p => p.evaluated_count > 0);
  if (sample) {
    const d = await api('/api/projects/' + sample.project_id + '/expert-scores', 'GET', null, TOKEN);
    const evs = d.evaluators || [];
    ck('5 打分明细返回评审人列表', evs.length > 0, evs.length);
    ck('5 每个工作项都带回各专家人天数组', (d.work_items || []).every(w => Array.isArray(w.expert_days) && w.expert_days.length === evs.length));
    ck('5 明细带统计（原成本/评估后/核减）', d.stats && typeof d.stats.reduction === 'number', JSON.stringify(d.stats));
    const w0 = (d.work_items || []).find(w => (w.expert_count || 0) > 0);
    ck('5 已打分项的平均人天 = 原人天 × 0.9', w0 && Math.abs(w0.expert_days_avg - (w0.person_days * FACTOR)) < 0.02,
      w0 ? (w0.expert_days_avg + ' vs ' + (w0.person_days * FACTOR)) : 'none');
    // 未评估项保持原成本
    const un = (d.work_items || []).filter(w => !(w.expert_count > 0));
    ck('5 未评估项保持原成本（不被算成核减）', un.every(w => Math.abs((w.adjusted_cost || 0) - (w.cost || 0)) < 0.02),
      un.length + ' 项');
  }

  console.log('\n结果：PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
