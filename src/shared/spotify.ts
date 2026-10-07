// Custard listens on this loopback address during sign-in. It must be added,
// exactly, as a Redirect URI in the Spotify developer dashboard.
export const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:43821/callback'

// Only what the tools need: reading playback state, devices and the queue
// (the queue read also needs user-read-currently-playing), and modifying
// playback (adding to the queue, moving to a device). No listening history.
export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state'
]

export type SpotifyStatus = {
  clientId: string | null
  connected: boolean
  user: string | null
}
