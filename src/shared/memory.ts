// Automatic memory settings. `auto` is "Remember automatically" in Settings;
// `plugins` holds plugins whose activity the user asked not to remember.
export type MemorySettings = { auto: boolean; offPlugins: string[] }

export const defaultMemorySettings: MemorySettings = { auto: true, offPlugins: [] }
