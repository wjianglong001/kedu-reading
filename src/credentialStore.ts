import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Capacitor } from '@capacitor/core'

const KEY = 'minimax-api-key'

export const credentialStore = {
  async get(): Promise<string> {
    if (Capacitor.isNativePlatform()) {
      const stored = await SecureStorage.get(KEY)
      return stored == null ? '' : String(stored)
    }
    return window.localStorage.getItem(KEY) ?? ''
  },

  async set(value: string): Promise<void> {
    const clean = value.trim()
    if (!clean) throw new Error('API Key 不能为空')
    if (Capacitor.isNativePlatform()) {
      await SecureStorage.set(KEY, clean)
      return
    }
    window.localStorage.setItem(KEY, clean)
  },

  async remove(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await SecureStorage.remove(KEY)
      return
    }
    window.localStorage.removeItem(KEY)
  },

  mask(value: string): string {
    if (value.length < 9) return value ? '••••••••' : ''
    return `${value.slice(0, 4)}••••••${value.slice(-4)}`
  },
}
