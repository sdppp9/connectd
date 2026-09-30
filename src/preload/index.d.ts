import type { ConnectDeeApi } from './index'

declare global {
  interface Window {
    api: ConnectDeeApi
  }
}

export {}
