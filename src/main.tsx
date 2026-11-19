import { OfflineVoiceProvider } from './OfflineVoiceProvider.tsx'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import AppStartup from './AppStartup.tsx'
import { ConfirmProvider } from './ConfirmDialog.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfirmProvider>
      <OfflineVoiceProvider><AppStartup /></OfflineVoiceProvider>
    </ConfirmProvider>
  </StrictMode>,
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('Unable to register the offline app worker.', error)
    })
  })
}
