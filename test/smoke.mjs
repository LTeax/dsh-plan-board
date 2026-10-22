// Functional smoke test for plan-board's host half: no DSH needed.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../index.js';

const tmpHome = path.join(process.cwd(), '_smoke-tmp');
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(tmpHome, { recursive: true });
process.env.DSH_HOME = tmpHome;

const routes = new Map();
const ctx = {
  effect(fn) { return fn(); },
  webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
};
apply(ctx, {});

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function makeReq({ method = 'GET', body = null, remote = '127.0.0.1', headers = {}, url = '/' } = {}) {
  const stream = body == null ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.headers = headers;
  stream.url = url;
  stream.socket = { remoteAddress: remote };
  return stream;
}

async function call(target, args = {}) {
  const [pathname, query] = target.split('?');
  const route = routes.get(pathname);
  if (!route) throw new Error(`route not registered: ${pathname}`);
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code) { status = code; },
    end(chunk) { if (chunk) payload += chunk.toString(); },
  };
  await route.handler(makeReq({ ...args, url: args.url || target }), res);
  return { status, json: payload ? JSON.parse(payload) : null };
}

// 1. every route is registered
check('state route registered', routes.has('/plan-board/state.json'));
check('toggle route registered', routes.has('/plan-board/toggle'));
check('boards route registered', routes.has('/plan-board/boards.json'));
check('create route registered', routes.has('/plan-board/board'));

// 2. first read creates the boards directory and one board
const first = await call('/plan-board/state.json');
const boardsDir = path.join(tmpHome, 'plan-board');
const defaultFile = path.join(boardsDir, 'default.json');
check('first GET is 200', first.status === 200, `status=${first.status}`);
check('boards dir created', fs.existsSync(boardsDir));
check('document created on disk', fs.existsSync(defaultFile));
check('slug is default', first.json.slug === 'default', first.json.slug);
check('five sections present', ['long', 'mid', 'short', 'idea', 'advice'].every((p) => first.json.doc.sections[p]), Object.keys(first.json.doc.sections).join(','));

// 3. the agent seeds items with steps
const seeded = {
  version: 1,
  title: '默认',
  updatedAt: new Date().toISOString(),
  sections: {
    long: { title: '长期', items: [{ id: 'l1', text: '把 DSH 插件开发跑通', done: false, steps: [] }] },
    mid: { title: '中期', items: [] },
    short: {
      title: '短期',
      items: [{
        id: 's1',
        text: '验证右栏渲染',
        done: false,
        note: '装完看右下角',
        steps: [{ text: '写 manifest', done: true }, { text: '重启客户端', done: false }],
      }],
    },
    idea: { title: '预想', items: [{ id: 'i1', text: '做成本看板插件', done: false, steps: [] }] },
  },
};
fs.writeFileSync(defaultFile, JSON.stringify(seeded, null, 2), 'utf8');

const read = await call('/plan-board/state.json?board=default');
const shortItem = read.json.doc.sections.short.items[0];
check('reads seeded item text', shortItem.text === '验证右栏渲染', shortItem.text);
check('reads steps verbatim', shortItem.steps.length === 2 && shortItem.steps[0].done === true);
check('default board listed', read.json.boards.some((b) => b.slug === 'default'));

// 4. toggle one step: item.done must stay false
const toggled = await call('/plan-board/toggle', { method: 'POST', body: { board: 'default', part: 'short', id: 's1', step: 0 } });
check('step toggle returns 200', toggled.status === 200, `status=${toggled.status}`);
const afterStep = toggled.json.doc.sections.short.items[0];
check('step 0 now false', afterStep.steps[0].done === false);
check('item still not done', afterStep.done === false);

// 5. toggle the whole item: every step flips true
const whole = await call('/plan-board/toggle', { method: 'POST', body: { board: 'default', part: 'short', id: 's1' } });
const afterItem = whole.json.doc.sections.short.items[0];
check('item done = true', afterItem.done === true);
check('all steps done', afterItem.steps.every((s) => s.done === true));

// 6. persisted to disk
const onDisk = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
check('persisted item.done', onDisk.sections.short.items[0].done === true);
check('persisted updatedAt', typeof onDisk.updatedAt === 'string');

// 7. write guards
const remote = await call('/plan-board/toggle', { method: 'POST', body: { part: 'short', id: 's1' }, remote: '192.168.1.9' });
check('non-loopback write rejected', remote.status === 403, `status=${remote.status}`);
const crossSite = await call('/plan-board/toggle', { method: 'POST', body: { part: 'short', id: 's1' }, headers: { 'sec-fetch-site': 'cross-site' } });
check('cross-site write rejected', crossSite.status === 403, `status=${crossSite.status}`);
const badPart = await call('/plan-board/toggle', { method: 'POST', body: { part: 'nope', id: 's1' } });
check('unknown part rejected', badPart.status === 400, `status=${badPart.status}`);
const getOnly = await call('/plan-board/toggle', { method: 'GET' });
check('GET on toggle rejected', getOnly.status === 405, `status=${getOnly.status}`);

// 8. a second board is isolated from the first
const created = await call('/plan-board/board', { method: 'POST', body: { title: '项目B' } });
check('create board returns 200', created.status === 200, `status=${created.status}`);
check('create board slug', created.json.slug === '项目B', created.json.slug);
const secondFile = path.join(boardsDir, '项目B.json');
check('second board file written', fs.existsSync(secondFile));
const listed = await call('/plan-board/boards.json');
check('two boards listed', listed.json.boards.length === 2, listed.json.boards.map((b) => b.slug).join(','));
const dup = await call('/plan-board/board', { method: 'POST', body: { title: '项目B' } });
check('duplicate board rejected', dup.status === 409, `status=${dup.status}`);

const secondRead = await call('/plan-board/state.json?board=' + encodeURIComponent('项目B'));
check('second board empty', secondRead.json.doc.sections.short.items.length === 0);
await call('/plan-board/toggle', { method: 'POST', body: { board: 'default', part: 'long', id: 'l1' } });
const secondAgain = await call('/plan-board/state.json?board=' + encodeURIComponent('项目B'));
check('other board untouched', secondAgain.json.doc.sections.long.items.length === 0);
const firstAgain = await call('/plan-board/state.json?board=default');
check('first board kept its toggle', firstAgain.json.doc.sections.long.items[0].done === true);

// 9. priority: 1..3 有效，0 可清空，其余拒绝
check('priority route registered', routes.has('/plan-board/priority'));
const pri = await call('/plan-board/priority', { method: 'POST', body: { board: 'default', part: 'long', id: 'l1', priority: 1 } });
check('priority set returns 200', pri.status === 200, `status=${pri.status}`);
check('priority persisted in response', pri.json.doc.sections.long.items.find((i) => i.id === 'l1').priority === 1);
const badPri = await call('/plan-board/priority', { method: 'POST', body: { board: 'default', part: 'long', id: 'l1', priority: 9 } });
check('out-of-range priority rejected', badPri.status === 400, `status=${badPri.status}`);
const missingItem = await call('/plan-board/priority', { method: 'POST', body: { board: 'default', part: 'long', id: 'nope', priority: 1 } });
check('unknown item rejected', missingItem.status === 404, `status=${missingItem.status}`);
await call('/plan-board/priority', { method: 'POST', body: { board: 'default', part: 'long', id: 'l1', priority: 0 } });
const onDiskPri = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
check('priority written to disk (cleared to 0)', onDiskPri.sections.long.items.find((i) => i.id === 'l1').priority === 0);

// 10. 收集 / 提出
await call('/plan-board/toggle', { method: 'POST', body: { board: 'default', part: 'long', id: 'l1' } });
const notDone = await call('/plan-board/collect', { method: 'POST', body: { board: 'default', part: 'long', id: 'l1' } });
check('collect requires done', notDone.status === 400, `status=${notDone.status}`);
await call('/plan-board/toggle', { method: 'POST', body: { board: 'default', part: 'long', id: 'l1' } });
const col = await call('/plan-board/collect', { method: 'POST', body: { board: 'default', part: 'long', id: 'l1' } });
check('collect returns 200', col.status === 200, `status=${col.status}`);
check('archive holds the entry', col.json.doc.archive.length === 1);
check('item left the section', col.json.doc.sections.long.items.length === 0);
check('archive remembers original part', col.json.doc.archive[0].part === 'long');
const aid = col.json.doc.archive[0].aid;
const rest = await call('/plan-board/restore', { method: 'POST', body: { board: 'default', aid } });
check('restore returns 200', rest.status === 200, `status=${rest.status}`);
check('archive empty after restore', rest.json.doc.archive.length === 0);
const backItem = rest.json.doc.sections.long.items.find((i) => i.text === '把 DSH 插件开发跑通');
check('restored item is reopened', !!backItem && backItem.done === false);
const onDiskArchive = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
check('archive persisted on disk', Array.isArray(onDiskArchive.archive));
const badRestore = await call('/plan-board/restore', { method: 'POST', body: { board: 'default', aid: 'nope' } });
check('unknown aid rejected', badRestore.status === 404, `status=${badRestore.status}`);

// 11. corrupt document is not overwritten
fs.writeFileSync(defaultFile, '{"broken": ');
const corrupt = await call('/plan-board/state.json?board=default');
check('corrupt doc reports failure', corrupt.status === 500 && corrupt.json.ok === false);
check('corrupt doc left untouched', fs.readFileSync(defaultFile, 'utf8') === '{"broken": ');
const blocked = await call('/plan-board/toggle', { method: 'POST', body: { board: 'default', part: 'short', id: 's1' } });
check('toggle refuses when unparsable', blocked.status === 409, `status=${blocked.status}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
