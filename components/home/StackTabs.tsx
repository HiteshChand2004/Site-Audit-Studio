'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Atom, Code2, FileCode2, Folder, Server, Terminal, Triangle } from 'lucide-react';
import { FrameBar } from '@/components/ui';

/*
 * Four stacks as tabs with a gliding underline (same style as the auth switch) and one code window that shows the
 * selected stack's project tree and run command, cross-fading on switch. The tabs cycle every 4 s until the
 * visitor interacts; hover or focus pauses the cycle. Under reduced motion it never cycles.
 */

type TreeNode = { name: string; dir?: boolean; depth?: number };
type Stack = { id: string; name: string; Icon: typeof Code2; tag: string; tree: TreeNode[]; run: string };

const STACKS: Stack[] = [
  {
    id: 'html',
    name: 'HTML',
    Icon: Code2,
    tag: 'Plain pages that load fastest and work on any web host. Best for most sites.',
    tree: [
      { name: 'index.html' },
      { name: 'about.html' },
      { name: 'assets', dir: true },
      { name: 'css/styles.css', depth: 1 },
      { name: 'js/main.js', depth: 1 },
      { name: 'images/', depth: 1 },
      { name: '.nojekyll' },
    ],
    run: 'npx serve .',
  },
  {
    id: 'react-vite',
    name: 'React + Vite',
    Icon: Atom,
    tag: 'For React teams. Pages are ready for Google; visitors download a little app code.',
    tree: [
      { name: 'index.html' },
      { name: 'package.json' },
      { name: 'vite.config.js' },
      { name: 'public', dir: true },
      { name: 'src', dir: true },
      { name: 'main.jsx', depth: 1 },
      { name: 'App.jsx', depth: 1 },
    ],
    run: 'npm run dev',
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    Icon: Triangle,
    tag: 'For Next.js teams. Pages are ready for Google; visitors download more app code.',
    tree: [
      { name: 'package.json' },
      { name: 'next.config.js' },
      { name: 'public', dir: true },
      { name: 'app', dir: true },
      { name: 'layout.tsx', depth: 1 },
      { name: 'page.tsx', depth: 1 },
      { name: 'about/page.tsx', depth: 1 },
    ],
    run: 'npm run dev',
  },
  {
    id: 'mern',
    name: 'MERN',
    Icon: Server,
    tag: 'React pages plus a small server and database that store what visitors send through forms.',
    tree: [
      { name: 'package.json' },
      { name: 'client', dir: true },
      { name: 'src/App.jsx', depth: 1 },
      { name: 'server', dir: true },
      { name: 'server.js', depth: 1 },
      { name: 'models/Message.js', depth: 1 },
    ],
    run: 'npm run build && npm start',
  },
];

const CYCLE_MS = 4000;
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export default function StackTabs() {
  const [active, setActive] = useState(0);
  const [stopped, setStopped] = useState(false); // the visitor chose a tab: no more auto-cycling
  const [paused, setPaused] = useState(false); // hover or focus inside
  const list = useRef<HTMLDivElement>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();

  const placeLine = useCallback(() => {
    const l = list.current;
    const t = tabs.current[active];
    if (!l || !t) return;
    l.style.setProperty('--lx', `${t.offsetLeft}px`);
    l.style.setProperty('--ls', String(t.offsetWidth / 100));
    l.dataset.ready = '';
  }, [active]);
  useIsoLayoutEffect(placeLine, [placeLine]);
  useEffect(() => {
    const l = list.current;
    if (!l) return;
    const ro = new ResizeObserver(placeLine);
    ro.observe(l);
    return () => ro.disconnect();
  }, [placeLine]);

  // Auto-cycle until the visitor interacts; pause while hovered or focused; never under reduced motion.
  useEffect(() => {
    if (stopped || paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setTimeout(() => setActive((a) => (a + 1) % STACKS.length), CYCLE_MS);
    return () => window.clearTimeout(t);
  }, [active, stopped, paused]);

  const choose = (i: number) => {
    setStopped(true);
    setActive(i);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const last = STACKS.length - 1;
    const map: Record<string, number> = { ArrowRight: Math.min(last, active + 1), ArrowLeft: Math.max(0, active - 1), Home: 0, End: last };
    if (!(e.key in map)) return;
    e.preventDefault();
    choose(map[e.key]);
    tabs.current[map[e.key]]?.focus();
  };

  return (
    <div
      className="stabs"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
      data-reveal
    >
      <div ref={list} className="stabs__list" role="tablist" aria-label="Stacks">
        {STACKS.map((s, i) => (
          <button
            key={s.id}
            ref={(n) => {
              tabs.current[i] = n;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${i}`}
            aria-selected={active === i}
            aria-controls={`${id}-panel`}
            tabIndex={active === i ? 0 : -1}
            className="stabs__tab"
            onClick={() => choose(i)}
            onKeyDown={onKey}
          >
            <s.Icon size={16} aria-hidden="true" />
            {s.name}
          </button>
        ))}
        <span className="stabs__line" aria-hidden="true" />
      </div>

      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${active}`} className="frame stabs__win">
        <FrameBar addr="your-site · download" />
        <div className="stabs__body">
          {STACKS.map((s, i) => (
            <div key={s.id} className="stabs__view" aria-hidden={active !== i || undefined} data-on={active === i || undefined}>
              <ul className="stabs__tree">
                {s.tree.map((n, j) => (
                  <li key={j} data-dir={n.dir || undefined} style={{ paddingLeft: `${(n.depth ?? 0) * 18}px` }}>
                    {n.dir ? <Folder size={14} aria-hidden="true" /> : <FileCode2 size={14} aria-hidden="true" />}
                    {n.name}
                    {n.dir ? '/' : ''}
                  </li>
                ))}
              </ul>
              <div className="stabs__run">
                <Terminal size={14} aria-hidden="true" />
                <code>{s.run}</code>
              </div>
              <p className="stabs__tag">{s.tag}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
