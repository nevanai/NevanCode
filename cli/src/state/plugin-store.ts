import { create } from 'zustand'

interface PluginStoreState {
  showPluginMode: boolean
  skillsVersion: number
}

interface PluginStoreActions {
  openPluginMode: () => void
  closePluginMode: () => void
  bumpSkillsVersion: () => void
}

type PluginStore = PluginStoreState & PluginStoreActions

export const usePluginStore = create<PluginStore>()((set) => ({
  showPluginMode: false,
  skillsVersion: 0,

  openPluginMode: () => set({ showPluginMode: true }),

  closePluginMode: () => set({ showPluginMode: false }),

  bumpSkillsVersion: () => set((state) => ({ skillsVersion: state.skillsVersion + 1 })),
}))
