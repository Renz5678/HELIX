import { useState, useEffect, useRef } from 'react';
import { fsOp } from '../lib/api.js';

/*
 * Workspace file tree backed by the C server's /api/library + /api/fs.
 * Workspace folders are writable; examples/tests are read-only fixtures.
 */
export default function FileExplorer({ files, activePath, onOpen, onRefresh, onToast }) {
  const [menu, setMenu] = useState(null); // {x, y, file}
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  /* group files by their display folder */
  const groups = {};
  for (const f of files) {
    (groups[f.dir] ||= []).push(f);
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  const folderOrder = Object.keys(groups).sort((a, b) => {
    const writable = (d) => d !== 'examples' && d !== 'tests';
    if (writable(a) !== writable(b)) return writable(a) ? -1 : 1;
    return a.localeCompare(b);
  });

  async function act(fn) {
    try {
      await fn();
      onRefresh();
    } catch (err) {
      onToast(err.message, 'error');
    }
  }

  const doNewFile = () =>
    act(async () => {
      const name = window.prompt('New rule file name:', 'new_rule.helix');
      if (!name) return;
      const safe = name.endsWith('.helix') ? name : name + '.helix';
      const folder = window.prompt('Folder under workspace/ (e.g. rules):', 'rules') || 'rules';
      const path = `workspace/${folder.replace(/[^a-z0-9_\-]/gi, '')}/${safe.replace(/[/\\]/g, '_')}`;
      await fsOp({ op: 'create', path, body: `# New HELIX rule\nrule Untitled:\n    intent: "TODO"\nend\n` });
      onOpen(path, safe);
      onToast(`Created ${path}`, 'info');
    });

  const doNewFolder = () =>
    act(async () => {
      const name = window.prompt('New folder name under workspace/:', 'panels');
      if (!name) return;
      await fsOp({ op: 'mkdir', path: `workspace/${name.replace(/[^a-z0-9_\-]/gi, '')}` });
      onToast(`Created workspace/${name}`, 'info');
    });

  const doRename = (file) =>
    act(async () => {
      const name = window.prompt('Rename to:', file.name);
      if (!name || name === file.name) return;
      const to = `${file.dir}/${name.replace(/[/\\]/g, '_')}`;
      await fsOp({ op: 'rename', path: file.path, to });
      onToast(`Renamed to ${name}`, 'info');
    });

  const doDelete = (file) =>
    act(async () => {
      if (!window.confirm(`Delete ${file.path}?`)) return;
      await fsOp({ op: 'delete', path: file.path });
      onToast(`Deleted ${file.path}`, 'info');
    });

  const FileIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
  );
  const FolderIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
  );

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-cyan-400/15 px-2.5 py-2">
        <span className="flex-1 text-[10.5px] font-bold uppercase tracking-[1.5px] text-helix-muted">Modules</span>
        <button className="btn btn-icon" onClick={doNewFile} title="New rule file" aria-label="New file">{FileIcon}</button>
        <button className="btn btn-icon" onClick={doNewFolder} title="New folder" aria-label="New folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>
        </button>
        <button className="btn btn-icon" onClick={onRefresh} title="Refresh workspace" aria-label="Refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1.5">
        {folderOrder.length === 0 && (
          <div className="p-3.5 text-center text-xs text-helix-dim">No modules found — is the server running?</div>
        )}
        {folderOrder.map((dir) => (
          <div key={dir}>
            <div className="flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] font-semibold text-helix-text">
              <span className="text-helix-cyan">{FolderIcon}</span>
              <span className="font-ui">{dir}</span>
            </div>
            {groups[dir].map((f) => (
              <div
                key={f.path}
                className={`flex cursor-pointer items-center gap-1.5 border-l-2 py-1 pl-6 pr-2.5 text-helix-muted transition-colors hover:bg-cyan-400/5 hover:text-helix-text ${
                  f.path === activePath ? 'border-l-helix-cyan bg-cyan-400/10 text-helix-cyan' : 'border-transparent'
                }`}
                onClick={() => onOpen(f.path, f.name, f.ro)}
                onContextMenu={(e) => { e.preventDefault(); if (!f.ro) setMenu({ x: e.clientX, y: e.clientY, file: f }); }}
                title={f.path + (f.ro ? ' (read-only)' : '')}
              >
                <span className="w-3.5 shrink-0 opacity-70">{FileIcon}</span>
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs">{f.name}</span>
                {f.ro && <span className="rounded border border-cyan-400/15 px-1 text-[8.5px] text-helix-dim">RO</span>}
              </div>
            ))}
          </div>
        ))}
        <div className="mt-2 border-t border-cyan-400/10 px-3 pt-2 text-[10.5px] leading-relaxed text-helix-dim">
          Right-click workspace files to rename or delete. <b>examples/</b> and <b>tests/</b> are protected fixtures.
        </div>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-[200] min-w-[150px] rounded-lg border border-cyan-400/35 bg-helix-surface2 p-1 shadow-[0_10px_34px_rgba(0,0,0,0.6)]"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <div
            className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-xs hover:bg-cyan-400/10"
            onClick={() => { setMenu(null); doRename(menu.file); }}
            role="menuitem"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
            Rename
          </div>
          <div
            className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-xs text-helix-err hover:bg-rose-500/10"
            onClick={() => { setMenu(null); doDelete(menu.file); }}
            role="menuitem"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            Delete
          </div>
        </div>
      )}
    </>
  );
}
