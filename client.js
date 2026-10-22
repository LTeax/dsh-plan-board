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

    function orderedItems(items) {
      return [...items].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return PRIORITY_RANK(a.priority || 0) - PRIORITY_RANK(b.priority || 0);
      });
    }

    function Item({ item, part, onToggle, onPriority, showPriority }) {
      const ratio = itemRatio(item);
      const priority = item.priority || 0;
      return h(
        'div',
        { className: showPriority ? `pb-item pb-imp-${priority}` : 'pb-item' },
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
      );
    }

    function Section({ part, section, collapsed, onToggleCollapse, onToggle, onPriority }) {
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
                      showPriority: !NO_PROGRESS.has(part),
                    }),
                  ),
            ),
      );
    }

    function PlanPanel() {
      const [state, setState] = useState({ loading: true, ok: false, doc: null, error: '' });
      const [collapsed, setCollapsed] = useState({});
      const [busy, setBusy] = useState('');
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

      const createBoard = useCallback(async () => {
        const title = window.prompt('新计划的名称（建议直接用项目名）', '');
        if (!title || !title.trim()) return;
        try {
          const response = await fetch('/plan-board/board', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: title.trim() }),
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
        } catch (error) {
          setState((previous) => ({ ...previous, error: String((error && error.message) || error) }));
        }
      }, [remember]);

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

      const onToggleCollapse = useCallback((part) => {
        setCollapsed((previous) => ({ ...previous, [part]: !previous[part] }));
      }, []);

      const doc = state.doc;
      // 只对"有条目"的分区求平均：空分区没有完成度，掺进分母会虚增或虚减总进度。
      const tracked = doc
        ? PARTS.filter((part) => !NO_PROGRESS.has(part) && doc.sections[part].items.length > 0)
        : [];
      const overall = tracked.length
        ? tracked.reduce((total, part) => total + sectionRatio(doc.sections[part]), 0) / tracked.length
        : null;

      return h(
        'div',
        { className: 'pb-root' },
        h('style', null, STYLE),
        h(
          'header',
          { className: 'pb-head' },
          h('span', { className: 'pb-title' }, '计划'),
          h(
            'select',
            {
              className: 'pb-select',
              value: board || (boards[0] ? boards[0].slug : ''),
              onChange: (event) => switchBoard(event.target.value),
              title: '切换计划（每个项目一个）',
            },
            boards.length === 0 ? h('option', { value: '' }, '（还没有计划）') : null,
            boards.map((item) => h('option', { key: item.slug, value: item.slug }, item.title)),
          ),
          doc ? h('span', { className: 'pb-muted' }, overall === null ? '总进度 —' : `总进度 ${percent(overall)}`) : null,
          h(
            'button',
            { type: 'button', className: 'pb-refresh', onClick: () => void createBoard(), title: '新建计划' },
            '＋',
          ),
          h(
            'button',
            { type: 'button', className: 'pb-refresh', onClick: () => void load(), title: '刷新' },
            '↻',
          ),
        ),
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
      .pb-select { max-width:150px; height:24px; border-radius:6px; background:transparent; color:inherit;
        border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14)); font:inherit; padding:0 4px; }
      .pb-select option { color:#111; }
      .pb-muted { color:var(--dsw-alias-text-secondary, #9aa0a6); font-size:12px; }
      .pb-refresh { margin-left:auto; background:transparent; border:1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.14));
        color:inherit; border-radius:6px; width:24px; height:24px; cursor:pointer; }
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
      .pb-item { display:flex; flex-direction:column; gap:4px; padding:6px 8px; border-radius:8px;
        background:var(--dsw-alias-bg-elevated, rgba(255,255,255,.04)); }
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
