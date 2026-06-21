export type FetchFn = (url: string) => Promise<{ status: number }>

const defaultFetchFn: FetchFn = async (url) => {
  const res = await globalThis.fetch(url)
  return { status: res.status }
}

const defaultSleepFn = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function waitForReadiness(
  url: string,
  opts: { timeoutSec: number; intervalSec: number },
  fetchFn: FetchFn = defaultFetchFn,
  sleepFn: (ms: number) => Promise<void> = defaultSleepFn,
): Promise<void> {
  const attempts = Math.ceil(opts.timeoutSec / opts.intervalSec)
  for (let i = 0; i < attempts; i++) {
    try {
      const { status } = await fetchFn(url)
      if (status >= 200 && status < 300) return
    } catch {
      // swallow fetch errors, retry
    }
    if (i < attempts - 1) await sleepFn(opts.intervalSec * 1000)
  }
  throw new Error(`readiness check failed: ${url} not ready within ${opts.timeoutSec}s`)
}
