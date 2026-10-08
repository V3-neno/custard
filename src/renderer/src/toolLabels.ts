import { createContext } from 'react'

// Chat labels for plugin tools, from their manifests (e.g. 'Searched Spotify
// for "{query}"'), so past tool calls read well in the history.
export const ToolLabelsContext = createContext<Record<string, string>>({})
