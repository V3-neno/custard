import type { CustardAPI } from './index'

declare global {
  interface Window {
    custard: CustardAPI
  }
}
