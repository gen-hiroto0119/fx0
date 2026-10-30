'use client'

import dynamic from 'next/dynamic'

// The game runs entirely in the browser (localStorage, canvas), so it is not prerendered.
const Game = dynamic(() => import('./game'), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-muted-foreground">地域を読み込んでいます…</p>,
})

export function GameLoader() {
  return <Game />
}
