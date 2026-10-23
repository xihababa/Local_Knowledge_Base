import base64
import json
import os
import random
import re
import time
import uuid
from html import unescape
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT, "public")
DATA_DIR = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "db.json")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
PORT = int(os.environ.get("PORT", "5173"))
IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}

CATEGORIES = [
    "概念解释",
    "SQL 技巧",
    "建模方法",
    "指标口径",
    "数据质量问题",
    "调度/任务问题",
    "报错与解决方案",
    "工具使用经验",
]


class LinkFetchError(Exception):
    def __init__(self, message, status=422):
        super(LinkFetchError, self).__init__(message)
        self.status = status


def ensure_db():
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR)
    if not os.path.exists(UPLOAD_DIR):
        os.makedirs(UPLOAD_DIR)
    if not os.path.exists(DB_PATH):
        write_db({"entries": [], "qas": [], "articles": [], "settings": {"categories": CATEGORIES}})


def read_db():
    ensure_db()
    with open(DB_PATH, "r", encoding="utf-8") as file:
        db = json.load(file)
    changed = False
    if "entries" not in db:
        db["entries"] = []
        changed = True
    if "qas" not in db:
        db["qas"] = []
        changed = True
    if "articles" not in db:
        db["articles"] = []
        changed = True
    if "settings" not in db:
        db["settings"] = {"categories": CATEGORIES}
        changed = True
    if changed:
        write_db(db)
    return db


def write_db(db):
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR)
    with open(DB_PATH, "w", encoding="utf-8") as file:
        json.dump(db, file, ensure_ascii=False, indent=2)


def make_id(prefix):
    return "%s_%s_%s" % (prefix, int(time.time() * 1000), uuid.uuid4().hex[:8])


def safe_upload_name(file_name, mime_type):
    ext = IMAGE_EXTENSIONS.get(str(mime_type or "").lower())
    if not ext:
        ext = os.path.splitext(str(file_name or ""))[1].lower()
    if ext not in IMAGE_EXTENSIONS.values():
        raise ValueError("只支持 png、jpg、gif、webp 图片")
    return "%s%s" % (make_id("img"), ext)


def build_upload(payload):
    mime_type = str(payload.get("mimeType") or "").lower()
    raw_data = str(payload.get("data") or "")
    if "," in raw_data and raw_data.startswith("data:"):
        raw_data = raw_data.split(",", 1)[1]
    data = base64.b64decode(raw_data, validate=True)
    if not data:
        raise ValueError("图片内容为空")
    if len(data) > 6 * 1024 * 1024:
        raise ValueError("图片不能超过 6MB")
    file_name = safe_upload_name(payload.get("fileName"), mime_type)
    file_path = os.path.abspath(os.path.join(UPLOAD_DIR, file_name))
    if not file_path.startswith(os.path.abspath(UPLOAD_DIR)):
        raise ValueError("非法文件路径")
    with open(file_path, "wb") as file:
        file.write(data)
    return {
        "url": "/uploads/%s" % file_name,
        "fileName": file_name,
        "size": len(data),
    }


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def normalize_text(value):
    value = str(value or "")
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"[，。！？、；：,.!?;:()\[\]{}'\"`~@#$%^&*_+=|\\/<>\-]", " ", value)
    return value.strip().lower()


def tokenize(value):
    normalized = normalize_text(value)
    latin = re.findall(r"[a-z0-9_]{2,}", normalized)
    chinese_chars = "".join(re.findall(r"[\u4e00-\u9fa5]", normalized))
    grams = []
    for index, char in enumerate(chinese_chars):
        grams.append(char)
        if index < len(chinese_chars) - 1:
            grams.append(chinese_chars[index : index + 2])
    result = []
    seen = set()
    for token in latin + grams:
        if token and token not in seen:
            result.append(token)
            seen.add(token)
    return result


def similarity(left, right):
    left_tokens = set(tokenize(left))
    right_tokens = set(tokenize(right))
    if not left_tokens or not right_tokens:
        return 0
    overlap = len(left_tokens.intersection(right_tokens))
    return float(overlap) / float(max(len(left_tokens), len(right_tokens)))


def canonical_question_key(question):
    compact = re.sub(r"\s+", "", normalize_text(question))
    if not compact:
        return ""
    normalized = compact.replace("的", "").replace("是怎么样", "").replace("是什么", "")
    if "rdd" in normalized and any(marker in normalized for marker in ["什么是rdd", "rdd是什么", "rdd理解", "rdd概念"]):
        return "rdd概念"
    if "spark" in normalized and any(
        marker in normalized
        for marker in ["任务执行流程", "作业执行流程", "作业运行流程", "spark运行流程"]
    ):
        return "spark作业执行流程"
    if "shuffle" in normalized and "算子" in normalized and any(marker in normalized for marker in ["引起", "哪些", "会有"]):
        return "sparkshuffle触发算子"
    return compact


def is_duplicate_question(existing_question, next_question):
    if similarity(existing_question, next_question) >= 0.72:
        return True
    existing_key = canonical_question_key(existing_question)
    next_key = canonical_question_key(next_question)
    return bool(existing_key and next_key and existing_key == next_key)


def score_text(query, text):
    query_tokens = tokenize(query)
    text_tokens = set(tokenize(text))
    if not query_tokens or not text_tokens:
        return 0
    score = 0
    for token in query_tokens:
        if token in text_tokens:
            score += 2 if len(token) > 1 else 1
    if normalize_text(query) and normalize_text(query) in normalize_text(text):
        score += 6
    return score


def summarize(text, max_len=140):
    clean = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(clean) <= max_len:
        return clean
    parts = re.split(r"[。！？.!?]\s*", clean)
    for part in parts:
        if 24 <= len(part) <= max_len:
            return part
    return clean[: max_len - 1] + "..."


def infer_tags(text):
    source = str(text or "").lower()
    rules = [
        ("SQL 技巧", ["sql", "select", "join", "where", "group by", "窗口函数", "分区", "索引", "执行计划"]),
        ("建模方法", ["维度", "事实表", "星型", "雪花", "拉链", "范式", "宽表", "数仓建模"]),
        ("指标口径", ["指标", "口径", "同比", "环比", "uv", "pv", "gmv", "转化率"]),
        ("数据质量问题", ["数据质量", "校验", "重复", "缺失", "空值", "异常", "对账"]),
        ("调度/任务问题", ["调度", "依赖", "airflow", "dolphinscheduler", "crontab", "任务", "失败重跑"]),
        ("报错与解决方案", ["error", "exception", "报错", "失败", "timeout", "oom", "权限不足"]),
        ("工具使用经验", ["hive", "spark", "flink", "clickhouse", "doris", "dbt", "superset", "tableau"]),
    ]
    tags = []
    for tag, keywords in rules:
        for keyword in keywords:
            if keyword in source:
                tags.append(tag)
                break
    return tags or ["概念解释"]


def sanitize_tags(value):
    if not isinstance(value, list):
        return []
    result = []
    seen = set()
    for item in value:
        tag = str(item or "").strip()
        if tag and tag not in seen:
            result.append(tag)
            seen.add(tag)
    return result


def strip_html(html):
    text = re.sub(r"<script[\s\S]*?</script>", " ", str(html or ""), flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def extract_meta(html, names):
    source = str(html or "")
    for name in names:
        patterns = [
            r'<meta[^>]+property=["\']%s["\'][^>]+content=["\']([\s\S]*?)["\'][^>]*>' % re.escape(name),
            r'<meta[^>]+name=["\']%s["\'][^>]+content=["\']([\s\S]*?)["\'][^>]*>' % re.escape(name),
            r'<meta[^>]+content=["\']([\s\S]*?)["\'][^>]+property=["\']%s["\'][^>]*>' % re.escape(name),
            r'<meta[^>]+content=["\']([\s\S]*?)["\'][^>]+name=["\']%s["\'][^>]*>' % re.escape(name),
        ]
        for pattern in patterns:
            match = re.search(pattern, source, flags=re.I)
            if match:
                value = unescape(match.group(1)).strip()
                if value:
                    return value
    return ""


def extract_title(html, fallback):
    meta_title = extract_meta(html, ["og:title", "twitter:title"])
    if meta_title:
        return meta_title[:120]
    match = re.search(r"<title[^>]*>([\s\S]*?)</title>", str(html or ""), flags=re.I)
    if match:
        title = strip_html(match.group(1))[:120]
        if title:
            return title
    h1 = re.search(r"<h1[^>]*>([\s\S]*?)</h1>", str(html or ""), flags=re.I)
    if h1:
        title = strip_html(h1.group(1))[:120]
        if title:
            return title
    return fallback


def remove_noisy_blocks(html):
    text = str(html or "")
    for tag in ["script", "style", "noscript", "svg", "canvas", "header", "footer", "nav", "aside"]:
        text = re.sub(r"<%s[\s\S]*?</%s>" % (tag, tag), " ", text, flags=re.I)
    return text


def extract_tag_blocks(html, tag):
    return re.findall(r"<%s\b[^>]*>([\s\S]*?)</%s>" % (tag, tag), str(html or ""), flags=re.I)


def meaningful_text_score(text):
    clean = re.sub(r"\s+", "", str(text or ""))
    chinese = len(re.findall(r"[\u4e00-\u9fa5]", clean))
    latin_words = len(re.findall(r"[A-Za-z0-9_]{3,}", clean))
    return chinese + latin_words


def extract_readable_content(html):
    source = remove_noisy_blocks(html)
    candidates = []
    for tag in ["article", "main"]:
        for block in extract_tag_blocks(source, tag):
            candidates.append(strip_html(block))
    for pattern in [
        r'<div[^>]+class=["\'][^"\']*(?:article|content|markdown|rich-text|doc|post|body)[^"\']*["\'][^>]*>([\s\S]*?)</div>',
        r'<section[^>]+class=["\'][^"\']*(?:article|content|markdown|rich-text|doc|post|body)[^"\']*["\'][^>]*>([\s\S]*?)</section>',
    ]:
        for block in re.findall(pattern, source, flags=re.I):
            candidates.append(strip_html(block))
    paragraphs = " ".join(strip_html(item) for item in re.findall(r"<p\b[^>]*>([\s\S]*?)</p>", source, flags=re.I))
    if paragraphs:
        candidates.append(paragraphs)
    description = extract_meta(html, ["description", "og:description", "twitter:description"])
    if description:
        candidates.append(description)
    candidates.append(strip_html(source))
    candidates = [re.sub(r"\s+", " ", item).strip() for item in candidates if item and meaningful_text_score(item) >= 40]
    if not candidates:
        return ""
    candidates.sort(key=lambda item: meaningful_text_score(item), reverse=True)
    return candidates[0][:12000]


def looks_like_auth_page(html, final_url):
    source = str(html or "")
    url = str(final_url or "")
    hard_auth_markers = [
        "accounts.feishu.cn",
        "请求以下飞书账号进行授权",
        "重新授权",
        "authen/v1/authorize",
        "请重新授权",
    ]
    shell_auth_markers = [
        "passportSettings",
        "oauth2/callback",
        "loginAppId",
        "passport_web_did",
        "deviceInfoBySSO",
    ]
    if any(marker in source or marker in url for marker in hard_auth_markers):
        return True
    if any(marker in source or marker in url for marker in shell_auth_markers):
        title_match = re.search(r"<title[^>]*>\s*</title>", source, flags=re.I)
        has_article_hint = re.search(r"<(?:article|main)\b|class=[\"'][^\"']*(?:article|content|markdown|rich-text|doc|post|body)", source, flags=re.I)
        if title_match and not has_article_hint:
            return True
    return False


def fetch_url(url):
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 LocalKnowledgeBase/0.1",
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
    )
    with urlopen(request, timeout=15) as response:
        final_url = response.geturl()
        raw = response.read(2 * 1024 * 1024)
        charset = response.headers.get_content_charset() or "utf-8"
        html = raw.decode(charset, errors="ignore")
        if looks_like_auth_page(html, final_url):
            raise LinkFetchError("该链接需要登录或飞书授权，本地后端无法直接读取正文。请在已登录浏览器中打开文章后复制正文导入，或提供公开可访问链接。", 422)
        content = extract_readable_content(html)
        if meaningful_text_score(content) < 40:
            raise LinkFetchError("没有从该链接解析到有效正文，已停止导入，避免把 URL 当作知识内容入库。", 422)
        return {"title": extract_title(html, url), "content": content}


def clean_qa_text(text):
    text = str(text or "").replace("[图片]", " ")
    text = text.replace("暂时无法在飞书文档外展示此内容", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def clean_section_title(title):
    title = clean_qa_text(title)
    title = re.sub(r"^\s*\d+\s*[.、]\s*", "", title)
    return title.strip(" ：:")


def split_sentences(text):
    result = []
    for item in re.findall(r"[^。！？.!?\n]+[。！？.!?]?", str(text or "")):
        item = clean_qa_text(item)
        if meaningful_text_score(item) >= 8:
            result.append(item)
    return result


def parse_knowledge_sections(content, fallback_title):
    sections = []
    current = None
    lines = [line.strip() for line in str(content or "").splitlines()]
    for line in lines:
        if not line:
            continue
        heading = re.match(r"^\s*(\d+)\s*[.、]\s*(.+)$", line)
        if heading:
            if current:
                sections.append(current)
            current = {"title": clean_section_title(heading.group(2)), "lines": []}
            continue
        if current is None:
            current = {"title": clean_section_title(fallback_title), "lines": []}
        current["lines"].append(line)
    if current:
        sections.append(current)
    if not sections:
        sections.append({"title": clean_section_title(fallback_title), "lines": [content]})
    for section in sections:
        section["body"] = "\n".join(section.get("lines", [])).strip()
    return sections


def extract_definition_pairs(lines):
    pairs = []
    for line in lines:
        clean = clean_qa_text(line)
        match = re.match(r"^([^：:]{1,30})[：:]\s*(.+)$", clean)
        if not match:
            continue
        key = clean_qa_text(match.group(1)).strip(" -")
        value = clean_qa_text(match.group(2))
        if key and value and key not in ["注"]:
            pairs.append((key, value))
    return pairs


def answer_from_sentences(sentences, max_count=2, max_len=320):
    answer = " ".join(sentences[:max_count])
    return summarize(clean_qa_text(answer), max_len)


def sentences_from_match(sentences, predicate, max_count=2):
    for index, sentence in enumerate(sentences):
        if predicate(sentence):
            return sentences[index : index + max_count]
    return []


def answer_from_pairs(pairs, max_len=420):
    answer = "\n".join(["%s：%s" % (key, value) for key, value in pairs])
    return summarize(answer, max_len)


def section_default_question(title):
    clean = clean_section_title(title)
    if not clean:
        return "这段知识的核心内容是什么？"
    if "、" in clean or "/" in clean:
        return "%s 分别是什么？" % clean
    return "%s 是什么？" % clean


QUESTION_CUES = [
    "什么",
    "为什么",
    "为何",
    "怎么",
    "如何",
    "哪些",
    "是否",
    "能否",
    "有没有",
    "讲讲",
    "讲下",
    "简述",
    "区别",
    "作用",
    "分几种",
    "评价",
    "衡量",
    "保证",
    "解决",
    "理解",
    "做没做过",
]


def looks_like_question_line(line):
    clean = clean_qa_text(line).strip()
    if not clean or len(clean) > 80:
        return False
    clean = re.sub(r"^\s*\d+\s*[.、]\s*", "", clean).strip()
    if not clean:
        return False
    if re.match(r"^[-•●○■]\s*", clean):
        return False
    if clean.endswith(("?", "？")):
        return True
    if "：" in clean or ":" in clean:
        return False
    if clean.endswith(("。", "！", "!", "；", ";", "：", ":")):
        return False
    if re.match(r"^[A-Za-z0-9_]{2,12}层$", clean):
        return False
    return any(cue in clean for cue in QUESTION_CUES)


def normalize_question_text(text):
    clean = clean_section_title(text).strip(" ？?")
    return clean + "？" if clean else ""


def extract_question_answer_blocks(content):
    blocks = []
    current = None
    for raw_line in str(content or "").splitlines():
        line = raw_line.strip()
        if not line:
            if current and current["answer_lines"]:
                current["answer_lines"].append("")
            continue
        if looks_like_question_line(line):
            if current:
                blocks.append(current)
            current = {"question": normalize_question_text(line), "answer_lines": []}
            continue
        if current:
            current["answer_lines"].append(line)
    if current:
        blocks.append(current)

    candidates = []
    for block in blocks:
        question = block.get("question") or ""
        answer = "\n".join(block.get("answer_lines") or []).strip()
        if question and meaningful_text_score(question) >= 4:
            candidates.append({"question": question, "answer": answer})
    return candidates


def build_entry(payload):
    content = str(payload.get("content") or "").strip()
    title = str(payload.get("title") or "").strip() or summarize(content, 42) or "未命名知识"
    tags = sanitize_tags(payload.get("tags"))
    current = now_iso()
    return {
        "id": make_id("entry"),
        "title": title,
        "content": content,
        "summary": str(payload.get("summary") or "").strip() or summarize(content),
        "sourceType": payload.get("sourceType") or "text",
        "sourceUrl": str(payload.get("sourceUrl") or "").strip(),
        "tags": tags,
        "createdAt": current,
        "updatedAt": current,
    }


def build_article(payload):
    title = str(payload.get("title") or "").strip()
    content = str(payload.get("content") or "").strip()
    tags = sanitize_tags(payload.get("tags"))
    plain_content = strip_html(content)
    current = now_iso()
    return {
        "id": make_id("article"),
        "title": title,
        "content": content,
        "summary": summarize(plain_content or content, 160),
        "tags": tags,
        "createdAt": current,
        "updatedAt": current,
    }


def generate_qas_for_entry(entry, existing_qas):
    candidates = extract_question_answer_blocks(entry.get("content"))
    has_question_blocks = bool(candidates)
    sections = parse_knowledge_sections(entry.get("content"), entry.get("title"))

    for section in sections:
        section_candidate_start = len(candidates)
        title = clean_section_title(section.get("title"))
        body = section.get("body") or ""
        lines = section.get("lines") or []
        sentences = split_sentences(body)
        pairs = extract_definition_pairs(lines)
        title_lower = title.lower()
        body_lower = body.lower()

        if "rdd" in title_lower or "rdd" in body_lower:
            for sentence in sentences:
                if "RDD是指" in sentence or "RDD 是指" in sentence:
                    candidates.append({"question": "什么是 RDD？", "answer": summarize(sentence, 260)})
                    break
            core_sentences = sentences_from_match(
                sentences,
                lambda item: "核心概念" in item or ("分区" in item and "计算函数" in item),
                2,
            )
            if core_sentences:
                candidates.append({"question": "RDD 的核心概念是什么？", "answer": answer_from_sentences(core_sentences, 2, 520)})
            source_index = -1
            for index, line in enumerate(lines):
                if "数据来源" in line:
                    source_index = index
                    break
            if source_index >= 0:
                bullets = []
                for line in lines[source_index + 1 :]:
                    if re.match(r"^\s*[-•]", line):
                        bullets.append(clean_qa_text(re.sub(r"^\s*[-•]\s*", "", line)))
                    elif bullets:
                        break
                if bullets:
                    candidates.append({"question": "RDD 的数据来源有哪些？", "answer": "\n".join(["- %s" % item for item in bullets])})

        if ("driver" in title_lower and "executor" in title_lower) or ("driver" in body_lower and "executor" in body_lower):
            driver_executor_pairs = [(key, value) for key, value in pairs if key.lower() in ["driver", "executor"]]
            if driver_executor_pairs:
                candidates.append(
                    {
                        "question": "Driver 和 Executor 分别负责什么？",
                        "answer": answer_from_pairs(driver_executor_pairs, 520),
                    }
                )

        dag_pairs = [(key, value) for key, value in pairs if key in ["Job", "Stage", "Task"]]
        if dag_pairs:
            candidates.append(
                {
                    "question": "Spark DAG 中 Job、Stage、Task 分别是什么？",
                    "answer": answer_from_pairs(dag_pairs, 620),
                }
            )

        if "spark作业执行" in title_lower or "spark 作业执行" in title_lower or "作业执行" in title:
            flow_sentences = [item for item in sentences if "执行流程" in item or "读取文件" in item or "分配到集群" in item]
            if flow_sentences:
                candidates.append({"question": "Spark 作业的执行流程是什么？", "answer": answer_from_sentences(flow_sentences, 3, 520)})
            relation_sentences = [item for item in sentences if "InputSplit" in item or "Partition" in item and "Task" in item]
            if relation_sentences:
                candidates.append({"question": "InputSplit、Partition 和 Task 的关系是什么？", "answer": answer_from_sentences(relation_sentences, 3, 520)})
            concurrency_sentences = [item for item in sentences if "并发度" in item or "core" in item and "Task" in item]
            if concurrency_sentences:
                candidates.append({"question": "Spark Task 的实际并发度如何计算？", "answer": answer_from_sentences(concurrency_sentences, 2, 420)})

        if (
            not has_question_blocks
            and len(candidates) == section_candidate_start
            and pairs
            and len(pairs) == 1
            and meaningful_text_score(pairs[0][1]) >= 20
        ):
            candidates.append({"question": "%s 是什么？" % pairs[0][0], "answer": pairs[0][1]})

        if not has_question_blocks and len(candidates) == section_candidate_start and title and sentences:
            candidates.append(
                {
                    "question": section_default_question(title),
                    "answer": answer_from_sentences(sentences, 2, 360),
                }
            )

    if not candidates:
        parts = split_sentences(entry.get("content"))
        if parts:
            candidates.append({"question": section_default_question(entry.get("title")), "answer": answer_from_sentences(parts, 3, 360)})

    result = []
    all_questions = [qa.get("question", "") for qa in existing_qas]
    for candidate in candidates:
        question = normalize_question_text(candidate.get("question"))
        answer = str(candidate.get("answer") or "").strip()
        if meaningful_text_score(question) < 4:
            continue
        duplicate = False
        normalized_question = normalize_question_text(candidate["question"])
        for existing_question in all_questions + [qa.get("question", "") for qa in result]:
            if is_duplicate_question(existing_question, normalized_question):
                duplicate = True
                break
        if duplicate:
            continue
        result.append(
            {
                "id": make_id("qa"),
                "question": normalized_question,
                "answer": answer,
                "entryId": entry["id"],
                "sourceTitle": entry["title"],
                "tags": entry["tags"],
                "confirmed": True,
                "autoGenerated": True,
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
            }
        )
    return result[:80]


def search_knowledge(db, query):
    hits = []
    for qa in db.get("qas", []):
        score = score_text(query, "%s %s %s" % (qa.get("question", ""), qa.get("answer", ""), " ".join(qa.get("tags", []))))
        if score > 0:
            hits.append(
                {
                    "type": "qa",
                    "id": qa.get("id"),
                    "title": qa.get("question"),
                    "answer": qa.get("answer"),
                    "score": score,
                    "sourceTitle": qa.get("sourceTitle"),
                    "entryId": qa.get("entryId"),
                    "tags": qa.get("tags", []),
                }
            )
    for entry in db.get("entries", []):
        score = score_text(
            query,
            "%s %s %s %s"
            % (entry.get("title", ""), entry.get("summary", ""), entry.get("content", ""), " ".join(entry.get("tags", []))),
        )
        if score > 0:
            hits.append(
                {
                    "type": "entry",
                    "id": entry.get("id"),
                    "title": entry.get("title"),
                    "answer": entry.get("summary") or summarize(entry.get("content"), 220),
                    "score": score,
                    "sourceTitle": entry.get("title"),
                    "entryId": entry.get("id"),
                    "tags": entry.get("tags", []),
                }
            )
    hits.sort(key=lambda item: item["score"], reverse=True)
    return hits[:8]


def external_search(query):
    url = "https://api.duckduckgo.com/?q=%s&format=json&no_html=1&skip_disambig=1" % quote(query)
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 LocalKnowledgeBase/0.1"})
    with urlopen(request, timeout=15) as response:
        data = json.loads(response.read().decode("utf-8", errors="ignore"))
    sources = []
    if data.get("AbstractText"):
        sources.append(
            {
                "title": data.get("Heading") or "DuckDuckGo 摘要",
                "url": data.get("AbstractURL") or "",
                "snippet": data.get("AbstractText"),
            }
        )
    related = data.get("RelatedTopics") if isinstance(data.get("RelatedTopics"), list) else []
    flattened = []
    for item in related:
        if isinstance(item, dict) and isinstance(item.get("Topics"), list):
            flattened.extend(item.get("Topics"))
        else:
            flattened.append(item)
    for item in flattened[:5]:
        if isinstance(item, dict) and item.get("Text"):
            sources.append(
                {
                    "title": item.get("Text", "").split(" - ")[0][:80],
                    "url": item.get("FirstURL") or "",
                    "snippet": item.get("Text"),
                }
            )
    return sources[:5]


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 8 * 1024 * 1024:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(raw or "{}")

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, file_path):
        with open(file_path, "rb") as file:
            body = file.read()
        ext = os.path.splitext(file_path)[1].lower()
        types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        }
        self.send_response(200)
        self.send_header("Content-Type", types.get(ext, "application/octet-stream"))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api("GET", parsed)
        if parsed.path.startswith("/uploads/"):
            safe_name = os.path.basename(unquote(parsed.path))
            full_path = os.path.abspath(os.path.join(UPLOAD_DIR, safe_name))
            if not full_path.startswith(os.path.abspath(UPLOAD_DIR)):
                return self.send_json(403, {"error": "Forbidden"})
            if not os.path.exists(full_path) or os.path.isdir(full_path):
                return self.send_json(404, {"error": "Not found"})
            return self.send_file(full_path)
        safe_path = "/index.html" if parsed.path == "/" else unquote(parsed.path)
        full_path = os.path.abspath(os.path.join(PUBLIC_DIR, safe_path.lstrip("/")))
        if not full_path.startswith(PUBLIC_DIR):
            return self.send_json(403, {"error": "Forbidden"})
        if not os.path.exists(full_path) or os.path.isdir(full_path):
            return self.send_json(404, {"error": "Not found"})
        return self.send_file(full_path)

    def do_POST(self):
        return self.handle_api("POST", urlparse(self.path))

    def do_PUT(self):
        return self.handle_api("PUT", urlparse(self.path))

    def do_DELETE(self):
        return self.handle_api("DELETE", urlparse(self.path))

    def handle_api(self, method, parsed):
        try:
            db = read_db()
            path = parsed.path
            query = parse_qs(parsed.query)

            if method == "GET" and path == "/api/state":
                return self.send_json(
                    200,
                    {
                        "entries": db.get("entries", []),
                        "qas": db.get("qas", []),
                        "articles": db.get("articles", []),
                        "categories": db.get("settings", {}).get("categories", CATEGORIES),
                    },
                )

            if method == "POST" and path == "/api/import":
                payload = self.read_json()
                if not sanitize_tags(payload.get("tags")):
                    return self.send_json(400, {"error": "导入知识必须至少指定一个标签。"})
                entry_payload = dict(payload)
                if payload.get("sourceType") == "link" and payload.get("sourceUrl"):
                    try:
                        fetched = fetch_url(payload.get("sourceUrl"))
                    except LinkFetchError as error:
                        return self.send_json(error.status, {"error": str(error)})
                    entry_payload["title"] = payload.get("title") or fetched["title"]
                    entry_payload["content"] = "\n\n".join([item for item in [payload.get("content"), fetched["content"]] if item])
                    if meaningful_text_score(entry_payload.get("content")) < 40:
                        return self.send_json(422, {"error": "链接正文为空或过短，已停止导入，避免生成无效 QA。"})
                entry = build_entry(entry_payload)
                qas = generate_qas_for_entry(entry, db.get("qas", []))
                db.setdefault("entries", []).insert(0, entry)
                db.setdefault("qas", []).extend(qas)
                write_db(db)
                return self.send_json(201, {"entry": entry, "qas": qas, "message": "已导入，并自动生成 %s 条 QA" % len(qas)})

            if method == "POST" and path == "/api/uploads":
                payload = self.read_json()
                try:
                    upload = build_upload(payload)
                except Exception as upload_error:
                    return self.send_json(400, {"error": str(upload_error)})
                return self.send_json(201, {"upload": upload})

            if method == "PUT" and path.startswith("/api/entries/"):
                payload = self.read_json()
                entry_id = path.split("/")[-1]
                entry = next((item for item in db.get("entries", []) if item.get("id") == entry_id), None)
                if not entry:
                    return self.send_json(404, {"error": "知识条目不存在"})
                entry["title"] = str(payload.get("title") or entry.get("title")).strip()
                entry["content"] = str(payload.get("content") or entry.get("content")).strip()
                entry["summary"] = str(payload.get("summary") or entry.get("summary") or "").strip() or summarize(entry.get("content"))
                if isinstance(payload.get("tags"), list):
                    entry["tags"] = sanitize_tags(payload.get("tags"))
                entry["updatedAt"] = now_iso()
                write_db(db)
                return self.send_json(200, {"entry": entry})

            if method == "DELETE" and path.startswith("/api/entries/"):
                entry_id = path.split("/")[-1]
                before = len(db.get("entries", []))
                db["entries"] = [item for item in db.get("entries", []) if item.get("id") != entry_id]
                db["qas"] = [item for item in db.get("qas", []) if item.get("entryId") != entry_id]
                write_db(db)
                return self.send_json(200, {"deleted": before - len(db.get("entries", []))})

            if method == "POST" and path == "/api/qas":
                payload = self.read_json()
                question = str(payload.get("question") or "").strip()
                answer = str(payload.get("answer") or "").strip()
                if not question or not answer:
                    return self.send_json(400, {"error": "问题和答案不能为空"})
                duplicate = next((qa for qa in db.get("qas", []) if is_duplicate_question(qa.get("question"), question)), None)
                if duplicate:
                    return self.send_json(409, {"error": "已存在相似问题", "duplicate": duplicate})
                qa = {
                    "id": make_id("qa"),
                    "question": question,
                    "answer": answer,
                    "entryId": payload.get("entryId") or "",
                    "sourceTitle": payload.get("sourceTitle") or "人工添加",
                    "tags": sanitize_tags(payload.get("tags")),
                    "confirmed": True,
                    "autoGenerated": False,
                    "createdAt": now_iso(),
                    "updatedAt": now_iso(),
                }
                db.setdefault("qas", []).append(qa)
                write_db(db)
                return self.send_json(201, {"qa": qa})

            if method == "PUT" and path.startswith("/api/qas/"):
                payload = self.read_json()
                qa_id = path.split("/")[-1]
                qa = next((item for item in db.get("qas", []) if item.get("id") == qa_id), None)
                if not qa:
                    return self.send_json(404, {"error": "QA 不存在"})
                next_question = str(payload.get("question") or qa.get("question")).strip()
                duplicate = next(
                    (item for item in db.get("qas", []) if item.get("id") != qa_id and similarity(item.get("question"), next_question) >= 0.72),
                    None,
                )
                if duplicate:
                    return self.send_json(409, {"error": "已存在相似问题", "duplicate": duplicate})
                qa["question"] = next_question
                qa["answer"] = str(payload.get("answer") or qa.get("answer")).strip()
                if isinstance(payload.get("tags"), list):
                    qa["tags"] = sanitize_tags(payload.get("tags"))
                if "confirmed" in payload:
                    qa["confirmed"] = bool(payload.get("confirmed"))
                qa["updatedAt"] = now_iso()
                write_db(db)
                return self.send_json(200, {"qa": qa})

            if method == "DELETE" and path.startswith("/api/qas/"):
                qa_id = path.split("/")[-1]
                before = len(db.get("qas", []))
                db["qas"] = [item for item in db.get("qas", []) if item.get("id") != qa_id]
                write_db(db)
                return self.send_json(200, {"deleted": before - len(db.get("qas", []))})

            if method == "POST" and path == "/api/articles":
                payload = self.read_json()
                if not str(payload.get("title") or "").strip():
                    return self.send_json(400, {"error": "文章标题不能为空"})
                if not str(payload.get("content") or "").strip():
                    return self.send_json(400, {"error": "文章内容不能为空"})
                if not sanitize_tags(payload.get("tags")):
                    return self.send_json(400, {"error": "文章必须至少指定一个标签"})
                article = build_article(payload)
                db.setdefault("articles", []).insert(0, article)
                write_db(db)
                return self.send_json(201, {"article": article})

            if method == "PUT" and path.startswith("/api/articles/"):
                payload = self.read_json()
                article_id = path.split("/")[-1]
                article = next((item for item in db.get("articles", []) if item.get("id") == article_id), None)
                if not article:
                    return self.send_json(404, {"error": "文章不存在"})
                title = str(payload.get("title") or "").strip()
                content = str(payload.get("content") or "").strip()
                if not title:
                    return self.send_json(400, {"error": "文章标题不能为空"})
                if not content:
                    return self.send_json(400, {"error": "文章内容不能为空"})
                tags = sanitize_tags(payload.get("tags")) if isinstance(payload.get("tags"), list) else article.get("tags", [])
                if not tags:
                    return self.send_json(400, {"error": "文章必须至少指定一个标签"})
                article["title"] = title
                article["content"] = content
                plain_content = strip_html(content)
                article["summary"] = summarize(plain_content or content, 160)
                article["tags"] = tags
                article["updatedAt"] = now_iso()
                write_db(db)
                return self.send_json(200, {"article": article})

            if method == "DELETE" and path.startswith("/api/articles/"):
                article_id = path.split("/")[-1]
                before = len(db.get("articles", []))
                db["articles"] = [item for item in db.get("articles", []) if item.get("id") != article_id]
                write_db(db)
                return self.send_json(200, {"deleted": before - len(db.get("articles", []))})

            if method == "GET" and path == "/api/random-qa":
                count = max(1, min(20, int(query.get("count", ["1"])[0])))
                tag = query.get("tag", [""])[0]
                pool = [qa for qa in db.get("qas", []) if not tag or tag in qa.get("tags", [])]
                random.shuffle(pool)
                return self.send_json(200, {"qas": pool[:count]})

            if method == "POST" and path == "/api/ask":
                payload = self.read_json()
                user_query = str(payload.get("query") or "").strip()
                if not user_query:
                    return self.send_json(400, {"error": "问题不能为空"})
                hits = search_knowledge(db, user_query)
                strong_hits = [hit for hit in hits if hit.get("score", 0) >= 4][:5]
                if strong_hits:
                    answer = "\n".join(["%s. %s" % (index + 1, hit.get("answer")) for index, hit in enumerate(strong_hits[:3])])
                    return self.send_json(200, {"mode": "knowledge", "answer": answer, "sources": strong_hits, "externalSources": []})
                try:
                    external_sources = external_search(user_query)
                    external_error = ""
                except Exception as external_exception:
                    external_sources = []
                    external_error = str(external_exception) or "外部搜索请求失败"
                answer = (
                    "\n".join(["%s. %s" % (index + 1, source.get("snippet")) for index, source in enumerate(external_sources)])
                    if external_sources
                    else ("知识库未命中，且外部搜索失败：%s" % external_error if external_error else "知识库未命中，外部搜索也没有返回可用摘要。建议换一个更具体的问题。")
                )
                return self.send_json(200, {"mode": "external", "answer": answer, "sources": hits[:3], "externalSources": external_sources})

            return self.send_json(404, {"error": "接口不存在"})
        except Exception as error:
            return self.send_json(500, {"error": str(error)})


if __name__ == "__main__":
    ensure_db()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("Local knowledge base is running at http://127.0.0.1:%s" % PORT)
    server.serve_forever()
