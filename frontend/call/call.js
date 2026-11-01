/* TalkBridge Call — group voice call with live translation.
 *
 * Every participant picks ONE language. When someone speaks, their device
 * recognizes the speech and broadcasts the text (with its language) to the
 * room. Each listener's device translates it into the listener's own language
 * and speaks it aloud. The speaker never hears their own translation.
 *
 * Signaling messages (relayed by /ws/signaling/{room}/{id}):
 *   hello          {name, lang, muted}    announce / update myself
 *   speech-interim {text, lang}           words so far (live captions)
 *   speech-final   {uid, text, lang}      finished utterance (translate + speak)
 */

const LANGS = {
  en: { name: "English", native: "English", flag: "🇬🇧", speech: "en-IN" },
  hi: { name: "Hindi", native: "हिंदी", flag: "🇮🇳", speech: "hi-IN" },
  kn: { name: "Kannada", native: "ಕನ್ನಡ", flag: "🇮🇳", speech: "kn-IN" },
};

const $ = (id) => document.getElementById(id);
const els = {
  joinScreen: $("joinScreen"), callScreen: $("callScreen"),
  nameInput: $("nameInput"), langPicker: $("langPicker"), roomInput: $("roomInput"),
  newRoomBtn: $("newRoomBtn"), joinBtn: $("joinBtn"), joinError: $("joinError"),
  roomLabel: $("roomLabel"), callTimer: $("callTimer"), peopleCount: $("peopleCount"), connState: $("connState"),
  shareBtn: $("shareBtn"), tiles: $("tiles"),
  caption: $("caption"), captionWho: $("captionWho"), captionMain: $("captionMain"), captionSub: $("captionSub"),
  history: $("history"), statusLine: $("statusLine"),
  muteBtn: $("muteBtn"), speakerBtn: $("speakerBtn"), callLangSelect: $("callLangSelect"), leaveBtn: $("leaveBtn"),
  voice: $("voice"),
};

const state = {
  id: Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4),
  name: "",
  lang: "en",
  room: "",
  joined: false,
  ws: null,
  peers: new Map(), // id -> {name, lang, muted, speakingUntil}
  muted: false,
  speakerOn: true,
  startedAt: 0,
  timer: null,
  wakeLock: null,
  // Translated-voice playback (one at a time, in arrival order).
  playQueue: [],
  playing: false,
  cooldownUntil: 0,
  audioCtx: null,
};

/* ───── Diagnostics (phones have no visible console) ───── */
function clientLog(line, obj) {
  const text = obj ? `${line} ${JSON.stringify(obj)}` : line;
  try {
    fetch("/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: `call:${state.id}`, line: text.slice(0, 2000) }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

function setStatus(text, warn = false) {
  els.statusLine.textContent = text;
  els.statusLine.classList.toggle("warn", warn);
}

/* ───── Join screen ───── */
function randomRoom() {
  const words = ["sun", "river", "mango", "tiger", "lotus", "cloud", "star", "peacock"];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function renderLangPicker() {
  els.langPicker.innerHTML = "";
  for (const [code, l] of Object.entries(LANGS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lang-option";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(code === state.lang));
    b.innerHTML = `<span class="flag">${l.flag}</span><span class="native"></span><span class="english"></span>`;
    b.querySelector(".native").textContent = l.native;
    b.querySelector(".english").textContent = l.name;
    b.addEventListener("click", () => {
      state.lang = code;
      renderLangPicker();
    });
    els.langPicker.appendChild(b);
  }
  els.callLangSelect.innerHTML = "";
  for (const [code, l] of Object.entries(LANGS)) {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = l.native;
    els.callLangSelect.appendChild(o);
  }
  els.callLangSelect.value = state.lang;
}

function loadPrefs() {
  state.name = localStorage.getItem("tbcall_name") || "";
  const lang = localStorage.getItem("tbcall_lang");
  if (lang && LANGS[lang]) state.lang = lang;
  els.nameInput.value = state.name;
  const hashRoom = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
  els.roomInput.value = hashRoom || localStorage.getItem("tbcall_room") || randomRoom();
  renderLangPicker();
}

els.newRoomBtn.addEventListener("click", () => { els.roomInput.value = randomRoom(); });

/* ───── Mobile audio unlock / screen wake ─────
 * Phones only allow audio that starts from a tap. Translated voice arrives
 * later (not from a tap), so the Join tap "unlocks" the shared <audio>.
 */
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

function getAudioCtx() {
  if (!state.audioCtx || state.audioCtx.state === "closed") {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new Ctx();
  }
  return state.audioCtx;
}

function unlockAudio() {
  try { getAudioCtx().resume(); } catch {}
  els.voice.src = SILENT_WAV;
  els.voice.play().catch(() => {});
}

async function keepScreenAwake() {
  if (!("wakeLock" in navigator) || !state.joined) return;
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.joined) keepScreenAwake();
});

/* ───── Join / leave ───── */
els.joinBtn.addEventListener("click", () => {
  const name = els.nameInput.value.trim();
  const room = els.roomInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) { showJoinError("Please enter your name."); return; }
  if (!room) { showJoinError("Please enter a room code."); return; }
  els.joinError.hidden = true;

  unlockAudio(); // must run synchronously inside the tap

  state.name = name;
  state.room = room;
  localStorage.setItem("tbcall_name", name);
  localStorage.setItem("tbcall_lang", state.lang);
  localStorage.setItem("tbcall_room", room);
  history.replaceState(null, "", `#${encodeURIComponent(room)}`);

  state.joined = true;
  state.muted = false;
  state.peers.clear();
  els.history.innerHTML = "";
  els.roomLabel.textContent = room;
  els.callLangSelect.value = state.lang;
  els.joinScreen.hidden = true;
  els.callScreen.hidden = false;
  resetCaption();
  renderControls();
  renderTiles();

  state.startedAt = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(updateTimer, 1000);
  updateTimer();
  keepScreenAwake();

  clientLog("call_join", {
    room, lang: state.lang, ua: navigator.userAgent, secure: window.isSecureContext,
    speech: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  });
  connect();
  mic.start();
});

function showJoinError(text) {
  els.joinError.textContent = text;
  els.joinError.hidden = false;
}

els.leaveBtn.addEventListener("click", leave);

function leave() {
  state.joined = false;
  mic.stop();
  stopPlayback();
  clearInterval(state.timer);
  try { state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
  const ws = state.ws;
  state.ws = null;
  try { ws?.close(); } catch {}
  els.callScreen.hidden = true;
  els.joinScreen.hidden = false;
  renderLangPicker();
}

function updateTimer() {
  const s = Math.floor((Date.now() - state.startedAt) / 1000);
  els.callTimer.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/* ───── Room signaling ───── */
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/signaling/${encodeURIComponent(state.room)}/${encodeURIComponent(state.id)}`);
  state.ws = ws;
  setConn("connecting…");

  ws.onopen = () => {
    setConn("connected", "ok");
    sendHello();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleSignal(msg);
  };
  ws.onclose = () => {
    if (state.ws !== ws || !state.joined) return;
    setConn("reconnecting…", "bad");
    setTimeout(() => { if (state.joined && state.ws === ws) connect(); }, 1500);
  };
}

function setConn(text, cls = "") {
  els.connState.textContent = text;
  els.connState.className = `conn ${cls}`;
}

function send(type, data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type, sender: state.id, data }));
  }
}

function sendHello() {
  send("hello", { name: state.name, lang: state.lang, muted: state.muted });
}

function handleSignal(msg) {
  const from = msg.sender || msg.from;
  if (from === state.id) return;
  switch (msg.type) {
    case "peer-joined":
      // Someone (re)joined: introduce myself to them.
      sendHello();
      break;
    case "peer-left":
      state.peers.delete(msg.data?.peer_id || from);
      renderTiles();
      break;
    case "hello":
      if (msg.data && LANGS[msg.data.lang]) {
        const prev = state.peers.get(from) || {};
        state.peers.set(from, { ...prev, name: String(msg.data.name || "Guest").slice(0, 24), lang: msg.data.lang, muted: !!msg.data.muted });
        renderTiles();
      }
      break;
    case "speech-interim":
      onRemoteInterim(from, msg.data);
      break;
    case "speech-final":
      onRemoteFinal(from, msg.data);
      break;
  }
}

/* ───── People tiles ───── */
function renderTiles() {
  els.tiles.innerHTML = "";
  const me = { name: `${state.name} (you)`, lang: state.lang, muted: state.muted };
  const all = [[state.id, me], ...state.peers];
  for (const [id, p] of all) {
    const t = document.createElement("div");
    t.className = "tile";
    t.dataset.id = id;
    if (p.muted) t.classList.add("muted");
    if (p.speakingUntil && p.speakingUntil > Date.now()) t.classList.add("speaking");
    const initials = (p.name || "?").replace(/\(you\)/, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    t.innerHTML = `<div class="avatar"></div><div class="tile-name"></div><div class="tile-lang"></div>`;
    t.querySelector(".avatar").textContent = initials || "?";
    t.querySelector(".tile-name").textContent = p.name;
    const l = LANGS[p.lang];
    t.querySelector(".tile-lang").textContent = l ? `${l.flag} ${l.native}` : "";
    els.tiles.appendChild(t);
  }
  const n = state.peers.size + 1;
  els.peopleCount.textContent = `${n} ${n === 1 ? "person" : "people"}`;
  if (state.peers.size === 0) {
    setStatus("Waiting for others to join… tap 🔗 Invite to share the link.");
  } else if (els.statusLine.textContent.startsWith("Waiting")) {
    mic.showListening();
  }
}

function markSpeaking(id) {
  const p = state.peers.get(id);
  if (!p) return;
  p.speakingUntil = Date.now() + 1500;
  const tile = els.tiles.querySelector(`[data-id="${CSS.escape(id)}"]`);
  tile?.classList.add("speaking");
  clearTimeout(p._speakTimer);
  p._speakTimer = setTimeout(() => tile?.classList.remove("speaking"), 1600);
}

/* ───── Captions & history ───── */
function resetCaption() {
  els.caption.classList.remove("live");
  els.captionWho.textContent = "Waiting for someone to speak…";
  els.captionMain.textContent = "";
  els.captionSub.textContent = "";
}

function showCaption(who, main, sub, live) {
  els.caption.classList.toggle("live", !!live);
  els.captionWho.textContent = who;
  els.captionMain.textContent = main;
  els.captionSub.textContent = sub || "";
}

function addHistory({ who, text, orig, mine, audio }) {
  const m = document.createElement("div");
  m.className = `msg${mine ? " mine" : ""}`;
  const w = document.createElement("div");
  w.className = "msg-who";
  w.textContent = who;
  const t = document.createElement("div");
  t.className = "msg-text";
  t.textContent = text;
  m.append(w, t);
  if (orig && orig !== text) {
    const o = document.createElement("div");
    o.className = "msg-orig";
    o.textContent = orig;
    m.appendChild(o);
  }
  if (audio) {
    const b = document.createElement("button");
    b.className = "msg-replay";
    b.type = "button";
    b.textContent = "▶ Play again";
    b.addEventListener("click", () => { audio.then((a) => a && new Audio(a.url).play().catch(() => {})); });
    m.appendChild(b);
  }
  els.history.appendChild(m);
  els.history.scrollTop = els.history.scrollHeight;
}

/* ───── Translation & voice requests ───── */
async function translate(text, src, tgt) {
  if (!text || src === tgt) return text;
  try {
    const res = await fetch("/translate-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, src_lang: src, tgt_lang: tgt, tts: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).translated || text;
  } catch (e) {
    clientLog("translate_failed", { error: String(e) });
    return null;
  }
}

async function synthesize(text, lang) {
  try {
    const res = await fetch("/tts-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return blob.size ? { url: URL.createObjectURL(blob) } : null;
  } catch (e) {
    clientLog("tts_failed", { error: String(e) });
    return null;
  }
}

/* ───── Hearing others ───── */
const interimTranslate = new Map(); // speaker id -> {timer, seq, text, lang, finalSeq}

function onRemoteInterim(from, data) {
  if (!data || !data.text || !LANGS[data.lang]) return;
  const p = state.peers.get(from);
  const who = p ? p.name : "Someone";
  markSpeaking(from);

  if (data.lang === state.lang) {
    showCaption(`${who} is speaking…`, data.text, "", true);
    return;
  }
  // Show the original right away; replace with my language as it arrives.
  const t = interimTranslate.get(from) || { seq: 0, finalSeq: 0 };
  interimTranslate.set(from, t);
  t.text = data.text;
  t.lang = data.lang;
  if (!els.caption.classList.contains("live") || els.captionWho.dataset.from !== from) {
    showCaption(`${who} is speaking…`, "…", data.text, true);
    els.captionWho.dataset.from = from;
  } else {
    els.captionSub.textContent = data.text;
  }
  if (t.timer) return;
  t.timer = setTimeout(async () => {
    t.timer = null;
    const seq = ++t.seq;
    const translated = await translate(t.text, t.lang, state.lang);
    // Ignore if a newer interim was translated or the sentence already finished.
    if (!translated || seq !== t.seq || seq <= t.finalSeq) return;
    showCaption(`${who} is speaking…`, translated, t.text, true);
    els.captionWho.dataset.from = from;
  }, 350);
}

async function onRemoteFinal(from, data) {
  if (!data || !data.text || !LANGS[data.lang]) return;
  const p = state.peers.get(from);
  const who = p ? p.name : "Someone";
  const t = interimTranslate.get(from);
  if (t) {
    t.finalSeq = t.seq + 1;
    clearTimeout(t.timer);
    t.timer = null;
  }
  markSpeaking(from);

  const myLang = state.lang;
  // Queue the voice slot now so voices play in the order people spoke,
  // even if a later sentence translates faster.
  let resolveText;
  const textReady = new Promise((r) => (resolveText = r));
  const audio = state.speakerOn
    ? textReady.then((txt) => (txt ? synthesize(txt, myLang) : null))
    : null;
  if (audio) enqueueVoice(audio);

  const translated = data.lang === myLang ? data.text : await translate(data.text, data.lang, myLang);
  const shown = translated || data.text;
  resolveText(translated ? shown : null);

  const langLabel = data.lang === myLang ? LANGS[myLang].native : `${LANGS[data.lang].native} → ${LANGS[myLang].native}`;
  showCaption(`${who} · ${langLabel}`, shown, data.lang === myLang ? "" : data.text, false);
  els.captionWho.dataset.from = "";
  addHistory({ who, text: shown, orig: data.lang === myLang ? "" : data.text, audio });
  if (!translated) setStatus("⚠️ Translation failed — showing the original. Check the computer's internet.", true);
}

/* ───── Voice playback (with mic paused, so the phone doesn't hear itself) ───── */
function enqueueVoice(promise) {
  state.playQueue.push(promise);
  playNext();
}

async function playNext() {
  if (state.playing || !state.playQueue.length) return;
  state.playing = true;
  const next = state.playQueue.shift();
  const audio = await next;
  if (!audio || !state.speakerOn || !state.joined) {
    state.playing = false;
    playNext();
    return;
  }
  mic.pauseForPlayback();
  const el = els.voice;
  const done = () => {
    el.onended = el.onerror = null;
    state.playing = false;
    state.cooldownUntil = Date.now() + 600; // let the speaker's echo die away
    if (state.playQueue.length) playNext();
    else setTimeout(() => mic.resumeAfterPlayback(), 600);
  };
  el.onended = done;
  el.onerror = done;
  el.src = audio.url;
  setStatus("🔊 Playing translation… (your mic is paused)");
  el.play().catch((e) => {
    clientLog("voice_play_blocked", { error: String(e) });
    setStatus("🔇 Tap anywhere to allow sound, then the next translation will play.", true);
    done();
  });
}

function stopPlayback() {
  state.playQueue = [];
  try { els.voice.pause(); } catch {}
  if (state.playing) {
    state.playing = false;
    mic.resumeAfterPlayback();
  }
}

// If the browser blocked audio, any tap unlocks it again.
document.addEventListener("click", () => {
  if (state.joined && els.voice.paused && !state.playing) {
    els.voice.src = SILENT_WAV;
    els.voice.play().catch(() => {});
  }
}, true);

/* ───── My speech ───── */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
// Android Chrome repeats results in continuous mode; one utterance per session is reliable.
const IS_ANDROID = /Android/i.test(navigator.userAgent);

const mic = {
  rec: null,
  useServer: !SpeechRec,
  paused: false,     // during translated-voice playback
  resultIndex: 0,
  dropSession: false,
  buffer: "",
  commitTimer: null,
  interimTimer: null,
  lastInterimSent: 0,

  wanted() {
    return state.joined && !state.muted && !this.paused;
  },

  start() {
    if (!this.wanted()) return;
    if (this.useServer) { serverAsr.start(); this.showListening(); return; }
    if (this.rec) return;
    let rec;
    try {
      rec = new SpeechRec();
    } catch (e) {
      clientLog("speech_rec_create_failed", { error: String(e) });
      this.switchToServer("create_failed");
      return;
    }
    rec.lang = LANGS[state.lang].speech;
    rec.continuous = !IS_ANDROID;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;
    this.resultIndex = 0;
    this.dropSession = false;

    rec.onresult = (e) => this.onResult(e);
    rec.onerror = (e) => this.onError(e);
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      // Keep listening: restart a fresh session (picks up any language change).
      if (this.wanted() && !this.useServer) setTimeout(() => this.start(), 150);
    };
    try {
      rec.start();
      this.showListening();
    } catch (e) {
      clientLog("speech_rec_start_failed", { error: String(e) });
      this.rec = null;
    }
  },

  stop() {
    clearTimeout(this.commitTimer);
    this.buffer = "";
    const rec = this.rec;
    this.rec = null;
    try { rec?.abort(); } catch {}
    serverAsr.stop();
  },

  restart() {
    // Used after a language change: drop the current session and start a new
    // one once the browser has released the old one.
    this.stop();
    setTimeout(() => this.start(), 300);
  },

  pauseForPlayback() {
    this.paused = true;
    clearTimeout(this.commitTimer);
    this.buffer = "";
    const rec = this.rec;
    this.rec = null;
    try { rec?.abort(); } catch {}
    serverAsr.setGated(true);
  },

  resumeAfterPlayback() {
    if (state.playing) return;
    this.paused = false;
    serverAsr.setGated(false);
    if (state.muted) { setStatus("🔇 You're muted"); return; }
    this.start();
    this.showListening();
  },

  showListening() {
    if (!state.joined) return;
    if (state.muted) setStatus("🔇 You're muted");
    else if (state.peers.size === 0) setStatus("Waiting for others to join… tap 🔗 Invite to share the link.");
    else setStatus(`🎙️ Listening in ${LANGS[state.lang].native}… speak naturally`);
  },

  onResult(e) {
    if (this.dropSession || this.paused) return;
    let finalText = "";
    let interimText = "";
    for (let i = this.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript + " ";
      else interimText += e.results[i][0].transcript + " ";
    }
    const text = (finalText + interimText).trim();
    if (!text) return;
    this.buffer = text;
    showCaption("You", text, "", true);
    els.captionWho.dataset.from = "";

    // Live words to everyone (throttled).
    const now = performance.now();
    if (now - this.lastInterimSent > 250) {
      this.lastInterimSent = now;
      send("speech-interim", { text, lang: state.lang });
    } else {
      clearTimeout(this.interimTimer);
      this.interimTimer = setTimeout(() => {
        if (this.buffer) send("speech-interim", { text: this.buffer, lang: state.lang });
      }, 250);
    }

    clearTimeout(this.commitTimer);
    if (finalText.trim() && !interimText.trim()) {
      // The browser says the sentence is finished: send it now.
      this.resultIndex = e.results.length;
      this.commit();
    } else {
      // Fallback if the browser never finalizes (noise, some phones).
      this.commitTimer = setTimeout(() => this.commit(true), 1000);
    }
  },

  commit(cut = false) {
    clearTimeout(this.commitTimer);
    clearTimeout(this.interimTimer);
    const text = this.buffer.trim();
    this.buffer = "";
    if (text.length < 2) return;
    if (cut && this.rec) {
      // These results were never finalized; restart so they aren't sent twice.
      this.dropSession = true;
      const rec = this.rec;
      this.rec = null;
      try { rec.abort(); } catch {}
    }
    sendFinal(text);
  },

  onError(e) {
    if (e.error === "no-speech" || e.error === "aborted") return;
    clientLog("speech_rec_error", { error: e.error });
    if (e.error === "not-allowed" || e.error === "audio-capture") {
      setStatus(e.error === "not-allowed"
        ? "🎤 Microphone blocked. Allow the microphone for this site in your browser settings, then rejoin."
        : "🎤 No microphone available (is another app using it?).", true);
      return;
    }
    if (["network", "service-not-allowed", "language-not-supported"].includes(e.error)) {
      this.switchToServer(e.error);
    }
  },

  switchToServer(reason) {
    if (this.useServer) return;
    clientLog("switching_to_server_asr", { reason });
    this.useServer = true;
    const rec = this.rec;
    this.rec = null;
    try { rec?.abort(); } catch {}
    if (this.wanted()) serverAsr.start();
  },
};

function sendFinal(text) {
  const uid = `${state.id}-${Date.now()}`;
  send("speech-final", { uid, text, lang: state.lang });
  showCaption("You said", text, state.peers.size ? "Sent to everyone in their language" : "No one else is here yet", false);
  addHistory({ who: `You · ${LANGS[state.lang].native}`, text, mine: true });
  clientLog("speech_final_sent", { chars: text.length, lang: state.lang, peers: state.peers.size });
}

/* ───── Server speech recognition (when the browser has none, or it fails) ───── */
const serverAsr = {
  active: false,
  gated: false,
  ws: null,
  stream: null,
  source: null,
  node: null,

  async start() {
    if (this.active) return;
    this.active = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      clientLog("server_asr_mic_error", { error: String(e) });
      setStatus("🎤 Microphone blocked. Allow the microphone for this site in your browser settings, then rejoin.", true);
      this.active = false;
      return;
    }
    if (!this.active) { this.stream.getTracks().forEach((t) => t.stop()); return; }
    this.open();
    const ctx = getAudioCtx();
    ctx.resume().catch(() => {});
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (ev) => this.onAudio(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
    this.source.connect(this.node);
    this.node.connect(ctx.destination);
    clientLog("server_asr_started");
  },

  open() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/stream-audio/${encodeURIComponent(state.id)}`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.event === "final_transcript" && m.text && !state.muted && !mic.paused) sendFinal(m.text);
    };
    ws.onclose = () => {
      if (this.active && this.ws === ws) setTimeout(() => { if (this.active && this.ws === ws) this.open(); }, 1000);
    };
  },

  stop() {
    if (!this.active) return;
    this.active = false;
    try { this.node?.disconnect(); } catch {}
    try { this.source?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch {}
    this.node = this.source = this.stream = null;
  },

  setGated(on) {
    if (on && !this.gated && this.ws?.readyState === WebSocket.OPEN) {
      // Throw away the half-heard sentence instead of translating a fragment.
      this.ws.send(JSON.stringify({ reset: true }));
    }
    this.gated = on;
  },

  onAudio(input, rate) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (state.muted || this.gated || Date.now() < state.cooldownUntil) return;
    const ratio = rate / 16000;
    const outLen = Math.floor(input.length / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = a; j < b; j++) sum += input[j];
      const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const bytes = new Uint8Array(pcm.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    this.ws.send(JSON.stringify({ pcm16_b64: btoa(bin), sample_rate: 16000, source_lang: state.lang, asr_only: true }));
  },
};

/* ───── Controls ───── */
function renderControls() {
  els.muteBtn.classList.toggle("active", state.muted);
  els.muteBtn.querySelector(".ctrl-icon").textContent = state.muted ? "🔇" : "🎙️";
  els.muteBtn.querySelector(".ctrl-label").textContent = state.muted ? "Unmute" : "Mute";
  els.speakerBtn.classList.toggle("active", !state.speakerOn);
  els.speakerBtn.querySelector(".ctrl-icon").textContent = state.speakerOn ? "🔊" : "🔈";
  els.speakerBtn.querySelector(".ctrl-label").textContent = state.speakerOn ? "Voice on" : "Text only";
}

els.muteBtn.addEventListener("click", () => {
  state.muted = !state.muted;
  if (state.muted) {
    mic.stop();
    setStatus("🔇 You're muted");
  } else {
    mic.paused = false;
    mic.start();
  }
  renderControls();
  renderTiles();
  sendHello();
});

els.speakerBtn.addEventListener("click", () => {
  state.speakerOn = !state.speakerOn;
  if (!state.speakerOn) stopPlayback();
  renderControls();
  mic.showListening();
});

els.callLangSelect.addEventListener("change", () => {
  const lang = els.callLangSelect.value;
  if (!LANGS[lang] || lang === state.lang) return;
  state.lang = lang;
  localStorage.setItem("tbcall_lang", lang);
  sendHello();   // updates my language on everyone's tiles
  renderTiles();
  mic.restart(); // recognize my speech in the new language from now on
  clientLog("language_changed", { lang });
  setStatus(`🌐 Now speaking & hearing ${LANGS[lang].native}`);
});

els.shareBtn.addEventListener("click", async () => {
  const url = `${location.origin}/call/#${encodeURIComponent(state.room)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "Join my TalkBridge call", text: `Join room ${state.room}`, url });
      return;
    }
  } catch { return; }
  try {
    await navigator.clipboard.writeText(url);
    setStatus("🔗 Invite link copied — send it to the people you're calling.");
  } catch {
    setStatus(`🔗 Invite link: ${url}`);
  }
});

loadPrefs();
