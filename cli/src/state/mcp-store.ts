import { create } from 'zustand'

interface McpStoreState {
  showMcpMode: boolean
}

interface McpStoreActions {
  openMcpMode: () => void
  closeMcpMode: () => void
}

type McpStore = McpStoreState & McpStoreActions

export const useMcpStore = create<McpStore>()((set) => ({
  showMcpMode: false,
  openMcpMode: () => set({ showMcpMode: true }),
  closeMcpMode: () => set({ showMcpMode: false }),
}))
