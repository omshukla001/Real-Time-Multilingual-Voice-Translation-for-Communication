/* TalkBridge AI — Real-Time Bidirectional Voice Translation
 * Clean, Robust, 100% Reliable Implementation
 */

const $ = (id) => document.getElementById(id);

/* ───── DOM Elements ───── */
const els = {
  roomId: $("roomId"),
  joinBtn: $("joinBtn"),
  startBtn: $("startBtn"),
  hangupBtn: $("hangupBtn"),
  remoteAudio: $("remoteAudio"),
  translatedAudio: $("translatedAudio"),
  log: $("log"),
  clientId: $("clientId"),
  signalingStatus: $("signalingStatus"),
  callStatus: $("callStatus"),
  myLang: $("myLang"),
  theyHearLang: $("theyHearLang"),
  localLangBadge: $("localLangBadge"),
  remoteLangBadge: $("remoteLangBadge"),
  waveformCanvas: $("waveformCanvas"),
  micIndicator: $("micIndicator"),
  callTimer: $("callTimer"),
  transcriptPanel: $("transcriptPanel"),
  transcriptPlaceholder: $("transcriptPlaceholder"),
  transcriptCount: $("transcriptCount"),
  logsToggle: $("logsToggle"),
  logsChevron: $("logsChevron"),
  listenTranslated: $("listenTranslated"),
  listenBoth: $("listenBoth"),
  swapLangBtn: $("swapLangBtn"),
  chipAsr: $("chipAsr"),
  chipMt: $("chipMt"),
  chipTts: $("chipTts"),
  chipLatency: $("chipLatency"),
  copyTranscriptBtn: $("copyTranscriptBtn"),
  clearTranscriptBtn: $("clearTranscriptBtn"),
  installAppBtn: $("installAppBtn"),
  shareRoomBtn: $("shareRoomBtn"),
  localPulseRing: $("localPulseRing"),
  remotePulseRing: $("remotePulseRing"),
  streamingWordTicker: $("streamingWordTicker"),
  streamingWordTranslation: $("streamingWordTranslation"),
  translationModeHint: $("translationModeHint"),
  dockMuteBtn: $("dockMuteBtn"),
  dockMicLabel: $("dockMicLabel"),
  dockSwapLangBtn: $("dockSwapLangBtn"),
  dockListenModeBtn: $("dockListenModeBtn"),
  dockListenModeLabel: $("dockListenModeLabel"),
  dockHangupBtn: $("dockHangupBtn"),
  geminiApiKey: $("geminiApiKey"),
  commitTranslateBtn: $("commitTranslateBtn"),
  listeningStatusTip: $("listeningStatusTip"),
};

/* ───── ID helper ───── */
function randomId() {
  return Math.random().toString(16).slice(2, 10) + "-" + Date.now().toString(16).slice(-6);
}

/* ───── Logging ───── */
function log(line, obj) {
  const ts = new Date().toISOString().slice(11, 19);
  const extra = obj ? ` ${JSON.stringify(obj)}` : "";
  if (els.log) {
    els.log.textContent = `${ts} ${line}${extra}\n` + els.log.textContent;
  }
  // Mirror to the server log: phones have no visible console, so this is how
  // mic/speech problems on a phone can be diagnosed from the computer.
  try {
    fetch("/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: (typeof state !== "undefined" && state.clientId) || "", line: `${line}${extra}`.slice(0, 2000) }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

/* ───── Status pills ───── */
function setPill(el, status) {
  if (!el) return;
  el.setAttribute("data-status", status);
}

/* ───── Pipeline stage chips ───── */
function setChip(chip, on) {
  if (!chip) return;
  chip.setAttribute("data-active", on ? "true" : "false");
}
function pulseChip(chip) {
  if (!chip) return;
  chip.classList.remove("pulse");
  void chip.offsetWidth;
  chip.classList.add("pulse");
}
function setLatency(ms) {
  if (!els.chipLatency) return;
  if (ms == null) {
    els.chipLatency.textContent = "— ms";
    els.chipLatency.removeAttribute("data-grade");
    return;
  }
  els.chipLatency.textContent = `${ms} ms`;
  const grade = ms < 800 ? "good" : ms < 1800 ? "ok" : "slow";
  els.chipLatency.setAttribute("data-grade", grade);
}

/* ───── App state ───── */
const state = {
  clientId: randomId(),
  ws: null,
  isMuted: false,
  callActive: false,
  transcriptEntries: [],
  audioStream: null,
  analyser: null,
  animFrame: null,
  translatedQueue: [],
  translatedPlaying: false,
  peerLang: null,
};

if (els.clientId) els.clientId.textContent = state.clientId;

log("client_info", {
  ua: navigator.userAgent,
  secure: window.isSecureContext,
  speech: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
});

/* ───── Saved Gemini API Key ───── */
if (els.geminiApiKey) {
  const savedKey = localStorage.getItem("talkbridge_gemini_key");
  if (savedKey) els.geminiApiKey.value = savedKey;
  els.geminiApiKey.addEventListener("input", () => {
    localStorage.setItem("talkbridge_gemini_key", els.geminiApiKey.value.trim());
  });
}

/* ───── Language helpers ───── */
const LANG_NAME = {
  en: "English",
  hi: "Hindi",
  kn: "Kannada",
};

// Kannada script transliterator
function transliterateKannada(text) {
  if (!text) return "";
  const kn_vowels = {'ಅ':'a','ಆ':'aa','ಇ':'i','ಈ':'ee','ಉ':'u','ಊ':'oo','ಋ':'ru','ಎ':'e','ಏ':'ee','ಐ':'ai','ಒ':'o','ಓ':'oo','ಔ':'au','ಅಂ':'am','ಅಃ':'aha'};
  const kn_matras = {'ಾ':'aa','ಿ':'i','ೀ':'ee','ು':'u','ೂ':'oo','ೃ':'ru','ೆ':'e','ೇ':'ee','ೈ':'ai','ೊ':'o','ೋ':'oo','ೌ':'au','ಂ':'m','ಃ':'h','್':''};
  const kn_cons = {'ಕ':'k','ಖ':'kh','ಗ':'g','ಘ':'gh','ಙ':'ng','ಚ':'ch','ಛ':'chh','ಜ':'j','ಝ':'jh','ಞ':'ny','ಟ':'t','ಠ':'th','ಡ':'d','ಢ':'dh','ಣ':'n','ತ':'th','ಥ':'thh','ದ':'d','ಧ':'dh','ನ':'n','ಪ':'p','ಫ':'ph','ಬ':'b','ಭ':'bh','ಮ':'m','ಯ':'y','ರ':'r','ಱ':'r','ಲ':'l','ವ':'v','ಶ':'sh','ಷ':'sh','ಸ':'s','ಹ':'h','ಳ':'l'};

  if (!/[\u0C80-\u0CFF]/.test(text)) return text;

  const res = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (kn_vowels[c]) {
      res.push(kn_vowels[c]);
    } else if (kn_cons[c]) {
      const base = kn_cons[c];
      if (i + 1 < text.length && kn_matras[text[i+1]] !== undefined) {
        res.push(base + kn_matras[text[i+1]]);
        i++;
      } else if (i + 1 < text.length && text[i+1] === '್') {
        res.push(base);
        i++;
      } else {
        res.push(base + 'a');
      }
    } else if (kn_matras[c]) {
      res.push(kn_matras[c]);
    } else {
      res.push(c);
    }
    i++;
  }
  return res.join('').trim();
}

function formatReadableText(text, lang) {
  return (text || "").trim();
}

function getLangParams() {
  const my = (els.myLang?.value || "en").trim();
  let target = (els.theyHearLang?.value || (my === "kn" ? "en" : "kn")).trim();
  if (target === my) {
    target = my === "en" ? "kn" : (my === "kn" ? "en" : "en");
    if (els.theyHearLang) els.theyHearLang.value = target;
  }
  return { source_lang: my, target_lang: target, tts_lang: target };
}

function updateLanguageBadges() {
  const params = getLangParams();
  const my = params.source_lang;
  const target = params.target_lang;

  if (els.localLangBadge) {
    els.localLangBadge.textContent = `Speaks ${LANG_NAME[my] || my}`;
  }
  if (els.remoteLangBadge) {
    els.remoteLangBadge.textContent = `Hears ${LANG_NAME[target] || target}`;
  }
  if (els.translationModeHint) {
    els.translationModeHint.textContent = `${LANG_NAME[my] || my} ➔ ${LANG_NAME[target] || target}`;
  }

  if (speechEngine && speechEngine.recognizer) {
    speechEngine.updateLanguage();
  }
}

// Tell the other caller which language I speak, so their "They hear" follows
// it automatically (otherwise an English->Hindi call silently produced Kannada,
// the "They hear" default). Only sent on my own language changes, never in
// response to a peer's announcement, so the two sides can't ping-pong.
function announceMyLang() {
  sendSignal({ type: "peer-lang", sender: state.clientId, data: { lang: getLangParams().source_lang } });
}

// Point "They hear" at the peer's language (unless we speak the same one).
function applyPeerLang() {
  const peerLang = state.peerLang;
  const my = (els.myLang?.value || "en").trim();
  if (peerLang && peerLang !== my && els.theyHearLang && els.theyHearLang.value !== peerLang) {
    els.theyHearLang.value = peerLang;
    log("they_hear_set_from_peer", { lang: peerLang });
  }
}

els.myLang?.addEventListener("change", () => {
  // The peer's announcement may have arrived while we still had the same language.
  applyPeerLang();
  updateLanguageBadges();
  announceMyLang();
});
els.theyHearLang?.addEventListener("change", updateLanguageBadges);

function swapLanguages() {
  const params = getLangParams();
  const oldMy = params.source_lang;
  const oldTarget = params.target_lang;

  if (els.myLang) els.myLang.value = oldTarget;
  if (els.theyHearLang) els.theyHearLang.value = oldMy;

  updateLanguageBadges();
  announceMyLang();
  els.swapLangBtn?.classList.add("spin");
  setTimeout(() => els.swapLangBtn?.classList.remove("spin"), 500);
  log("languages_swapped", { my: oldTarget, target: oldMy });
}

els.swapLangBtn?.addEventListener("click", swapLanguages);
els.dockSwapLangBtn?.addEventListener("click", swapLanguages);

/* ───── Call timer (Stopwatch) ───── */
let callTimerInterval = null;
let callStartTime = null;

function startCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callStartTime = Date.now();
  if (els.callTimer) {
    els.callTimer.classList.add("active");
    els.callTimer.textContent = "00:00";
    callTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const ss = String(elapsed % 60).padStart(2, "0");
      els.callTimer.textContent = `${mm}:${ss}`;
    }, 1000);
  }
}

function stopCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = null;
  callStartTime = null;
  if (els.callTimer) {
    els.callTimer.textContent = "00:00";
    els.callTimer.classList.remove("active");
  }
}

/* ───── Transcript Panel ───── */
function updateTranscriptCount() {
  if (els.transcriptCount) {
    const count = state.transcriptEntries.length;
    els.transcriptCount.textContent = `${count} message${count === 1 ? '' : 's'}`;
  }
}

window.playEntryAudio = function(b64, mime) {
  if (!b64) return;
  try {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime || "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play();
  } catch (e) {
    log("play_entry_audio_err", { error: String(e) });
  }
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function addTranscriptEntry(type, text, lang, tts_b64 = null, tts_mime = null) {
  if (!text || !text.trim()) return;
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  state.transcriptEntries.push({ type, text, lang, ts });

  if (els.transcriptPlaceholder) {
    els.transcriptPlaceholder.style.display = "none";
  }

  const card = document.createElement("div");
  card.className = `transcript-entry ${type}`;

  const langLabel = escapeHtml(LANG_NAME[lang] || String(lang || "").toUpperCase());
  const cleanText = text.trim();

  let phoneticHtml = "";
  if (lang === "kn" || /[\u0C80-\u0CFF]/.test(cleanText)) {
    const roman = transliterateKannada(cleanText);
    if (roman && roman !== cleanText) {
      phoneticHtml = `<div class="entry-romanized" style="font-size: 0.8rem; color: #94a3b8; font-style: italic; margin-top: 3px;">📖 Pronunciation: ${escapeHtml(roman)}</div>`;
    }
  }

  let playButtonHtml = "";
  if (type === "translated" && tts_b64) {
    playButtonHtml = `
      <button class="entry-audio-btn" title="Replay natural voice">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        Play Voice
      </button>
    `;
  }

  card.innerHTML = `
    <div class="entry-meta">
      <span class="entry-label">${type === "original" ? "You (Spoken)" : "Live Translation"}</span>
      <span class="entry-lang">${langLabel}</span>
      <span class="entry-ts">${ts}</span>
    </div>
    <div class="entry-text">${escapeHtml(cleanText)}</div>
    ${phoneticHtml}
    ${playButtonHtml}
  `;

  // Bind each replay button to its own clip (not just the most recent one).
  const audioBtn = card.querySelector(".entry-audio-btn");
  if (audioBtn) {
    const mime = tts_mime || "audio/mpeg";
    audioBtn.addEventListener("click", () => window.playEntryAudio(tts_b64, mime));
  }

  if (els.transcriptPanel) {
    els.transcriptPanel.appendChild(card);
    els.transcriptPanel.scrollTop = els.transcriptPanel.scrollHeight;
  }
  updateTranscriptCount();
  return card;
}

// Add a "Play Voice" button to a transcript card once its audio is ready.
function attachEntryAudio(card, b64, mime) {
  if (!card || !b64 || card.querySelector(".entry-audio-btn")) return;
  const btn = document.createElement("button");
  btn.className = "entry-audio-btn";
  btn.title = "Replay natural voice";
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Play Voice`;
  btn.addEventListener("click", () => window.playEntryAudio(b64, mime || "audio/mpeg"));
  card.appendChild(btn);
}

function clearTranscript() {
  state.transcriptEntries = [];
  if (els.transcriptPanel) {
    els.transcriptPanel.innerHTML = '<div class="transcript-placeholder" id="transcriptPlaceholder">Live transcript will appear here as you speak...</div>';
    els.transcriptPlaceholder = $("transcriptPlaceholder");
  }
  updateTranscriptCount();
}

function copyTranscript() {
  const text = state.transcriptEntries
    .map((e) => `[${e.ts}] (${e.type === "original" ? "Spoken" : "Translation"}) [${e.lang}]: ${e.text}`)
    .join("\n");
  navigator.clipboard.writeText(text).then(() => {
    const btn = els.copyTranscriptBtn;
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = "✓ Copied";
      setTimeout(() => (btn.innerHTML = orig), 2000);
    }
  });
}

els.clearTranscriptBtn?.addEventListener("click", clearTranscript);
els.copyTranscriptBtn?.addEventListener("click", copyTranscript);

/* ───── Share Room Link ───── */
els.shareRoomBtn?.addEventListener("click", () => {
  const room = (els.roomId?.value || "demo-room").trim() || "demo-room";
  const url = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(room)}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = els.shareRoomBtn;
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `<span>✓ Link Copied!</span>`;
      setTimeout(() => (btn.innerHTML = orig), 2200);
    }
  });
});

if (window.location.hash) {
  const hashRoom = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (hashRoom && els.roomId) els.roomId.value = hashRoom;
}

/* ───── Audio Output Queue (Zero Echo & Pristine Clarity) ───── */
function queueTranslatedAudio(mime, b64) {
  try {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime || "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    state.translatedQueue.push(url);
    playNextTranslated();
  } catch (e) {
    log("queue_tts_error", { error: String(e) });
  }
}

function playNextTranslated() {
  if (state.translatedPlaying) return;
  const url = state.translatedQueue.shift();
  if (!url) return;

  // 1. Immediately pause microphone before audio plays (prevents speaker feedback)
  speechEngine.pauseForAudio();
  state.translatedPlaying = true;
  state.ttsCooldownUntil = Date.now() + 30000; // Guard during playback

  const audioEl = els.translatedAudio || new Audio();
  audioEl.src = url;

  const onEnded = () => {
    URL.revokeObjectURL(url);
    state.translatedPlaying = false;
    state.ttsCooldownUntil = Date.now() + 800; // 800ms echo clearance buffer
    setChip(els.chipTts, false);

    if (state.translatedQueue.length > 0) {
      playNextTranslated();
    } else {
      setTimeout(() => {
        if (!state.translatedPlaying && state.translatedQueue.length === 0) {
          speechEngine.resumeAfterAudio();
        }
      }, 800);
    }
  };

  audioEl.onended = onEnded;
  audioEl.onerror = onEnded;
  audioEl.play().catch(onEnded);
}

/* ───── Real-Time Speech Recognition Engine ───── */
const speechEngine = {
  recognizer: null,
  active: false,
  isPausedForPlayback: false,
  _currentSpeechBuffer: "",
  _translateDebounce: null,
  _resultIndex: 0,
  _dropUntilRestart: false,

  init() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      log("speech_rec_not_supported_using_server_asr");
      this.useServer = true;
      return;
    }
    try {
      this.recognizer = new SpeechRec();
      this.recognizer.continuous = true;
      this.recognizer.interimResults = true;
      this.recognizer.maxAlternatives = 1;
      this.updateLanguage();

      this.recognizer.onstart = () => {
        // Each recognition session numbers its results from 0 again.
        this._resultIndex = 0;
        this._dropUntilRestart = false;
        this.active = true;
        setChip(els.chipAsr, true);
        log("speech_rec_started");
      };

      this.recognizer.onresult = (event) => {
        // Drop any voice input during playback or echo cooldown
        if (this.isPausedForPlayback || state.translatedPlaying || Date.now() < (state.ttsCooldownUntil || 0)) {
          return;
        }

        // Results we already translated (or that were cut off by a manual
        // commit) must not be sent again.
        if (this._dropUntilRestart) return;
        if (!this._loggedResult) {
          this._loggedResult = true;
          log("speech_rec_first_result");
        }

        const params = getLangParams();
        const my = params.source_lang;
        const results = event.results;

        let finalText = "";
        let interimText = "";
        for (let i = this._resultIndex; i < results.length; ++i) {
          if (results[i].isFinal) finalText += results[i][0].transcript + " ";
          else interimText += results[i][0].transcript + " ";
        }

        const currentWords = (finalText + interimText).trim();
        if (currentWords && !this.isPausedForPlayback) {
          this._currentSpeechBuffer = currentWords;

          if (els.streamingWordTicker) {
            els.streamingWordTicker.textContent = formatReadableText(currentWords, my);
            els.streamingWordTicker.className = "streaming-text";
          }
          if (els.listeningStatusTip) {
            els.listeningStatusTip.textContent = "🎙️ Listening... translation updates live as you speak";
          }
          if (els.localPulseRing) {
            els.localPulseRing.classList.add("active-speech");
            clearTimeout(this._pulseTimeout);
            this._pulseTimeout = setTimeout(() => {
              els.localPulseRing?.classList.remove("active-speech");
            }, 800);
          }

          // Forward live interim speech to peer in room
          sendSignal({
            type: "peer-interim",
            data: { text: currentWords, isInterim: true, lang: my },
          });

          clearTimeout(this._translateDebounce);
          if (finalText.trim() && !interimText.trim()) {
            // Chrome marked the utterance final (~0.3-0.5 s after you stop):
            // translate right away instead of waiting for a fixed pause.
            this._resultIndex = results.length;
            this.commitTranslation(true);
          } else {
            // Live subtitles while still speaking.
            this.liveTranslate(currentWords);
            // Safety net if Chrome never finalizes (e.g. background noise).
            this._translateDebounce = setTimeout(() => {
              if (!this.isPausedForPlayback && this._currentSpeechBuffer.trim().length > 2) {
                this.commitTranslation();
              }
            }, 900);
          }
        }
      };

      this.recognizer.onerror = (e) => {
        if (e.error !== "no-speech" && e.error !== "aborted") {
          log("speech_rec_error", { error: e.error });
        }
        if ((e.error === "not-allowed" || e.error === "audio-capture") && els.streamingWordTicker) {
          els.streamingWordTicker.textContent = e.error === "not-allowed"
            ? "🎤 Microphone blocked. Allow microphone access for this site in your browser settings, then reload."
            : "🎤 No microphone found or it's in use by another app.";
        }
        // The browser's cloud speech service is unreachable or blocked
        // (offline, Brave, some Edge builds): fall back to server-side Whisper.
        if (["network", "service-not-allowed", "language-not-supported"].includes(e.error) && !this.useServer) {
          log("switching_to_server_asr", { reason: e.error });
          this.useServer = true;
          try { this.recognizer.abort(); } catch {}
          if (this.active) serverAsr.start();
        }
      };

      this.recognizer.onend = () => {
        if (this.active && !this.isPausedForPlayback && !this.useServer) {
          try {
            setTimeout(() => {
              if (this.active && !this.isPausedForPlayback) {
                try { this.recognizer.start(); } catch {}
              }
            }, 100);
          } catch {}
        }
      };
    } catch (e) {
      log("speech_rec_init_failed", { error: String(e) });
    }
  },

  updateLanguage() {
    if (!this.recognizer || this.useServer) return;
    const my = (els.myLang?.value || "en").trim();
    const langMap = { en: "en-IN", hi: "hi-IN", kn: "kn-IN" };
    const newLang = langMap[my] || "en-IN";
    if (this.recognizer.lang !== newLang) {
      this.recognizer.lang = newLang;
      log("speech_rec_lang_updated", { lang: newLang });
      if (this.active && !this.isPausedForPlayback) {
        try {
          this.recognizer.abort();
          setTimeout(() => { if (this.active) this.start(); }, 150);
        } catch {}
      }
    }
  },

  pauseForAudio() {
    this.isPausedForPlayback = true;
    clearTimeout(this._translateDebounce);
    if (this.recognizer) {
      try { this.recognizer.abort(); } catch {}
    }
  },

  resumeAfterAudio() {
    if (state.isMuted) return;
    this.isPausedForPlayback = false;
    if (this.active && this.recognizer && !this.useServer) {
      try { this.recognizer.start(); } catch {}
    }
  },

  start() {
    if (!this.recognizer && !this.useServer) this.init();
    if (this.useServer) {
      this.active = true;
      this.isPausedForPlayback = false;
      serverAsr.start();
      return;
    }
    if (this.recognizer) {
      this.active = true;
      this.isPausedForPlayback = false;
      try {
        const my = (els.myLang?.value || "en").trim();
        const langMap = { en: "en-IN", hi: "hi-IN", kn: "kn-IN" };
        this.recognizer.lang = langMap[my] || "en-IN";
        this.recognizer.start();
      } catch (e) {}
    }
  },

  stop() {
    this.active = false;
    this.isPausedForPlayback = false;
    clearTimeout(this._translateDebounce);
    if (this.recognizer) {
      try { this.recognizer.abort(); } catch {}
    }
    serverAsr.stop();
    if (els.streamingWordTicker) {
      els.streamingWordTicker.textContent = "Waiting for voice input...";
      els.streamingWordTicker.className = "streaming-text";
    }
    setChip(els.chipAsr, false);
  },

  // fromFinal: Chrome already closed these results. Otherwise (pause timeout,
  // Space key, button) the in-progress results are cut off here, so the
  // recognizer is restarted to stop them being finalized and sent twice.
  commitTranslation(fromFinal = false) {
    clearTimeout(this._translateDebounce);
    const textToTranslate = (this._currentSpeechBuffer || "").trim();
    this._currentSpeechBuffer = "";
    if (!textToTranslate || textToTranslate.length < 2) return;

    // Live translations still in flight are for this utterance; ignore them.
    this._committedSeq = this._liveSeq;
    clearTimeout(this._liveTimer);
    this._liveTimer = null;

    if (!fromFinal && this.recognizer && !this.useServer) {
      this._dropUntilRestart = true;
      try { this.recognizer.abort(); } catch {}
    }

    if (els.listeningStatusTip) {
      els.listeningStatusTip.textContent = "⚡ Translating...";
    }
    this.translateAndSpeak(textToTranslate);
  },

  _liveSeq: 0,
  _committedSeq: 0,
  _liveTimer: null,
  _liveLastSent: 0,
  _liveText: "",

  // Translate the in-progress sentence (text only, no voice) at most every
  // ~350 ms, so subtitles follow the speaker instead of appearing at the end.
  liveTranslate(text) {
    this._liveText = text;
    if (this._liveTimer) return;
    const wait = Math.max(0, 350 - (performance.now() - this._liveLastSent));
    this._liveTimer = setTimeout(() => this._sendLiveTranslation(), wait);
  },

  async _sendLiveTranslation() {
    this._liveTimer = null;
    this._liveLastSent = performance.now();
    const text = this._liveText;
    const seq = ++this._liveSeq;
    const params = getLangParams();
    const translated = await fetchTranslation(text, params.source_lang, params.target_lang);
    // Drop stale responses: a newer live request was sent, or the sentence was committed.
    if (!translated || seq !== this._liveSeq || seq <= this._committedSeq) return;
    if (els.streamingWordTranslation) {
      els.streamingWordTranslation.textContent = formatReadableText(translated, params.target_lang);
    }
    sendSignal({
      type: "peer-interim",
      data: { text, translated, isInterim: true, lang: params.source_lang, tlang: params.target_lang },
    });
  },

  async translateAndSpeak(text) {
    if (!text) return;
    const params = getLangParams();
    const my = params.source_lang;
    const target = params.target_lang;

    const startTime = performance.now();
    setChip(els.chipAsr, false);
    setChip(els.chipMt, true);
    pulseChip(els.chipMt);

    addTranscriptEntry("original", text, my);

    // 1. Text first (~100 ms), so the subtitle doesn't wait ~1 s for the voice.
    let translatedText;
    try {
      const geminiKey = (els.geminiApiKey?.value || "").trim();
      const res = await fetch("/translate-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text,
          src_lang: my,
          tgt_lang: target,
          tts: false,
          gemini_api_key: geminiKey || undefined,
        }),
      });
      setChip(els.chipMt, false);
      if (!res.ok) {
        log("translate_http_error", { status: res.status });
        if (els.streamingWordTranslation) {
          els.streamingWordTranslation.textContent =
            `⚠️ Translation failed (server returned ${res.status}). Make sure this page is open on the TalkBridge server's address (the one printed by run_app.py).`;
        }
        return;
      }
      translatedText = (await res.json()).translated || text;
    } catch (err) {
      log("translate_error", { error: String(err) });
      if (els.streamingWordTranslation) {
        els.streamingWordTranslation.textContent = "⚠️ Can't reach the TalkBridge server. Is run_app.py still running?";
      }
      setChip(els.chipMt, false);
      return;
    }

    const card = addTranscriptEntry("translated", translatedText, target);
    if (els.streamingWordTranslation) {
      els.streamingWordTranslation.textContent = formatReadableText(translatedText, target);
    }
    setLatency(Math.round(performance.now() - startTime));
    // The peer sees the final text immediately too; the voice follows.
    sendSignal({
      type: "peer-interim",
      data: { text, translated: translatedText, isInterim: false, lang: my, tlang: target },
    });

    // 2. Voice.
    setChip(els.chipTts, true);
    pulseChip(els.chipTts);
    const audio = await fetchTtsAudio(translatedText, target);
    if (audio) {
      attachEntryAudio(card, audio.b64, audio.mime);
      queueTranslatedAudio(audio.mime, audio.b64);
    } else {
      setChip(els.chipTts, false);
    }
    sendSignal({
      type: "peer-translation",
      sender: state.clientId,
      data: {
        original: text,
        translated: translatedText,
        src_lang: my,
        tgt_lang: target,
        tts_b64: audio ? audio.b64 : null,
        tts_mime: audio ? audio.mime : null,
      },
    });
    log("sent_translation_to_peer", { target, text: translatedText });
  }
};

/* ───── Translation / TTS requests ───── */
async function fetchTranslation(text, src, tgt) {
  try {
    const res = await fetch("/translate-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, src_lang: src, tgt_lang: tgt, tts: false }),
    });
    if (!res.ok) return null;
    return (await res.json()).translated || null;
  } catch {
    return null;
  }
}

async function fetchTtsAudio(text, lang) {
  try {
    const res = await fetch("/tts-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
    const b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return b64 ? { b64, mime: blob.type || "audio/mpeg" } : null;
  } catch (err) {
    log("tts_error", { error: String(err) });
    return null;
  }
}

/* ───── Server-side Speech Recognition (Whisper fallback) ─────
 * Used when the browser has no Web Speech API (Firefox) or its cloud speech
 * service fails. Streams 16 kHz PCM16 mic audio to /stream-audio, where the
 * backend runs VAD + Whisper (large-v3-turbo for Hindi/Kannada) + MT + TTS.
 */
const serverAsr = {
  active: false,
  ws: null,
  ctx: null,
  stream: null,
  source: null,
  node: null,
  segmentStart: 0,
  gated: false,

  async start() {
    if (this.active) return;
    this.active = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      log("server_asr_mic_error", { error: String(e) });
      if (els.streamingWordTicker) {
        els.streamingWordTicker.textContent = "🎤 Microphone blocked. Allow microphone access for this site in your browser settings, then reload.";
      }
      this.active = false;
      return;
    }
    if (!this.active) {
      // stop() was called while the permission prompt was open.
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return;
    }

    this.openSocket();
    this.ctx = getAudioCtx();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0));
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination); // required for onaudioprocess to fire; output stays silent

    setChip(els.chipAsr, true);
    if (els.listeningStatusTip) {
      els.listeningStatusTip.textContent = "🎙️ Listening (server speech recognition)... translates after a short pause";
    }
    log("server_asr_started");
  },

  openSocket() {
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${loc.host}/stream-audio/${encodeURIComponent(state.clientId)}`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      try { this.handleEvent(JSON.parse(ev.data)); } catch {}
    };
    ws.onclose = () => {
      if (this.active && this.ws === ws) {
        log("server_asr_socket_closed_reconnecting");
        setTimeout(() => { if (this.active && this.ws === ws) this.openSocket(); }, 1000);
      }
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
    this.node = this.source = this.ctx = this.stream = null;
    setChip(els.chipAsr, false);
  },

  onAudio(input) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Same echo/mute gating as the Web Speech path.
    if (state.isMuted || state.translatedPlaying || Date.now() < (state.ttsCooldownUntil || 0)) {
      if (!this.gated) {
        // Discard any half-captured utterance so the server doesn't translate a fragment.
        this.gated = true;
        this.ws.send(JSON.stringify({ reset: true }));
      }
      return;
    }
    this.gated = false;

    const ratio = this.ctx.sampleRate / 16000;
    const outLen = Math.floor(input.length / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      // Box-filter decimation: average the input samples that map to this output sample.
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }

    const params = getLangParams();
    this.ws.send(JSON.stringify({
      pcm16_b64: btoa(binary),
      sample_rate: 16000,
      source_lang: params.source_lang,
      target_lang: params.target_lang,
      tts_lang: params.tts_lang,
      whisper_model: "base",
    }));
  },

  handleEvent(ev) {
    const params = getLangParams();
    switch (ev.event) {
      case "segment_finalized":
        this.segmentStart = performance.now();
        setChip(els.chipMt, true);
        pulseChip(els.chipMt);
        break;
      case "final_transcript":
        addTranscriptEntry("original", ev.text, params.source_lang);
        if (els.streamingWordTicker) {
          els.streamingWordTicker.textContent = formatReadableText(ev.text, params.source_lang);
        }
        break;
      case "translation_complete":
        if (els.streamingWordTranslation) {
          els.streamingWordTranslation.textContent = formatReadableText(ev.text, params.target_lang);
        }
        break;
      case "tts_audio_ready": {
        // The event carries its own text, so audio is never paired with a newer subtitle.
        const p = { original: ev.original, translated: ev.text, src: params.source_lang, tgt: params.target_lang };
        setChip(els.chipMt, false);
        if (!p.translated) break;
        addTranscriptEntry("translated", p.translated, p.tgt, ev.audio_b64 || null, ev.mime);
        if (this.segmentStart) setLatency(Math.round(performance.now() - this.segmentStart));
        if (ev.audio_b64) {
          setChip(els.chipTts, true);
          pulseChip(els.chipTts);
          queueTranslatedAudio(ev.mime || "audio/mpeg", ev.audio_b64);
        }
        sendSignal({
          type: "peer-translation",
          sender: state.clientId,
          data: {
            original: p.original,
            translated: p.translated,
            src_lang: p.src,
            tgt_lang: p.tgt,
            tts_b64: ev.audio_b64 || null,
            tts_mime: ev.mime,
          },
        });
        break;
      }
      case "asr_failed":
      case "segment_timeout":
      case "segment_dropped_backpressure":
        setChip(els.chipMt, false);
        log("server_asr_" + ev.event, ev.error ? { error: ev.error } : undefined);
        break;
      default:
        if (ev.event && ev.event.startsWith("segment_skipped")) setChip(els.chipMt, false);
    }
  },
};

speechEngine.init();

els.commitTranslateBtn?.addEventListener("click", () => {
  speechEngine.commitTranslation();
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "SELECT") {
    if (speechEngine._currentSpeechBuffer && speechEngine._currentSpeechBuffer.trim().length > 2) {
      e.preventDefault();
      speechEngine.commitTranslation();
    }
  }
});

/* ───── Waveform Visualizer ───── */
async function startVisualizer() {
  if (state.audioStream) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    state.audioStream = stream;

    const ctx = getAudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);

    const canvas = els.waveformCanvas;
    if (!canvas) return;
    const canvasCtx = canvas.getContext("2d");
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
      state.animFrame = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
      const avg = sum / bufferLength;

      if (avg > 15) {
        els.micIndicator?.classList.add("speaking");
        els.localPulseRing?.classList.add("active-speech");
      } else {
        els.micIndicator?.classList.remove("speaking");
      }

      canvasCtx.fillStyle = "rgba(5, 8, 20, 0.4)";
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height * 0.9;
        const grad = canvasCtx.createLinearGradient(0, canvas.height - barHeight, 0, canvas.height);
        grad.addColorStop(0, "#818cf8");
        grad.addColorStop(1, "#38bdf8");

        canvasCtx.fillStyle = grad;
        canvasCtx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
        x += barWidth + 1;
      }
    }
    draw();
  } catch (e) {
    log("visualizer_mic_error", { error: String(e) });
  }
}

function stopVisualizer() {
  if (state.animFrame) cancelAnimationFrame(state.animFrame);
  if (state.audioStream) {
    state.audioStream.getTracks().forEach((t) => t.stop());
    state.audioStream = null;
  }
}

/* ───── WebSocket Room Signaling ───── */
function sendSignal(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function joinRoom() {
  return new Promise((resolve) => {
    const roomId = (els.roomId?.value || "demo-room").trim() || "demo-room";
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${loc.host}/ws/signaling/${encodeURIComponent(roomId)}/${encodeURIComponent(state.clientId)}`;

    setPill(els.signalingStatus, "bad");
    if (els.joinBtn) els.joinBtn.innerHTML = `<span class="btn-spinner"></span> Connecting...`;

    try {
      if (state.ws) {
        try { state.ws.close(); } catch {}
      }
      const ws = new WebSocket(url);
      state.ws = ws;

      ws.onopen = () => {
        setPill(els.signalingStatus, "ok");
        announceMyLang();
        if (els.joinBtn) {
          els.joinBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> Joined (${roomId})`;
          els.joinBtn.classList.add("btn-joined");
        }
        log("signaling connected", { roomId, clientId: state.clientId });
        resolve(true);
      };

      ws.onclose = () => {
        setPill(els.signalingStatus, "off");
        if (els.joinBtn) {
          els.joinBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg> Join Room`;
          els.joinBtn.classList.remove("btn-joined");
        }
        log("signaling closed");
        resolve(false);
      };

      ws.onerror = (ev) => {
        setPill(els.signalingStatus, "bad");
        if (els.joinBtn) {
          els.joinBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg> Retry Join`;
          els.joinBtn.classList.remove("btn-joined");
        }
        resolve(false);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          handleSignalMessage(msg);
        } catch (e) {}
      };
    } catch (err) {
      resolve(false);
    }
  });
}

function handleSignalMessage(msg) {
  if (!msg || msg.sender === state.clientId) {
    // Ignore self-broadcast message (prevents echo / duplicate audio)
    return;
  }
  if (msg.type === "peer-joined") {
    // Someone (re)joined the room: let them know my language.
    announceMyLang();
  } else if (msg.type === "peer-lang") {
    const peerLang = msg.data?.lang;
    if (peerLang && LANG_NAME[peerLang]) {
      state.peerLang = peerLang;
      applyPeerLang();
      updateLanguageBadges();
    }
  } else if (msg.type === "peer-interim") {
    if (msg.data?.text && els.streamingWordTicker) {
      els.streamingWordTicker.textContent = formatReadableText(msg.data.text, msg.data.lang);
      els.streamingWordTicker.className = "streaming-text interim";
    }
    if (msg.data?.translated && els.streamingWordTranslation) {
      els.streamingWordTranslation.textContent = formatReadableText(msg.data.translated, msg.data.tlang);
    }
    if (els.remotePulseRing) {
      els.remotePulseRing.classList.add("active-speech");
      setTimeout(() => els.remotePulseRing?.classList.remove("active-speech"), 700);
    }
  } else if (msg.type === "peer-translation") {
    const data = msg.data;
    if (!data) return;
    if (data.original) addTranscriptEntry("original", data.original, data.src_lang);
    if (data.translated) {
      addTranscriptEntry("translated", data.translated, data.tgt_lang, data.tts_b64, data.tts_mime);
      if (els.streamingWordTranslation) {
        els.streamingWordTranslation.textContent = formatReadableText(data.translated, data.tgt_lang);
      }
      if (els.streamingWordTicker) {
        els.streamingWordTicker.textContent = formatReadableText(data.original || data.translated, data.src_lang);
      }
    }
    if (els.remotePulseRing) {
      els.remotePulseRing.classList.add("active-speech");
      setTimeout(() => els.remotePulseRing?.classList.remove("active-speech"), 1200);
    }
    if (data.tts_b64) {
      setChip(els.chipTts, true);
      pulseChip(els.chipTts);
      queueTranslatedAudio(data.tts_mime || "audio/mpeg", data.tts_b64);
    }
  }
}

/* ───── Mobile support ─────
 * Phone browsers only allow audio that starts from a tap, and suspend
 * AudioContexts created outside one. Translated voice arrives ~1 s after
 * speech (not from a tap), so audio is unlocked once when the call starts.
 */
function getAudioCtx() {
  if (!state.audioCtx || state.audioCtx.state === "closed") {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AudioCtx();
  }
  return state.audioCtx;
}

const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

function unlockMobileAudio() {
  try { getAudioCtx().resume(); } catch {}
  const el = els.translatedAudio;
  if (el && !state.audioUnlocked) {
    el.src = SILENT_WAV;
    el.play().then(() => { state.audioUnlocked = true; }).catch(() => {});
  }
}

// Keep the screen on during a call: when a phone locks, the browser stops the mic.
async function keepScreenAwake() {
  if (!("wakeLock" in navigator) || !state.callActive) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) {
    log("wake_lock_failed", { error: String(e) });
  }
}

function releaseScreenAwake() {
  try { state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
}

// The OS drops the wake lock whenever the page is hidden; take it again on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.callActive) keepScreenAwake();
});

/* ───── Main Call Controls ───── */
async function startCall() {
  if (state.callActive) return;
  log("startCall triggered");
  // Must run synchronously inside the tap, before any await.
  unlockMobileAudio();

  // 1. Immediately activate Stopwatch Timer & Status UI
  state.callActive = true;
  keepScreenAwake();
  setPill(els.callStatus, "ok");
  startCallTimer();

  if (els.startBtn) {
    els.startBtn.innerHTML = `🎙️ Voice Translation Active`;
    els.startBtn.classList.add("btn-joined");
  }
  if (els.hangupBtn) els.hangupBtn.disabled = false;
  if (els.dockHangupBtn) els.dockHangupBtn.disabled = false;
  if (els.micIndicator) els.micIndicator.classList.add("active");

  // 2. Start Speech Recognition
  speechEngine.start();

  // 3. Start Waveform Visualizer
  startVisualizer().catch(() => {});

  // 4. Auto-connect room in background
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    joinRoom().catch(() => {});
  }
}

function hangup() {
  log("hangup triggered");
  state.callActive = false;
  releaseScreenAwake();

  speechEngine.stop();
  stopVisualizer();
  stopCallTimer();

  if (els.startBtn) {
    els.startBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.362 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0122 16.92z" /></svg> Start Voice Translation`;
    els.startBtn.classList.remove("btn-joined");
  }
  if (els.hangupBtn) els.hangupBtn.disabled = true;
  if (els.dockHangupBtn) els.dockHangupBtn.disabled = true;
  setPill(els.callStatus, "off");
  els.micIndicator?.classList.remove("active");
}

/* ───── Mute Control ───── */
function toggleMicMute() {
  state.isMuted = !state.isMuted;
  if (state.isMuted) {
    speechEngine.pauseForAudio();
  } else {
    speechEngine.resumeAfterAudio();
  }
  if (els.dockMuteBtn) els.dockMuteBtn.classList.toggle("active-muted", state.isMuted);
  if (els.dockMicLabel) els.dockMicLabel.textContent = state.isMuted ? "Unmute" : "Mute";
  log("mic_mute_toggled", { muted: state.isMuted });
}

els.dockMuteBtn?.addEventListener("click", toggleMicMute);

/* ───── Wire Global Handlers & Buttons ───── */
window.joinRoom = joinRoom;
window.startCall = startCall;
window.hangup = hangup;

els.joinBtn?.addEventListener("click", joinRoom);
els.startBtn?.addEventListener("click", startCall);
els.hangupBtn?.addEventListener("click", hangup);
els.dockHangupBtn?.addEventListener("click", hangup);

/* ───── Collapsible logs ───── */
els.logsToggle?.addEventListener("click", () => {
  const card = els.logsToggle.closest(".logs-card");
  card?.classList.toggle("collapsed");
});

/* ───── Sliding Reviews Carousel ───── */
(function initReviews() {
  const viewport = document.getElementById("reviewsViewport");
  const track = document.getElementById("reviewsTrack");
  const dotsContainer = document.getElementById("reviewsDots");
  const prevBtn = document.getElementById("reviewPrev");
  const nextBtn = document.getElementById("reviewNext");
  if (!viewport || !track || !dotsContainer) return;

  const slides = Array.from(track.querySelectorAll(".review-slide"));
  if (slides.length === 0) return;

  let index = 0;
  let autoTimer = null;
  let paused = false;
  const AUTO_MS = 5000;

  slides.forEach((_, i) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "dot" + (i === 0 ? " active" : "");
    dot.setAttribute("role", "tab");
    dot.setAttribute("aria-label", `Go to review ${i + 1}`);
    dot.addEventListener("click", () => goTo(i, { user: true }));
    dotsContainer.appendChild(dot);
  });
  const dots = Array.from(dotsContainer.children);

  function render() {
    track.style.transform = `translateX(-${index * 100}%)`;
    dots.forEach((d, i) => d.classList.toggle("active", i === index));
  }

  function goTo(i, opts = {}) {
    const n = slides.length;
    index = ((i % n) + n) % n;
    render();
    if (opts.user) restartAuto();
  }
  function next(opts) { goTo(index + 1, opts); }
  function prev(opts) { goTo(index - 1, opts); }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(() => { if (!paused) next(); }, AUTO_MS);
  }
  function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
  function restartAuto() { startAuto(); }

  prevBtn?.addEventListener("click", () => prev({ user: true }));
  nextBtn?.addEventListener("click", () => next({ user: true }));

  viewport.addEventListener("mouseenter", () => { paused = true; });
  viewport.addEventListener("mouseleave", () => { paused = false; });

  render();
  startAuto();
})();

// Initial language setup
updateLanguageBadges();

// Auto-connect room on initial load
setTimeout(() => {
  joinRoom().catch(() => {});
}, 300);
