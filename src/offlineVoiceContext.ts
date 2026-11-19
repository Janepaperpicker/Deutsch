import { createContext, useContext } from 'react'
export type OfflineVoice = {
  installed: boolean
  preview: boolean
  open: (word?: string) => void
  speak: (word: string, onPlaying?: () => void) => Promise<void>
  stop: () => void
  clear: () => void
}
export const OfflineVoiceContext = createContext<OfflineVoice | null>(null)
export const useOfflineVoice = () => useContext(OfflineVoiceContext)
