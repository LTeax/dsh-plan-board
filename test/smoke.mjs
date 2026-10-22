// Functional smoke test for plan-board's host half: no DSH needed.
// Layout under test: <boardsDir>/<project>/<plan>.json
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
  const [pathname] = target.split('?');
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

const boardsDir = path.join(tmpHome, 'plan-board');
const defaultFile = path.join(boardsDir, 'default', 'main.json');
const q = (slug) => `?board=${encodeURIComponent(slug)}`;

// 1. every route is registered
for (const p of ['/plan-board/state.json', '/plan-board/toggle', '/plan-board/boards.json', '/plan-board/board', '/plan-board/priority', '/plan-board/collect', '/plan-board/restore']) {
  check(`route ${p}`, routes.has(p));
}

// 2. first read creates <project>/<plan>.json
const first = await call('/plan-board/state.json');
check('first GET is 200', first.status === 200, `status=${first.status}`);
check('project dir created', fs.existsSync(path.join(boardsDir, 'default')));
check('default/main.json created', fs.existsSync(defaultFile));
check('fallback slug is project/plan', first.json.slug === 'default/main', first.json.slug);
check('five sections present', ['long', 'mid', 'short', 'idea', 'advice'].every((p) => first.json.doc.sections[p]), Object.keys(first.json.doc.sections).join(','));

// 3. seed items with steps
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
  archive: [],
};
fs.writeFileSync(defaultFile, JSON.stringify(seeded, null, 2), 'utf8');

const read = await call(`/plan-board/state.json${q('default/main')}`);
check('reads seeded item text', read.json.doc.sections.short.items[0].text === '验证右栏渲染');
check('reads steps verbatim', read.json.doc.sections.short.items[0].steps.length === 2);

// 4. toggle a step, then the whole item
const stepRes = await call('/plan-board/toggle', { method: 'POST', body: { board: 'default/main', part: 'short', id: 's1', step: 0 } });
check('step toggle 200', stepRes.status === 200, `status=${stepRes.status}`);
check('step flipped to false', stepRes.json.doc.sections.short.items[0].steps[0].done === false);
const wholeRes = await call('/plan-board/toggle', { method: 'POST', body: { board: 'default/main', part: 'short', id: 's1' } });
check('item done', wholeRes.json.doc.sections.short.items[0].done === true);
check('all steps done', wholeRes.json.doc.sections.short.items[0].steps.every((s) => s.done === true));

// 5. write guards
check('non-loopback 403', (await call('/plan-board/toggle', { method: 'POST', body: { part: 'short', id: 's1' }, remote: '10.0.0.2' })).status === 403);
check('cross-site 403', (await call('/plan-board/toggle', { method: 'POST', body: { part: 'short', id: 's1' }, headers: { 'sec-fetch-site': 'cross-site' } })).status === 403);
check('unknown part 400', (await call('/plan-board/toggle', { method: 'POST', body: { part: 'nope', id: 's1' } })).status === 400);
check('GET on toggle 405', (await call('/plan-board/toggle', { method: 'GET' })).status === 405);

// 6. project layout: two projects, same plan name is fine
const createdB = await call('/plan-board/board', { method: 'POST', body: { project: '项目B', plan: 'main' } });
check('create project B', createdB.status === 200, `status=${createdB.status}`);
check('slug is project/plan', createdB.json.slug === '项目B/main', createdB.json.slug);
check('file at 项目B/main.json', fs.existsSync(path.join(boardsDir, '项目B', 'main.json')));
const dup = await call('/plan-board/board', { method: 'POST', body: { project: '项目B', plan: 'main' } });
check('duplicate plan in same project 409', dup.status === 409, `status=${dup.status}`);
const createdC = await call('/plan-board/board', { method: 'POST', body: { project: '项目C', plan: 'main' } });
check('same plan name in another project allowed', createdC.status === 200, `status=${createdC.status}`);
const badCreate = await call('/plan-board/board', { method: 'POST', body: { project: '', plan: '' } });
check('empty project/plan rejected', badCreate.status === 400, `status=${badCreate.status}`);
check('two plans under a project', (await call('/plan-board/board', { method: 'POST', body: { project: '项目B', plan: 'refactor-q4' } })).status === 200);
const listed = await call('/plan-board/boards.json');
check('boards list groups by project', listed.json.boards.some((b) => b.project === '项目B' && b.plan === 'refactor-q4'));
check('list carries project field', listed.json.boards.every((b) => typeof b.project === 'string' && typeof b.plan === 'string'));

// 7. isolation
const secondRead = await call(`/plan-board/state.json${q('项目B/main')}`);
check('new board starts empty', secondRead.json.doc.sections.short.items.length === 0);
await call('/plan-board/toggle', { method: 'POST', body: { board: 'default/main', part: 'long', id: 'l1' } });
check('other board untouched', (await call(`/plan-board/state.json${q('项目B/main')}`)).json.doc.sections.long.items.length === 0);
check('first board kept its toggle', (await call(`/plan-board/state.json${q('default/main')}`)).json.doc.sections.long.items[0].done === true);

// 8. legacy flat file is migrated into <name>/main.json
fs.writeFileSync(path.join(boardsDir, 'legacy-flat.json'), JSON.stringify({ title: 'flat', sections: {}, archive: [] }), 'utf8');
await call('/plan-board/boards.json');
check('flat file migrated into project dir', fs.existsSync(path.join(boardsDir, 'legacy-flat', 'main.json')));
check('flat file removed from root', !fs.existsSync(path.join(boardsDir, 'legacy-flat.json')));

// 9. priority
const pri = await call('/plan-board/priority', { method: 'POST', body: { board: 'default/main', part: 'long', id: 'l1', priority: 1 } });
check('priority 200', pri.status === 200);
check('priority persisted', pri.json.doc.sections.long.items[0].priority === 1);
check('priority range checked', (await call('/plan-board/priority', { method: 'POST', body: { board: 'default/main', part: 'long', id: 'l1', priority: 9 } })).status === 400);
check('unknown item 404', (await call('/plan-board/priority', { method: 'POST', body: { board: 'default/main', part: 'long', id: 'nope', priority: 1 } })).status === 404);

// 10. collect / restore
await call('/plan-board/toggle', { method: 'POST', body: { board: 'default/main', part: 'long', id: 'l1' } });
check('collect requires done', (await call('/plan-board/collect', { method: 'POST', body: { board: 'default/main', part: 'long', id: 'l1' } })).status === 400);
await call('/plan-board/toggle', { method: 'POST', body: { board: 'default/main', part: 'long', id: 'l1' } });
const col = await call('/plan-board/collect', { method: 'POST', body: { board: 'default/main', part: 'long', id: 'l1' } });
check('collect 200', col.status === 200);
check('archive holds it', col.json.doc.archive.length === 1);
check('section empty after collect', col.json.doc.sections.long.items.length === 0);
const aid = col.json.doc.archive[0].aid;
const rest = await call('/plan-board/restore', { method: 'POST', body: { board: 'default/main', aid } });
check('restore 200', rest.status === 200);
check('archive empty after restore', rest.json.doc.archive.length === 0);
check('restored reopened', rest.json.doc.sections.long.items[0].done === false);
check('unknown aid 404', (await call('/plan-board/restore', { method: 'POST', body: { board: 'default/main', aid: 'nope' } })).status === 404);

// 11. corrupt document is not overwritten
fs.writeFileSync(defaultFile, '{"broken": ');
const corrupt = await call(`/plan-board/state.json${q('default/main')}`);
check('corrupt reports failure', corrupt.status === 500 && corrupt.json.ok === false);
check('corrupt untouched', fs.readFileSync(defaultFile, 'utf8') === '{"broken": ');
check('toggle refuses when unparsable', (await call('/plan-board/toggle', { method: 'POST', body: { board: 'default/main', part: 'short', id: 's1' } })).status === 409);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
