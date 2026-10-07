export const cleanError = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

export const button = 'rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40'
export const primary = `${button} molten-fill text-forge-950`
export const secondary = `${button} border border-forge-700 text-ash-300 hover:text-molten-200`
export const danger = `${button} border border-forge-700 text-ash-400 hover:border-ember-600 hover:text-ember-600`
export const input =
  'w-full rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 text-sm outline-none focus:border-molten-500/60'
