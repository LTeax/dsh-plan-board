/**
 * Host half of the plan-board bundle.
 *
 * One JSON document per project, all under a boards directory
 * (`$DSH_HOME/plan-board/<slug>.json` by default). A board is addressed by its
 * slug, so no single file has to hold every project.
 *
 * Config (row config in cordis.patch.yml):
 *   boardsDir - absolute path of the boards directory. Defaults to
 *               $DSH_HOME/plan-board. A pre-boards `$DSH_HOME/plan-board.json`
 *               is migrated once into `default.json`.
 *
 * The agent reaches the board through the `plan_board` tool (and the same
 * write through POST /plan-board/item): the boards directory lives outside the
 * workspace, so the agent's own file tools cannot write there under the default
 * workspace-write sandbox. Hand-editing the JSON still works when it can.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'plan-board';
export const inject = ['webServer', 'tools'];

const PARTS = ['long', 'mid', 'short', 'idea', 'advice'];
const TOOL_ACTIONS = ['list', 'read', 'add', 'update', 'toggle'];
const DEFAULT_TITLES = { long: '长期', mid: '中期', short: '短期', idea: '预想', advice: 'agent 建议' };
// 每个分区一个字母前缀：L3 / S11 / A2 这类短编号，人和 agent 都能直接说出来、直接检索。
const PART_LETTERS = { long: 'L', mid: 'M', short: 'S', idea: 'I', advice: 'A' };
const LETTERS = PARTS.map((part) => PART_LETTERS[part]);
const CODE_RE = /^[A-Z]\d{1,3}$/;
const MAX_BODY = 1024 * 1024;
const BOARD_FILE = /\.json$/i;

function expandHome(value) {
  return value.replace(/^~(?=$|[\\/])/, os.homedir());
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function resolveBoardsDir(config) {
  const configured = config && typeof config.boardsDir === 'string' ? config.boardsDir.trim() : '';
  if (configured) return path.resolve(expandHome(configured));
  return path.join(dshHome(), 'plan-board');
}

/** Board slugs are file names: keep them readable, only strip path-hostile characters. */
function toSlug(title) {
  return String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim();
}

function emptyDoc(title) {
  const sections = {};
  for (const part of PARTS) sections[part] = { title: DEFAULT_TITLES[part], items: [] };
  const codeSeq = {};
  for (const letter of LETTERS) codeSeq[letter] = 0;
  return {
    version: 1,
    title: title || '未命名',
    updatedAt: new Date().toISOString(),
    sections,
    // 已完成并"收集"起来的条目。元素带 part（原分区）与时间戳，主列表不再包含它们。
    archive: [],
    // 各字母的编号高水位：删掉条目也不回退，引用过的编号永远指同一件事。
    codeSeq,
  };
}

function normalizeItem(item, part, index) {
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `${part}-${index + 1}`,
    // 短编号（S3 这种），由 assignCodes 保证不重复；手写的非法编号会被替换。
    code: typeof item.code === 'string' ? item.code : '',
    text: item.text,
    done: item.done === true,
    // 1 = 最高，3 = 最低，0 = 未设。只认整数 1..3，其余一律当未设。
    priority: Number.isInteger(item.priority) && item.priority >= 1 && item.priority <= 3 ? item.priority : 0,
    note: typeof item.note === 'string' ? item.note : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    steps: Array.isArray(item.steps)
      ? item.steps
          .filter((step) => step && typeof step.text === 'string')
          .map((step) => ({ text: step.text, done: step.done === true }))
      : [],
  };
}

/**
 * 给每条待办发一个「分区字母 + 序号」的短编号：长期 L、中期 M、短期 S、预想 I、建议 A。
 * 规则：
 *   - 已经写好的合法编号原地保留（字母要和分区对得上、全板不重复），引用过的号不搬家；
 *   - 缺号、错字母、重复的编号在这里改掉，从该字母的高水位继续发；
 *   - 归档条目照样占号，提出时（restore）尽量回到原编号。
 * 老文档第一次被读到时补号并立即写回，agent 直接在文件里就能按编号检索。
 */
function assignCodes(doc, stats) {
  const marks = {};
  for (const letter of LETTERS) {
    const value = doc.codeSeq && doc.codeSeq[letter];
    marks[letter] = Number.isInteger(value) && value > 0 ? value : 0;
  }
  const taken = new Set();
  const keep = (entry, letter) => {
    const code = typeof entry.code === 'string' ? entry.code : '';
    if (!CODE_RE.test(code) || code[0] !== letter || taken.has(code)) return false;
    taken.add(code);
    marks[letter] = Math.max(marks[letter], Number(code.slice(1)));
    return true;
  };
  // 先认领全板已写好的编号，再发新号：这样已引用的号不会因为新增条目而变。
  for (const part of PARTS) {
    for (const item of doc.sections[part].items) if (!keep(item, PART_LETTERS[part])) item.code = '';
  }
  for (const entry of doc.archive) if (!keep(entry, PART_LETTERS[entry.part] || 'A')) entry.code = '';

  const issue = (entry, letter) => {
    marks[letter] += 1;
    entry.code = `${letter}${marks[letter]}`;
    taken.add(entry.code);
    if (stats) stats.assigned += 1;
  };
  for (const part of PARTS) {
    for (const item of doc.sections[part].items) if (!item.code) issue(item, PART_LETTERS[part]);
  }
  for (const entry of doc.archive) if (!entry.code) issue(entry, PART_LETTERS[entry.part] || 'A');

  doc.codeSeq = marks;
  return doc;
}

/** Coerce whatever is on disk into the shape the client renders, without inventing items. */
function normalize(raw, fallbackTitle, stats) {
  const doc = emptyDoc(fallbackTitle);
  if (!raw || typeof raw !== 'object') return doc;
  if (typeof raw.title === 'string' && raw.title.trim()) doc.title = raw.title;
  if (typeof raw.updatedAt === 'string') doc.updatedAt = raw.updatedAt;
  if (raw.codeSeq && typeof raw.codeSeq === 'object') {
    for (const letter of LETTERS) {
      const value = raw.codeSeq[letter];
      if (Number.isInteger(value) && value > 0) doc.codeSeq[letter] = value;
    }
  }
  const src = raw.sections && typeof raw.sections === 'object' ? raw.sections : {};
  for (const part of PARTS) {
    const section = src[part];
    if (!section || typeof section !== 'object') continue;
    if (typeof section.title === 'string' && section.title.trim()) doc.sections[part].title = section.title;
    const items = Array.isArray(section.items) ? section.items : [];
    doc.sections[part].items = items
      .filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
      .map((item, index) => normalizeItem(item, part, index));
  }
  const archived = Array.isArray(raw.archive) ? raw.archive : [];
  doc.archive = archived
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.text === 'string' && PARTS.includes(entry.part))
    .map((entry, index) => ({
      ...normalizeItem(entry, entry.part, index),
      aid: typeof entry.aid === 'string' && entry.aid ? entry.aid : `a-${index + 1}`,
      part: entry.part,
      completedAt: typeof entry.completedAt === 'string' ? entry.completedAt : '',
      archivedAt: typeof entry.archivedAt === 'string' ? entry.archivedAt : '',
    }));
  assignCodes(doc, stats);
  return doc;
}

/**
 * Layout is one directory per project: <boardsDir>/<project>/<plan>.json.
 * Every call migrates leftovers from the two older layouts first, so a
 * half-migrated directory never hides a board.
 */
function migrateLayout(dir) {
  // 1) pre-boards single file at $DSH_HOME/plan-board.json -> default/main.json
  const legacy = path.join(dshHome(), 'plan-board.json');
  try {
    if (fs.existsSync(legacy)) {
      const projectDir = path.join(dir, 'default');
      fs.mkdirSync(projectDir, { recursive: true });
      const target = path.join(projectDir, 'main.json');
      if (!fs.existsSync(target)) fs.copyFileSync(legacy, target);
    }
  } catch {
    /* best effort: the legacy file stays where it is */
  }
  // 2) flat <name>.json files at the root -> <name>/main.json
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!BOARD_FILE.test(name)) continue;
    const from = path.join(dir, name);
    try {
      if (!fs.statSync(from).isFile()) continue;
      const project = toSlug(name.replace(BOARD_FILE, '')) || 'default';
      const projectDir = path.join(dir, project);
      fs.mkdirSync(projectDir, { recursive: true });
      const target = path.join(projectDir, 'main.json');
      if (!fs.existsSync(target)) fs.renameSync(from, target);
    } catch {
      /* leave an unmovable file alone; it stays visible on the next scan */
    }
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  migrateLayout(dir);
}

/** Every `<project>/<plan>.json` under the boards directory. */
function plansOf(dir) {
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    let files = [];
    try {
      files = fs.readdirSync(path.join(dir, entry.name));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!BOARD_FILE.test(file)) continue;
      out.push({
        project: entry.name,
        plan: file.replace(BOARD_FILE, ''),
        file: path.join(dir, entry.name, file),
      });
    }
  }
  return out;
}

function listBoards(dir) {
  ensureDir(dir);
  return plansOf(dir)
    .map(({ project, plan, file }) => {
      let title = plan;
      let updatedAt = '';
      let count = 0;
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof doc.title === 'string' && doc.title.trim()) title = doc.title;
        if (typeof doc.updatedAt === 'string') updatedAt = doc.updatedAt;
        count = PARTS.reduce(
          (total, part) => total + (Array.isArray(doc.sections?.[part]?.items) ? doc.sections[part].items.length : 0),
          0,
        );
      } catch {
        title = `${plan}（无法解析）`;
      }
      return { slug: `${project}/${plan}`, project, plan, title, updatedAt, count };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** `<project>/<plan>` -> parts; anything else is rejected rather than guessed. */
function parseSlug(slug) {
  const parts = String(slug || '').split('/');
  if (parts.length !== 2) return null;
  const project = toSlug(parts[0]);
  const plan = toSlug(parts[1]);
  if (!project || !plan) return null;
  return { project, plan };
}

function readBoard(dir, slug, options) {
  const create = Boolean(options && options.create);
  ensureDir(dir);
  const parsed = parseSlug(slug);
  if (!parsed) return { ok: false, slug, error: `不合法的计划标识：${slug}（应为 项目/计划）` };
  const file = path.join(dir, parsed.project, `${parsed.plan}.json`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      // 读路径绝不建文件：面板每 3 秒拉一次状态，ENOENT 时写回空板会把
      // 刚删掉的计划书原地复活。只有显式写入（add / 新建 / POST item）才建。
      if (!create) {
        return { ok: false, slug, missing: true, error: `计划书不存在：${slug}（已被删除，或还没新建）` };
      }
      const doc = emptyDoc(parsed.plan);
      writeBoard(dir, slug, doc);
      return { ok: true, slug, doc, created: true };
    }
    return { ok: false, slug, error: `读取失败：${error && error.message}` };
  }
  try {
    const stats = { assigned: 0 };
    const doc = normalize(JSON.parse(text), parsed.plan, stats);
    // 老文档第一次读到就补编号，并立刻落盘，让 agent 在文件里也能按编号检索。
    if (stats.assigned > 0) {
      try {
        writeBoard(dir, slug, doc);
      } catch {
        /* 落盘失败不要紧，下一次读取会再补一遍 */
      }
    }
    return { ok: true, slug, doc };
  } catch (error) {
    // Never overwrite a document we cannot parse: it may be hand-edited.
    return { ok: false, slug, error: `${slug}.json 解析失败：${error && error.message}` };
  }
}

function writeBoard(dir, slug, doc) {
  ensureDir(dir);
  const parsed = parseSlug(slug);
  if (!parsed) throw new Error(`不合法的计划标识：${slug}`);
  const projectDir = path.join(dir, parsed.project);
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${parsed.plan}.json`);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function isLoopback(req) {
  const address = (req.socket && req.socket.remoteAddress) || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function rejectWrite(req) {
  if (!isLoopback(req)) return '只接受本机请求';
  const site = req.headers && req.headers['sec-fetch-site'];
  if (site === 'cross-site') return '拒绝跨站写入';
  return '';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Flip one done flag: a whole item, or one of its steps. */
function toggle(doc, part, id, stepIndex) {
  const section = doc.sections[part];
  if (!section) throw new Error(`未知分区：${part}`);
  const item = section.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`未找到条目：${id}`);
  const now = new Date().toISOString();
  if (stepIndex === undefined || stepIndex === null) {
    item.done = !item.done;
    // Ticking an item means its own steps are done; unticking leaves steps alone
    // so a partially-advanced item does not silently rewind.
    if (item.done) for (const step of item.steps) step.done = true;
  } else {
    const step = item.steps[Number(stepIndex)];
    if (!step) throw new Error(`未找到子步骤：${stepIndex}`);
    step.done = !step.done;
    if (item.steps.length > 0) item.done = item.steps.every((entry) => entry.done);
  }
  item.updatedAt = now;
  doc.updatedAt = now;
}

function boardFromUrl(rawUrl) {
  const query = String(rawUrl || '').split('?')[1] || '';
  const board = new URLSearchParams(query).get('board');
  return board && board.trim() ? board.trim() : '';
}

/** A missing `board` falls back to the first known board, then to default/main. */
function resolveSlug(dir, requested) {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  const boards = listBoards(dir);
  return (boards[0] && boards[0].slug) || 'default/main';
}

function archiveId() {
  return `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 把一条已完成的条目移出主列表、放进归档。 */
function collect(doc, part, id) {
  const section = doc.sections[part];
  if (!section) throw new Error(`未知分区：${part}`);
  const index = section.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`未找到条目：${id}`);
  const item = section.items[index];
  if (!item.done) throw new Error('只有已完成的条目才能收集');
  const now = new Date().toISOString();
  section.items.splice(index, 1);
  doc.archive.unshift({
    ...item,
    aid: archiveId(),
    part,
    // 完成时间用最后一次状态变更粗略代表（勾选完成时 updatedAt 就是那一刻）。
    completedAt: item.updatedAt || now,
    archivedAt: now,
  });
  doc.updatedAt = now;
}

/** 把归档条目放回原分区，并重新打开（done 归 false）。 */
function restore(doc, aid) {
  const index = doc.archive.findIndex((entry) => entry.aid === aid);
  if (index < 0) throw new Error(`未找到归档条目：${aid}`);
  const [entry] = doc.archive.splice(index, 1);
  const section = doc.sections[entry.part];
  if (!section) throw new Error(`未知分区：${entry.part}`);
  const taken = new Set(section.items.map((item) => item.id));
  let id = entry.id || `${entry.part}-restored`;
  if (taken.has(id)) id = `${id}-r${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  section.items.push({
    id,
    // 编号跟着条目走：提出来的还是原来的号，除非那个号已经被别人占了。
    code: typeof entry.code === 'string' ? entry.code : '',
    text: entry.text,
    done: false,
    priority: entry.priority || 0,
    note: entry.note || '',
    updatedAt: now,
    steps: (entry.steps || []).map((step) => ({ text: step.text, done: false })),
  });
  assignCodes(doc);
  doc.updatedAt = now;
}

/** 追加一条待办并立刻发编号；text 是唯一必填内容。 */
function addItem(doc, part, input) {
  const section = doc.sections[part];
  if (!section) throw new Error(`未知分区：${part}`);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('缺少条目正文 text');
  const now = new Date().toISOString();
  const item = {
    // 不能再用 <分区>-<序号>：agent 和工作区外的调用方都会加条目，序号会撞。
    id: `${part}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    code: '',
    text,
    done: false,
    priority: Number.isInteger(input.priority) && input.priority >= 1 && input.priority <= 3 ? input.priority : 0,
    note: typeof input.note === 'string' ? input.note.trim() : '',
    updatedAt: now,
    steps: Array.isArray(input.steps)
      ? input.steps
          .filter((step) => typeof step === 'string' && step.trim())
          .map((step) => ({ text: step.trim(), done: false }))
      : [],
  };
  section.items.push(item);
  assignCodes(doc);
  doc.updatedAt = now;
  return item;
}

/** 按编号（S11）或 id 定位条目；给了 part 就只在该分区里找。 */
function locateItem(doc, { part, code, id }) {
  if (code && !CODE_RE.test(code)) throw new Error(`编号格式不对：${code}（应形如 S11、L3）`);
  if (!code && !id) throw new Error('需要 code 或 id 才能定位条目');
  const parts = part ? [part] : PARTS;
  for (const name of parts) {
    const section = doc.sections[name];
    if (!section) throw new Error(`未知分区：${name}`);
    for (const item of section.items) {
      if (code ? item.code === code : item.id === id) return { part: name, item };
    }
  }
  throw new Error(code ? `看板上没有编号 ${code} 的条目` : `看板上没有 id ${id} 的条目`);
}

/** 只改显式传入的字段；steps 传字符串数组时整体替换并重置进度。 */
function patchItem(doc, target, patch) {
  const { item } = target;
  const now = new Date().toISOString();
  if (typeof patch.text === 'string' && patch.text.trim()) item.text = patch.text.trim();
  if (typeof patch.note === 'string') item.note = patch.note.trim();
  if (Number.isInteger(patch.priority) && patch.priority >= 0 && patch.priority <= 3) item.priority = patch.priority;
  if (typeof patch.done === 'boolean') {
    item.done = patch.done;
    if (item.done) for (const step of item.steps) step.done = true;
  }
  if (Array.isArray(patch.steps)) {
    item.steps = patch.steps
      .map((step) =>
        typeof step === 'string'
          ? { text: step.trim(), done: false }
          : step && typeof step.text === 'string'
            ? { text: step.text.trim(), done: step.done === true }
            : null,
      )
      .filter((step) => step && step.text);
  }
  item.updatedAt = now;
  doc.updatedAt = now;
  return item;
}

/** agent/工具看到的条目形状：编号在前，进度用 [x] 标出来。 */
function viewItem(item) {
  return {
    code: item.code,
    text: item.text,
    done: item.done === true,
    ...(item.priority ? { priority: item.priority } : {}),
    ...(item.note ? { note: item.note } : {}),
    ...(item.steps.length ? { steps: item.steps.map((step) => `${step.done ? '[x]' : '[ ]'} ${step.text}`) } : {}),
  };
}

function viewBoard(doc, slug) {
  const sections = {};
  for (const part of PARTS) {
    sections[part] = { title: doc.sections[part].title, items: doc.sections[part].items.map(viewItem) };
  }
  return { board: slug, title: doc.title, updatedAt: doc.updatedAt, sections, archived: doc.archive.length };
}

/**
 * 工具/路由没给 board 时：只有一份计划书就用它，一份都没有就用 default/main，
 * 有多份就报错让调用方指名——比默默挑"最近改过的"更容易让人发现写错了板子。
 */
function pickBoard(dir, requested) {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  const boards = listBoards(dir);
  if (boards.length === 0) return 'default/main';
  if (boards.length === 1) return boards[0].slug;
  throw new Error(`这里有多份计划书，请用 board 指明：${boards.map((board) => board.slug).join('、')}`);
}

/**
 * agent 工具。宿主进程自己写盘，绕开 workspace-write 沙箱；描述里写清楚
 * "要写计划的时候就写进看板"，这是模型唯一会读到的触发面。
 */
function registerPlanBoardTool(ctx, boardsDir) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'plan_board',
      description:
        'Read and change the user\'s plan board — the right-sidebar panel where they keep plans, one board per project. Use it whenever the user asks for a plan, roadmap, schedule, phase breakdown, or TODO list, and whenever you finish or advance such work: add the items to the board instead of creating a separate plan or TODO markdown file, then keep their status current as you go. Boards are named "<project>/<plan>" such as "m10264/csv-editor"; action=list shows them, and board may be omitted only when exactly one exists. Sections: long 长期, mid 中期, short 短期 are dated horizons; idea 预想 holds uncommitted ideas; advice agent 建议 is where your own proposals go. Every item carries a short code such as S11 or L3 — use that code in later calls and when replying to the user. Read the board before writing so existing wording and order survive. One item is one line of work; note holds a short detail, steps holds the sub-steps.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: TOOL_ACTIONS,
            description: 'list = every board; read = one board; add = append an item; update = change fields of one item; toggle = flip one item\'s done flag.',
          },
          board: {
            type: 'string',
            description: '"<project>/<plan>" from action=list. Omit only when exactly one board exists.',
          },
          part: {
            type: 'string',
            enum: PARTS,
            description: 'Board section. Required for add; optional for update/toggle, which then find the item by code across sections. long=长期, mid=中期, short=短期, idea=预想, advice=agent 建议.',
          },
          code: {
            type: 'string',
            description: 'Item code such as S11 or L3, as shown on the board. Required for update/toggle unless id is given.',
          },
          id: {
            type: 'string',
            description: 'Internal item id. Prefer code.',
          },
          text: {
            type: 'string',
            description: 'Item text: one line, imperative. Required for add; for update it replaces the text.',
          },
          note: {
            type: 'string',
            description: 'Optional one-line detail shown under the item text.',
          },
          priority: {
            type: 'integer',
            enum: [0, 1, 2, 3],
            description: '1 high, 2 medium, 3 low, 0 unset.',
          },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Sub-steps. On update they replace the existing steps and reset their progress.',
          },
          done: {
            type: 'boolean',
            description: 'For update: set completion explicitly instead of flipping it.',
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const action = args.action;
        if (!TOOL_ACTIONS.includes(action)) throw new Error(`action 只能是 ${TOOL_ACTIONS.join(' / ')}`);
        if (action === 'list') {
          const boards = listBoards(boardsDir).map(({ slug, title, count, updatedAt }) => ({
            board: slug,
            title,
            items: count,
            updatedAt,
          }));
          return JSON.stringify({ dir: boardsDir, boards });
        }
        const slug = pickBoard(boardsDir, args.board);
        // 只有 add 是显式写入，允许顺手建板；read / update / toggle 遇到缺失就报错。
        const current = readBoard(boardsDir, slug, { create: action === 'add' });
        if (!current.ok) throw new Error(current.error || `读取 ${slug} 失败`);
        const doc = current.doc;
        if (action === 'read') return JSON.stringify(viewBoard(doc, slug));
        if (action === 'add') {
          if (!PARTS.includes(args.part)) throw new Error(`add 需要 part，取 ${PARTS.join(' / ')} 之一`);
          const item = addItem(doc, args.part, args);
          writeBoard(boardsDir, slug, doc);
          return JSON.stringify({ board: slug, part: args.part, added: viewItem(item) });
        }
        const target = locateItem(doc, { part: args.part, code: args.code, id: args.id });
        if (action === 'toggle') {
          target.item.done = !target.item.done;
          if (target.item.done) for (const step of target.item.steps) step.done = true;
          target.item.updatedAt = new Date().toISOString();
          doc.updatedAt = target.item.updatedAt;
        } else {
          patchItem(doc, target, args);
        }
        writeBoard(boardsDir, slug, doc);
        return JSON.stringify({ board: slug, part: target.part, item: viewItem(target.item) });
      },
    }),
  );
}

export function apply(ctx, config) {
  const boardsDir = resolveBoardsDir(config);

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plan-board/boards.json',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: '只支持 GET' });
        sendJson(res, 200, { ok: true, dir: boardsDir, boards: listBoards(boardsDir) });
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plan-board/state.json',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: '只支持 GET' });
        const boards = listBoards(boardsDir);
        const slug = boardFromUrl(req.url) || (boards[0] && boards[0].slug) || 'default/main';
        const result = readBoard(boardsDir, slug);
        // 读接口不建文件：面板每 3 秒轮询一次，把 ENOENT 当成"建一块空板"会让
        // 删掉的计划书在下次轮询时原地复活（计划书被删、面板还开着时必现）。
        sendJson(res, result.ok ? 200 : result.missing ? 404 : 500, { ...result, boards, dir: boardsDir });
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plan-board/toggle',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
        const denied = rejectWrite(req);
        if (denied) return sendJson(res, 403, { ok: false, error: denied });
        try {
          const body = await readBody(req);
          const { board, part, id, step } = body || {};
          if (!PARTS.includes(part)) return sendJson(res, 400, { ok: false, error: '未知分区' });
          if (typeof id !== 'string' || !id) return sendJson(res, 400, { ok: false, error: '缺少条目 id' });
          const slug = resolveSlug(boardsDir, board);
          const current = readBoard(boardsDir, slug);
          if (!current.ok) return sendJson(res, current.missing ? 404 : 409, current);
          toggle(current.doc, part, id, step);
          writeBoard(boardsDir, slug, current.doc);
          sendJson(res, 200, { ok: true, slug, doc: current.doc, boards: listBoards(boardsDir) });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plan-board/board',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
        const denied = rejectWrite(req);
        if (denied) return sendJson(res, 403, { ok: false, error: denied });
        try {
          const body = await readBody(req);
          const project = toSlug(typeof body.project === 'string' ? body.project.trim() : '');
          const plan = toSlug(typeof body.plan === 'string' ? body.plan.trim() : '');
          const title =
            typeof body.title === 'string' && body.title.trim() ? body.title.trim() : plan;
          if (!project || !plan) {
            return sendJson(res, 400, { ok: false, error: '项目名和计划名都不能为空' });
          }
          const file = path.join(boardsDir, project, `${plan}.json`);
          if (fs.existsSync(file)) {
            return sendJson(res, 409, { ok: false, error: `项目「${project}」下已有计划「${plan}」` });
          }
          const slug = `${project}/${plan}`;
          const doc = emptyDoc(title);
          writeBoard(boardsDir, slug, doc);
          sendJson(res, 200, { ok: true, slug, doc, boards: listBoards(boardsDir) });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plan-board/priority',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
        const denied = rejectWrite(req);
        if (denied) return sendJson(res, 403, { ok: false, error: denied });
        try {
          const body = await readBody(req);
          const { board, part, id, priority } = body || {};
          if (!PARTS.includes(part)) return sendJson(res, 400, { ok: false, error: '未知分区' });
          if (typeof id !== 'string' || !id) return sendJson(res, 400, { ok: false, error: '缺少条目 id' });
          const next = Number(priority);
          if (![0, 1, 2, 3].includes(next)) return sendJson(res, 400, { ok: false, error: 'priority 只能是 0..3' });
          const slug = resolveSlug(boardsDir, board);
          const current = readBoard(boardsDir, slug);
          if (!current.ok) return sendJson(res, current.missing ? 404 : 409, current);
          const item = current.doc.sections[part].items.find((candidate) => candidate.id === id);
          if (!item) return sendJson(res, 404, { ok: false, error: `未找到条目：${id}` });
          item.priority = next;
          item.updatedAt = new Date().toISOString();
          current.doc.updatedAt = item.updatedAt;
          writeBoard(boardsDir, slug, current.doc);
          sendJson(res, 200, { ok: true, slug, doc: current.doc, boards: listBoards(boardsDir) });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plan-board/collect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
        const denied = rejectWrite(req);
        if (denied) return sendJson(res, 403, { ok: false, error: denied });
        try {
          const body = await readBody(req);
          const { board, part, id } = body || {};
          if (!PARTS.includes(part)) return sendJson(res, 400, { ok: false, error: '未知分区' });
          if (typeof id !== 'string' || !id) return sendJson(res, 400, { ok: false, error: '缺少条目 id' });
          const slug = resolveSlug(boardsDir, board);
          const current = readBoard(boardsDir, slug);
          if (!current.ok) return sendJson(res, current.missing ? 404 : 409, current);
          collect(current.doc, part, id);
          writeBoard(boardsDir, slug, current.doc);
          sendJson(res, 200, { ok: true, slug, doc: current.doc, boards: listBoards(boardsDir) });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plan-board/restore',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
        const denied = rejectWrite(req);
        if (denied) return sendJson(res, 403, { ok: false, error: denied });
        try {
          const body = await readBody(req);
          const { board, aid } = body || {};
          if (typeof aid !== 'string' || !aid) return sendJson(res, 400, { ok: false, error: '缺少归档 id' });
          const slug = resolveSlug(boardsDir, board);
          const current = readBoard(boardsDir, slug);
          if (!current.ok) return sendJson(res, current.missing ? 404 : 409, current);
          restore(current.doc, aid);
          writeBoard(boardsDir, slug, current.doc);
          sendJson(res, 200, { ok: true, slug, doc: current.doc, boards: listBoards(boardsDir) });
        } catch (error) {
          sendJson(res, 404, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plan-board/item',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
        const denied = rejectWrite(req);
        if (denied) return sendJson(res, 403, { ok: false, error: denied });
        try {
          const body = await readBody(req);
          const part = body && body.part;
          if (!PARTS.includes(part)) return sendJson(res, 400, { ok: false, error: '未知分区' });
          const slug = pickBoard(boardsDir, body.board);
          const current = readBoard(boardsDir, slug, { create: true });
          if (!current.ok) return sendJson(res, 404, current);
          const item = addItem(current.doc, part, body);
          writeBoard(boardsDir, slug, current.doc);
          sendJson(res, 200, { ok: true, slug, item: viewItem(item), doc: current.doc });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
  );

  registerPlanBoardTool(ctx, boardsDir);
}
