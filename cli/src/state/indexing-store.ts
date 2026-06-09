import { create } from 'zustand'

import type { IndexProgress, IndexSummary } from '@codebuff/semantic-context'

interface IndexingState {
  enabled: boolean
  /** The project root currently being indexed (absolute path). */
  projectRoot: string | null
  progress: IndexProgress | null
  summary: IndexSummary | null
  lastError: string | null
}

interface IndexingActions {
  enable: (projectRoot: string) => void
  disable: () => void
  setProgress: (progress: IndexProgress) => void
  setSummary: (summary: IndexSummary) => void
  setError: (error: string | null) => void
  reset: () => void
}

type Store = IndexingState & IndexingActions

const INITIAL: IndexingState = {
  enabled: false,
  projectRoot: null,
  progress: null,
  summary: null,
  lastError: null,
}

export const useIndexingStore = create<Store>((set) => ({
  ...INITIAL,
  enable: (projectRoot) =>
    set({
      enabled: true,
      projectRoot,
      progress: null,
      summary: null,
      lastError: null,
    }),
  disable: () => set({ ...INITIAL }),
  setProgress: (progress) => set({ progress }),
  setSummary: (summary) => set({ summary }),
  setError: (lastError) => set({ lastError }),
  reset: () => set({ ...INITIAL }),
}))
