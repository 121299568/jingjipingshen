// 解析文件内容，按其中的项目编号/名称判断应挂接哪个项目。
// 当前可解析：xlsx/xls（抽取全部单元格文本）。pdf/doc/docx 等无第三方库时不自动解析，
// 交由调用方的「同文件夹归并」逻辑兜底（同文件夹内只要有文件解析出项目，其余文件一并挂接）。
const path = require('path');

function normStr(s) {
  return (s == null ? '' : String(s)).replace(/\s+/g, '').toLowerCase();
}

// 从 xlsx 抽取全部单元格文本，拼成一段用于检索的字符串
function extractXlsxText(filePath) {
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(filePath);
    const parts = [];
    for (const sn of wb.SheetNames) {
      const ws = wb.Sheets[sn];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        for (const c of row) {
          if (c == null) continue;
          if (typeof c === 'string') { if (c.trim()) parts.push(c); }
          else parts.push(String(c));
        }
      }
    }
    return parts.join('\n');
  } catch (e) {
    return '';
  }
}

// projects: 当前批次下的项目数组（含 project_code / project_name / id）
// 返回 { project, by } 或 null
function resolveProjectByContent(filePath, projects) {
  const ext = (path.extname(filePath) || '').toLowerCase();
  let text = '';
  if (ext === '.xlsx' || ext === '.xls') text = extractXlsxText(filePath);
  if (!text) return null;
  const nt = normStr(text);
  let best = null, bestScore = 0, bestBy = '';
  for (const p of projects) {
    const code = p.project_code, name = p.project_name;
    if (code && nt.includes(normStr(code))) {
      const score = normStr(code).length * 3; // 编号精确匹配权重最高
      if (score > bestScore) { best = p; bestScore = score; bestBy = 'content-code'; }
    }
    if (name) {
      const nn = normStr(name);
      if (nt.includes(nn)) {
        const score = nn.length * 2; // 全称精确匹配次之
        if (score > bestScore) { best = p; bestScore = score; bestBy = 'content-name'; }
      } else if (nn.length >= 8) {
        // 部分匹配：在名称中取 6~12 连续字符，看是否出现在文件内容中，取最长命中
        let foundLen = 0;
        for (let L = Math.min(12, nn.length); L >= 6; L--) {
          let ok = false;
          for (let s = 0; s + L <= nn.length; s++) {
            if (nt.includes(nn.substr(s, L))) { ok = true; break; }
          }
          if (ok) { foundLen = L; break; }
        }
        if (foundLen >= 6) {
          const score = foundLen; // 部分匹配权重最低，仅在前两者都未命中时启用
          if (score > bestScore) { best = p; bestScore = score; bestBy = 'content-name-partial'; }
        }
      }
    }
  }
  return best ? { project: best, by: bestBy } : null;
}

module.exports = { normStr, extractXlsxText, resolveProjectByContent };
