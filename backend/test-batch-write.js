// 验证 writeCollection 批量分块与逐行 REPLACE 语义完全等价
// 原理：mock 一个 pool，把每条 REPLACE 按 MySQL 语义（按主键替换）应用到内存表；
//       「批量分块」与「逐行」两种实现各自跑一遍同样的行，最终表内容必须逐字段一致。
// 这是对持久化层的改动，任何不等价都会直接导致数据错乱，必须先过这一关再部署。
const path = require('path');
const DB = require(path.join(__dirname, 'src', 'db.mysql.js'));

const def = DB.SCHEMA.workflowLogs; // 行数最多的表，最能暴露分块边界问题
const cols = [...def.cols, 'extra'];

function makePool() {
  const table = new Map();
  const self = {
    queries: 0, rowsPerQuery: [],
    async query(sql, vals) {
      self.queries++;
      const s = String(sql).trim();
      const m = s.match(/^REPLACE INTO `(\w+)` \(([^)]+)\) VALUES (.+)$/i);
      if (m) {
        const colArr = m[2].split(',').map(c => c.replace(/[` ]/g, ''));
        const groups = [];
        let depth = 0, cur = '';
        for (const ch of m[3]) {
          if (ch === '(') { depth++; if (depth === 1) { cur = ''; continue; } }
          else if (ch === ')') { depth--; if (depth === 0) { groups.push(cur); continue; } }
          if (depth > 0) cur += ch;
        }
        self.rowsPerQuery.push(groups.length);
        let vi = 0;
        for (const g of groups) {
          const n = g.split(',').length;
          const rowVals = vals.slice(vi, vi + n); vi += n;
          const row = {};
          colArr.forEach((c, i) => row[c] = rowVals[i]);
          table.set(row.id, row); // REPLACE：按主键覆盖
        }
        return [{}];
      }
      if (/^DELETE FROM `(\w+)` WHERE id NOT IN \(\?\)$/i.test(s)) {
        const keep = new Set(vals[0]);
        for (const k of [...table.keys()]) if (!keep.has(k)) table.delete(k);
        return [{}];
      }
      if (/^DELETE FROM/i.test(s)) { table.clear(); return [{}]; }
      throw new Error('未实现的 SQL: ' + s.slice(0, 100));
    },
    snapshot() { return JSON.stringify([...table.values()].sort((a, b) => a.id - b.id)); }
  };
  return self;
}

function makeRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: i, project_id: 1000 + (i % 13), action: i % 2 ? 'submit_estimate' : 'upload',
      detail: '日志明细'.repeat(i % 8) + i, operator_id: (i % 5) + 1,
      operator_name: '操作人' + (i % 5), created_at: '2026-09-21T10:00:' + String(i % 60).padStart(2, '0'),
      // extra 列：除 cols 外的字段由 extraOf 序列化进 extra
      _wild: '自由字段' + i, _n: i * 7
    });
  }
  return rows;
}

let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  -> ' + extra));
  if (!ok) fail++;
};

(async () => {
  // 1) 批量实现（当前代码）
  const pBatch = makePool();
  const rows = makeRows(1234);
  await DB.writeCollection(pBatch, 'workflowLogs', rows);
  const snapBatch = pBatch.snapshot();
  check('批量实现写入了全部 1234 行', pBatch.queries >= 1 && JSON.parse(snapBatch).length === 1234,
    'queries=' + pBatch.queries + ' rows=' + JSON.parse(snapBatch).length);
  check('分块大小生效（每批 ≤500 行）', Math.max(...pBatch.rowsPerQuery) <= 500, 'max=' + Math.max(...pBatch.rowsPerQuery));
  check('分块覆盖完整（每批行数之和 = 1234）', pBatch.rowsPerQuery.reduce((a, b) => a + b, 0) === 1234,
    'sum=' + pBatch.rowsPerQuery.reduce((a, b) => a + b, 0));

  // 2) 逐行参照（等价语义）：逐行 REPLACE，最后做一次全量孤儿删除，
  //    与 writeCollection(全部行) 的最终状态必须一致
  const pRow = makePool();
  const allIds = rows.map(r => r.id);
  for (const r of rows) await pRow.query(
    `REPLACE INTO \`${def.table}\` (${cols.map(c => '`' + c + '`').join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    [...def.cols.map(c => DB.toVal(c, def, r)), DB.extraOf(def, r)]);
  await pRow.query(`DELETE FROM \`${def.table}\` WHERE id NOT IN (?)`, [allIds]);
  const snapRow = pRow.snapshot();
  check('批量与逐行最终表内容完全一致（1234 行全量比对）', snapBatch === snapRow,
    snapBatch.length === snapRow.length ? '长度相同但内容有差异' : 'len ' + snapBatch.length + ' vs ' + snapRow.length);

  // 3) 重复 id 覆盖（REPLACE 语义）
  const pDup = makePool();
  await DB.writeCollection(pDup, 'workflowLogs', [{ id: 5, project_id: 1, action: 'a', detail: '旧', operator_id: 1, operator_name: 'x', created_at: 't' }]);
  await DB.writeCollection(pDup, 'workflowLogs', [{ id: 5, project_id: 2, action: 'b', detail: '新', operator_id: 2, operator_name: 'y', created_at: 't2' }]);
  const dup = JSON.parse(pDup.snapshot());
  check('同 id 二次写入是覆盖而非追加', dup.length === 1 && dup[0].project_id === 2 && dup[0].action === 'b', JSON.stringify(dup));

  // 4) 孤儿删除
  const pOrp = makePool();
  await DB.writeCollection(pOrp, 'workflowLogs', makeRows(10));
  await DB.writeCollection(pOrp, 'workflowLogs', makeRows(5)); // 只剩 id 1..5
  const orp = JSON.parse(pOrp.snapshot());
  check('孤儿行被清理（10 → 5）', orp.length === 5, 'len=' + orp.length);

  // 5) 空集合（全表删除）
  const pEmpty = makePool();
  await DB.writeCollection(pEmpty, 'workflowLogs', makeRows(3));
  await DB.writeCollection(pEmpty, 'workflowLogs', []);
  check('空集合清空整表', JSON.parse(pEmpty.snapshot()).length === 0, pEmpty.snapshot());

  // 6) 边界：恰好 500 行 / 501 行
  for (const n of [499, 500, 501]) {
    const p = makePool();
    await DB.writeCollection(p, 'workflowLogs', makeRows(n));
    const got = JSON.parse(p.snapshot()).length;
    check('边界行数 ' + n + ' 全量落库', got === n, 'got=' + got);
  }

  console.log('\n结果：PASS=' + (12 - fail) + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(2); });
