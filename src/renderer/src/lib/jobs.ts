import { useEffect, useState } from 'react'
import type { JobProgress } from '../../../shared/types'

export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Latest progress event for one backup/restore job (null until the first one arrives). */
export function useJobProgress(jobId: string | null): JobProgress | null {
  const [progress, setProgress] = useState<JobProgress | null>(null)
  useEffect(() => {
    setProgress(null)
    if (!jobId) return
    return window.api.onJobProgress((p) => {
      if (p.jobId === jobId) setProgress(p)
    })
  }, [jobId])
  return progress
}
