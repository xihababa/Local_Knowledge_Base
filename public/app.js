const state = {
  entries: [],
  qas: [],
  articles: [],
  categories: [],
  view: "dashboard",
  importType: "mixed",
  query: "",
  knowledgeTag: "",
  qaTag: "",
  qaQuery: "",
  qaMode: "exam",
  qaDetailId: "",
  qaAnswerVisible: false,
  collapsedQaGroups: new Set(),
  articleTag: "",
  articleQuery: "",
  articleDetailId: "",
  collapsedArticleGroups: new Set()
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function qaCreatedTime(qa) {
  const time = Date.parse(qa?.createdAt || "");
  return Number.isNaN(time) ? 0 : time;
}

function sortQasByCreatedAt(qas) {
  return [...(qas || [])]
    .map((qa, index) => ({ qa, index }))
    .sort((left, right) => {
      const timeDiff = qaCreatedTime(left.qa) - qaCreatedTime(right.qa);
      if (timeDiff !== 0) return timeDiff;
      return left.index - right.index;
    })
    .map(item => item.qa);
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:()[\]{}'"`~@#$%^&*_+=|\\/<>\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function searchTokens(value) {
  const normalized = normalizeSearchText(value);
  const latin = normalized.match(/[a-z0-9_]{2,}/g) || [];
  const chinese = (normalized.match(/[\u4e00-\u9fa5]/g) || []).join("");
  const grams = [];
  for (let index = 0; index < chinese.length - 1; index += 1) {
    grams.push(chinese.slice(index, index + 2));
  }
  return Array.from(new Set([...latin, ...grams].filter(token => token.length >= 2)));
}

function expandSearchQuery(query) {
  const aliases = [
    ["流程", "过程 步骤 执行流程 运行流程"],
    ["过程", "流程 步骤"],
    ["运行", "执行"],
    ["执行", "运行"],
    ["场景", "适用 使用场景 用途"],
    ["适合", "适用 使用场景"],
    ["区别", "不同 差异 对比"],
    ["解决", "处理 方案"],
    ["优化", "调优 性能"],
    ["架构", "组成 结构"],
    ["容错", "恢复 血统 lineage checkpoint"],
    ["血统", "lineage 容错"],
    ["宽依赖", "shuffle 阶段 stage"],
    ["窄依赖", "无shuffle"],
    ["倾斜", "热点key 长尾 skew"],
    ["广播", "broadcast 小表 mapjoin"],
    ["缓存", "cache persist 持久化"],
    ["分区", "partition 并行度"],
  ];
  const expanded = [query];
  const compact = compactSearchText(query);
  aliases.forEach(([keyword, words]) => {
    if (compact.includes(compactSearchText(keyword))) {
      expanded.push(words);
    }
  });
  return expanded.join(" ");
}

function qaSearchScore(qa, query) {
  if (!query) return 1;
  const expandedQuery = expandSearchQuery(query);
  const queryCompact = compactSearchText(query);
  const question = qa.question || "";
  const answer = qa.answer || "";
  const tags = (qa.tags || []).join(" ");
  const questionCompact = compactSearchText(question);
  const tagCompact = compactSearchText(tags);
  if (!queryCompact) return 1;
  if (questionCompact.includes(queryCompact)) return 200;
  if (tagCompact.includes(queryCompact)) return 120;

  const queryTokens = searchTokens(expandedQuery);
  if (!queryTokens.length) return 0;
  const questionTokens = new Set(searchTokens(question));
  const answerTokens = new Set(searchTokens(answer));
  const tagTokens = new Set(searchTokens(tags));
  let score = 0;
  let strongMatched = 0;
  let answerMatched = 0;
  queryTokens.forEach(token => {
    if (questionTokens.has(token)) {
      score += 12;
      strongMatched += 1;
    } else if (tagTokens.has(token)) {
      score += 6;
      strongMatched += 1;
    } else if (answerTokens.has(token)) {
      score += 1;
      answerMatched += 1;
    }
  });
  if (!strongMatched) return 0;
  const strongCoverage = strongMatched / queryTokens.length;
  return score + strongCoverage * 35 + Math.min(answerMatched, 3);
}

function applySidebarState(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const button = $("#sidebarToggle");
  if (!button) return;
  button.setAttribute("aria-label", collapsed ? "展开侧边栏" : "收起侧边栏");
  button.setAttribute("title", collapsed ? "展开侧边栏" : "收起侧边栏");
}

function initSidebarState() {
  const collapsed = localStorage.getItem("kbSidebarCollapsed") === "1";
  applySidebarState(collapsed);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function questionPreview(question) {
  const firstLine = String(question || "").split(/\n+/)[0].trim();
  const optionIndex = firstLine.search(/\s+1[.、）)]\s*/);
  if (optionIndex > 12) {
    return firstLine.slice(0, optionIndex).trim();
  }
  return firstLine;
}

function formatQuestion(question) {
  const text = String(question || "").trim().replace(/\r\n/g, "\n");
  const sqlStart = findEmbeddedSqlStart(text);
  if (sqlStart > 0) {
    const prompt = text.slice(0, sqlStart).trim();
    const sql = text.slice(sqlStart).trim();
    return `
      <div class="qa-question-text">${formatInlineRichText(prompt)}</div>
      <pre class="qa-code"><code>${escapeHtml(formatQuestionSql(sql))}</code></pre>
    `;
  }
  const normalized = text
    .replace(/\s+(?=\d+[.、）)]\s*)/g, "\n")
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);
  const preview = questionPreview(text);
  const options = normalized.filter(line => /^\d+[.、）)]\s*/.test(line));
  if (!options.length) {
    return `<div class="qa-question-text">${formatInlineRichText(text)}</div>`;
  }
  return `
    <div class="qa-question-prompt">${escapeHtml(preview)}</div>
    <div class="qa-question-options">
      ${options.map(option => `<div class="qa-question-option">${escapeHtml(option)}</div>`).join("")}
    </div>
  `;
}

function formatQuestionSql(sql) {
  const normalized = String(sql || "").replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");
  const meaningfulLines = lines.filter(line => line.trim());
  if (meaningfulLines.length >= 3) {
    return lines.map(line => line.replace(/\s+$/g, "")).join("\n").trim();
  }
  return formatSql(normalized);
}

function splitTags(value) {
  return String(value || "")
    .split(/[,，]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function cleanOcrText(rawText) {
  const lines = String(rawText || "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .split("\n")
    .map(line => line.replace(/[ \t]+/g, " ").trim());
  const result = [];
  const isBlank = line => !line;
  const isList = line => /^([-*•]|(\d+|[A-Za-z])[.、）)]|[一二三四五六七八九十]+[.、）)])\s*/.test(line);
  const isSql = line => /^(select|from|where|join|left|right|inner|group|order|having|with|insert|create|case|when|and|or)\b/i.test(line);
  const endsSentence = line => /[。！？；;：:）)\]}]$/.test(line);
  const shouldMerge = (previous, current) => {
    if (!previous || !current) return false;
    if (isList(previous) || isList(current) || isSql(previous) || isSql(current)) return false;
    if (endsSentence(previous)) return false;
    return previous.length < 90 && current.length < 90;
  };

  for (const line of lines) {
    if (isBlank(line)) {
      if (result.length && result[result.length - 1] !== "") result.push("");
      continue;
    }
    const previous = result[result.length - 1];
    if (shouldMerge(previous, line)) {
      const spacer = /[\u4e00-\u9fa5]$/.test(previous) && /^[\u4e00-\u9fa5]/.test(line) ? "" : " ";
      result[result.length - 1] = `${previous}${spacer}${line}`;
    } else {
      result.push(line);
    }
  }

  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function appendImportContent(title, text) {
  const cleaned = cleanOcrText(text);
  if (!cleaned) return false;
  const current = $("#importContent").value.trim();
  const block = title ? `【${title}】\n${cleaned}` : cleaned;
  $("#importContent").value = [current, block].filter(Boolean).join("\n\n");
  return true;
}

function openStandardTextDialog(title, text, mode = "replace") {
  const cleaned = cleanOcrText(text);
  openDialog(title, `
    <div class="form">
      <label>标准格式内容<textarea id="standardTextContent" rows="14">${escapeHtml(cleaned)}</textarea></label>
    </div>
  `, async () => {
    const edited = $("#standardTextContent").value.trim();
    if (!edited) return;
    if (mode === "append") {
      const current = $("#importContent").value.trim();
      $("#importContent").value = [current, edited].filter(Boolean).join("\n\n");
    } else {
      $("#importContent").value = edited;
    }
    $("#importStatus").textContent = "已写入标准格式内容，可继续编辑或导入";
  });
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function sourceTypeLabel(type) {
  return {
    mixed: "图文",
    text: "文字",
    image: "图片",
    link: "链接"
  }[type] || type || "图文";
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    throw new Error("请求后端失败，请确认本地服务 http://127.0.0.1:5173 正在运行，然后刷新页面重试。");
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || "请求失败");
    error.payload = data;
    throw error;
  }
  return data;
}

async function loadState() {
  const data = await api("/api/state");
  state.entries = data.entries || [];
  state.qas = sortQasByCreatedAt(data.qas);
  state.articles = data.articles || [];
  state.categories = data.categories || [];
  if (state.qaDetailId && !state.qas.some(qa => qa.id === state.qaDetailId)) {
    state.qaDetailId = "";
    state.qaAnswerVisible = false;
  }
  if (state.articleDetailId && !state.articles.some(article => article.id === state.articleDetailId)) {
    state.articleDetailId = "";
  }
  render();
}

function setView(view) {
  state.view = view;
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach(section => section.classList.remove("active"));
  $(`#${view}View`).classList.add("active");
  const titles = {
    dashboard: "总览",
    import: "导入",
    ask: "问答",
    knowledge: "知识库",
    qa: "题库",
    article: "文章库"
  };
  $("#viewTitle").textContent = titles[view] || "数仓知识库";
}

function closeQaDetail() {
  state.qaDetailId = "";
  state.qaAnswerVisible = false;
  renderQas();
}

function tagsHtml(tags = []) {
  return `<div class="tags">${tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function findEmbeddedSqlStart(text) {
  const match = String(text || "").match(/\b(?:CREATE\s+(?:EXTERNAL\s+)?TABLE|WITH\s+|SELECT\s+|INSERT\s+)/i);
  return match ? match.index : -1;
}

function isDdlLike(text) {
  return /\bCREATE\s+(?:EXTERNAL\s+)?TABLE\b/i.test(String(text || ""));
}

function isSqlLike(text) {
  const source = String(text || "").toLowerCase();
  if (isDdlLike(source)) return true;
  const keywords = ["select", " from ", " where ", " join ", " group by ", " order by ", " partition by ", " over ", "with "];
  return source.includes("select") && keywords.filter(keyword => source.includes(keyword)).length >= 2;
}

function splitSqlTopLevelList(text) {
  const items = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];
    if (quote) {
      current += char;
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(depth - 1, 0);
    if (char === "," && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function findMatchingParen(text, openIndex) {
  let depth = 0;
  let quote = "";
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function formatDdlSql(text) {
  const source = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const openIndex = source.indexOf("(");
  if (openIndex < 0) return source;
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0) return source;
  const prefix = source.slice(0, openIndex).trim();
  const body = source.slice(openIndex + 1, closeIndex).trim();
  const suffix = source.slice(closeIndex + 1).trim()
    .replace(/\s+(COMMENT|PARTITIONED BY|ROW FORMAT|FIELDS TERMINATED BY|COLLECTION ITEMS TERMINATED BY|MAP KEYS TERMINATED BY|LINES TERMINATED BY|STORED AS|LOCATION|TBLPROPERTIES|WITH SERDEPROPERTIES)\b/gi, "\n$1")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const columns = splitSqlTopLevelList(body);
  const columnText = columns.length ? `\n  ${columns.join(",\n  ")}\n` : "";
  return `${prefix} (${columnText})${suffix ? `\n${suffix}` : ""}`.trim();
}

function formatSql(text) {
  if (isDdlLike(text)) return formatDdlSql(text);
  const prepared = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\s+(FROM|WHERE|LEFT JOIN|RIGHT JOIN|INNER JOIN|JOIN|GROUP BY|ORDER BY|HAVING|PARTITION BY|OVER|ROWS BETWEEN|LIMIT)\b/gi, "\n$1")
    .replace(/\s+(AND|OR)\s+/gi, "\n  $1 ")
    .replace(/,\s*(?=[A-Za-z_][A-Za-z0-9_]*(?:\s|,|\)|$))/g, ",\n  ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  let depth = 0;
  return prepared
    .split("\n")
    .map(line => {
      const trimmed = line.trim();
      const leadingClose = (trimmed.match(/^\)+/) || [""])[0].length;
      const baseDepth = Math.max(depth - leadingClose, 0);
      const isMajor = /^(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|WITH|UNION|LEFT JOIN|RIGHT JOIN|INNER JOIN|JOIN|\))/i.test(trimmed);
      const isWindow = /^(PARTITION BY|ROWS BETWEEN|RANGE BETWEEN)/i.test(trimmed) || (baseDepth > 0 && /^ORDER BY/i.test(trimmed));
      const extra = isWindow ? 2 : isMajor ? 0 : 1;
      const formatted = `${"  ".repeat(baseDepth + extra)}${trimmed}`;
      const opens = (trimmed.match(/\(/g) || []).length;
      const closes = (trimmed.match(/\)/g) || []).length;
      depth = Math.max(baseDepth + opens - closes, 0);
      return formatted;
    })
    .join("\n")
    .trim();
}

function formatQaAnswer(answer) {
  const normalized = String(answer || "")
    .trim()
    .replace(/\r\n/g, "\n");
  if (!normalized) return `<p class="answer-placeholder">答案待补充</p>`;
  if (isSqlLike(normalized)) {
    return `<pre class="qa-code"><code>${escapeHtml(formatSql(normalized))}</code></pre>`;
  }
  return `<div class="qa-answer-plain">${formatRichAnswer(normalized)}</div>`;
}

function formatInlineRichText(text) {
  const pattern = /(\*\*([^*\n]+)\*\*)|(\[([^\]\n]{1,200})\]\{color=(#[0-9a-fA-F]{6})\})|(\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\))/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    result += formatSafeInlineHtml(text.slice(lastIndex, match.index));
    if (match[2]) {
      result += `<strong>${formatInlineRichText(match[2])}</strong>`;
    } else if (match[4] && match[5]) {
      result += `<span class="qa-rich-color" style="color: ${match[5]}">${escapeHtml(match[4])}</span>`;
    } else if (match[7] && match[8]) {
      result += `<a href="${escapeHtml(match[8])}" target="_blank" rel="noopener noreferrer">${formatInlineRichText(match[7])}</a>`;
    }
    lastIndex = pattern.lastIndex;
  }
  return result + formatSafeInlineHtml(text.slice(lastIndex));
}

function normalizeLegacyFontTags(value) {
  return String(value || "")
    .replace(/<font\b([^>]*)>/gi, (_, attrs) => {
      const styleMatch = String(attrs || "").match(/style\s*=\s*(['"])([\s\S]*?)\1/i);
      const colorMatch = styleMatch ? styleMatch[2].match(/color\s*:\s*([^;]+)/i) : null;
      const color = colorMatch ? colorMatch[1].trim().replace(/["<>]/g, "") : "";
      return color ? `<span style="color: ${color}">` : "<span>";
    })
    .replace(/<\/font>/gi, "</span>");
}

function formatSafeInlineHtml(text) {
  const source = normalizeLegacyFontTags(text);
  return /<\s*(?:span|font|a|strong|b|em|i|u|s|code|br)\b/i.test(source)
    ? sanitizeRichHtml(source)
    : escapeHtml(source);
}

function formatRichAnswer(text) {
  return String(text || "")
    .split("\n")
    .map(formatInlineRichText)
    .join("\n");
}

function splitMarkdownTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cell => cell.trim());
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function renderMarkdownTable(lines, startIndex) {
  if (startIndex + 1 >= lines.length || !isMarkdownTableSeparator(lines[startIndex + 1])) {
    return null;
  }
  const header = splitMarkdownTableRow(lines[startIndex]);
  if (header.length < 2) return null;
  const rows = [];
  let index = startIndex + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    const row = splitMarkdownTableRow(lines[index]);
    if (row.length >= 2) rows.push(row);
    index += 1;
  }
  return {
    nextIndex: index,
    html: `
      <div class="article-table-wrap">
        <table class="article-table">
          <thead>
            <tr>${header.map(cell => `<th>${formatInlineRichText(cell)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>${header.map((_, cellIndex) => `<td>${formatInlineRichText(row[cellIndex] || "")}</td>`).join("")}</tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `
  };
}

function splitDelimitedTableRow(line) {
  return String(line || "")
    .split(/\t+/)
    .map(cell => cell.trim());
}

function renderDelimitedTable(lines, startIndex) {
  if (!String(lines[startIndex] || "").includes("\t")) return null;
  const rows = [];
  let index = startIndex;
  while (index < lines.length && String(lines[index] || "").includes("\t")) {
    const row = splitDelimitedTableRow(lines[index]).filter(cell => cell || cell === "");
    if (row.length >= 2) rows.push(row);
    index += 1;
  }
  if (rows.length < 2) return null;
  const maxColumns = Math.max(...rows.map(row => row.length));
  const header = rows[0];
  return {
    nextIndex: index,
    html: `
      <div class="article-table-wrap">
        <table class="article-table">
          <thead>
            <tr>${Array.from({ length: maxColumns }).map((_, cellIndex) => `<th>${formatInlineRichText(header[cellIndex] || "")}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${rows.slice(1).map(row => `
              <tr>${Array.from({ length: maxColumns }).map((_, cellIndex) => `<td>${formatInlineRichText(row[cellIndex] || "")}</td>`).join("")}</tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `
  };
}

function renderMarkdownImage(line) {
  const match = String(line || "").trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (!match) return "";
  const alt = match[1] || "文章图片";
  const src = match[2] || "";
  if (!src.startsWith("/uploads/") && !/^https?:\/\//i.test(src)) return "";
  return `
    <figure class="article-image">
      <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">
    </figure>
  `;
}

function renderMarkdownHeading(line) {
  const match = String(line || "").trim().match(/^(#{1,6})\s+(.+)$/);
  if (!match) return "";
  const level = match[1].length;
  return `<h${level}>${formatInlineRichText(match[2])}</h${level}>`;
}

function renderSimpleList(lines, startIndex) {
  const items = [];
  let index = startIndex;
  while (index < lines.length) {
    const match = String(lines[index] || "").trim().match(/^(?:[-+*]|[•●])\s+(.+)$/);
    if (!match) break;
    items.push(match[1]);
    index += 1;
  }
  if (!items.length) return null;
  return {
    nextIndex: index,
    html: `<ul>${items.map(item => `<li>${formatInlineRichText(item)}</li>`).join("")}</ul>`
  };
}

function renderFencedCodeBlock(lines, startIndex) {
  const startMatch = String(lines[startIndex] || "").trim().match(/^```([\w#+.-]*)\s*$/);
  if (!startMatch) return null;
  const language = startMatch[1] || "";
  const code = [];
  let index = startIndex + 1;
  while (index < lines.length && String(lines[index] || "").trim() !== "```") {
    code.push(lines[index]);
    index += 1;
  }
  const nextIndex = index < lines.length ? index + 1 : index;
  return {
    nextIndex,
    html: `
      <pre class="article-code" data-language="${escapeHtml(language || "code")}"><code>${escapeHtml(code.join("\n"))}</code></pre>
    `
  };
}

function isIgnorableArticleLine(line) {
  const normalized = String(line || "").trim();
  return normalized.startsWith("<!--") || /^<\/?(?:font|span)\b[^>]*>\s*$/i.test(normalized);
}

function isRichHtmlContent(content) {
  return /<\s*(?:p|div|h[1-6]|table|thead|tbody|tr|td|th|ul|ol|li|figure|img|a|strong|b|em|i|span|pre|code|blockquote|hr|br)\b/i.test(String(content || ""));
}

function cleanRichStyle(element) {
  const style = element.style;
  const next = {};
  if (style.color) next.color = style.color;
  if (style.backgroundColor && style.backgroundColor !== "transparent") next.backgroundColor = style.backgroundColor;
  if (style.fontWeight) next.fontWeight = style.fontWeight;
  if (style.fontStyle) next.fontStyle = style.fontStyle;
  if (style.textDecorationLine && style.textDecorationLine !== "none") next.textDecoration = style.textDecorationLine;
  if (style.textAlign) next.textAlign = style.textAlign;
  if (/^\d+(\.\d+)?(px|em|rem|%)$/.test(style.fontSize || "")) next.fontSize = style.fontSize;
  const cssText = Object.entries(next).map(([key, value]) => `${key.replace(/[A-Z]/g, item => `-${item.toLowerCase()}`)}: ${value}`).join("; ");
  if (cssText) {
    element.setAttribute("style", cssText);
  } else {
    element.removeAttribute("style");
  }
}

function sanitizeRichHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const allowedTags = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BR", "HR", "STRONG", "B", "EM", "I", "U", "S", "SPAN", "A", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "FIGURE", "IMG"]);
  const allowedImage = src => /^\/uploads\/[^"'<>]+$/i.test(src) || /^https?:\/\/[^"'<>]+$/i.test(src);
  const cleanNode = node => {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent || "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return document.createDocumentFragment();
    }
    if (!allowedTags.has(node.tagName)) {
      const fragment = document.createDocumentFragment();
      Array.from(node.childNodes).forEach(child => fragment.appendChild(cleanNode(child)));
      return fragment;
    }
    const element = document.createElement(node.tagName.toLowerCase());
    Array.from(node.childNodes).forEach(child => element.appendChild(cleanNode(child)));
    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href) || href.startsWith("#")) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") || "";
      if (!allowedImage(src)) return document.createDocumentFragment();
      element.setAttribute("src", src);
      element.setAttribute("alt", node.getAttribute("alt") || "文章图片");
      element.setAttribute("loading", "lazy");
    }
    if (node.hasAttribute("style")) {
      element.setAttribute("style", node.getAttribute("style") || "");
      cleanRichStyle(element);
    }
    return element;
  };
  const wrapper = document.createElement("div");
  Array.from(template.content.childNodes).forEach(child => wrapper.appendChild(cleanNode(child)));
  return wrapper.innerHTML.trim();
}

function formatArticleMarkdown(content) {
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      html.push(`<div class="article-spacer"></div>`);
      index += 1;
      continue;
    }
    if (isIgnorableArticleLine(line)) {
      index += 1;
      continue;
    }
    const codeBlock = renderFencedCodeBlock(lines, index);
    if (codeBlock) {
      html.push(codeBlock.html);
      index = codeBlock.nextIndex;
      continue;
    }
    const heading = renderMarkdownHeading(line);
    if (heading) {
      html.push(heading);
      index += 1;
      continue;
    }
    const table = renderMarkdownTable(lines, index);
    if (table) {
      html.push(table.html);
      index = table.nextIndex;
      continue;
    }
    const list = renderSimpleList(lines, index);
    if (list) {
      html.push(list.html);
      index = list.nextIndex;
      continue;
    }
    const delimitedTable = renderDelimitedTable(lines, index);
    if (delimitedTable) {
      html.push(delimitedTable.html);
      index = delimitedTable.nextIndex;
      continue;
    }
    const image = renderMarkdownImage(line);
    if (image) {
      html.push(image);
      index += 1;
      continue;
    }
    html.push(`<p>${formatInlineRichText(line)}</p>`);
    index += 1;
  }
  return html.join("");
}

function articleContentToEditorHtml(content) {
  const normalized = String(content || "").trim().replace(/\r\n/g, "\n");
  if (!normalized) return "";
  if (isRichHtmlContent(normalized)) return sanitizeRichHtml(normalized);
  return formatArticleMarkdown(normalized);
}

function answerEditorHtml(id, value = "", placeholder = "输入答案", options = {}) {
  const imageTools = options.images
    ? `
        <button class="secondary small rich-button" type="button" data-rich-image title="插入图片">图片</button>
        <input class="rich-image-input hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
      `
    : "";
  const editorBody = options.richHtml
    ? `
      <div id="${id}Editor" class="rich-html-input" contenteditable="true" data-rich-html-input data-target="${id}" data-placeholder="${escapeHtml(placeholder)}">${articleContentToEditorHtml(value)}</div>
      <textarea id="${id}" class="hidden">${escapeHtml(value)}</textarea>
    `
    : `<textarea id="${id}" rows="7" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`;
  return `
    <div class="rich-editor" data-image-upload="${options.images ? "1" : "0"}" data-rich-html="${options.richHtml ? "1" : "0"}">
      <div class="rich-toolbar" aria-label="答案格式工具">
        <button class="secondary small rich-button rich-bold" type="button" data-rich-action="bold" title="加粗">B</button>
        <button class="secondary small rich-button color-red" type="button" data-rich-color="#d93025" title="红色"></button>
        <button class="secondary small rich-button color-green" type="button" data-rich-color="#087443" title="绿色"></button>
        <button class="secondary small rich-button color-blue" type="button" data-rich-color="#1a73e8" title="蓝色"></button>
        ${imageTools}
      </div>
      ${editorBody}
      <span class="help-text">${options.richHtml ? "支持直接粘贴网页图文，标题、字号、链接、表格会尽量保留；图片会自动保存并插入。" : options.images ? "支持 Markdown 表格；可直接粘贴图文，图片会自动保存并插入。" : "选中文字后点击按钮，可设置加粗或颜色；保存后在详情中生效。"}</span>
    </div>
  `;
}

function applyAnswerFormat(textarea, prefix, suffix, fallbackText) {
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  const selected = textarea.value.slice(start, end) || fallbackText;
  const nextText = `${prefix}${selected}${suffix}`;
  textarea.setRangeText(nextText, start, end, "select");
  textarea.focus();
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart || 0;
  const end = textarea.selectionEnd || 0;
  textarea.setRangeText(text, start, end, "end");
  textarea.focus();
}

function syncRichEditor(editor) {
  const input = editor?.querySelector("[data-rich-html-input]");
  const textarea = editor?.querySelector("textarea");
  if (!input || !textarea) return;
  textarea.value = sanitizeRichHtml(input.innerHTML);
}

function syncRichEditors() {
  $$(".rich-editor[data-rich-html='1']").forEach(syncRichEditor);
}

function insertHtmlAtSelection(editable, html) {
  editable.focus();
  document.execCommand("insertHTML", false, sanitizeRichHtml(html));
  syncRichEditor(editable.closest(".rich-editor"));
}

function normalizePastedArticleText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function insertArticleBlock(textarea, text) {
  const content = normalizePastedArticleText(text);
  if (!content) return;
  const prefix = textarea.selectionStart > 0 && !textarea.value.slice(0, textarea.selectionStart).endsWith("\n") ? "\n" : "";
  insertAtCursor(textarea, `${prefix}${content}\n`);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadArticleImage(file) {
  if (!file || !file.type.startsWith("image/")) {
    throw new Error("请选择图片文件");
  }
  const dataUrl = await fileToDataUrl(file);
  const data = await api("/api/uploads", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name || "image",
      mimeType: file.type,
      data: dataUrl
    })
  });
  return data.upload;
}

function empty(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function matchesQuery(item) {
  if (!state.query) return true;
  const text = JSON.stringify(item).toLowerCase();
  return text.includes(state.query.toLowerCase());
}

function allTags() {
  return Array.from(new Set([
    ...state.entries.flatMap(entry => entry.tags || []),
    ...state.qas.flatMap(qa => qa.tags || []),
    ...state.articles.flatMap(article => article.tags || [])
  ])).filter(Boolean);
}

function renderFilters() {
  const tagOptions = allTags().map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("");
  $("#knowledgeTagFilter").innerHTML = `<option value="">全部标签</option>${tagOptions}`;
  $("#qaTagFilter").innerHTML = `<option value="">全部标签</option>${tagOptions}`;
  $("#articleTagFilter").innerHTML = `<option value="">全部标签</option>${tagOptions}`;
  $("#existingTagOptions").innerHTML = tagOptions;
  $("#knowledgeTagFilter").value = state.knowledgeTag;
  $("#qaTagFilter").value = state.qaTag;
  $("#articleTagFilter").value = state.articleTag;
}

function renderDashboard() {
  const tags = allTags();
  $("#entryCount").textContent = state.entries.length;
  $("#qaCount").textContent = state.qas.length;
  $("#articleCount").textContent = state.articles.length;
  $("#tagCount").textContent = tags.length;

  const recent = state.entries.slice(0, 5);
  $("#recentEntries").innerHTML = recent.length
    ? recent.map(entryCard).join("")
    : empty("还没有知识条目，先去导入一条。");

  const random = [...state.qas].sort(() => Math.random() - 0.5).slice(0, 3);
  $("#dashboardRandom").innerHTML = random.length
    ? random.map(qaCard).join("")
    : empty("还没有 QA，导入知识后会自动生成。");
}

function entryCard(entry) {
  return `
    <article class="item">
      <div class="item-head">
        <div>
          <div class="item-title">${escapeHtml(entry.title)}</div>
          <div class="item-text">${escapeHtml(entry.summary || "")}</div>
        </div>
        <span class="pill">${escapeHtml(sourceTypeLabel(entry.sourceType))}</span>
      </div>
      ${tagsHtml(entry.tags)}
      <div class="item-head">
        <span class="status">更新于 ${formatTime(entry.updatedAt || entry.createdAt)}</span>
        <div class="item-actions">
          ${entry.sourceUrl ? `<a class="text-button" href="${escapeHtml(entry.sourceUrl)}" target="_blank" rel="noreferrer">打开来源</a>` : ""}
          <button class="secondary small" data-edit-entry="${entry.id}">编辑</button>
          <button class="secondary small danger" data-delete-entry="${entry.id}">删除</button>
        </div>
      </div>
    </article>
  `;
}

function qaCard(qa) {
  return `
    <article class="item">
      <div class="item-head">
        <div class="item-title">${escapeHtml(qa.question)}</div>
        <span class="pill">${qa.confirmed ? "已入库" : "待确认"}</span>
      </div>
      <div class="item-text">${escapeHtml(qa.answer)}</div>
      ${tagsHtml(qa.tags)}
      <div class="item-head">
        <div class="item-actions">
          <button class="secondary small" data-edit-qa="${qa.id}">编辑</button>
          <button class="secondary small danger" data-delete-qa="${qa.id}">删除</button>
        </div>
      </div>
    </article>
  `;
}

function qaQuestionCard(qa, index) {
  const preview = questionPreview(qa.question);
  return `
    <button class="qa-question" data-open-qa="${qa.id}" title="${escapeHtml(qa.question)}">
      <span class="qa-question-index">${index + 1}</span>
      <span>${escapeHtml(preview)}</span>
    </button>
  `;
}

function groupQasByTag(qas) {
  const groups = [];
  const index = new Map();
  qas.forEach((qa, order) => {
    const tags = qa.tags || [];
    const groupTag = state.qaTag && tags.includes(state.qaTag) ? state.qaTag : (tags[0] || "未打标签");
    if (!index.has(groupTag)) {
      index.set(groupTag, { tag: groupTag, items: [] });
      groups.push(index.get(groupTag));
    }
    index.get(groupTag).items.push({ qa, order });
  });
  return groups;
}

function qaGroupCard(group) {
  const collapsed = state.collapsedQaGroups.has(group.tag);
  return `
    <section class="qa-group${collapsed ? " collapsed" : ""}">
      <div class="qa-group-title">
        <div class="qa-group-title-text">
          <span>${escapeHtml(group.tag)}</span>
          <small>${group.items.length} 题</small>
        </div>
        <button class="secondary small qa-group-toggle" type="button" data-toggle-qa-group="${escapeHtml(group.tag)}">
          ${collapsed ? "展开" : "折叠"}
        </button>
      </div>
      <div class="qa-group-list${collapsed ? " hidden" : ""}">
        ${group.items.map(item => qaQuestionCard(item.qa, item.order)).join("")}
      </div>
    </section>
  `;
}

function qaDetailCard(qa, index, total = 0) {
  const showAnswer = state.qaMode === "review" || state.qaAnswerVisible;
  const answerHtml = showAnswer
    ? `<div class="qa-answer">${formatQaAnswer(qa.answer)}</div>`
    : `<button class="primary" data-show-answer="${qa.id}">显示答案</button>`;
  const indexHtml = Number.isInteger(index) && index >= 0
    ? `<span class="qa-question-index qa-detail-index">${index + 1}</span>`
    : "";
  const canNavigate = Number.isInteger(index) && index >= 0 && total > 0;
  const navHtml = canNavigate
    ? `
      <div class="qa-detail-nav">
        <button class="secondary small" data-qa-nav="prev" ${index <= 0 ? "disabled" : ""}>上一题</button>
        <span>${index + 1} / ${total}</span>
        <button class="secondary small" data-qa-nav="next" ${index >= total - 1 ? "disabled" : ""}>下一题</button>
      </div>
    `
    : "";
  return `
    <article class="qa-detail">
      <div class="item-head">
        <button class="secondary small" data-back-qa>返回题库</button>
        <div class="item-actions">
          <button class="secondary small" data-edit-qa="${qa.id}">编辑</button>
          <button class="secondary small danger" data-delete-qa="${qa.id}">删除</button>
        </div>
      </div>
      ${navHtml}
      <div>
        <div class="qa-detail-label">问</div>
        <div class="qa-detail-question-wrap">
          ${indexHtml}
          <div class="qa-detail-question">${formatQuestion(qa.question)}</div>
        </div>
      </div>
      ${tagsHtml(qa.tags)}
      <div>
        <div class="qa-detail-label">答</div>
        ${answerHtml}
      </div>
    </article>
  `;
}

function renderKnowledge() {
  const entries = state.entries
    .filter(matchesQuery)
    .filter(entry => !state.knowledgeTag || (entry.tags || []).includes(state.knowledgeTag));
  $("#entryList").innerHTML = entries.length ? entries.map(entryCard).join("") : empty("没有匹配的知识条目。");
}

function visibleQas() {
  return state.qas
    .map((qa, index) => ({ qa, index, score: qaSearchScore(qa, state.qaQuery) }))
    .filter(matchesQuery)
    .filter(item => !state.qaQuery || item.score >= 32)
    .filter(item => !state.qaTag || (item.qa.tags || []).includes(state.qaTag))
    .sort((left, right) => {
      if (!state.qaQuery) return left.index - right.index;
      const scoreDiff = right.score - left.score;
      return scoreDiff || left.index - right.index;
    })
    .map(item => item.qa);
}

function navigateQa(direction) {
  const qas = visibleQas();
  const currentIndex = qas.findIndex(qa => qa.id === state.qaDetailId);
  if (currentIndex < 0) return;
  const nextIndex = direction === "prev" ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= qas.length) return;
  state.qaDetailId = qas[nextIndex].id;
  state.qaAnswerVisible = state.qaMode === "review";
  renderQas();
}

function renderQas() {
  const qas = visibleQas();
  const selected = state.qaDetailId ? state.qas.find(qa => qa.id === state.qaDetailId) : null;
  if (selected) {
    const selectedIndex = qas.findIndex(qa => qa.id === selected.id);
    $("#qaList").innerHTML = qaDetailCard(selected, selectedIndex, qas.length);
    return;
  }
  $("#qaList").innerHTML = qas.length ? groupQasByTag(qas).map(qaGroupCard).join("") : empty("没有匹配的题目。");
}

function articleMatchesQuery(article) {
  if (!state.articleQuery) return true;
  const query = compactSearchText(state.articleQuery);
  const text = compactSearchText(`${article.title || ""} ${article.content || ""} ${(article.tags || []).join(" ")}`);
  return query && text.includes(query);
}

function visibleArticles() {
  return state.articles
    .filter(matchesQuery)
    .filter(articleMatchesQuery)
    .filter(article => !state.articleTag || (article.tags || []).includes(state.articleTag));
}

function navigateArticle(direction) {
  const articles = visibleArticles();
  const currentIndex = articles.findIndex(article => article.id === state.articleDetailId);
  if (currentIndex < 0) return;
  const nextIndex = direction === "prev" ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= articles.length) return;
  state.articleDetailId = articles[nextIndex].id;
  renderArticles();
}

function groupArticlesByTag(articles) {
  const groups = [];
  const index = new Map();
  articles.forEach(article => {
    const tags = article.tags || [];
    const groupTag = state.articleTag && tags.includes(state.articleTag) ? state.articleTag : (tags[0] || "未打标签");
    if (!index.has(groupTag)) {
      index.set(groupTag, { tag: groupTag, items: [] });
      groups.push(index.get(groupTag));
    }
    index.get(groupTag).items.push(article);
  });
  return groups;
}

function articleCard(article) {
  return `
    <button class="article-card" data-open-article="${article.id}" title="${escapeHtml(article.title)}">
      <div>
        <div class="item-title">${escapeHtml(article.title)}</div>
      </div>
      <span class="status">更新于 ${formatTime(article.updatedAt || article.createdAt)}</span>
    </button>
  `;
}

function articleGroupCard(group) {
  const collapsed = state.collapsedArticleGroups.has(group.tag);
  return `
    <section class="qa-group${collapsed ? " collapsed" : ""}">
      <div class="qa-group-title">
        <div class="qa-group-title-text">
          <span>${escapeHtml(group.tag)}</span>
          <small>${group.items.length} 篇</small>
        </div>
        <button class="secondary small qa-group-toggle" type="button" data-toggle-article-group="${escapeHtml(group.tag)}">
          ${collapsed ? "展开" : "折叠"}
        </button>
      </div>
      <div class="qa-group-list${collapsed ? " hidden" : ""}">
        ${group.items.map(articleCard).join("")}
      </div>
    </section>
  `;
}

function formatArticleContent(content) {
  const normalized = String(content || "").trim().replace(/\r\n/g, "\n");
  if (!normalized) return `<p class="answer-placeholder">暂无内容</p>`;
  if (isRichHtmlContent(normalized)) {
    return `<div class="article-content-text rich-article-html">${sanitizeRichHtml(normalized)}</div>`;
  }
  return `<div class="article-content-text">${formatArticleMarkdown(normalized)}</div>`;
}

function articleDetailCard(article, index, total = 0) {
  const canNavigate = Number.isInteger(index) && index >= 0 && total > 0;
  const navHtml = canNavigate
    ? `
      <div class="qa-detail-nav">
        <button class="secondary small" data-article-nav="prev" ${index <= 0 ? "disabled" : ""}>上一篇</button>
        <span>${index + 1} / ${total}</span>
        <button class="secondary small" data-article-nav="next" ${index >= total - 1 ? "disabled" : ""}>下一篇</button>
      </div>
    `
    : "";
  return `
    <article class="article-detail">
      <div class="item-head">
        <button class="secondary small" data-back-article>返回文章库</button>
        <div class="item-actions">
          <button class="secondary small" data-edit-article="${article.id}">编辑</button>
          <button class="secondary small danger" data-delete-article="${article.id}">删除</button>
        </div>
      </div>
      ${navHtml}
      <div>
        <h3 class="article-detail-title">${escapeHtml(article.title)}</h3>
        <span class="status">更新于 ${formatTime(article.updatedAt || article.createdAt)}</span>
      </div>
      ${tagsHtml(article.tags)}
      <div class="article-content">${formatArticleContent(article.content)}</div>
    </article>
  `;
}

function renderArticles() {
  const articles = visibleArticles();
  const selected = state.articleDetailId ? state.articles.find(article => article.id === state.articleDetailId) : null;
  if (selected) {
    const selectedIndex = articles.findIndex(article => article.id === selected.id);
    $("#articleList").innerHTML = articleDetailCard(selected, selectedIndex, articles.length);
    return;
  }
  $("#articleList").innerHTML = articles.length
    ? groupArticlesByTag(articles).map(articleGroupCard).join("")
    : empty("没有匹配的文章。");
}

function render() {
  renderFilters();
  renderDashboard();
  renderKnowledge();
  renderQas();
  renderArticles();
}

function setImportType(type) {
  state.importType = type;
  $$("[data-import-type]").forEach(button => button.classList.toggle("active", button.dataset.importType === type));
  $("#urlField").classList.toggle("hidden", type !== "link");
  $("#importContent").placeholder = type === "link"
    ? "可补充链接备注；系统会解析链接正文并合并导入"
    : "粘贴文字，或直接 Ctrl+V 粘贴截图；图片会 OCR 后弹出确认框";
}

async function handleImport(event) {
  event.preventDefault();
  const status = $("#importStatus");
  const tags = splitTags($("#importTags").value);
  if (!tags.length) {
    status.textContent = "请至少指定一个标签后再导入";
    $("#importTags").focus();
    return;
  }
  status.textContent = "正在导入...";
  const payload = {
    sourceType: state.importType,
    title: $("#importTitle").value,
    sourceUrl: $("#importUrl").value,
    content: $("#importContent").value,
    tags
  };
  try {
    const data = await api("/api/import", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    status.textContent = data.message || "已导入";
    $("#importForm").reset();
    await loadState();
  } catch (error) {
    status.textContent = error.message;
  }
}

async function recognizeImage(file, label = "图片") {
  const status = $("#importStatus");
  if (!window.Tesseract) {
    status.textContent = "OCR 库加载失败，请检查网络后重试";
    return "";
  }
  try {
    const result = await window.Tesseract.recognize(file, "chi_sim+eng", {
      logger: message => {
        if (message.status === "recognizing text") {
          status.textContent = `${label} 正在识别 ${Math.round((message.progress || 0) * 100)}%`;
        }
      }
    });
    const cleaned = cleanOcrText(result?.data?.text || "");
    return cleaned ? `【${label} OCR】\n${cleaned}` : "";
  } catch (error) {
    status.textContent = `OCR 失败：${error.message}`;
    return "";
  }
}

function standardizeImportContent() {
  const status = $("#importStatus");
  const content = $("#importContent").value.trim();
  if (!content) {
    status.textContent = "请先粘贴图文内容";
    $("#importContent").focus();
    return;
  }
  openStandardTextDialog("确认标准格式内容", content, "replace");
}

async function ocrPastedImages(files, pastedText = "") {
  const status = $("#importStatus");
  const blocks = [];
  if (pastedText && pastedText.trim()) {
    blocks.push(cleanOcrText(pastedText));
  }
  for (let index = 0; index < files.length; index += 1) {
    status.textContent = `正在识别粘贴图片 ${index + 1}/${files.length}...`;
    const text = await recognizeImage(files[index], `粘贴图片 ${index + 1}`);
    if (text) {
      blocks.push(text);
    }
  }
  const merged = blocks.filter(Boolean).join("\n\n");
  if (!merged) {
    status.textContent = "粘贴图片未识别到有效文字";
    return;
  }
  status.textContent = "OCR 完成，请确认标准格式内容";
  openStandardTextDialog("确认 OCR 标准格式内容", merged, "append");
}

async function handleImportPaste(event) {
  if (state.importType === "link") return;
  const files = Array.from(event.clipboardData?.items || [])
    .filter(item => item.kind === "file" && item.type.startsWith("image/"))
    .map(item => item.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  const pastedText = event.clipboardData?.getData("text/plain");
  await ocrPastedImages(files, pastedText);
}

async function handleAsk(event) {
  event.preventDefault();
  const query = $("#askInput").value.trim();
  if (!query) return;
  $("#answerBox").innerHTML = empty("正在查询知识库...");
  try {
    const data = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({ query })
    });
    renderAnswer(data);
  } catch (error) {
    $("#answerBox").innerHTML = empty(error.message);
  }
}

function renderAnswer(data) {
  const isExternal = data.mode === "external";
  const modeText = isExternal ? "知识库未命中，以下为知识库外部来源" : "来自知识库";
  const sourceHtml = (data.sources || []).length
    ? `
      <div>
        <strong>知识库引用</strong>
        <div class="source-list">
          ${data.sources.map(source => `<div>${escapeHtml(source.title)} · ${escapeHtml((source.tags || []).join(" / "))}</div>`).join("")}
        </div>
      </div>
    `
    : "";
  const externalHtml = (data.externalSources || []).length
    ? `
      <div>
        <strong>外部来源</strong>
        <div class="source-list">
          ${data.externalSources.map(source => `
            <div>
              ${source.url ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title || source.url)}</a>` : escapeHtml(source.title || "外部摘要")}
              <div class="item-text">${escapeHtml(source.snippet || "")}</div>
            </div>
          `).join("")}
        </div>
      </div>
    `
    : "";

  $("#answerBox").innerHTML = `
    <div class="answer-card">
      <span class="answer-mode ${isExternal ? "external" : ""}">${modeText}</span>
      <div class="item-text">${escapeHtml(data.answer)}</div>
      ${sourceHtml}
      ${externalHtml}
    </div>
  `;
}

async function randomQa(target = "#randomQaBox") {
  const box = $(target);
  box.classList.remove("hidden");
  box.innerHTML = "正在抽取...";
  const tag = target === "#randomQaBox" ? state.qaTag : "";
  const data = await api(`/api/random-qa?count=1&tag=${encodeURIComponent(tag)}`);
  if (!data.qas.length) {
    box.innerHTML = "当前范围没有可抽取的题目。";
    return;
  }
  box.classList.add("hidden");
  box.innerHTML = "";
  state.qaDetailId = data.qas[0].id;
  state.qaAnswerVisible = state.qaMode === "review";
  renderQas();
}

function openDialog(title, bodyHtml, onSave) {
  const dialog = $("#editorDialog");
  $("#dialogTitle").textContent = title;
  $("#dialogBody").innerHTML = bodyHtml;
  const save = $("#dialogSaveBtn");
  const next = save.cloneNode(true);
  save.replaceWith(next);
  next.addEventListener("click", async event => {
    event.preventDefault();
    await onSave();
    dialog.close();
  });
  dialog.showModal();
}

function editEntry(id) {
  const entry = state.entries.find(item => item.id === id);
  if (!entry) return;
  openDialog("编辑知识条目", `
    <div class="form">
      <label>标题<input id="editEntryTitle" value="${escapeHtml(entry.title)}"></label>
      <label>摘要<textarea id="editEntrySummary" rows="3">${escapeHtml(entry.summary || "")}</textarea></label>
      <label>内容<textarea id="editEntryContent" rows="10">${escapeHtml(entry.content || "")}</textarea></label>
      <label>标签<input id="editEntryTags" list="existingTagOptions" value="${escapeHtml((entry.tags || []).join(", "))}" placeholder="输入或选择已有标签，多个标签用逗号分隔"></label>
    </div>
  `, async () => {
    await api(`/api/entries/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        title: $("#editEntryTitle").value,
        summary: $("#editEntrySummary").value,
        content: $("#editEntryContent").value,
        tags: splitTags($("#editEntryTags").value)
      })
    });
    await loadState();
  });
}

function editQa(id) {
  const qa = state.qas.find(item => item.id === id);
  if (!qa) return;
  openDialog("编辑 QA", `
    <div class="form">
      <label>Question<textarea id="editQaQuestion" rows="3">${escapeHtml(qa.question)}</textarea></label>
      <label>Answer${answerEditorHtml("editQaAnswer", qa.answer)}</label>
      <label>标签<input id="editQaTags" list="existingTagOptions" value="${escapeHtml((qa.tags || []).join(", "))}" placeholder="输入或选择已有标签，多个标签用逗号分隔"></label>
    </div>
  `, async () => {
    try {
      await api(`/api/qas/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          question: $("#editQaQuestion").value,
          answer: $("#editQaAnswer").value,
          tags: splitTags($("#editQaTags").value)
        })
      });
      await loadState();
    } catch (error) {
      alert(error.payload?.duplicate ? `保存失败：已存在相似问题「${error.payload.duplicate.question}」` : error.message);
      throw error;
    }
  });
}

function newQa() {
  openDialog("人工添加 QA", `
    <div class="form">
      <label>Question<textarea id="newQaQuestion" rows="3" placeholder="输入一个简短问题"></textarea></label>
      <label>Answer${answerEditorHtml("newQaAnswer")}</label>
      <label>标签<input id="newQaTags" list="existingTagOptions" placeholder="输入或选择已有标签，多个标签用逗号分隔"></label>
    </div>
  `, async () => {
    try {
      await api("/api/qas", {
        method: "POST",
        body: JSON.stringify({
          question: $("#newQaQuestion").value,
          answer: $("#newQaAnswer").value,
          tags: splitTags($("#newQaTags").value)
        })
      });
      await loadState();
    } catch (error) {
      alert(error.payload?.duplicate ? `添加失败：已存在相似问题「${error.payload.duplicate.question}」` : error.message);
      throw error;
    }
  });
}

function editArticle(id) {
  const article = state.articles.find(item => item.id === id);
  if (!article) return;
  openDialog("编辑文章", `
    <div class="form">
      <label>标题<input id="editArticleTitle" value="${escapeHtml(article.title)}"></label>
      <label>内容${answerEditorHtml("editArticleContent", article.content, "输入文章内容", { images: true, richHtml: true })}</label>
      <label>标签<input id="editArticleTags" list="existingTagOptions" value="${escapeHtml((article.tags || []).join(", "))}" placeholder="输入或选择已有标签，多个标签用逗号分隔"></label>
    </div>
  `, async () => {
    syncRichEditors();
    await api(`/api/articles/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        title: $("#editArticleTitle").value,
        content: $("#editArticleContent").value,
        tags: splitTags($("#editArticleTags").value)
      })
    });
    await loadState();
  });
}

function newArticle() {
  openDialog("新增文章", `
    <div class="form">
      <label>标题<input id="newArticleTitle" placeholder="输入文章标题"></label>
      <label>内容${answerEditorHtml("newArticleContent", "", "输入文章内容", { images: true, richHtml: true })}</label>
      <label>标签<input id="newArticleTags" list="existingTagOptions" placeholder="输入或选择已有标签，多个标签用逗号分隔"></label>
    </div>
  `, async () => {
    syncRichEditors();
    await api("/api/articles", {
      method: "POST",
      body: JSON.stringify({
        title: $("#newArticleTitle").value,
        content: $("#newArticleContent").value,
        tags: splitTags($("#newArticleTags").value)
      })
    });
    await loadState();
  });
}

async function deleteEntry(id) {
  if (!confirm("删除知识条目会同时删除它自动生成的 QA，确定删除？")) return;
  await api(`/api/entries/${id}`, { method: "DELETE" });
  await loadState();
}

async function deleteQa(id) {
  if (!confirm("确定删除这条 QA？")) return;
  await api(`/api/qas/${id}`, { method: "DELETE" });
  if (state.qaDetailId === id) {
    state.qaDetailId = "";
    state.qaAnswerVisible = false;
  }
  await loadState();
}

async function deleteArticle(id) {
  if (!confirm("确定删除这篇文章？")) return;
  await api(`/api/articles/${id}`, { method: "DELETE" });
  if (state.articleDetailId === id) {
    state.articleDetailId = "";
  }
  await loadState();
}

function openImagePreview(img) {
  const preview = $("#imagePreview");
  const previewImg = $("#imagePreviewImg");
  if (!preview || !previewImg || !img?.src) return;
  previewImg.src = img.src;
  previewImg.alt = img.alt || "文章图片预览";
  preview.classList.remove("hidden");
  preview.setAttribute("aria-hidden", "false");
  document.body.classList.add("preview-open");
}

function closeImagePreview() {
  const preview = $("#imagePreview");
  const previewImg = $("#imagePreviewImg");
  if (!preview || preview.classList.contains("hidden")) return;
  preview.classList.add("hidden");
  preview.setAttribute("aria-hidden", "true");
  if (previewImg) previewImg.src = "";
  document.body.classList.remove("preview-open");
}

function bindEvents() {
  $$(".nav-item").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("[data-jump]").forEach(button => button.addEventListener("click", () => setView(button.dataset.jump)));
  $("#sidebarToggle")?.addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("sidebar-collapsed");
    localStorage.setItem("kbSidebarCollapsed", collapsed ? "1" : "0");
    applySidebarState(collapsed);
  });
  $$("[data-import-type]").forEach(button => button.addEventListener("click", () => setImportType(button.dataset.importType)));
  $("#importForm").addEventListener("submit", handleImport);
  $("#standardizeBtn").addEventListener("click", standardizeImportContent);
  $("#importContent").addEventListener("paste", handleImportPaste);
  $("#askForm").addEventListener("submit", handleAsk);
  $("#globalSearch").addEventListener("input", event => {
    state.query = event.target.value.trim();
    state.qaDetailId = "";
    state.qaAnswerVisible = false;
    state.articleDetailId = "";
    renderKnowledge();
    renderQas();
    renderArticles();
  });
  $("#knowledgeTagFilter").addEventListener("change", event => {
    state.knowledgeTag = event.target.value;
    renderKnowledge();
  });
  $("#qaSearch").addEventListener("input", event => {
    state.qaQuery = event.target.value.trim();
    state.qaDetailId = "";
    state.qaAnswerVisible = false;
    renderQas();
  });
  $("#qaTagFilter").addEventListener("change", event => {
    state.qaTag = event.target.value;
    state.qaDetailId = "";
    state.qaAnswerVisible = false;
    renderQas();
  });
  $("#articleSearch").addEventListener("input", event => {
    state.articleQuery = event.target.value.trim();
    state.articleDetailId = "";
    renderArticles();
  });
  $("#articleTagFilter").addEventListener("change", event => {
    state.articleTag = event.target.value;
    state.articleDetailId = "";
    renderArticles();
  });
  $$("#qaModeToggle [data-qa-mode]").forEach(button => {
    button.addEventListener("click", () => {
      state.qaMode = button.dataset.qaMode;
      state.qaAnswerVisible = state.qaMode === "review";
      $$("#qaModeToggle [data-qa-mode]").forEach(item => item.classList.toggle("active", item.dataset.qaMode === state.qaMode));
      renderQas();
    });
  });
  $("#randomQaBtn").addEventListener("click", () => randomQa("#randomQaBox"));
  $("#dashboardRandomBtn").addEventListener("click", () => {
    renderDashboard();
  });
  $("#newQaBtn").addEventListener("click", newQa);
  $("#newArticleBtn").addEventListener("click", newArticle);

  document.body.addEventListener("click", event => {
    const preview = event.target.closest("#imagePreview");
    const closePreviewButton = event.target.closest(".image-preview-close");
    const articleImage = event.target.closest(".article-content img");
    const richActionButton = event.target.closest("[data-rich-action]");
    const richColorButton = event.target.closest("[data-rich-color]");
    const richImageButton = event.target.closest("[data-rich-image]");
    const editEntryButton = event.target.closest("[data-edit-entry]");
    const deleteEntryButton = event.target.closest("[data-delete-entry]");
    const openQaButton = event.target.closest("[data-open-qa]");
    const backQaButton = event.target.closest("[data-back-qa]");
    const showAnswerButton = event.target.closest("[data-show-answer]");
    const editQaButton = event.target.closest("[data-edit-qa]");
    const deleteQaButton = event.target.closest("[data-delete-qa]");
    const toggleQaGroupButton = event.target.closest("[data-toggle-qa-group]");
    const qaNavButton = event.target.closest("[data-qa-nav]");
    const openArticleButton = event.target.closest("[data-open-article]");
    const backArticleButton = event.target.closest("[data-back-article]");
    const editArticleButton = event.target.closest("[data-edit-article]");
    const deleteArticleButton = event.target.closest("[data-delete-article]");
    const toggleArticleGroupButton = event.target.closest("[data-toggle-article-group]");
    const articleNavButton = event.target.closest("[data-article-nav]");
    if (closePreviewButton || (preview && event.target.id === "imagePreview")) {
      closeImagePreview();
      return;
    }
    if (articleImage) {
      event.preventDefault();
      event.stopPropagation();
      openImagePreview(articleImage);
      return;
    }
    if (richImageButton) {
      const editor = richImageButton.closest(".rich-editor");
      editor?.querySelector(".rich-image-input")?.click();
      return;
    }
    if (richActionButton || richColorButton) {
      const editor = event.target.closest(".rich-editor");
      const richInput = editor?.querySelector("[data-rich-html-input]");
      if (richInput) {
        richInput.focus();
        if (richActionButton?.dataset.richAction === "bold") {
          document.execCommand("bold", false);
        } else if (richColorButton?.dataset.richColor) {
          document.execCommand("foreColor", false, richColorButton.dataset.richColor);
        }
        syncRichEditor(editor);
        return;
      }
      const textarea = editor?.querySelector("textarea");
      if (!textarea) return;
      if (richActionButton?.dataset.richAction === "bold") {
        applyAnswerFormat(textarea, "**", "**", "加粗文字");
      } else if (richColorButton?.dataset.richColor) {
        applyAnswerFormat(textarea, "[", `]{color=${richColorButton.dataset.richColor}}`, "标记文字");
      }
      return;
    }
    if (editEntryButton) {
      editEntry(editEntryButton.dataset.editEntry);
      return;
    }
    if (deleteEntryButton) {
      deleteEntry(deleteEntryButton.dataset.deleteEntry);
      return;
    }
    if (openQaButton) {
      state.qaDetailId = openQaButton.dataset.openQa;
      state.qaAnswerVisible = state.qaMode === "review";
      renderQas();
      return;
    }
    if (toggleQaGroupButton) {
      const tag = toggleQaGroupButton.dataset.toggleQaGroup;
      if (state.collapsedQaGroups.has(tag)) {
        state.collapsedQaGroups.delete(tag);
      } else {
        state.collapsedQaGroups.add(tag);
      }
      renderQas();
      return;
    }
    if (qaNavButton) {
      navigateQa(qaNavButton.dataset.qaNav);
      return;
    }
    if (openArticleButton) {
      state.articleDetailId = openArticleButton.dataset.openArticle;
      renderArticles();
      return;
    }
    if (articleNavButton) {
      navigateArticle(articleNavButton.dataset.articleNav);
      return;
    }
    if (toggleArticleGroupButton) {
      const tag = toggleArticleGroupButton.dataset.toggleArticleGroup;
      if (state.collapsedArticleGroups.has(tag)) {
        state.collapsedArticleGroups.delete(tag);
      } else {
        state.collapsedArticleGroups.add(tag);
      }
      renderArticles();
      return;
    }
    if (backArticleButton) {
      state.articleDetailId = "";
      renderArticles();
      return;
    }
    if (editArticleButton) {
      editArticle(editArticleButton.dataset.editArticle);
      return;
    }
    if (deleteArticleButton) {
      deleteArticle(deleteArticleButton.dataset.deleteArticle);
      return;
    }
    if (backQaButton) {
      closeQaDetail();
      return;
    }
    if (showAnswerButton) {
      state.qaAnswerVisible = true;
      renderQas();
      return;
    }
    if (editQaButton) {
      editQa(editQaButton.dataset.editQa);
      return;
    }
    if (deleteQaButton) {
      deleteQa(deleteQaButton.dataset.deleteQa);
      return;
    }
    if (
      state.view === "qa" &&
      state.qaDetailId &&
      event.target.closest(".app") &&
      !event.target.closest(".qa-detail") &&
      !event.target.closest(".panel-head") &&
      !event.target.closest("#randomQaBox") &&
      !event.target.closest("button, input, select, textarea, a, dialog")
    ) {
      closeQaDetail();
    }
    if (
      state.view === "article" &&
      state.articleDetailId &&
      event.target.closest(".app") &&
      !event.target.closest(".article-detail") &&
      !event.target.closest(".panel-head") &&
      !event.target.closest("button, input, select, textarea, a, dialog")
    ) {
      state.articleDetailId = "";
      renderArticles();
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeImagePreview();
  });

  document.body.addEventListener("change", async event => {
    const input = event.target.closest(".rich-image-input");
    if (!input || !input.files?.length) return;
    const editor = input.closest(".rich-editor");
    const richInput = editor?.querySelector("[data-rich-html-input]");
    const textarea = editor?.querySelector("textarea");
    if (!textarea && !richInput) return;
    try {
      const upload = await uploadArticleImage(input.files[0]);
      if (richInput) {
        insertHtmlAtSelection(richInput, `<figure class="article-image"><img src="${upload.url}" alt="${escapeHtml(input.files[0].name || "图片")}"></figure>`);
      } else {
        insertAtCursor(textarea, `\n![${input.files[0].name || "图片"}](${upload.url})\n`);
      }
    } catch (error) {
      alert(error.message);
    } finally {
      input.value = "";
    }
  });

  document.body.addEventListener("paste", async event => {
    const editor = event.target.closest(".rich-editor[data-image-upload='1']");
    if (!editor) return;
    const richInput = event.target.closest("[data-rich-html-input]");
    const textarea = event.target.closest("textarea");
    if (!richInput && !textarea) return;
    const pastedHtml = event.clipboardData?.getData("text/html") || "";
    const pastedText = event.clipboardData?.getData("text/plain") || "";
    const files = Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (!files.length && !richInput) return;
    event.preventDefault();
    try {
      if (richInput) {
        const html = pastedHtml ? sanitizeRichHtml(pastedHtml) : `<p>${escapeHtml(pastedText).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
        if (html) insertHtmlAtSelection(richInput, html);
      } else {
        insertArticleBlock(textarea, pastedText);
      }
      for (const file of files) {
        const upload = await uploadArticleImage(file);
        if (richInput) {
          insertHtmlAtSelection(richInput, `<figure class="article-image"><img src="${upload.url}" alt="粘贴图片"></figure>`);
        } else {
          insertAtCursor(textarea, `\n![粘贴图片](${upload.url})\n`);
        }
      }
    } catch (error) {
      alert(error.message);
    }
  });
}

initSidebarState();
bindEvents();
setImportType("mixed");
loadState().catch(error => {
  document.body.innerHTML = `<main class="app">${empty(error.message)}</main>`;
});
