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
 * Registers no agent tool on purpose: a board is a plain file, so the agent
 * edits it with its ordinary file tools while the panel only flips a done flag.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'plan-board';
export const inject = ['webServer'];

const PARTS = ['long', 'mid', 'short', 'idea', 'advice'];
const DEFAULT_TITLES = { long: '长期', mid: '中期', short: '短期', idea: '预想', advice: 'agent 建议' };
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
  return {
    version: 1,
    title: title || '未命名',
    updatedAt: new Date().toISOString(),
    sections,
    // 已完成并"收集"起来的条目。元素带 part（原分区）与时间戳，主列表不再包含它们。
    archive: [],
  };
}

function normalizeItem(item, part, index) {
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `${part}-${index + 1}`,
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

/** Coerce whatever is on disk into the shape the client renders, without inventing items. */
function normalize(raw, fallbackTitle) {
  const doc = emptyDoc(fallbackTitle);
  if (!raw || typeof raw !== 'object') return doc;
  if (typeof raw.title === 'string' && raw.title.trim()) doc.title = raw.title;
  if (typeof raw.updatedAt === 'string') doc.updatedAt = raw.updatedAt;
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
  return doc;
}

/** First call creates the directory and migrates a pre-boards single file, once. */
function ensureDir(dir) {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  const legacy = path.join(dshHome(), 'plan-board.json');
  if (fs.existsSync(legacy)) {
    try {
      fs.copyFileSync(legacy, path.join(dir, 'default.json'));
    } catch {
      /* best effort: the legacy file is left untouched */
    }
  }
}

function boardsOf(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => BOARD_FILE.test(name))
    .map((name) => ({ slug: name.replace(BOARD_FILE, ''), file: path.join(dir, name) }));
}

function listBoards(dir) {
  ensureDir(dir);
  return boardsOf(dir)
    .map(({ slug, file }) => {
      let title = slug;
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
        title = `${slug}（无法解析）`;
      }
      return { slug, title, updatedAt, count };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function readBoard(dir, slug) {
  ensureDir(dir);
  const file = path.join(dir, `${slug}.json`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const doc = emptyDoc(slug);
      writeBoard(dir, slug, doc);
      return { ok: true, slug, doc, created: true };
    }
    return { ok: false, slug, error: `读取失败：${error && error.message}` };
  }
  try {
    return { ok: true, slug, doc: normalize(JSON.parse(text), slug) };
  } catch (error) {
    // Never overwrite a document we cannot parse: it may be hand-edited.
    return { ok: false, slug, error: `${slug}.json 解析失败：${error && error.message}` };
  }
}

function writeBoard(dir, slug, doc) {
  ensureDir(dir);
  const file = path.join(dir, `${slug}.json`);
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
    text: entry.text,
    done: false,
    priority: entry.priority || 0,
    note: entry.note || '',
    updatedAt: now,
    steps: (entry.steps || []).map((step) => ({ text: step.text, done: false })),
  });
  doc.updatedAt = now;
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
        const slug = boardFromUrl(req.url) || (boards[0] && boards[0].slug) || 'default';
        const result = readBoard(boardsDir, slug);
        sendJson(res, result.ok ? 200 : 500, { ...result, boards, dir: boardsDir });
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
          const slug = typeof board === 'string' && board.trim() ? board.trim() : 'default';
          const current = readBoard(boardsDir, slug);
          if (!current.ok) return sendJson(res, 409, current);
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
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          const slug = toSlug(title);
          if (!slug) return sendJson(res, 400, { ok: false, error: '名称不合法' });
          if (fs.existsSync(path.join(boardsDir, `${slug}.json`))) {
            return sendJson(res, 409, { ok: false, error: '同名计划已存在' });
          }
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
          const slug = typeof board === 'string' && board.trim() ? board.trim() : 'default';
          const current = readBoard(boardsDir, slug);
          if (!current.ok) return sendJson(res, 409, current);
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
          const slug = typeof board === 'string' && board.trim() ? board.trim() : 'default';
          const current = readBoard(boardsDir, slug);
          if (!current.ok) return sendJson(res, 409, current);
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
          const slug = typeof board === 'string' && board.trim() ? board.trim() : 'default';
          const current = readBoard(boardsDir, slug);
          if (!current.ok) return sendJson(res, 409, current);
          restore(current.doc, aid);
          writeBoard(boardsDir, slug, current.doc);
          sendJson(res, 200, { ok: true, slug, doc: current.doc, boards: listBoards(boardsDir) });
        } catch (error) {
          sendJson(res, 404, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
  );
}
