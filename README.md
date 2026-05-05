# Open Meet

A self-hosted, open-source meeting app built with React, WebRTC, and WebSocket signaling.

## Features

- Create room
- Join with invite link
- Camera and microphone
- Noise suppression, echo cancellation, auto gain control
- Push-to-talk
- Screen share
- Virtual background presets
- Chat
- Participant list
- Secure invite token flow
- No accounts

## Run locally

```bash
npm install
npm run dev
```

Open the app at the Vite URL, create a room, then copy the invite link.

## Production

Build the client:

```bash
npm run build
```

Run the server with `NODE_ENV=production` behind HTTPS / WSS.

## Security notes

- Use HTTPS in production so camera and microphone permissions work.
- Put the app behind a reverse proxy with TLS.
- Set `TOKEN_SECRET` to a long random value.
- Set `ALLOWED_ORIGINS` to your real domain.
- For internet-scale rooms, replace mesh with an SFU such as mediasoup, Janus, or LiveKit.