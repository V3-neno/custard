# Spotify plugin

The reference plugin for Custard: it uses only the public plugin API (`custard-plugin-sdk`). Custard's core has no Spotify code.

- **Tools:** `spotify__search`, `spotify__now_playing`, `spotify__devices` (read); `spotify__add_to_queue`, `spotify__open`, `spotify__transfer_playback` (write, so Custard asks before each one unless you turn that off).
- **Permissions:** connect to `api.spotify.com` and `accounts.spotify.com`, open `spotify:` links, and sign in to your Spotify account with three scopes: `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`.
- **Sign-in:** Authorization Code with PKCE, run by Custard's host. The plugin asks the host to add the token (`ctx.fetch(url, { auth: true })`) and never sees it.
- **No vault access:** music preferences are read and written by the assistant with its own vault tools, following the `music` skill, not by this plugin.

Setup, limits and the manual test checklist are in [docs/SPOTIFY.md](../../docs/SPOTIFY.md).
