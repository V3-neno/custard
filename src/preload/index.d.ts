import { ElectronAPI } from '@electron-toolkit/preload'
import type { CustardAPI } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    custard: CustardAPI
  }
}
