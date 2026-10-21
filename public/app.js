const state = {
  entries: [],
  qas: [],
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
  collapsedQaGroups: new Set()
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

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
  const normalized = text
    .replace(/\s+(?=\d+[.、）)]\s*)/g, "\n")
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);
  const preview = questionPreview(text);
  const options = normalized.filter(line => /^\d+[.、）)]\s*/.test(line));
  if (!options.length) {
    return escapeHtml(text);
  }
  return `
    <div class="qa-question-prompt">${escapeHtml(preview)}</div>
    <div class="qa-question-options">
      ${options.map(option => `<div class="qa-question-option">${escapeHtml(option)}</div>`).join("")}
    </div>
  `;
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
  state.qas = data.qas || [];
  state.categories = data.categories || [];
  if (state.qaDetailId && !state.qas.some(qa => qa.id === state.qaDetailId)) {
    state.qaDetailId = "";
    state.qaAnswerVisible = false;
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
    qa: "题库"
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

function isSqlLike(text) {
  const source = String(text || "").toLowerCase();
  const keywords = ["select", " from ", " where ", " join ", " group by ", " order by ", " partition by ", " over ", "with "];
  return source.includes("select") && keywords.filter(keyword => source.includes(keyword)).length >= 2;
}

function formatSql(text) {
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
  const pattern = /(\*\*([^*\n]+)\*\*)|(\[([^\]\n]{1,200})\]\{color=(#[0-9a-fA-F]{6})\})/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    result += escapeHtml(text.slice(lastIndex, match.index));
    if (match[2]) {
      result += `<strong>${escapeHtml(match[2])}</strong>`;
    } else if (match[4] && match[5]) {
      result += `<span class="qa-rich-color" style="color: ${match[5]}">${escapeHtml(match[4])}</span>`;
    }
    lastIndex = pattern.lastIndex;
  }
  return result + escapeHtml(text.slice(lastIndex));
}

function formatRichAnswer(text) {
  return String(text || "")
    .split("\n")
    .map(formatInlineRichText)
    .join("\n");
}

function answerEditorHtml(id, value = "", placeholder = "输入答案") {
  return `
    <div class="rich-editor">
      <div class="rich-toolbar" aria-label="答案格式工具">
        <button class="secondary small rich-button rich-bold" type="button" data-rich-action="bold" title="加粗">B</button>
        <button class="secondary small rich-button color-red" type="button" data-rich-color="#d93025" title="红色"></button>
        <button class="secondary small rich-button color-green" type="button" data-rich-color="#087443" title="绿色"></button>
        <button class="secondary small rich-button color-blue" type="button" data-rich-color="#1a73e8" title="蓝色"></button>
      </div>
      <textarea id="${id}" rows="7" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>
      <span class="help-text">选中文字后点击按钮，可设置加粗或颜色；保存后在答案详情中生效。</span>
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
    ...state.qas.flatMap(qa => qa.tags || [])
  ])).filter(Boolean);
}

function renderFilters() {
  const tagOptions = allTags().map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("");
  $("#knowledgeTagFilter").innerHTML = `<option value="">全部标签</option>${tagOptions}`;
  $("#qaTagFilter").innerHTML = `<option value="">全部标签</option>${tagOptions}`;
  $("#existingTagOptions").innerHTML = tagOptions;
  $("#knowledgeTagFilter").value = state.knowledgeTag;
  $("#qaTagFilter").value = state.qaTag;
}

function renderDashboard() {
  const tags = allTags();
  $("#entryCount").textContent = state.entries.length;
  $("#qaCount").textContent = state.qas.length;
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

function qaDetailCard(qa, index) {
  const showAnswer = state.qaMode === "review" || state.qaAnswerVisible;
  const answerHtml = showAnswer
    ? `<div class="qa-answer">${formatQaAnswer(qa.answer)}</div>`
    : `<button class="primary" data-show-answer="${qa.id}">显示答案</button>`;
  const indexHtml = Number.isInteger(index) && index >= 0
    ? `<span class="qa-question-index qa-detail-index">${index + 1}</span>`
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

function renderQas() {
  const qas = state.qas
    .filter(matchesQuery)
    .filter(qa => {
      if (!state.qaQuery) return true;
      const text = `${qa.question || ""} ${qa.answer || ""} ${(qa.tags || []).join(" ")}`.toLowerCase();
      return text.includes(state.qaQuery.toLowerCase());
    })
    .filter(qa => !state.qaTag || (qa.tags || []).includes(state.qaTag));
  const selected = state.qaDetailId ? state.qas.find(qa => qa.id === state.qaDetailId) : null;
  if (selected) {
    const selectedIndex = qas.findIndex(qa => qa.id === selected.id);
    $("#qaList").innerHTML = qaDetailCard(selected, selectedIndex);
    return;
  }
  $("#qaList").innerHTML = qas.length ? groupQasByTag(qas).map(qaGroupCard).join("") : empty("没有匹配的题目。");
}

function render() {
  renderFilters();
  renderDashboard();
  renderKnowledge();
  renderQas();
}

function setImportType(type) {
  state.importType = type;
  $$(".segment").forEach(button => button.classList.toggle("active", button.dataset.importType === type));
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

function bindEvents() {
  $$(".nav-item").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("[data-jump]").forEach(button => button.addEventListener("click", () => setView(button.dataset.jump)));
  $("#sidebarToggle")?.addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("sidebar-collapsed");
    localStorage.setItem("kbSidebarCollapsed", collapsed ? "1" : "0");
    applySidebarState(collapsed);
  });
  $$(".segment").forEach(button => button.addEventListener("click", () => setImportType(button.dataset.importType)));
  $("#importForm").addEventListener("submit", handleImport);
  $("#standardizeBtn").addEventListener("click", standardizeImportContent);
  $("#importContent").addEventListener("paste", handleImportPaste);
  $("#askForm").addEventListener("submit", handleAsk);
  $("#globalSearch").addEventListener("input", event => {
    state.query = event.target.value.trim();
    state.qaDetailId = "";
    state.qaAnswerVisible = false;
    renderKnowledge();
    renderQas();
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

  document.body.addEventListener("click", event => {
    const richActionButton = event.target.closest("[data-rich-action]");
    const richColorButton = event.target.closest("[data-rich-color]");
    const editEntryButton = event.target.closest("[data-edit-entry]");
    const deleteEntryButton = event.target.closest("[data-delete-entry]");
    const openQaButton = event.target.closest("[data-open-qa]");
    const backQaButton = event.target.closest("[data-back-qa]");
    const showAnswerButton = event.target.closest("[data-show-answer]");
    const editQaButton = event.target.closest("[data-edit-qa]");
    const deleteQaButton = event.target.closest("[data-delete-qa]");
    const toggleQaGroupButton = event.target.closest("[data-toggle-qa-group]");
    if (richActionButton || richColorButton) {
      const editor = event.target.closest(".rich-editor");
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
  });
}

initSidebarState();
bindEvents();
setImportType("mixed");
loadState().catch(error => {
  document.body.innerHTML = `<main class="app">${empty(error.message)}</main>`;
});
