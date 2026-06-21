import React, { useEffect, useMemo, useRef, useState } from "react";

function randomId(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function encodeSvg(svg) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function makePreset(name, a, b, c, d) {
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${a}" />
        <stop offset="55%" stop-color="${b}" />
        <stop offset="100%" stop-color="${c}" />
      </linearGradient>
      <filter id="blur">
        <feGaussianBlur stdDeviation="42" />
      </filter>
    </defs>
    <rect width="1280" height="720" fill="${d}" />
    <circle cx="180" cy="110" r="180" fill="${a}" opacity="0.22" filter="url(#blur)" />
    <circle cx="1140" cy="160" r="220" fill="${b}" opacity="0.2" filter="url(#blur)" />
    <circle cx="980" cy="610" r="280" fill="${c}" opacity="0.18" filter="url(#blur)" />
    <rect width="1280" height="720" fill="url(#g)" opacity="0.18" />
    <path d="M0 540 C 220 470, 390 650, 640 570 S 1060 460, 1280 560 L 1280 720 L 0 720 Z" fill="rgba(255,255,255,0.06)" />
    <path d="M0 600 C 180 530, 420 700, 680 620 S 1030 560, 1280 650 L 1280 720 L 0 720 Z" fill="rgba(0,0,0,0.14)" />
  </svg>`;
  return { name, src: encodeSvg(svg) };
}

const PRESETS = [
  makePreset("Midnight", "#0f172a", "#4f46e5", "#14b8a6", "#050816"),
  makePreset("Aurora", "#8b5cf6", "#22c55e", "#06b6d4", "#08111f"),
  makePreset("Slate", "#1e293b", "#334155", "#0f766e", "#0b1020"),
  makePreset("Ember", "#fb7185", "#f97316", "#8b5cf6", "#120b11"),
];

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478?transport=udp" },
];

let selfieSegmentationLoaderPromise = null;

function useRoomPath() {
  const [pathState, setPathState] = useState({ roomId: null, token: null });

  useEffect(() => {
    const match = window.location.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)/);
    const roomId = match?.[1] || null;
    const token = new URLSearchParams(window.location.search).get("t");
    setPathState({ roomId, token });
  }, []);

  return pathState;
}

function parseInviteText(input) {
  const value = String(input || "").trim();
  if (!value) return { roomId: "", token: "" };

  const direct = value.match(
    /^([a-zA-Z0-9_-]{4,32})(?:\s+|\s*[,;:\-]\s*|\s*\|\s*)([A-Za-z0-9._~\-]+=*)$/,
  );
  if (direct) return { roomId: direct[1], token: direct[2] };

  try {
    const url = new URL(value, window.location.origin);
    const roomMatch = url.pathname.match(/\/room\/([a-zA-Z0-9_-]+)/);
    if (roomMatch) {
      const token = url.searchParams.get("t") || "";
      return { roomId: roomMatch[1], token };
    }
  } catch {}

  const roomMatch = value.match(/\/room\/([a-zA-Z0-9_-]+)/);
  const tokenMatch = value.match(/[?&]t=([^\s]+)/);
  if (roomMatch && tokenMatch) {
    return {
      roomId: roomMatch[1],
      token: decodeURIComponent(tokenMatch[1]),
    };
  }

  return {
    roomId: value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32),
    token: "",
  };
}

async function createRoom({ name, title }) {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, title }),
  });
  if (!res.ok) throw new Error("Unable to create room");
  return res.json();
}

function buildWsUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function loadScriptOnce(src) {
  if (typeof window === "undefined") return Promise.resolve(false);
  const existing = document.querySelector(`script[data-src="${src}"]`);
  if (existing) {
    return new Promise((resolve) => {
      if (window.SelfieSegmentation) return resolve(true);
      existing.addEventListener("load", () => resolve(true), { once: true });
      existing.addEventListener("error", () => resolve(false), { once: true });
    });
  }

  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.src = src;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

async function ensureSelfieSegmentationLoaded() {
  if (typeof window === "undefined") return false;
  if (window.SelfieSegmentation) return true;
  if (!selfieSegmentationLoaderPromise) {
    selfieSegmentationLoaderPromise = loadScriptOnce(
      "/mediapipe/selfie_segmentation.js",
    );
  }
  return selfieSegmentationLoaderPromise;
}

function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {}
  }
}

function useVirtualBackground(cameraStream, enabled, preset) {
  const [stream, setStream] = useState(null);
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const segRef = useRef(null);

  useEffect(() => {
    if (!cameraStream) {
      setStream(null);
      return;
    }

    const video = videoRef.current;
    if (video) {
      video.srcObject = cameraStream;
      video.play().catch(() => {});
    }
  }, [cameraStream]);

  useEffect(() => {
    if (!cameraStream) {
      setStream(null);
      return;
    }

    if (!enabled || !preset) {
      setStream(cameraStream);
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      setStream(cameraStream);
      return;
    }

    let cancelled = false;
    let ready = false;
    let busy = false;
    const ctx = canvas.getContext("2d", { alpha: false });
    const bg = new Image();
    bg.src = preset.src;

    const start = async () => {
      const loaded = await ensureSelfieSegmentationLoaded();
      if (cancelled || !loaded || !window.SelfieSegmentation) {
        setStream(cameraStream);
        return;
      }

      const seg = new window.SelfieSegmentation({
        locateFile: (file) => `/mediapipe/${file}`,
      });

      seg.setOptions({ modelSelection: 1 });
      seg.onResults((results) => {
        if (cancelled) return;
        const width = results.image.videoWidth || results.image.width || 1280;
        const height = results.image.videoHeight || results.image.height || 720;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;

        ctx.save();
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(results.segmentationMask, 0, 0, width, height);
        ctx.globalCompositeOperation = "source-in";
        ctx.drawImage(results.image, 0, 0, width, height);
        ctx.globalCompositeOperation = "destination-over";
        ctx.drawImage(bg, 0, 0, width, height);
        ctx.restore();
      });

      segRef.current = seg;
      ready = true;
      const canvasStream = canvas.captureStream(30);
      const audioTracks = cameraStream.getAudioTracks();
      setStream(
        new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]),
      );

      const tick = async () => {
        if (cancelled || !ready) return;
        if (!busy && video.readyState >= 2) {
          busy = true;
          try {
            await seg.send({ image: video });
          } catch {}
          busy = false;
        }
        if (cancelled) return;
        if (typeof video.requestVideoFrameCallback === "function") {
          video.requestVideoFrameCallback(() => tick());
        } else {
          rafRef.current = requestAnimationFrame(tick);
        }
      };

      tick();
    };

    start();

    return () => {
      cancelled = true;
      ready = false;
      cancelAnimationFrame(rafRef.current);
      try {
        segRef.current?.close?.();
      } catch {}
      segRef.current = null;
    };
  }, [cameraStream, enabled, preset]);

  return { stream, videoRef, canvasRef };
}

function App() {
  const { roomId: pathRoomId, token: pathToken } = useRoomPath();
  const [name, setName] = useState(
    () => localStorage.getItem("meet-name") || "",
  );
  const [invite, setInvite] = useState({
    roomId: pathRoomId || "",
    token: pathToken || "",
  });
  const [screen, setScreen] = useState(
    pathRoomId && pathToken ? "room" : "lobby",
  );
  const [error, setError] = useState("");

  useEffect(() => {
    if (pathRoomId && pathToken) {
      setInvite({ roomId: pathRoomId, token: pathToken });
      setScreen("room");
    }
  }, [pathRoomId, pathToken]);

  if (screen === "room" && invite.roomId && invite.token) {
    return (
      <RoomPage
        initialRoomId={invite.roomId}
        initialToken={invite.token}
        initialName={name}
        onLeave={() => setScreen("lobby")}
      />
    );
  }

  return (
    <Lobby
      name={name}
      setName={setName}
      error={error}
      setError={setError}
      initialRoomId={invite.roomId}
      initialToken={invite.token}
      onCreated={async (payload) => {
        setError("");
        localStorage.setItem("meet-name", name);
        setInvite({ roomId: payload.roomId, token: payload.token });
        window.history.pushState(
          {},
          "",
          `/room/${payload.roomId}?t=${encodeURIComponent(payload.token)}`,
        );
        setScreen("room");
      }}
      onJoin={(roomId, tokenValue) => {
        setInvite({ roomId, token: tokenValue });
        window.history.pushState(
          {},
          "",
          `/room/${roomId}?t=${encodeURIComponent(tokenValue)}`,
        );
        setScreen("room");
      }}
    />
  );
}

function Lobby({
  name,
  setName,
  onCreated,
  onJoin,
  error,
  setError,
  initialRoomId,
  initialToken,
}) {
  const [roomCode, setRoomCode] = useState(initialRoomId || "");
  const [inviteToken, setInviteToken] = useState(initialToken || "");
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (initialRoomId) setRoomCode(initialRoomId);
    if (initialToken) setInviteToken(initialToken);
  }, [initialRoomId, initialToken]);

  const applyInvite = (value) => {
    const parsed = parseInviteText(value);
    if (parsed.roomId) setRoomCode(parsed.roomId);
    if (parsed.token) setInviteToken(parsed.token);
  };

  return (
    <div className="join-wrap">
      <div className="join-box">
        <div className="card hero-card">
          <div className="stack">
            <div>
              <div className="badge">
                <span className="dot on" /> Open-source meeting room
              </div>
              <h2 className="hero-title">
                Meet, share, and talk without accounts
              </h2>
              <p className="hero-copy">
                Create a private room, send the invite link, and join with
                camera, microphone, screen share, noise suppression, echo
                cancellation, and background presets.
              </p>
            </div>
            <div className="input-row">
              <input
                className="input"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="input"
                placeholder="Room title (optional)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <button
                className="btn"
                onClick={async () => {
                  if (!name.trim()) return setError("Please enter your name");
                  try {
                    const payload = await createRoom({
                      name: name.trim(),
                      title,
                    });
                    onCreated(payload);
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                Create room
              </button>
            </div>
            {error ? <div className="badge error-badge">{error}</div> : null}
          </div>
        </div>

        <div className="card">
          <div className="stack">
            <div>
              <h3>Join an existing room</h3>
              <p>Paste a room link or fill the code and token.</p>
            </div>
            <div className="input-row">
              <input
                className="input"
                placeholder="Room code or invite link"
                value={roomCode}
                onChange={(e) => {
                  const value = e.target.value;
                  setRoomCode(value);
                  applyInvite(value);
                }}
              />
              <textarea
                className="textarea"
                placeholder="Invite token"
                value={inviteToken}
                onChange={(e) => setInviteToken(e.target.value)}
              />
              <button
                className="btn secondary"
                onClick={() => {
                  const parsedRoom = parseInviteText(roomCode);
                  const finalRoom = parsedRoom.roomId || roomCode.trim();
                  const finalToken = inviteToken.trim() || parsedRoom.token;
                  if (!finalRoom || !finalToken)
                    return setError("Room code and invite token are required");
                  if (!name.trim()) return setError("Please enter your name");
                  localStorage.setItem("meet-name", name.trim());
                  onJoin(finalRoom, finalToken);
                }}
              >
                Join room
              </button>
            </div>
            <div className="mini">
              Tip: inside a room press <span className="kbd">Space</span> to
              hold-to-talk.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RoomPage({ initialRoomId, initialToken, initialName, onLeave }) {
  const [name, setName] = useState(initialName || "");
  const [roomId] = useState(initialRoomId);
  const [token] = useState(initialToken);
  const [selfId, setSelfId] = useState(null);
  const [room, setRoom] = useState(null);
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [cameraStream, setCameraStream] = useState(null);
  const [mediaReady, setMediaReady] = useState(false);
  const [bgEnabled, setBgEnabled] = useState(true);
  const [bgPreset, setBgPreset] = useState(PRESETS[0]);
  const [chatText, setChatText] = useState("");
  const [messages, setMessages] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState("");
  const [pushTalk, setPushTalk] = useState(false);
  const [layout, setLayout] = useState("auto");
  const [stats, setStats] = useState({ bitrate: 0, rtt: 0, packetLoss: 0 });

  const wsRef = useRef(null);
  const pcMap = useRef(new Map());
  const remoteStreams = useRef(new Map());
  const localVideoRef = useRef(null);
  const shareVideoRef = useRef(null);
  const activeShareRef = useRef(null);

  const {
    stream: processedStream,
    videoRef: bgVideoRef,
    canvasRef,
  } = useVirtualBackground(cameraStream, bgEnabled, bgPreset);
  const basePreviewStream = processedStream || cameraStream || null;

  useEffect(() => {
    localStorage.setItem("meet-name", name);
  }, [name]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setPushTalk(true);
      }
    };
    const onKeyUp = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        setPushTalk(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const pc of pcMap.current.values()) {
        try {
          pc.close();
        } catch {}
      }
      pcMap.current.clear();
      try {
        wsRef.current?.close();
      } catch {}
      stopStream(cameraStream);
      stopStream(activeShareRef.current);
    };
  }, [cameraStream]);

  useEffect(() => {
    if (!basePreviewStream) return;
    const video = localVideoRef.current;
    if (video) {
      video.srcObject = basePreviewStream;
      video.play().catch(() => {});
    }
  }, [basePreviewStream]);

  useEffect(() => {
    const run = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
          },
        });
        setCameraStream(stream);
        setMediaReady(true);
        setMuted(true);
      } catch {
        setError("Camera or microphone permission is required");
      }
    };
    run();
  }, []);

  const updateSelfParticipant = (patch) => {
    setParticipants((prev) => {
      const selfIndex = prev.findIndex((p) => p.self);
      const current =
        selfIndex >= 0
          ? prev[selfIndex]
          : { id: selfId || "self", self: true, name: name.trim() || "Guest" };
      const next = { ...current, ...patch, self: true };
      if (selfIndex >= 0) {
        const copy = [...prev];
        copy[selfIndex] = next;
        return copy;
      }
      return [next, ...prev];
    });
  };

  const syncLocalState = (overrides = {}) => {
    const ws = wsRef.current;
    const payload = {
      type: "state",
      name: name.trim(),
      muted,
      video: videoOn,
      speaking: !muted || pushTalk,
      screen: sharing,
      ...overrides,
    };
    updateSelfParticipant({
      name: payload.name || name.trim() || "Guest",
      muted: payload.muted,
      video: payload.video,
      speaking: payload.speaking,
      screen: payload.screen,
    });
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
  };

  useEffect(() => {
    if (!roomId || !token || !name.trim() || !mediaReady) return;

    const ws = new WebSocket(buildWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("joining");
      ws.send(
        JSON.stringify({ type: "join", roomId, token, name: name.trim() }),
      );
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "joined") {
        setConnected(true);
        setRoom(msg.room);
        setSelfId(msg.self.id);
        const list = [
          {
            id: msg.self.id,
            name: msg.self.name,
            muted: true,
            video: true,
            speaking: false,
            screen: false,
            self: true,
          },
          ...msg.peers.map((p) => ({ ...p, self: false })),
        ];
        setParticipants(list);
        setStatus("connected");
        for (const peer of msg.peers) {
          await ensurePeer(peer.id, true);
        }
        syncLocalState({ name: name.trim() });
        return;
      }

      if (msg.type === "peer-joined") {
        setParticipants((prev) => {
          const exists = prev.some((p) => p.id === msg.peer.id);
          return exists ? prev : [...prev, { ...msg.peer, self: false }];
        });
        return;
      }

      if (msg.type === "peer-left") {
        setParticipants((prev) => prev.filter((p) => p.id !== msg.peerId));
        const pc = pcMap.current.get(msg.peerId);
        if (pc) {
          try {
            pc.close();
          } catch {}
          pcMap.current.delete(msg.peerId);
        }
        remoteStreams.current.delete(msg.peerId);
        return;
      }

      if (msg.type === "state") {
        setParticipants((prev) =>
          prev.map((p) =>
            p.id === msg.peerId
              ? {
                  ...p,
                  muted: msg.muted,
                  video: msg.video,
                  speaking: msg.speaking,
                  screen: msg.screen,
                  name: msg.name,
                }
              : p,
          ),
        );
        return;
      }

      if (msg.type === "chat") {
        setMessages((prev) => [...prev, msg].slice(-100));
        return;
      }

      if (msg.type === "signal") {
        await handleSignal(msg.from, msg.data);
        return;
      }

      if (msg.type === "error") {
        setError(msg.message || "Something went wrong");
      }
    };

    ws.onerror = () => setStatus("error");
    ws.onclose = () => setConnected(false);

    const tick = setInterval(async () => {
      try {
        const s = await collectStats();
        if (s) setStats(s);
      } catch {}
    }, 5000);

    return () => {
      clearInterval(tick);
      try {
        ws.close();
      } catch {}
    };
  }, [roomId, token, name, mediaReady]);

  useEffect(() => {
    if (!cameraStream) return;
    for (const track of cameraStream.getAudioTracks()) {
      track.enabled = !muted || pushTalk;
    }
  }, [muted, pushTalk, cameraStream]);

  useEffect(() => {
    if (!cameraStream) return;
    for (const track of cameraStream.getVideoTracks()) {
      track.enabled = videoOn;
    }
  }, [videoOn, cameraStream]);

  useEffect(() => {
    if (!cameraStream) return;
    syncLocalState({ speaking: pushTalk });
  }, [pushTalk]);

  function currentLocalAudioTrack() {
    const stream = processedStream || cameraStream;
    return stream?.getAudioTracks?.()[0] || null;
  }

  function currentLocalVideoTrack() {
    if (sharing && activeShareRef.current)
      return activeShareRef.current.getVideoTracks()[0] || null;
    const stream = processedStream || cameraStream;
    return stream?.getVideoTracks?.()[0] || null;
  }

  function buildLocalSendStream() {
    const audio = currentLocalAudioTrack();
    const video = currentLocalVideoTrack();
    const tracks = [];
    if (audio) tracks.push(audio);
    if (video) tracks.push(video);
    return new MediaStream(tracks);
  }

  function sendSignal(to, data) {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1)
      ws.send(JSON.stringify({ type: "signal", to, data }));
  }

  function replaceOutgoingTrack(kind, track) {
    for (const pc of pcMap.current.values()) {
      const sender = pc
        .getSenders()
        .find((s) => s.track && s.track.kind === kind);
      if (sender) sender.replaceTrack(track).catch(() => {});
    }
  }

  function createPeerConnection(peerId) {
    if (pcMap.current.has(peerId)) return pcMap.current.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcMap.current.set(peerId, pc);

    const local = buildLocalSendStream();
    for (const track of local.getTracks()) {
      pc.addTrack(track, local);
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendSignal(peerId, { candidate: ev.candidate });
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      remoteStreams.current.set(peerId, stream);
      setParticipants((prev) =>
        prev.map((p) => (p.id === peerId ? { ...p, connected: true } : p)),
      );
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "closed" ||
        pc.connectionState === "disconnected"
      ) {
        setParticipants((prev) =>
          prev.map((p) => (p.id === peerId ? { ...p, disconnected: true } : p)),
        );
      }
    };

    return pc;
  }

  async function ensurePeer(peerId, createOffer = false) {
    const pc = createPeerConnection(peerId);
    if (createOffer) {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(offer);
      sendSignal(peerId, { description: pc.localDescription });
    }
    return pc;
  }

  async function handleSignal(from, data) {
    const pc = createPeerConnection(from);
    if (data.description) {
      const desc = data.description;
      const collision = desc.type === "offer" && pc.signalingState !== "stable";
      if (collision) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(from, { description: pc.localDescription });
      }
      return;
    }

    if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch {}
    }
  }

  async function collectStats() {
    let selectedPc = null;
    for (const pc of pcMap.current.values()) {
      if (pc.connectionState === "connected") {
        selectedPc = pc;
        break;
      }
    }
    if (!selectedPc) return null;
    const stats = await selectedPc.getStats();
    let outbound = null;
    let candidate = null;
    stats.forEach((report) => {
      if (report.type === "outbound-rtp" && report.kind === "video")
        outbound = report;
      if (
        report.type === "candidate-pair" &&
        report.state === "succeeded" &&
        report.currentRoundTripTime != null
      )
        candidate = report;
    });
    return {
      bitrate: outbound?.bytesSent ? Math.round(outbound.bytesSent / 1024) : 0,
      rtt: candidate?.currentRoundTripTime
        ? Math.round(candidate.currentRoundTripTime * 1000)
        : 0,
      packetLoss: outbound?.packetsLost || 0,
    };
  }

  async function toggleMute() {
    if (!cameraStream) return;
    const next = !muted;
    setMuted(next);
    for (const track of cameraStream.getAudioTracks())
      track.enabled = !next || pushTalk;
    syncLocalState({ muted: next });
  }

  async function toggleVideo() {
    if (!cameraStream) return;
    const next = !videoOn;
    setVideoOn(next);
    for (const track of cameraStream.getVideoTracks()) track.enabled = next;
    const track = next ? currentLocalVideoTrack() : null;
    replaceOutgoingTrack("video", track);
    syncLocalState({ video: next });
  }

  async function startScreenShare() {
    try {
      const share = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      activeShareRef.current = share;
      const shareTrack = share.getVideoTracks()[0];
      if (shareTrack) {
        setSharing(true);
        replaceOutgoingTrack("video", shareTrack);
        shareTrack.onended = () => stopScreenShare();
        const video = shareVideoRef.current;
        if (video) {
          video.srcObject = share;
          video.play().catch(() => {});
        }
        syncLocalState({ screen: true });
      }
    } catch {
      setSharing(false);
    }
  }

  function stopScreenShare() {
    const share = activeShareRef.current;
    activeShareRef.current = null;
    if (share) stopStream(share);
    setSharing(false);
    const track = currentLocalVideoTrack();
    replaceOutgoingTrack("video", track);
    syncLocalState({ screen: false });
  }

  function sendChat() {
    const text = chatText.trim();
    if (!text) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === 1)
      ws.send(JSON.stringify({ type: "chat", text }));
    setChatText("");
  }

  const remoteList = useMemo(
    () => participants.filter((p) => !p.self),
    [participants],
  );

  useEffect(() => {
    syncLocalState();
  }, [name, muted, videoOn, sharing, pushTalk]);

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <div className="logo" />
          <div>
            <h1>Open Meet</h1>
            <p>
              {room?.title || `Room ${roomId}`} · {connected ? "Live" : status}
            </p>
          </div>
        </div>
        <div className="row top-actions">
          <div className="badge">
            <span className={`dot ${connected ? "on" : "warn"}`} /> {roomId}
          </div>
          <button
            className="btn secondary"
            onClick={async () => {
              const link = `${window.location.origin}/room/${roomId}?t=${encodeURIComponent(token)}`;
              await navigator.clipboard.writeText(link);
            }}
          >
            Copy invite link
          </button>
          <button
            className="btn danger"
            onClick={() => {
              wsRef.current?.send(JSON.stringify({ type: "leave" }));
              onLeave?.();
              window.location.href = "/";
            }}
          >
            Leave
          </button>
        </div>
      </div>

      <div className="layout">
        <div className="main-panel">
          <div className="hero">
            <div className="stack">
              <div className="preview">
                <video ref={localVideoRef} autoPlay playsInline muted />
                <div className="label">You · {name || "Guest"}</div>
              </div>

              <div className="card">
                <div className="row title-row">
                  <div>
                    <h3>Video area</h3>
                    <div className="mini">
                      Grid auto-adapts to participant count.
                    </div>
                  </div>
                  <div className="badge">Layout: {layout}</div>
                </div>
              </div>

              <div className="grid">
                {remoteList.length === 0 ? (
                  <div className="card empty-state">
                    <h3>No one else is here yet</h3>
                    <p>
                      Send the invite link and the room will fill automatically.
                    </p>
                  </div>
                ) : (
                  remoteList.map((peer) => (
                    <RemoteTile
                      key={peer.id}
                      peer={peer}
                      stream={remoteStreams.current.get(peer.id)}
                    />
                  ))
                )}
              </div>
            </div>

            <div className="stack side-stack">
              <div className="card">
                <h3>Background presets</h3>
                <p>Replace your background with one of the prepared scenes.</p>
                <div className="preset-grid">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className={`preset ${bgPreset?.name === p.name ? "active" : ""}`}
                      onClick={() => setBgPreset(p)}
                    >
                      <img className="thumb" src={p.src} alt={p.name} />
                      <div className="name">{p.name}</div>
                    </button>
                  ))}
                </div>
                <div className="row control-row">
                  <button
                    className={`btn ${bgEnabled ? "" : "secondary"}`}
                    onClick={() => setBgEnabled((v) => !v)}
                  >
                    {bgEnabled ? "Background on" : "Background off"}
                  </button>
                  <button
                    className="btn secondary"
                    onClick={() =>
                      setLayout((prev) =>
                        prev === "auto" ? "speaker" : "auto",
                      )
                    }
                  >
                    Toggle layout
                  </button>
                </div>
              </div>

              <div className="card">
                <h3>Quality</h3>
                <div className="list">
                  <div className="person">
                    <div className="meta">
                      <strong>Bitrate</strong>
                      <span>{stats.bitrate} KB sent</span>
                    </div>
                    <span className="badge">
                      <span className="dot on" /> live
                    </span>
                  </div>
                  <div className="person">
                    <div className="meta">
                      <strong>RTT</strong>
                      <span>{stats.rtt} ms</span>
                    </div>
                  </div>
                  <div className="person">
                    <div className="meta">
                      <strong>Packet loss</strong>
                      <span>{stats.packetLoss}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card">
                <h3>Participants</h3>
                <div className="list participants-list">
                  {participants.map((p) => (
                    <div className="person" key={p.id}>
                      <div className="meta">
                        <strong>
                          {p.name}
                          {p.self ? " (you)" : ""}
                        </strong>
                        <span>
                          {p.muted ? "Muted" : "Speaking"} ·{" "}
                          {p.video ? "Camera on" : "Camera off"}
                        </span>
                      </div>
                      <div className="row participant-tags">
                        {p.screen ? (
                          <span className="badge">Sharing</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="side-panel">
          <div className="sidebar-head">
            <div>
              <strong>Room tools</strong>
              <div className="mini">
                Chat, mic controls, and secure invite flow
              </div>
            </div>
            <div className="badge">
              <span className={`dot ${connected ? "on" : ""}`} /> {status}
            </div>
          </div>

          <div className="sidebar-body">
            <div className="chat">
              <div className="chat-log">
                {messages.length === 0 ? (
                  <div className="mini">No chat yet.</div>
                ) : (
                  messages.map((m) => (
                    <div className="msg" key={m.id}>
                      <div className="who">{m.name}</div>
                      <div className="txt">{m.text}</div>
                    </div>
                  ))
                )}
              </div>
              <div className="row chat-input-row">
                <input
                  className="input"
                  placeholder="Type a message"
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendChat()}
                />
                <button className="btn secondary" onClick={sendChat}>
                  Send
                </button>
              </div>
            </div>

            <div className="card audio-card">
              <h4>Audio processing</h4>
              <p>
                Noise suppression, echo cancellation, and auto gain are enabled
                on the input stream.
              </p>
            </div>

            <div className="gallery">
              <video
                ref={bgVideoRef}
                muted
                playsInline
                autoPlay
                style={{ display: "none" }}
              />
              <canvas ref={canvasRef} style={{ display: "none" }} />
              <video
                ref={shareVideoRef}
                muted
                playsInline
                autoPlay
                style={{ display: "none" }}
              />
            </div>
          </div>
        </aside>
      </div>

      <div className="bottom-bar">
        <button
          className={`icon-btn ${muted ? "off" : "active"}`}
          onClick={toggleMute}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        <button
          className={`icon-btn ${videoOn ? "active" : "off"}`}
          onClick={toggleVideo}
        >
          {videoOn ? "Camera on" : "Camera off"}
        </button>
        <button
          className={`icon-btn ${sharing ? "active" : ""}`}
          onClick={sharing ? stopScreenShare : startScreenShare}
        >
          {sharing ? "Stop share" : "Share screen"}
        </button>
        <button
          className={`icon-btn ${pushTalk ? "active" : ""}`}
          onPointerDown={() => setPushTalk(true)}
          onPointerUp={() => setPushTalk(false)}
          onPointerLeave={() => setPushTalk(false)}
          onPointerCancel={() => setPushTalk(false)}
        >
          Push to talk
        </button>
        <button
          className="icon-btn secondary"
          onClick={() =>
            navigator.clipboard.writeText(
              `${window.location.origin}/room/${roomId}?t=${encodeURIComponent(token)}`,
            )
          }
        >
          Copy invite
        </button>
      </div>
    </div>
  );
}

function RemoteTile({ peer, stream }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream || null;
      videoRef.current.play().catch(() => {});
    }
    if (audioRef.current) {
      audioRef.current.srcObject = stream || null;
      audioRef.current.play().catch(() => {});
    }
  }, [stream]);

  return (
    <div className={`tile ${peer.self ? "me" : ""}`}>
      <video ref={videoRef} autoPlay playsInline muted />
      <audio ref={audioRef} autoPlay />
      <div className="name">{peer.name}</div>
      <div className="state">
        <span
          className={`dot ${peer.disconnected ? "" : peer.muted ? "warn" : "on"}`}
        />
        <span>
          {peer.disconnected
            ? "reconnecting"
            : peer.muted
              ? "mic off"
              : "mic on"}
        </span>
      </div>
    </div>
  );
}

export default App;
