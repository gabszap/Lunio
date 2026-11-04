# Screen sharing

**English** · [Português](screen-sharing.pt-BR.md) · ← [Back to the README](../README.md)

Off by default. It uses **MoQ over WebTransport** through a relay: the Host's browser captures the screen (`getDisplayMedia`), encodes it with WebCodecs (H.264 video, Opus audio) and publishes to the relay; viewers subscribe, decode and draw it, with the audio as the clock. The server only coordinates (who is broadcasting, the quality, the keys) and never touches the video.

To turn it on you need a relay. The default is [Cloudflare's managed MoQ relay](https://developers.cloudflare.com/) (beta): create a relay, then put its URL and its two default tokens in `.env` and set the flag:

```bash
SCREEN_SHARE_ENABLED=1
MOQ_RELAY_URL=https://<your relay>
MOQ_TOKEN_PUBLISH=…
MOQ_TOKEN_SUBSCRIBE=…
```

- **Who can do what.** Only the room's Host starts a broadcast (desktop Chromium; the page asks for the screen and, if the browser offers it, the system audio). The Host's quality choice is final for that broadcast: there is no automatic downgrade. The relay's publish token is only ever given to the Host who is streaming.
- **Privacy.** Every frame is encrypted (AES-GCM) with a key the Host's browser generates, and the server hands that key only to the people in the room right now over the room WebSocket. A relay token cannot be scoped to one broadcast, and revoking it does not drop a connection that is already open, so the encryption is what keeps outsiders out. When someone is kicked, banned or leaves, the Host rotates the key and the people who stay get the new one; the one who left keeps receiving bytes they can no longer decode. Keys are never stored, logged or put in the room state.
- **Browsers.** Hosts: Chrome, Edge or Brave on a computer (a recent version: older ones ignore the option that keeps the room video's own sound out of the shared system audio, so the Host's room video may be heard twice by viewers; sharing a window instead of the whole screen avoids it). Viewers: Chromium browsers and Firefox. Safari and iOS are not supported, and screen sharing is off inside the Discord Activity.
- **Cost.** The relay is in beta and has no price or meter yet. The server counts what the Hosts send and estimates the egress (bytes × viewers): **Status** shows it, and the numbers are kept per day in Redis when Redis is on. For scale, 1080p60 is up to 10 Mbps, about 4.5 GB per hour *per viewer*. `SCREEN_SHARE_MAX_LIVE` caps simultaneous broadcasts. If the managed relay ever becomes a problem, the transport sits behind an interface, so a self-hosted `moq-relay` (or another provider) can replace it without touching the rest.
- **Limits.** A broadcast ends with its Host (Host change, leaving, closing the page or a restart). It is memory-only and never saved to Redis. 60 fps depends on the Host's machine: some computers only capture about 30 fps even when asked for 60.
