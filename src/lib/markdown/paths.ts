/**
 * Local path shims for the markdown flows: pure string math instead of
 * @tauri-apps/api/path (whose per-call Rust invoke drags the flows
 * through mocked invokes in tests). Both separators are handled — the
 * file dialogs hand back native paths.
 */

function lastSeparator(path: string): number {
  const slash = path.lastIndexOf('/');
  const back = path.lastIndexOf('\\');
  return slash > back ? slash : back;
}

/** The directory portion ('.' when the path has no separator). */
export function dirName(path: string): string {
  const cut = lastSeparator(path);
  if (cut <= 0) return '.';
  if (cut === 0) return '/';
  return path.slice(0, cut);
}

/** The final segment (the filename). */
export function baseName(path: string): string {
  return path.slice(lastSeparator(path) + 1);
}

/** Strip the final extension ('archive.tar.gz' → 'archive.tar'). */
export function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Join a directory and a relative name, reusing the directory's own
 *  separator style ('C:\x' + name joins with '\'; everything else '/').
 *  Leading './' segments are stripped — markdown refs are commonly
 *  spelled './img/x.png', and a canonical join keeps the path clean. */
export function joinPath(dir: string, name: string): string {
  if (/^[\\/]/.test(name)) return name;
  const clean = name.replace(/^(\.[\\/])+/g, '');
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${clean}` : `${dir}${sep}${clean}`;
}
