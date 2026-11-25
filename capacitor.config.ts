import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.kedu.reading',
  appName: '刻读',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: ['api.minimaxi.com'],
  },
  plugins: {
    CapacitorHttp: { enabled: true },
  },
}

export default config
