import { createContext } from 'react'
import type { Provider } from '../../shared/chat'

// The provider of the selected model. It sets the app's tint.
export const ProviderContext = createContext<Provider>('claude')
