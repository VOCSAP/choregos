export type ThalposWarm = {
  /** Epoch ms after which no ping is sent. */
  deadline: number
  /** Epoch ms of the latest request of the main thread or ping. */
  lastRequestAt: number
  /** Epoch ms of the next ping or retry; null while waiting for a turn. */
  nextAt: number | null
  pings: number
  cacheRead: number
  cacheCreation: number
  /** Retries already spent on the ping in progress. */
  retries: number
}

declare module 'claude-code' {
  interface PluginState {
    /** `lastRequest`: epoch ms of the latest main turn.complete or warm ping, kept while inactive so start counts from it. */
    thalpos: { warm: ThalposWarm | null; lastRequest: number | null }
  }
}
