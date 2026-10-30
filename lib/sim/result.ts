// Actions return an error code instead of throwing, so the player and the AI
// rivals get the same answers from the same rules.
export type Result<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = (error: string): Result<never> => ({ ok: false, error })
