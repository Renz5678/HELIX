/*
 * API client for the HELIX C server (gui/server.c).
 * All endpoints:
 *   GET  /api/health
 *   GET  /api/library
 *   GET  /api/library/file?path=...
 *   POST /api/analyze            (body = raw source)
 *   POST /api/fs?op=...&path=... (body = file content for create/write)
 */

export async function analyze(code) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: code,
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export async function fetchLibrary() {
  const res = await fetch('/api/library');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).files || [];
}

export async function readFile(path) {
  const res = await fetch('/api/library/file?path=' + encodeURIComponent(path));
  if (!res.ok) throw new Error(res.status === 403 ? 'Path not allowed' : 'File not found');
  return res.text();
}

export async function fsOp({ op, path, to = '', kind = '', body = '' }) {
  const q = new URLSearchParams({ op, path, to, kind });
  const res = await fetch('/api/fs?' + q.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Operation failed (HTTP ${res.status})`);
  }
  return data;
}
