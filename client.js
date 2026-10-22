/**
 * Browser half of the plan-board bundle.
 *
 * Registers one page tab in the right sidebar (`ctx.sidebarRightTabs.register`)
 * and its body in the `sidebar.right.pane.tab` seat. The body polls the host
 * route and flips done flags through /plan-board/toggle, so the panel never
 * owns the document: the JSON file on disk stays the single source of truth
 * shared by every conversation.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plan-board',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const TAB_ID = 'dsh-plan-board';
    const PARTS = ['long', 'mid', 'short', 'idea', 'advice'];
    // 不给进度的分区：想法池与 agent 建议都不参与任何统计。
    const NO_PROGRESS = new Set(['idea', 'advice']);
    const POLL_MS = 3000;

    function itemRatio(item) {
      if (!item.steps || item.steps.length === 0) return item.done ? 1 : 0;
      const done = item.steps.filter((step) => step.done).length;
      return done / item.steps.length;
    }

    function sectionRatio(section) {
      if (!section.items.length) return 0;
      const sum = section.items.reduce((total, item) => total + itemRatio(item), 0);
      return sum / section.items.length;
    }

    function percent(ratio) {
      return `${Math.round(ratio * 100)}%`;
    }

    async function fetchState(board) {
      const query = board ? `?board=${encodeURIComponent(board)}` : '';
      const response = await fetch(`/plan-board/state.json${query}`, { cache: 'no-store' });
      return response.json();
    }

    function Bar({ ratio }) {
      return h(
        'div',
        { className: 'pb-bar' },
        h('div', { className: 'pb-bar-fill', style: { width: percent(ratio) } }),
      );
    }

    function Step({ item, part, index, onToggle }) {
      const step = item.steps[index];
      return h(
        'label',
        { className: 'pb-step' },
        h('input', {
          type: 'checkbox',
          checked: step.done,
          onChange: () => onToggle(part, item.id, index),
        }),
        h('span', { className: step.done ? 'pb-text pb-done' : 'pb-text' }, step.text),
      );
    }

    const PRIORITY_TEXT = { 1: 'P1 高', 2: 'P2 中', 3: 'P3 低', 0: '未设' };
    // 排序只在渲染时发生：文件里的顺序保持不变，agent 改写时也不会把整块打乱。
    // 规则：未完成在前；同组内按重要度（1 最高）；未设排在已设之后；其余保持原序。
    const PRIORITY_RANK = (p) => (p === 0 ? 4 : p);

    function groupBoards(boards) {
      const map = new Map();
      for (const board of boards) {
        if (!map.has(board.project)) map.set(board.project, []);
        map.get(board.project).push(board);
      }
      return [...map.entries()];
    }

    function orderedItems(items) {
      return [...items].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return PRIORITY_RANK(a.priority || 0) - PRIORITY_RANK(b.priority || 0);
      });
    }

    function Item({ item, part, onToggle, onPriority, onCollect, showPriority }) {
      const ratio = itemRatio(item);
      const priority = item.priority || 0;
      return h(
        'div',
        { className: `${showPriority ? `pb-item pb-imp-${priority}` : 'pb-item'}${item.done ? ' pb-item-collectable' : ''}` },
        h(
          'div',
          { className: 'pb-item-head' },
          showPriority &&
            h(
              'button',
              {
                type: 'button',
                className: `pb-pri pb-pri-${priority}`,
                title: `重要度：${PRIORITY_TEXT[priority]}（点击切换 高→中→低→未设）`,
                onClick: () => onPriority(part, item.id, priority),
              },
              priority ? `P${priority}` : '·',
            ),
          h('input', {
            type: 'checkbox',
            checked: item.done,
            onChange: () => onToggle(part, item.id, undefined),
          }),
          h('span', { className: item.done ? 'pb-text pb-done' : 'pb-text' }, item.text),
          item.steps.length > 0 ? h('span', { className: 'pb-chip' }, percent(ratio)) : null,
        ),
        item.note ? h('div', { className: 'pb-note' }, item.note) : null,
        item.steps.length > 0
          ? h(
              'div',
              { className: 'pb-steps' },
              item.steps.map((_, index) =>
                h(Step, { key: `${item.id}-${index}`, item, part, index, onToggle }),
              ),
            )
          : null,
        item.done && onCollect
          ? h(
              'button',
              {
                type: 'button',
                className: 'pb-collect',
                title: '收集到「已完成」抽屉',
                onClick: () => onCollect(part, item.id),
              },
              '收集',
            )
          : null,
      );
    }

    function Section({ part, section, collapsed, onToggleCollapse, onToggle, onPriority, onCollect }) {
      const ratio = sectionRatio(section);
      const done = section.items.filter((item) => item.done).length;
      const showProgress = !NO_PROGRESS.has(part);
      // 空分区没有"完成度"可言：0/0 显示破折号，而不是 0% —— 更不该是 100%。
      const hasItems = section.items.length > 0;
      return h(
        'section',
        { className: 'pb-section' },
        h(
          'button',
          {
            type: 'button',
            className: 'pb-section-head',
            onClick: () => onToggleCollapse(part),
            'aria-expanded': !collapsed,
          },
          h('span', { className: 'pb-caret' }, collapsed ? '▸' : '▾'),
          h('span', { className: 'pb-section-title' }, section.title),
          h('span', { className: 'pb-chip' }, `${done}/${section.items.length}`),
          showProgress ? h('span', { className: 'pb-chip pb-chip-strong' }, hasItems ? percent(ratio) : '—') : null,
        ),
        showProgress && !collapsed && hasItems ? h(Bar, { ratio }) : null,
        collapsed
          ? null
          : h(
              'div',
              { className: 'pb-items' },
              section.items.length === 0
                ? h('div', { className: 'pb-empty' }, '还没有条目')
                : orderedItems(section.items).map((item) =>
                    h(Item, {
                      key: item.id,
                      item,
                      part,
                      onToggle,
                      onPriority,
                      onCollect,
                      showPriority: !NO_PROGRESS.has(part),
                    }),
                  ),
            ),
      );
    }

    const ARCHIVE_PART_LABEL = { long: '长期', mid: '中期', short: '短期' };

    // 已完成抽屉：按完成日期倒序分组，组内再按原分区，分区内按重要度。
    function ArchiveDrawer({ entries, onRestore }) {
      const byDay = new Map();
      for (const entry of entries) {
        const stamp = entry.completedAt || entry.archivedAt || '';
        const day = stamp.slice(0, 10) || '未知日期';
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(entry);
      }
      const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
      return h(
        'div',
        { className: 'pb-archive' },
        days.map((day, dayIndex) => {
          const list = byDay.get(day);
          const groups = new Map();
          for (const entry of [...list].sort((a, b) => (a.priority || 4) - (b.priority || 4))) {
            const key = entry.part;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(entry);
          }
          return h(
            'details',
            { key: day, className: 'pb-archive-day', open: dayIndex === 0 },
            h('summary', { className: 'pb-archive-summary' }, `${day} · ${list.length} 条`),
            [...groups.entries()].map(([part, items]) =>
              h(
                'div',
                { key: part, className: 'pb-archive-group' },
                h('div', { className: 'pb-archive-group-title' }, ARCHIVE_PART_LABEL[part] || part),
                items.map((entry) =>
                  h(
                    'div',
                    { key: entry.aid, className: 'pb-archive-item' },
                    h('span', { className: 'pb-archive-text' }, entry.text),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pb-archive-restore',
                        onClick: () => onRestore(entry.aid),
                        title: '提出来并重新打开',
                      },
                      '提出',
                    ),
                  ),
                ),
              ),
            ),
          );
        }),
      );
    }

    function PlanPanel() {
      const [state, setState] = useState({ loading: true, ok: false, doc: null, error: '' });
      const [collapsed, setCollapsed] = useState({});
      const [busy, setBusy] = useState('');
      const [menuOpen, setMenuOpen] = useState(false);
      const [creating, setCreating] = useState(false);
      const [newProject, setNewProject] = useState('');
      const [newPlan, setNewPlan] = useState('main');
      const [archiveOpen, setArchiveOpen] = useState(false);
      const [boards, setBoards] = useState([]);
      const [board, setBoard] = useState(() => {
        try {
          return window.localStorage.getItem('plan-board:board') || '';
        } catch {
          return '';
        }
      });

      const remember = useCallback((slug) => {
        try {
          window.localStorage.setItem('plan-board:board', slug);
        } catch {
          /* private mode: the choice just won't persist */
        }
      }, []);

      const load = useCallback(
        async (slug) => {
          try {
            const payload = await fetchState(slug === undefined ? board : slug);
            setBoards(payload.boards || []);
            const active = payload.slug || '';
            if (active && active !== board) setBoard(active);
            setState({ loading: false, ok: payload.ok !== false, doc: payload.doc || null, error: payload.error || '' });
          } catch (error) {
            setState({ loading: false, ok: false, doc: null, error: String((error && error.message) || error) });
          }
        },
        [board],
      );

      useEffect(() => {
        let alive = true;
        const tick = () => {
          if (!alive) return;
          if (typeof document !== 'undefined' && document.hidden) return;
          void load();
        };
        void load();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [load]);

      const switchBoard = useCallback(
        (slug) => {
          if (!slug || slug === board) return;
          setBoard(slug);
          remember(slug);
          void load(slug);
        },
        [board, load, remember],
      );

      // 不用 window.prompt：Electron 没有实现它（返回 undefined，点了像没反应）。
      const createBoard = useCallback(async () => {
        const project = newProject.trim();
        const plan = newPlan.trim();
        if (!project || !plan) return;
        setBusy('create');
        try {
          const response = await fetch('/plan-board/board', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ project, plan }),
          });
          const payload = await response.json();
          if (!payload || !payload.ok) {
            setState((previous) => ({ ...previous, error: (payload && payload.error) || '创建失败' }));
            return;
          }
          setBoards(payload.boards || []);
          setBoard(payload.slug);
          remember(payload.slug);
          setState({ loading: false, ok: true, doc: payload.doc, error: '' });
          setCreating(false);
        } catch (error) {
          setState((previous) => ({ ...previous, error: String((error && error.message) || error) }));
        } finally {
          setBusy('');
        }
      }, [newProject, newPlan, remember]);

      const onToggle = useCallback(
        async (part, id, step) => {
          if (busy) return;
          setBusy(`${part}:${id}`);
          try {
            const response = await fetch('/plan-board/toggle', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ board, part, id, step }),
            });
            const payload = await response.json();
            if (payload && payload.ok && payload.doc) {
              if (payload.boards) setBoards(payload.boards);
              setState((previous) => ({ ...previous, ok: true, error: '', doc: payload.doc }));
            } else {
              setState((previous) => ({ ...previous, error: (payload && payload.error) || '更新失败' }));
            }
          } catch (error) {
            setState((previous) => ({ ...previous, error: String((error && error.message) || error) }));
          } finally {
            setBusy('');
          }
        },
        [board, busy],
      );

      const onPriority = useCallback(
        async (part, id, current) => {
          const next = current === 1 ? 2 : current === 2 ? 3 : current === 3 ? 0 : 1;
          setBusy(`pri:${part}:${id}`);
          try {
            const response = await fetch('/plan-board/priority', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ board, part, id, priority: next }),
            });
            const payload = await response.json();
            if (payload && payload.ok && payload.doc) {
              if (payload.boards) setBoards(payload.boards);
              setState((previous) => ({ ...previous, ok: true, error: '', doc: payload.doc }));
            } else {
              setState((previous) => ({ ...previous, error: (payload && payload.error) || '更新失败' }));
            }
          } catch (error) {
            setState((previous) => ({ ...previous, error: String((error && error.message) || error) }));
          } finally {
            setBusy('');
          }
        },
        [board],
      );

      const onCollect = useCallback(
        async (part, id) => {
          setBusy(`collect:${part}:${id}`);
          try {
            const response = await fetch('/plan-board/collect', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ board, part, id }),
            });
            const payload = await response.json();
            if (payload && payload.ok && payload.doc) {
              if (payload.boards) setBoards(payload.boards);
              setState((previous) => ({ ...previous, ok: true, error: '', doc: payload.doc }));
            } else {
              setState((previous) => ({ ...previous, error: (payload && payload.error) || '收集失败' }));
            }
          } catch (error) {
            setState((previous) => ({ ...previous, error: String((error && error.message) || error) }));
          } finally {
            setBusy('');
          }
        },
        [board],
      );

      const onRestore = useCallback(
        async (aid) => {
          setBusy(`restore:${aid}`);
          try {
            const response = await fetch('/plan-board/restore', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ board, aid }),
            });
            const payload = await response.json();
            if (payload && payload.ok && payload.doc) {
              if (payload.boards) setBoards(payload.boards);
              setState((previous) => ({ ...previous, ok: true, error: '', doc: payload.doc }));
            } else {
              setState((previous) => ({ ...previous, error: (payload && payload.error) || '提出失败' }));
            }
          } catch (error) {
            setState((previous) => ({ ...previous, error: String((error && error.message) || error) }));
          } finally {
            setBusy('');
          }
        },
        [board],
      );

      const onToggleCollapse = useCallback((part) => {        setCollapsed((previous) => ({ ...previous, [part]: !previous[part] }));
      }, []);

      const doc = state.doc;
      // 只对"有条目"的分区求平均：空分区没有完成度，掺进分母会虚增或虚减总进度。
      const tracked = doc
        ? PARTS.filter((part) => !NO_PROGRESS.has(part) && doc.sections[part].items.length > 0)
        : [];
      const overall = tracked.length
        ? tracked.reduce((total, part) => total + sectionRatio(doc.sections[part]), 0) / tracked.length
        : null;
      const activeBoard = boards.find((item) => item.slug === board) || boards[0] || null;

      return h(
        'div',
        { className: 'pb-root' },
        h('style', null, STYLE),
        h(
          'header',
          { className: 'pb-head' },
          h('span', { className: 'pb-title' }, '计划'),
          // 原生 select 的下拉由系统绘制、无法上色，所以自己画一个面板内列表。
          h(
            'button',
            {
              type: 'button',
              className: 'pb-board-btn',
              onClick: () => setMenuOpen((open) => !open),
              title: '切换计划（每个项目一个）',
              'aria-expanded': menuOpen,
            },
            h(
              'span',
              { className: 'pb-board-name' },
              activeBoard ? `${activeBoard.project} / ${activeBoard.plan}` : '（还没有计划）',
            ),
            h('span', { className: 'pb-board-caret' }, menuOpen ? '▴' : '▾'),
          ),
          doc ? h('span', { className: 'pb-muted' }, overall === null ? '总进度 —' : `总进度 ${percent(overall)}`) : null,
          doc && doc.archive && doc.archive.length > 0
            ? h(
                'div',
                { className: archiveOpen ? 'pb-archive-box pb-on' : 'pb-archive-box' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pb-archive-toggle',
                    onClick: () => setArchiveOpen((open) => !open),
                    title: archiveOpen ? '收起已完成' : '展开已完成',
                    'aria-expanded': archiveOpen,
                  },
                  '已完成',
                ),
                // 数量只是标签，不参与点击
                h('span', { className: 'pb-archive-count', 'aria-hidden': true }, String(doc.archive.length)),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'pb-refresh pb-new',
              onClick: () => {
                setMenuOpen(false);
                setNewProject(activeBoard ? activeBoard.project : '');
                setNewPlan('main');
                setCreating((open) => !open);
              },
              title: '新建计划（项目 / 计划名）',
            },
            '＋',
          ),
          h(
            'button',
            { type: 'button', className: 'pb-refresh', onClick: () => void load(), title: '刷新' },
            '↻',
          ),
        ),
        creating
          ? h(
              'div',
              { className: 'pb-create' },
              h('input', {
                className: 'pb-input',
                value: newProject,
                placeholder: '项目（建议用工作目录名）',
                autoFocus: true,
                onChange: (event) => setNewProject(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void createBoard();
                  } else if (event.key === 'Escape') {
                    setCreating(false);
                  }
                },
              }),
              h('input', {
                className: 'pb-input pb-input-plan',
                value: newPlan,
                placeholder: '计划名',
                onChange: (event) => setNewPlan(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void createBoard();
                  } else if (event.key === 'Escape') {
                    setCreating(false);
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'pb-btn pb-btn-primary',
                  onClick: () => void createBoard(),
                  disabled: busy === 'create' || !newProject.trim() || !newPlan.trim(),
                },
                '创建',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'pb-btn',
                  onClick: () => setCreating(false),
                },
                '取消',
              ),
            )
          : null,
        menuOpen
          ? h(
              'div',
              { className: 'pb-board-menu' },
              boards.length === 0 ? h('div', { className: 'pb-empty' }, '还没有计划，点 ＋ 新建') : null,
              groupBoards(boards).map(([project, plans]) =>
                h(
                  'div',
                  { key: project, className: 'pb-board-group' },
                  h('div', { className: 'pb-board-group-title' }, project),
                  plans.map((item) =>
                    h(
                      'button',
                      {
                        key: item.slug,
                        type: 'button',
                        className: item.slug === board ? 'pb-board-item pb-board-item-on' : 'pb-board-item',
                        onClick: () => {
                          switchBoard(item.slug);
                          setMenuOpen(false);
                        },
                      },
                      h('span', { className: 'pb-board-item-name' }, item.plan),
                      h('span', { className: 'pb-board-item-count' }, `${item.count} 条`),
                    ),
                  ),
                ),
              ),
            )
          : null,
        archiveOpen && doc && doc.archive && doc.archive.length > 0
          ? h(ArchiveDrawer, { entries: doc.archive, onRestore })
          : null,
        state.error ? h('div', { className: 'pb-error' }, state.error) : null,
        state.loading
          ? h('div', { className: 'pb-empty' }, '读取中…')
          : doc
            ? h(
                'div',
                { className: 'pb-body' },
                PARTS.map((part) =>
                  h(Section, {
                    key: part,
                    part,
                    section: doc.sections[part],
                    collapsed: collapsed[part] === true,
                    onToggleCollapse,
                    onToggle,
                    onPriority,
                    onCollect,
                  }),
                ),
                h('div', { className: 'pb-foot' }, doc.updatedAt ? `更新于 ${doc.updatedAt.replace('T', ' ').slice(0, 16)}` : ''),
              )
            : h('div', { className: 'pb-empty' }, '没有可显示的文档'),
      );
    }

    const STYLE = `
      .pb-root { display:flex; flex-direction:column; gap:8px; padding:12px 12px 20px; height:100%; overflow:auto;
        font-size:13px; line-height:1.5; color:var(--dsw-alias-text-primary, #e6e6e6); }
      .pb-head { display:flex; align-items:center; gap:8px; }
      .pb-title { font-weight:600; font-size:13px; }
      .pb-board-btn { display:flex; align-items:center; gap:4px; max-width:150px; height:24px; padding:0 6px;
        border-radius:6px; background:transparent; color:inherit; font:inherit; cursor:pointer;
        border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); }
      .pb-board-btn:hover { background:var(--dsw-alias-bg-hover, rgba(255,255,255,.06)); }
      .pb-board-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
      .pb-board-caret { flex:none; font-size:10px; color:var(--dsw-alias-text-secondary, #9aa0a6); }
      .pb-board-menu { display:flex; flex-direction:column; gap:2px; padding:4px; border-radius:8px;
        border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14));
        background:var(--dsw-alias-bg-elevated, rgba(255,255,255,.05)); }
      .pb-board-item { display:flex; align-items:center; gap:8px; width:100%; padding:5px 8px; border:0;
        border-radius:6px; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
      .pb-board-item:hover { background:var(--dsw-alias-bg-hover, rgba(255,255,255,.06)); }
      .pb-board-item-on { background:var(--dsw-alias-bg-selected, rgba(76,141,255,.16)); }
      .pb-board-item-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
      .pb-board-item-count { flex:none; font-size:11px; color:var(--dsw-alias-text-secondary, #9aa0a6); }
      .pb-board-group { display:flex; flex-direction:column; gap:2px; padding-top:2px; }
      .pb-board-group + .pb-board-group { border-top:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.10)); margin-top:2px; }
      .pb-board-group-title { padding:2px 8px; font-size:10px; letter-spacing:.02em;
        color:var(--dsw-alias-text-secondary, #9aa0a6); }
      .pb-input-plan { flex:0 0 96px; }
      .pb-muted { color:var(--dsw-alias-text-secondary, #9aa0a6); font-size:12px; }
      .pb-refresh { margin-left:auto; background:transparent; border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14));
        color:inherit; border-radius:6px; width:24px; height:24px; cursor:pointer; }
      .pb-refresh:hover { background:var(--dsw-alias-bg-hover, rgba(255,255,255,.06)); }
      .pb-new { font-size:14px; line-height:1; }
      .pb-archive-box { display:flex; align-items:stretch; height:22px; border-radius:6px; overflow:hidden;
        border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); }
      .pb-archive-toggle { padding:0 7px; border:0; background:transparent; color:inherit; font:inherit;
        font-size:11px; cursor:pointer; }
      .pb-archive-toggle:hover { background:var(--dsw-alias-bg-hover, rgba(255,255,255,.06)); }
      .pb-archive-count { display:flex; align-items:center; padding:0 6px; font-size:11px; cursor:default;
        user-select:none; color:var(--dsw-alias-text-secondary, #9aa0a6);
        border-left:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); }
      .pb-create { display:flex; align-items:center; gap:6px; }
      .pb-input { flex:1; min-width:0; height:24px; padding:0 6px; border-radius:6px; font:inherit; font-size:12px;
        background:transparent; color:inherit; border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); }
      .pb-input:focus { outline:none; border-color:var(--dsw-alias-accent, #4c8dff); }
      .pb-btn { flex:none; height:24px; padding:0 8px; border-radius:6px; font:inherit; font-size:12px; cursor:pointer;
        background:transparent; color:inherit; border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); }
      .pb-btn:hover { background:var(--dsw-alias-bg-hover, rgba(255,255,255,.06)); }
      .pb-btn-primary { border-color:var(--dsw-alias-accent, #4c8dff); color:var(--dsw-alias-accent, #4c8dff); }
      .pb-btn:disabled { opacity:.45; cursor:default; }
      .pb-body { display:flex; flex-direction:column; gap:14px; }
      .pb-section { display:flex; flex-direction:column; gap:6px; }
      .pb-section-head { display:flex; align-items:center; gap:6px; background:transparent; border:0; padding:2px 0;
        color:inherit; cursor:pointer; text-align:left; font:inherit; }
      .pb-section-title { font-weight:600; }
      .pb-caret { width:10px; color:var(--dsw-alias-text-secondary, #9aa0a6); }
      .pb-chip { margin-left:auto; font-size:11px; color:var(--dsw-alias-text-secondary, #9aa0a6);
        border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); border-radius:999px; padding:0 6px; }
      .pb-chip-strong { color:inherit; }
      .pb-bar { height:4px; border-radius:2px; background:var(--dsw-alias-bg-sunken, rgba(255,255,255,.08)); overflow:hidden; }
      .pb-bar-fill { height:100%; background:var(--dsw-alias-accent, #4c8dff); transition:width .25s ease; }
      .pb-items { display:flex; flex-direction:column; gap:8px; padding-left:2px; }
      .pb-item { display:flex; flex-direction:column; gap:4px; padding:6px 8px; border-radius:8px; position:relative;
        background:var(--dsw-alias-bg-elevated, rgba(255,255,255,.04)); }
      .pb-item-collectable { padding-bottom:26px; }
      .pb-collect { position:absolute; right:8px; bottom:6px; padding:1px 6px; border-radius:5px; cursor:pointer;
        font-size:10px; line-height:16px; font-family:inherit; color:var(--dsw-alias-text-secondary, #9aa0a6);
        background:transparent; border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); }
      .pb-collect:hover { color:inherit; background:var(--dsw-alias-bg-hover, rgba(255,255,255,.06)); }
      .pb-archive-box.pb-on { border-color:var(--dsw-alias-accent, #4c8dff); }
      .pb-archive-box.pb-on .pb-archive-toggle { color:var(--dsw-alias-accent, #4c8dff); }
      .pb-archive { display:flex; flex-direction:column; gap:6px; padding:6px; border-radius:8px;
        border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14));
        background:var(--dsw-alias-bg-sunken, rgba(0,0,0,.18)); }
      .pb-archive-day > summary { cursor:pointer; font-size:12px; padding:2px 0;
        color:var(--dsw-alias-text-secondary, #9aa0a6); }
      .pb-archive-group { padding:4px 0 2px 10px; }
      .pb-archive-group-title { font-size:11px; margin-bottom:2px; color:var(--dsw-alias-text-secondary, #9aa0a6); }
      .pb-archive-item { display:flex; align-items:center; gap:6px; padding:2px 0; }
      .pb-archive-text { flex:1; font-size:12px; text-decoration:line-through; opacity:.7;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .pb-archive-restore { flex:none; padding:1px 6px; border-radius:5px; cursor:pointer; font-size:10px;
        font-family:inherit; color:var(--dsw-alias-text-secondary, #9aa0a6); background:transparent;
        border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); }
      .pb-archive-restore:hover { color:inherit; background:var(--dsw-alias-bg-hover, rgba(255,255,255,.06)); }
      .pb-item-head { display:flex; align-items:center; gap:8px; }
      .pb-imp-1 { border-left:3px solid #e5534b; }
      .pb-imp-2 { border-left:3px solid #d29922; }
      .pb-imp-3 { border-left:3px solid #4c8dff; }
      .pb-imp-0 { border-left:3px solid transparent; }
      .pb-pri { flex:none; width:22px; height:18px; padding:0; border-radius:4px; cursor:pointer;
        background:transparent; font-size:10px; line-height:1; font-family:inherit;
        color:var(--dsw-alias-text-secondary, #9aa0a6); border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); }
      .pb-pri-1 { color:#ff9a92; border-color:#e5534b; }
      .pb-pri-2 { color:#e3b341; border-color:#d29922; }
      .pb-pri-3 { color:#8ab4f8; border-color:#4c8dff; }
      .pb-steps { display:flex; flex-direction:column; gap:2px; padding-left:22px; }
      .pb-step { display:flex; align-items:flex-start; gap:6px; cursor:pointer; font-size:12px;
        color:var(--dsw-alias-text-secondary, #b6bcc4); }
      .pb-text { flex:1; }
      .pb-done { text-decoration:line-through; opacity:.55; }
      .pb-note { font-size:12px; color:var(--dsw-alias-text-secondary, #9aa0a6); padding-left:22px; }
      .pb-empty { color:var(--dsw-alias-text-secondary, #9aa0a6); font-size:12px; padding:4px 2px; }
      .pb-error { color:var(--dsw-alias-danger, #ff6b6b); font-size:12px; }
      .pb-foot { color:var(--dsw-alias-text-secondary, #9aa0a6); font-size:11px; margin-top:auto; padding-top:8px; }
      .pb-root input[type="checkbox"] { margin:2px 0 0; accent-color:var(--dsw-alias-accent, #4c8dff); }
    `;

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: 'plan-board',
            keepMounted: true,
            title: () => '计划',
            guide: [{ id: TAB_ID, title: () => '计划看板', description: '长期 / 中期 / 短期 / 预想' }],
          }),
        );
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, PlanPanel),
        );
      },
    };
  },
});
