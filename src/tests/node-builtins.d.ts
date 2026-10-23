/**
 * Minimal Node builtin typings for the test suite. The repo has no
 * @types/node (the game itself is browser-only); tests run under Node via
 * esbuild, and a few guards read repo files (e.g. style.css) from disk.
 */
declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function readFileSync(path: string, encoding: 'utf8'): string
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string
}
