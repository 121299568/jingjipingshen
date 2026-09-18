// 解析文件内容，按其中的项目编号/名称判断应挂接哪个项目。
// 按扩展名自动选择解析器：
//   .xlsx/.xls -> 抽取全部单元格文本（xlsx）
//   .pdf       -> 抽取文本（pdf-parse）
//   .docx      -> 抽取文本（mammoth，仅支持 OOXML 的 .docx，旧版 .doc 不支持）
// 解析不出来的文件（如 .doc、图片、无文本的 pdf）返回空文本，
// 交由调用方的「同文件夹归并」逻辑兜底（同文件夹内只要有文件解析出项目，其余一并挂接）。
const path = require('path');

function normStr(s) {
  return (s == null ? '' : String(s)).replace(/\s+/g, '').toLowerCase();
}

// 通用词表：仅由这些词拼成的名称片段不具备区分度。
// 例如「有限责任公司」「研究项目」几乎出现在所有项目名/企业文件里，
// 用它们做部分匹配会把 A 项目的估算表错配到 B 项目。
const GENERIC_TOKENS = [
  '有限责任公司', '股份有限公司', '有限公司', '集团公司', '公司',
  '项目', '工程', '研究', '开发', '建设', '改造', '扩建',
  '服务', '技术', '管理', '咨询', '评估', '评审',
  '框架', '系统', '平台', '应用', '示范', '产业化'
];

// 片段去掉通用词后的剩余长度（即"区分度"字符数）
function distinctLen(fragment) {
  let s = fragment;
  for (const t of GENERIC_TOKENS) s = s.split(t).join('');
  return s.length;
}

// 从 xlsx 抽取全部单元格文本，拼成一段用于检索的字符串（同步）
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

// 从 PDF 抽取文本（pdf-parse，异步）
async function extractPdfText(filePath) {
  try {
    const fs = require('fs');
    const pdfParse = require('pdf-parse');
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return (data && data.text) ? data.text : '';
  } catch (e) {
    return '';
  }
}

// 从 docx 抽取纯文本（mammoth，异步；仅 .docx 有效，.doc 会失败返回空）
async function extractDocxText(filePath) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return (result && result.value) ? result.value : '';
  } catch (e) {
    return '';
  }
}

// 依据扩展名选择解析器，返回文件全文文本
async function extractText(filePath) {
  const ext = (path.extname(filePath) || '').toLowerCase();
  try {
    if (ext === '.xlsx' || ext === '.xls') return extractXlsxText(filePath);
    if (ext === '.pdf') return await extractPdfText(filePath);
    if (ext === '.docx') return await extractDocxText(filePath);
  } catch (e) {
    return '';
  }
  return '';
}

// projects: 当前批次下的项目数组（含 project_code / project_name / id）
// 返回 { project, by } 或 null（异步）
async function resolveProjectByContent(filePath, projects) {
  let text = '';
  try { text = await extractText(filePath); } catch (e) { text = ''; }
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
        // 部分匹配：在名称中取 6~12 连续字符，看是否出现在文件内容中，取最长命中。
        // 命中片段必须有"区分度"：去掉通用词（有限责任公司/项目/研究/框架…）后仍剩 ≥4 个字，
        // 否则跳过（防止「有限责任公司」这类通用片段把文件错配到别的项目）。
        let foundLen = 0;
        for (let L = Math.min(12, nn.length); L >= 6; L--) {
          let ok = false;
          for (let s = 0; s + L <= nn.length; s++) {
            const frag = nn.substr(s, L);
            if (nt.includes(frag) && distinctLen(frag) >= 4) { ok = true; break; }
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

module.exports = { normStr, extractXlsxText, extractPdfText, extractDocxText, extractText, resolveProjectByContent };
