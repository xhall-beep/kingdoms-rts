/**
 * Build stamp rendered in a HUD corner so every screenshot self-identifies
 * the build it came from. The deploy script (~/workspace/bin/
 * kingdoms-deploy-all.py) replaces the placeholder in the bundled output
 * with "<base commit> · <build date>". In dev the placeholder survives and
 * the HUD labels the build as a dev build instead.
 *
 * DEFECT (found 2026-11-24, live since 2026-10-22): the label used to be
 * `BUILD_STAMP === '__BUILD_STAMP__' ? 'dev build' : BUILD_STAMP` — but the
 * deploy pipeline replaces EVERY `__BUILD_STAMP__` occurrence in the
 * minified bundle, including the comparison literal, so in every shipped
 * build the comparison was true and the HUD read "dev build". The served
 * stamp was correct in the bytes while the visible label lied. Detect the
 * unstamped state by shape instead: a real stamp is "<hex> · <YYYY-MM-DD>".
 * The shape check contains no `__BUILD_STAMP__` token, so no deploy-time
 * replacement can ever touch it.
 */
export const BUILD_STAMP = '__BUILD_STAMP__'

const STAMP_RE = /^[0-9a-f]{7,} · \d{4}-\d{2}-\d{2}$/

export const BUILD_STAMP_LABEL = STAMP_RE.test(BUILD_STAMP) ? BUILD_STAMP : 'dev build'
