/**
 * Build stamp rendered in a HUD corner so every screenshot self-identifies
 * the build it came from. The deploy script (~/workspace/bin/
 * kingdoms-deploy-all.py) replaces the placeholder in the bundled output
 * with "<base commit> · <build date>". In dev the placeholder survives and
 * the HUD labels the build as a dev build instead.
 */
export const BUILD_STAMP = '__BUILD_STAMP__'

export const BUILD_STAMP_LABEL = BUILD_STAMP === '__BUILD_STAMP__' ? 'dev build' : BUILD_STAMP
