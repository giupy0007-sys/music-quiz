// Splash screen: mostra brevemente al lancio dalla home screen, poi scompare
(function dismissSplash() {
  const splash = document.getElementById("splash-screen");
  if (!splash) return;
  const hide = () => {
    splash.classList.add("hidden");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
  };
  // Aspetta che la pagina sia pronta (min 600ms per dare visibilità alla splash)
  if (document.readyState === "complete") {
    setTimeout(hide, 600);
  } else {
    window.addEventListener("load", () => setTimeout(hide, 600), { once: true });
  }
})();

const socket = io();

const TYPE_LABELS = {
  artist: "🎤 Indovina l'artista",
  year: "📅 Indovina l'anno",
  album: "💿 Indovina l'album",
  lyric: "📝 Indovina il titolo",
  feature: "🤝 Indovina il featuring",
  label: "🏷️ Indovina l'etichetta",
  nickname: "🃏 Indovina il soprannome",
};

const MODES = [
  { id: "classic", icon: "🎯", title: "Classica", desc: "Risposta rapida = più punti" },
  { id: "duel", icon: "⚔️", title: "Sfida 1v1", desc: "Solo 2 giocatori, testa a testa" },
  { id: "tournament", icon: "🏆", title: "Torneo", desc: "Eliminazione diretta, 2–8 giocatori" },
  { id: "blitz", icon: "⚡", title: "Blitz", desc: "10s a domanda, ritmo serrato" },
  { id: "blind", icon: "🙈", title: "Blind", desc: "Solo testo, nessuna immagine" },
  { id: "collab", icon: "🤝", title: "Collaborativa", desc: "Tutti in squadra contro il tempo" },
  { id: "audio", icon: "🎧", title: "Indovina dall'audio", desc: "Clip audio: artista, titolo, anno e album" },
  { id: "mixed", icon: "🌀", title: "Mista", desc: "Alterna clip audio e domande testo" },
  { id: "lyrics", icon: "🎤", title: "Indovina il testo", desc: "Verso famoso: chi l'ha cantato?" },
  { id: "streak", icon: "🔥", title: "Streak", desc: "Niente timer: quante di fila?" },
];
const MODE_META = Object.fromEntries(MODES.map((m) => [m.id, m]));

const BADGE_META = {
  first_login: { icon: "👋", label: "Primo accesso" },
  first_win: { icon: "🥇", label: "Prima vittoria" },
  streak_10: { icon: "🔥", label: "Streak di 10" },
  perfect_score: { icon: "💯", label: "Punteggio perfetto" },
  all_modes: { icon: "🎮", label: "Tutte le modalità" },
};

const screens = {
  home: document.getElementById("screen-home"),
  lobby: document.getElementById("screen-lobby"),
  loading: document.getElementById("screen-loading"),
  game: document.getElementById("screen-game"),
  roundResult: document.getElementById("screen-round-result"),
  final: document.getElementById("screen-final"),
  tournament: document.getElementById("screen-tournament"),
  profile: document.getElementById("screen-profile"),
  daily: document.getElementById("screen-daily"),
  dailyFinal: document.getElementById("screen-daily-final"),
};

const ROOM_SCREENS = new Set(["lobby", "loading", "game", "roundResult", "final", "tournament"]);
const appEl = document.getElementById("app");

let currentScreen = "home";

function showScreen(name) {
  currentScreen = name;
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle("active", key === name);
  }
  document.getElementById("btn-reaction-toggle").classList.toggle("hidden", !ROOM_SCREENS.has(name));
  closeReactionPanel();
  if (name === "home") {
    appEl.removeAttribute("data-theme");
    refreshHomeData();
  }
}

function applyTheme(category) {
  if (category && category !== "mixed") appEl.dataset.theme = category;
  else appEl.removeAttribute("data-theme");
}

// ---------- Nickname ricordato sul device ----------
const NICKNAME_STORAGE_KEY = "musicquiz_nickname";
function getSavedNickname() {
  try { return localStorage.getItem(NICKNAME_STORAGE_KEY) || ""; } catch { return ""; }
}
function saveNickname(name) {
  try { localStorage.setItem(NICKNAME_STORAGE_KEY, name); } catch { /* storage non disponibile */ }
}
function currentNickname() {
  return (document.getElementById("nickname-input").value || "").trim() || getSavedNickname();
}

let myId = null;
let myNickname = "";
let isHost = false;
let selectedMode = "classic";
let secretHardMode = false;
let collabTotalMs = 90000;
let timerInterval = null;
let countdownInterval = null;
let hasAnswered = false;

// ---------- TOAST ----------
function showToast(message, opts = {}) {
  const { variant = "default", duration = 3500 } = opts;
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast" + (variant !== "default" ? ` ${variant}` : "");
  el.style.setProperty("--life", `${duration}ms`);
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration + 450);
}

socket.on("room:toast", ({ message }) => showToast(message, { variant: "gold", duration: 4500 }));

// ---------- CONFETTI ----------
const CONFETTI_COLORS = ["#ff3d81", "#7c3aed", "#ffb020", "#22e2a0", "#ffffff"];
function confettiBurst(count = 120) {
  const container = document.getElementById("confetti-container");
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const duration = 1800 + Math.random() * 1600;
    piece.style.animationDuration = `${duration}ms`;
    piece.style.animationDelay = `${Math.random() * 300}ms`;
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    container.appendChild(piece);
    setTimeout(() => piece.remove(), duration + 500);
  }
}

// ---------- REACTION EMOJI: pannello, animazione di volo, suoni sintetizzati ----------
function flyEmoji(emoji) {
  const container = document.getElementById("flying-emoji-container");
  const el = document.createElement("div");
  el.className = "flying-emoji";
  el.textContent = emoji;
  el.style.left = `${10 + Math.random() * 70}%`;
  el.style.bottom = "70px";
  el.style.setProperty("--drift", `${(Math.random() * 80 - 40).toFixed(0)}px`);
  container.appendChild(el);
  setTimeout(() => el.remove(), 2300);
}

function sfxFire(ctx) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  filter.type = "bandpass";
  filter.frequency.value = 1200;
  filter.Q.value = 0.7;
  osc.frequency.setValueAtTime(1800, now);
  osc.frequency.exponentialRampToValueAtTime(120, now + 0.35);
  gain.gain.setValueAtTime(0.09, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
  osc.connect(filter).connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.4);
}
function sfxLaugh(ctx) {
  const now = ctx.currentTime;
  [0, 0.09, 0.18].forEach((t, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 300 + i * 40;
    gain.gain.setValueAtTime(0.08, now + t);
    gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + t);
    osc.stop(now + t + 0.13);
  });
}
function sfxGhost(ctx) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(420, now);
  osc.frequency.exponentialRampToValueAtTime(110, now + 0.7);
  lfo.frequency.value = 7;
  lfoGain.gain.value = 18;
  lfo.connect(lfoGain).connect(osc.frequency);
  gain.gain.setValueAtTime(0.08, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.75);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  lfo.start(now);
  osc.stop(now + 0.8);
  lfo.stop(now + 0.8);
}
function sfxGoat(ctx) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.value = 480;
  lfo.frequency.value = 11;
  lfoGain.gain.value = 90;
  lfo.connect(lfoGain).connect(osc.frequency);
  gain.gain.setValueAtTime(0.07, now);
  gain.gain.linearRampToValueAtTime(0.07, now + 0.25);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  lfo.start(now);
  osc.stop(now + 0.46);
  lfo.stop(now + 0.46);
}
function sfxSnort(ctx) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  osc.type = "square";
  filter.type = "lowpass";
  filter.frequency.value = 400;
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(80, now + 0.18);
  gain.gain.setValueAtTime(0.09, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  osc.connect(filter).connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.21);
}
function sfxTarget(ctx) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(900, now);
  osc.frequency.exponentialRampToValueAtTime(200, now + 0.12);
  gain.gain.setValueAtTime(0.1, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.15);
}
function sfxPoop(ctx) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(600, now);
  osc.frequency.exponentialRampToValueAtTime(150, now + 0.3);
  gain.gain.setValueAtTime(0.09, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.33);
}
function sfxThumbsUp(ctx) {
  const now = ctx.currentTime;
  [0, 0.1].forEach((t, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = i === 0 ? 660 : 880;
    gain.gain.setValueAtTime(0.09, now + t);
    gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + t);
    osc.stop(now + t + 0.19);
  });
}
const REACTION_SFX = { "🔥": sfxFire, "😂": sfxLaugh, "💀": sfxGhost, "🐐": sfxGoat, "😤": sfxSnort, "🎯": sfxTarget, "💩": sfxPoop, "👍": sfxThumbsUp };
function playReactionSound(emoji) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const fn = REACTION_SFX[emoji];
  if (fn) fn(ctx);
}

const reactionToggleBtn = document.getElementById("btn-reaction-toggle");
const reactionPanel = document.getElementById("reaction-panel");
function closeReactionPanel() {
  reactionPanel.classList.add("hidden");
}
reactionToggleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  ensureAudio();
  reactionPanel.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!reactionPanel.classList.contains("hidden") && !reactionPanel.contains(e.target) && e.target !== reactionToggleBtn) {
    closeReactionPanel();
  }
});

let reactionSentTimestamps = [];
document.querySelectorAll(".reaction-emoji-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const emoji = btn.dataset.emoji;
    const now = Date.now();
    reactionSentTimestamps = reactionSentTimestamps.filter((t) => now - t < 10000);
    if (reactionSentTimestamps.length >= 2) {
      showToast("Aspetta un attimo prima della prossima reaction 😉", { duration: 2200 });
      closeReactionPanel();
      return;
    }
    reactionSentTimestamps.push(now);
    flyEmoji(emoji);
    playReactionSound(emoji);
    socket.emit("reaction:send", { emoji });
    closeReactionPanel();
  });
});

socket.on("reaction:incoming", ({ emoji }) => {
  flyEmoji(emoji);
  playReactionSound(emoji);
});

// ---------- AUDIO + HAPTIC FEEDBACK ----------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      audioCtx = null;
    }
  }
  return audioCtx;
}

function playTone(freq, duration, type, volume) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

// iOS Safari non implementa la Vibration API: niente vibrazione vera possibile da una pagina
// web su iPhone. Compensiamo con un micro-suono + animazione "punch" immediata.
function hapticFeedback(kind) {
  if (navigator.vibrate) {
    if (kind === "select") navigator.vibrate(15);
    else if (kind === "correct") navigator.vibrate([0, 25, 40, 25]);
    else if (kind === "incorrect") navigator.vibrate(60);
  }
  if (kind === "select") {
    playTone(440, 0.06, "sine", 0.06);
  } else if (kind === "correct") {
    playTone(660, 0.10, "sine", 0.07);
    setTimeout(() => playTone(880, 0.10, "sine", 0.07), 90);
  } else if (kind === "incorrect") {
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(360, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(180, ctx.currentTime + 0.28);
    gain.gain.setValueAtTime(0.07, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.28);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.28);
  }
}

function punch(el) {
  el.classList.remove("haptic-punch");
  void el.offsetWidth;
  el.classList.add("haptic-punch");
}

// Audio ambientale rimosso: gli oscillatori sintetizzati producevano rumore fastidioso,
// non musica. Le funzioni sono no-op per non rompere i call site esistenti.
function startAmbient() {}
function stopAmbient() {}
function duckAmbient() {}

// ---------- HOME: nickname + modalità ----------
const nicknameInput = document.getElementById("nickname-input");
const codeInput = document.getElementById("code-input");
const homeError = document.getElementById("home-error");
const modeGrid = document.getElementById("mode-grid");

if (getSavedNickname()) nicknameInput.value = getSavedNickname();

// Gestione link di invito: ?join=CODICE
(function handleInviteParam() {
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get("join");
  if (joinCode) {
    codeInput.value = joinCode.toUpperCase().slice(0, 4);
    nicknameInput.focus();
    showToast(`🔗 Entra nella stanza ${joinCode.toUpperCase()} — inserisci il tuo nickname`, { duration: 5000 });
    history.replaceState({}, "", window.location.pathname);
  }
})();

MODES.forEach((m) => {
  const card = document.createElement("div");
  card.className = "mode-card" + (m.id === selectedMode ? " selected" : "");
  card.dataset.mode = m.id;
  card.innerHTML = `<span class="mode-card-icon">${m.icon}</span><span class="mode-card-title">${m.title}</span><span class="mode-card-desc">${m.desc}</span>`;
  card.addEventListener("click", () => {
    selectedMode = m.id;
    [...modeGrid.children].forEach((c) => c.classList.toggle("selected", c.dataset.mode === selectedMode));
  });
  modeGrid.appendChild(card);
});

document.getElementById("btn-create").addEventListener("click", () => {
  ensureAudio();
  const nickname = nicknameInput.value.trim();
  if (!nickname) return showHomeError("Inserisci un nickname.");
  saveNickname(nickname);
  socket.emit("room:create", { nickname, mode: selectedMode, hardMode: secretHardMode }, (res) => {
    if (!res.ok) return showHomeError(res.error || "Errore.");
    announceNewBadges(res.newBadges);
    enterLobby(res.room);
  });
});

document.getElementById("btn-join").addEventListener("click", () => {
  ensureAudio();
  const nickname = nicknameInput.value.trim();
  const code = codeInput.value.trim().toUpperCase();
  if (!nickname) return showHomeError("Inserisci un nickname.");
  if (!code) return showHomeError("Inserisci il codice della stanza.");
  saveNickname(nickname);
  socket.emit("room:join", { code, nickname }, (res) => {
    if (!res.ok) return showHomeError(res.error || "Errore.");
    if (res.rejoined) {
      // Riconnessione a partita in corso — vai direttamente alla schermata di gioco
      showSection("game");
      return;
    }
    announceNewBadges(res.newBadges);
    enterLobby(res.room);
  });
});

function announceNewBadges(newBadges) {
  if (!newBadges || !newBadges.length) return;
  newBadges.forEach((id, i) => {
    const meta = BADGE_META[id];
    if (!meta) return;
    setTimeout(() => showToast(`${meta.icon} Nuovo badge: ${meta.label}!`, { variant: "gold", duration: 4000 }), i * 600);
  });
}

function showHomeError(msg) {
  homeError.textContent = msg;
}

// ---------- HOME: cover fluttuanti + parallax ----------
const ICONIC_SEARCHES = [
  "2Pac All Eyez on Me",
  "Notorious B.I.G. Ready to Die",
  "Nas Illmatic",
  "Wu-Tang Clan Enter the Wu-Tang",
  "Dr. Dre The Chronic",
  "Snoop Dogg Doggystyle",
  "Eminem The Marshall Mathers LP",
  "Jay-Z The Black Album",
  "Kanye West Graduation",
  "Lil Wayne Tha Carter III",
  "Kendrick Lamar To Pimp a Butterfly",
  "Drake Views",
  "Travis Scott Astroworld",
  "Playboi Carti Whole Lotta Red",
];

const floatingCoverEls = [];

async function loadFloatingCovers() {
  const container = document.getElementById("floating-covers");
  const artworkUrls = await Promise.all(
    ICONIC_SEARCHES.map((term) =>
      fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=1`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => (data && data.results && data.results[0] ? data.results[0].artworkUrl100 : null))
        .catch(() => null)
    )
  );

  artworkUrls.forEach((art) => {
    if (!art) return;
    const url = art.replace(/\d+x\d+bb/, "300x300bb");
    const wrap = document.createElement("div");
    wrap.className = "cover-parallax";
    wrap.style.left = `${Math.random() * 88}%`;
    wrap.style.top = `${Math.random() * 88}%`;
    wrap.dataset.depth = (0.3 + Math.random() * 0.7).toFixed(2);

    const img = document.createElement("img");
    img.className = "cover-float";
    img.src = url;
    img.alt = "";
    img.style.setProperty("--dur", `${14 + Math.random() * 12}s`);
    img.style.setProperty("--delay", `${(Math.random() * 4).toFixed(2)}s`);
    img.style.setProperty("--dx", `${(Math.random() * 50 - 25).toFixed(0)}px`);
    img.style.setProperty("--dy", `${(Math.random() * 50 - 25).toFixed(0)}px`);
    img.style.setProperty("--rot", `${(Math.random() * 16 - 8).toFixed(1)}deg`);

    wrap.appendChild(img);
    container.appendChild(wrap);
    floatingCoverEls.push(wrap);
  });
}
loadFloatingCovers();

let parallaxRaf = null;
let targetPX = 0;
let targetPY = 0;

function queueParallax(px, py) {
  targetPX = px;
  targetPY = py;
  if (parallaxRaf) return;
  parallaxRaf = requestAnimationFrame(applyParallax);
}
function applyParallax() {
  parallaxRaf = null;
  floatingCoverEls.forEach((el) => {
    const depth = parseFloat(el.dataset.depth || "0.5");
    el.style.transform = `translate(${(targetPX * 26 * depth).toFixed(1)}px, ${(targetPY * 26 * depth).toFixed(1)}px)`;
  });
}

document.addEventListener("mousemove", (e) => {
  queueParallax(e.clientX / window.innerWidth - 0.5, e.clientY / window.innerHeight - 0.5);
});

function enableMotionParallax() {
  window.addEventListener("deviceorientation", (e) => {
    if (e.gamma == null || e.beta == null) return;
    const px = Math.max(-1, Math.min(1, e.gamma / 30));
    const py = Math.max(-1, Math.min(1, (e.beta - 40) / 30));
    queueParallax(px, py);
  });
}

let motionRequested = false;
function requestMotionPermissionOnce() {
  if (motionRequested) return;
  motionRequested = true;
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission()
      .then((state) => { if (state === "granted") enableMotionParallax(); })
      .catch(() => {});
  } else if (typeof DeviceOrientationEvent !== "undefined") {
    enableMotionParallax();
  }
}
screens.home.addEventListener("touchstart", requestMotionPermissionOnce, { once: true });

// ---------- HOME: easter egg tap logo -> modalità segreta domande difficili ----------
let logoTapCount = 0;
let logoTapTimer = null;
document.getElementById("brand-mark").addEventListener("click", (e) => {
  logoTapCount += 1;
  clearTimeout(logoTapTimer);
  logoTapTimer = setTimeout(() => { logoTapCount = 0; }, 1500);
  punch(e.currentTarget);
  if (logoTapCount >= 5) {
    logoTapCount = 0;
    secretHardMode = !secretHardMode;
    confettiBurst();
    e.currentTarget.classList.toggle("hard-mode-active", secretHardMode);
    showToast(
      secretHardMode
        ? "🐐 Modalità GOAT sbloccata: ora pescherai solo le domande più difficili (solo featuring, etichette e soprannomi). Per veri intenditori."
        : "Modalità GOAT disattivata. Si torna alla normalità.",
      { variant: "gold", duration: 5000 }
    );
  }
});

// ---------- LOBBY ----------
const lobbyCode = document.getElementById("lobby-code");
const lobbyCount = document.getElementById("lobby-count");
const lobbyPlayers = document.getElementById("lobby-players");
const lobbyModeBadge = document.getElementById("lobby-mode-badge");
const hostSettings = document.getElementById("host-settings");
const waitingText = document.getElementById("waiting-text");
const settingsStandard = document.getElementById("settings-standard");
const settingsCollab = document.getElementById("settings-collab");
const timelimitCol = document.getElementById("settings-timelimit-col");

document.getElementById("btn-invite-link").addEventListener("click", () => {
  const code = lobbyCode.textContent.trim();
  if (!code || code === "----") return;
  const url = `${window.location.origin}${window.location.pathname}?join=${code}`;
  navigator.clipboard.writeText(url).then(
    () => showToast("📋 Link copiato! Mandalo agli amici.", { duration: 3000 }),
    () => showToast(`Link: ${url}`, { duration: 6000 })
  );
});

function enterLobby(room) {
  myId = socket.id;
  homeError.textContent = "";
  showScreen("lobby");
  renderRoom(room);
}

function renderRoom(room) {
  isHost = room.hostId === myId;
  const me = room.players.find((p) => p.id === myId);
  if (me) myNickname = me.nickname;

  const meta = MODE_META[room.settings.mode] || MODE_META.classic;
  lobbyModeBadge.textContent = `${meta.icon} ${meta.title}`;

  lobbyCode.textContent = room.code;
  lobbyCount.textContent = room.players.length;
  lobbyPlayers.innerHTML = "";
  for (const p of room.players) {
    const li = document.createElement("li");
    const initial = (p.nickname || "?").trim().charAt(0).toUpperCase() || "?";
    const badge = p.badge ? `${p.badge} ` : "";
    li.innerHTML = `<span class="avatar">${escapeHtml(initial)}</span><span class="p-name">${badge}${escapeHtml(p.nickname)}${p.id === room.hostId ? '<span class="host-tag">HOST</span>' : ""}</span><span class="p-score">${p.score} pt</span>`;
    lobbyPlayers.appendChild(li);
  }
  hostSettings.classList.toggle("hidden", !isHost);
  waitingText.classList.toggle("hidden", isHost);

  const mode = room.settings.mode;
  const isCollabMode = mode === "collab";
  const isStreakMode = mode === "streak";
  const isDuelMode = mode === "duel";
  const isTournamentMode = mode === "tournament";
  settingsStandard.classList.toggle("hidden", isCollabMode || isStreakMode || isTournamentMode);
  settingsCollab.classList.toggle("hidden", !isCollabMode);
  timelimitCol.classList.toggle("hidden", mode === "blitz" || mode === "audio");

  if (isCollabMode) collabTotalMs = (room.settings.duration || 90) * 1000;

  const duelWaitEl = document.getElementById("duel-wait-hint");
  const btnStart = document.getElementById("btn-start");

  if (isDuelMode) {
    if (duelWaitEl) duelWaitEl.classList.toggle("hidden", room.players.length >= 2);
    if (btnStart && isHost) {
      btnStart.disabled = room.players.length < 2;
      btnStart.title = room.players.length < 2 ? "Aspetta l'avversario" : "";
    }
  } else if (isTournamentMode) {
    if (duelWaitEl) duelWaitEl.classList.add("hidden");
    const needsEven = room.players.length % 2 !== 0;
    if (btnStart && isHost) {
      btnStart.disabled = room.players.length < 2 || needsEven;
      btnStart.title = needsEven ? "Serve un numero pari di giocatori" : room.players.length < 2 ? "Aspetta altri giocatori" : "";
    }
  } else {
    if (duelWaitEl) duelWaitEl.classList.add("hidden");
    if (btnStart) { btnStart.disabled = false; btnStart.title = ""; }
  }
}

document.getElementById("btn-start").addEventListener("click", () => {
  const category = document.getElementById("setting-category").value;
  const rounds = document.getElementById("setting-rounds").value;
  const timeLimit = document.getElementById("setting-timelimit").value;
  const duration = document.getElementById("setting-duration").value;
  socket.emit("room:start", { category, rounds, timeLimit, duration, hardMode: secretHardMode });
});

socket.on("room:update", (room) => {
  if (room.state === "lobby") {
    appEl.removeAttribute("data-theme");
    showScreen("lobby");
    renderRoom(room);
  } else if (room.state === "loading") {
    applyTheme(room.settings.category);
    startAmbient(room.settings.category);
    showScreen("loading");
    isHost = room.hostId === myId;
  } else if (room.state === "playing") {
    // collab/streak passano da lobby a playing senza passare per "loading"
    applyTheme(room.settings.category);
    startAmbient(room.settings.category);
  } else if (screens.final.classList.contains("active")) {
    isHost = room.hostId === myId;
    updateFinalControls();
  } else if (screens.lobby.classList.contains("active")) {
    renderRoom(room);
  }
});

// ---------- NAVIGAZIONE: esci / torna al menu ----------
function leaveRoom() {
  socket.emit("room:leave");
  clearInterval(timerInterval);
  clearInterval(countdownInterval);
  stopAudioPreview();
  stopAmbient();
  isHost = false;
  appEl.removeAttribute("data-theme");
  showScreen("home");
}

document.querySelectorAll(".btn-exit").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.action === "back-home") {
      showScreen("home");
    } else if (confirm("Sei sicuro di voler uscire dalla stanza?")) {
      leaveRoom();
    }
  });
});
document.getElementById("btn-back-menu").addEventListener("click", leaveRoom);

// ---------- GAME ----------
const standardTop = document.getElementById("standard-top");
const collabTop = document.getElementById("collab-top");
const duelTop = document.getElementById("duel-top");
const duelNameA = document.getElementById("duel-name-a");
const duelNameB = document.getElementById("duel-name-b");
const duelScoreA = document.getElementById("duel-score-a");
const duelScoreB = document.getElementById("duel-score-b");
const duelSideA = document.getElementById("duel-side-a");
const duelSideB = document.getElementById("duel-side-b");
const duelRound = document.getElementById("duel-round");
const duelSpectatorBadge = document.getElementById("duel-spectator-badge");
const collabScoreValue = document.getElementById("collab-score-value");
const collabClockFill = document.getElementById("collab-clock-fill");
const collabClockText = document.getElementById("collab-clock-text");
const gameProgress = document.getElementById("game-progress");
const gameType = document.getElementById("game-type");
const answerCountBadge = document.getElementById("answer-count");
const timerBar = document.getElementById("timer-bar");
const questionText = document.getElementById("question-text");
const optionsGrid = document.getElementById("options-grid");
const answerFeedback = document.getElementById("answer-feedback");
const questionArt = document.getElementById("question-art");
const questionArtImg = document.getElementById("question-art-img");
const audioPlayer = document.getElementById("audio-player");
const btnPlayAudio = document.getElementById("btn-play-audio");
const waveform = document.getElementById("waveform");

let audioEl = null;
let audioStopTimer = null;

function stopAudioPreview() {
  clearTimeout(audioStopTimer);
  if (audioEl) { audioEl.pause(); audioEl.oncanplay = null; audioEl.onerror = null; }
  btnPlayAudio.classList.remove("playing");
  btnPlayAudio.textContent = "▶";
  btnPlayAudio.disabled = false;
  waveform.classList.remove("playing");
  duckAmbient(false);
}

function setupAudioPreview(url) {
  stopAudioPreview();
  if (!url) { audioEl = null; return; }
  audioEl = new Audio(url);
  btnPlayAudio.disabled = true;
  btnPlayAudio.textContent = "⏳";
  const fallback = setTimeout(() => {
    btnPlayAudio.disabled = false;
    btnPlayAudio.textContent = "▶";
  }, 3000);
  audioEl.oncanplay = () => {
    clearTimeout(fallback);
    btnPlayAudio.disabled = false;
    btnPlayAudio.textContent = "▶";
  };
  audioEl.onerror = () => {
    clearTimeout(fallback);
    btnPlayAudio.disabled = true;
    btnPlayAudio.textContent = "✕";
  };
}

btnPlayAudio.addEventListener("click", () => {
  if (!audioEl) return;
  clearTimeout(audioStopTimer);
  audioEl.currentTime = 0;
  audioEl.play().catch(() => {});
  btnPlayAudio.classList.add("playing");
  btnPlayAudio.textContent = "❚❚";
  waveform.classList.add("playing");
  duckAmbient(true);
  audioStopTimer = setTimeout(() => {
    audioEl.pause();
    btnPlayAudio.classList.remove("playing");
    btnPlayAudio.textContent = "▶";
    waveform.classList.remove("playing");
    duckAmbient(false);
  }, 5000);
});

function updateDuelScoreboard(players) {
  const me = players.find((p) => p.id === myId) || players[0];
  const opp = players.find((p) => p.id !== myId) || players[1];
  if (!me || !opp) return;
  duelNameA.textContent = me.nickname;
  duelScoreA.textContent = me.score;
  duelNameB.textContent = opp.nickname;
  duelScoreB.textContent = opp.score;
  duelSideA.classList.toggle("is-me", true);
  duelSideA.classList.toggle("winning", me.score > opp.score);
  duelSideA.classList.toggle("losing", me.score < opp.score);
  duelSideB.classList.toggle("winning", opp.score > me.score);
  duelSideB.classList.toggle("losing", opp.score < me.score);
}

function updateCollabClock(remainingMs) {
  const clamped = Math.max(0, remainingMs);
  const fraction = collabTotalMs > 0 ? clamped / collabTotalMs : 0;
  collabClockFill.style.width = `${Math.min(100, fraction * 100)}%`;
  collabClockText.textContent = `${Math.ceil(clamped / 1000)}s`;
}

socket.on("game:collabTick", ({ remainingMs }) => updateCollabClock(remainingMs));

socket.on("game:question", (q) => {
  myId = socket.id;
  hasAnswered = false;
  showScreen("game");

  const isCollab = q.mode === "collab";
  const isDuel = q.mode === "duel";
  const isTournament = q.mode === "tournament";
  const isDuelLike = isDuel || isTournament;
  const isSpectator = isTournament && q.tournamentActiveIds && !q.tournamentActiveIds.includes(myId);

  standardTop.classList.toggle("hidden", isCollab || isDuelLike);
  collabTop.classList.toggle("hidden", !isCollab);
  duelTop.classList.toggle("hidden", !isDuelLike);

  if (isCollab) {
    collabScoreValue.textContent = q.teamScore;
    updateCollabClock(q.remainingMs);
  } else if (isDuelLike && q.duelPlayers) {
    updateDuelScoreboard(q.duelPlayers);
    duelRound.textContent = `Round ${q.index + 1}/${q.total}`;
    duelRound.classList.remove("hidden");
    duelSpectatorBadge.classList.toggle("hidden", !isSpectator);
    answerCountBadge.classList.add("hidden");
  } else {
    gameProgress.textContent = `${q.index + 1} / ${q.total}`;
    answerCountBadge.classList.remove("hidden");
    gameType.textContent = TYPE_LABELS[q.type] || "Domanda";
  }

  questionText.textContent = q.question;
  answerFeedback.textContent = isSpectator ? "👁 Stai guardando — non puoi rispondere" : "";
  optionsGrid.innerHTML = "";

  if (q.imageMode === "audio") {
    questionArt.classList.add("hidden");
    audioPlayer.classList.remove("hidden");
    setupAudioPreview(q.previewUrl);
  } else {
    audioPlayer.classList.add("hidden");
    stopAudioPreview();
    if (q.imageUrl) {
      questionArt.classList.remove("hidden");
      questionArt.classList.add("img-loading");
      questionArtImg.onload = () => questionArt.classList.remove("img-loading");
      questionArtImg.onerror = () => questionArt.classList.remove("img-loading");
      questionArtImg.src = q.imageUrl;
      questionArt.classList.toggle("is-blurred", q.imageMode === "blur");
    } else {
      questionArt.classList.add("hidden");
      questionArt.classList.remove("img-loading");
      questionArtImg.removeAttribute("src");
    }
  }

  q.options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    if (isSpectator) btn.disabled = true;
    btn.textContent = opt;
    btn.addEventListener("click", () => submitAnswer(i, btn));
    optionsGrid.appendChild(btn);
  });

  clearInterval(timerInterval);
  const startTs = Date.now();
  const durationMs = q.timeLimit * 1000;
  timerBar.style.width = "100%";
  timerBar.classList.remove("warning");
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, durationMs - (Date.now() - startTs));
    const fraction = remaining / durationMs;
    timerBar.style.width = `${fraction * 100}%`;
    timerBar.classList.toggle("warning", fraction < 0.3);
    if (remaining <= 0) clearInterval(timerInterval);
  }, 100);
});

socket.on("game:answerCount", ({ answered, total }) => {
  answerCountBadge.textContent = `${answered}/${total} risposto`;
  punch(answerCountBadge);
});

// ---------- STREAK MODE ----------
socket.on("streak:question", (q) => {
  myId = socket.id;
  hasAnswered = false;
  showScreen("game");
  standardTop.classList.remove("hidden");
  collabTop.classList.add("hidden");
  gameProgress.textContent = `🔥 Streak: ${q.streakCount}`;
  answerCountBadge.classList.add("hidden");
  gameType.textContent = TYPE_LABELS[q.type] || "Domanda";
  questionText.textContent = q.question;
  answerFeedback.textContent = "";
  optionsGrid.innerHTML = "";
  audioPlayer.classList.add("hidden");
  stopAudioPreview();
  if (q.imageUrl) {
    questionArt.classList.remove("hidden");
    questionArt.classList.add("img-loading");
    questionArtImg.onload = () => questionArt.classList.remove("img-loading");
    questionArtImg.onerror = () => questionArt.classList.remove("img-loading");
    questionArtImg.src = q.imageUrl;
    questionArt.classList.toggle("is-blurred", q.imageMode === "blur");
  } else {
    questionArt.classList.add("hidden");
    questionArt.classList.remove("img-loading");
    questionArtImg.removeAttribute("src");
  }
  q.options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.textContent = opt;
    btn.addEventListener("click", () => submitAnswer(i, btn));
    optionsGrid.appendChild(btn);
  });
  clearInterval(timerInterval);
  timerBar.style.width = "100%";
  timerBar.classList.remove("warning");
});

socket.on("streak:result", (data) => {
  [...optionsGrid.children].forEach((btn, i) => {
    if (i === data.correctIndex) btn.classList.add("correct");
    else if (btn.classList.contains("selected")) btn.classList.add("incorrect");
  });
  hapticFeedback(data.correct ? "correct" : "incorrect");
  questionArt.classList.remove("is-blurred");
  gameProgress.textContent = `🔥 Streak: ${data.streakCount}`;
  answerFeedback.textContent = data.correct
    ? `✔ Corretto! Streak: ${data.streakCount} 🔥`
    : `✘ Sbagliato. Streak interrotta. Record: ${data.bestStreak}`;
  announceNewBadges(data.newBadges);
});

function submitAnswer(choiceIndex, btn) {
  if (hasAnswered) return;
  hasAnswered = true;
  hapticFeedback("select");
  punch(btn);
  for (const b of optionsGrid.children) b.disabled = true;
  btn.classList.add("selected");
  answerFeedback.textContent = "Risposta inviata, in attesa del risultato...";
  socket.emit("answer:submit", { choiceIndex });
}

// ---------- ROUND RESULT ----------
const roundResultTitle = document.getElementById("round-result-title");
const roundCorrectAnswer = document.getElementById("round-correct-answer");
const collabWinnerText = document.getElementById("collab-winner-text");
const roundResultList = document.getElementById("round-result-list");
const nextRoundFill = document.getElementById("next-round-fill");
const nextRoundSeconds = document.getElementById("next-round-seconds");

socket.on("game:roundResult", (data) => {
  showScreen("roundResult");
  clearInterval(timerInterval);
  stopAudioPreview();
  questionArt.classList.remove("is-blurred");

  const correctOptionText = optionsGrid.children[data.correctIndex] ? optionsGrid.children[data.correctIndex].textContent : "";

  if (data.mode === "collab") {
    roundResultTitle.textContent = data.winnerNickname ? "Punto conquistato! 🎯" : "Tempo scaduto per questa domanda";
    collabWinnerText.classList.remove("hidden");
    collabWinnerText.textContent = data.winnerNickname
      ? `${data.winnerNickname} ha indovinato! +100 punti squadra`
      : "Nessuno ha indovinato in tempo.";
    roundResultList.innerHTML = "";
    collabScoreValue.textContent = data.teamScore;
    hapticFeedback(data.winnerNickname === myNickname ? "correct" : data.winnerNickname ? "select" : "incorrect");
  } else {
    collabWinnerText.classList.add("hidden");
    const myResult = data.players.find((p) => p.id === myId);
    const isDuelLike = data.mode === "duel" || data.mode === "tournament";

    if (isDuelLike && data.duelPlayers) {
      updateDuelScoreboard(data.duelPlayers);
    }

    if (isDuelLike && myResult) {
      hapticFeedback(myResult.correct ? "correct" : "incorrect");
      roundResultTitle.textContent = myResult.correct ? "✅ Punto tuo!" : "❌ Punto perso";
    } else {
      hapticFeedback(myResult && myResult.correct ? "correct" : "incorrect");
      roundResultTitle.textContent = data.mode === "tournament" ? "Round terminato!" : "Round terminato!";
    }

    const sorted = data.players.slice().sort((a, b) => b.score - a.score);
    roundResultList.innerHTML = "";
    sorted.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = p.correct ? "correct" : "incorrect";
      li.style.setProperty("--i", i);
      li.innerHTML = `<span>${p.correct ? "✅" : "❌"} ${escapeHtml(p.nickname)}</span><span class="points-pill">${p.correct ? "+" + p.delta : "0"} pt · ${p.score} tot</span>`;
      roundResultList.appendChild(li);
    });
  }

  roundCorrectAnswer.textContent = correctOptionText ? `✔ Risposta corretta: ${correctOptionText}` : "";
  if (optionsGrid.children.length) {
    [...optionsGrid.children].forEach((btn, i) => {
      if (i === data.correctIndex) btn.classList.add("correct");
      else if (btn.classList.contains("selected")) btn.classList.add("incorrect");
    });
  }

  const totalMs = data.nextInMs || 5000;
  nextRoundFill.style.transition = "none";
  nextRoundFill.style.width = "100%";
  nextRoundSeconds.textContent = Math.ceil(totalMs / 1000);
  requestAnimationFrame(() => {
    nextRoundFill.style.transition = `width ${totalMs}ms linear`;
    nextRoundFill.style.width = "0%";
  });

  clearInterval(countdownInterval);
  const startTs = Date.now();
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, totalMs - (Date.now() - startTs));
    nextRoundSeconds.textContent = Math.ceil(remaining / 1000);
    if (remaining <= 0) clearInterval(countdownInterval);
  }, 200);
});

// ---------- FINAL ----------
const finalList = document.getElementById("final-list");
const finalCollab = document.getElementById("final-collab");
const finalCollabScore = document.getElementById("final-collab-score");
const finalCollabContrib = document.getElementById("final-collab-contrib");
const btnPlayAgain = document.getElementById("btn-play-again");
const finalWaiting = document.getElementById("final-waiting");

socket.on("game:final", (data) => {
  showScreen("final");
  clearInterval(countdownInterval);
  stopAudioPreview();
  stopAmbient();
  finalLeaderboardBlock.classList.add("hidden");

  const isCollab = data.mode === "collab";
  finalList.classList.toggle("hidden", isCollab);
  finalCollab.classList.toggle("hidden", !isCollab);

  if (isCollab) {
    finalCollabScore.textContent = data.teamScore;
    finalCollabContrib.innerHTML = "";
    data.players
      .slice()
      .sort((a, b) => b.correctCount - a.correctCount)
      .forEach((p) => {
        const li = document.createElement("li");
        const initial = (p.nickname || "?").trim().charAt(0).toUpperCase() || "?";
        li.innerHTML = `<span class="avatar">${escapeHtml(initial)}</span><span class="p-name">${p.badge ? p.badge + " " : ""}${escapeHtml(p.nickname)}</span><span class="p-score">${p.correctCount} corrette</span>`;
        finalCollabContrib.appendChild(li);
      });

    lastFinalSummary = `🎤 Music Quiz — modalità Collaborativa: la squadra ha totalizzato ${data.teamScore} punti! 🤝`;
    if (data.teamScore >= 1000) {
      confettiBurst();
      showToast("🏆🔥 Squadra leggendaria! Affiatamento perfetto.", { variant: "gold", duration: 5500 });
    } else if (data.teamScore === 0) {
      showToast("😅 Zero punti di squadra... la prossima andrà meglio!", { variant: "bad", duration: 4500 });
    }
  } else {
    finalList.innerHTML = "";
    data.players.forEach((p, i) => {
      const li = document.createElement("li");
      li.style.setProperty("--i", i);
      li.innerHTML = `<span>${p.badge ? p.badge + " " : ""}${escapeHtml(p.nickname)}</span><span>${p.score} pt</span>`;
      finalList.appendChild(li);
      if (p.id === myId) announceNewBadges(p.newBadges);
    });

    const me = data.players.find((p) => p.id === myId);
    if (me) {
      const meta = MODE_META[data.mode] || MODE_META.classic;
      lastFinalSummary = `🎤 Music Quiz — ${me.score} punti in modalità ${meta.title}! Battimi se ci riesci 🔥`;
      lastResultCardData = {
        nickname: me.nickname || currentNickname(),
        score: me.score,
        correctCount: me.correctCount,
        totalRounds: data.totalRounds,
        mode: data.mode,
        category: data.category || "all",
        newBadges: me.newBadges || [],
      };
    }
    if (me && data.totalRounds > 0) {
      if (me.score === 0) {
        showToast(randomZeroScoreMessage(), { variant: "bad", duration: 5000 });
      } else if (me.correctCount === data.totalRounds) {
        confettiBurst(160);
        emojiRain("🐐", 5000);
        showToast("🏆🔥 PUNTEGGIO PERFETTO! Sei una leggenda assoluta!", { variant: "gold", duration: 6000 });
      }
    }
  }
  updateFinalControls();
  showRatingWidget();
});

function updateFinalControls() {
  btnPlayAgain.classList.toggle("hidden", !isHost);
  finalWaiting.classList.toggle("hidden", isHost);
}

btnPlayAgain.addEventListener("click", () => {
  socket.emit("room:playAgain");
});

// ---------- TORNEO ----------
const tRoundName = document.getElementById("tournament-round-name");
const tMatchLabel = document.getElementById("tournament-match-label");
const tFighterA = document.getElementById("t-fighter-a");
const tFighterB = document.getElementById("t-fighter-b");
const tNameA = document.getElementById("t-name-a");
const tNameB = document.getElementById("t-name-b");
const tRankA = document.getElementById("t-rank-a");
const tRankB = document.getElementById("t-rank-b");
const tResultBanner = document.getElementById("tournament-result-banner");
const tWinnerText = document.getElementById("tournament-winner-text");
const tLoserText = document.getElementById("tournament-loser-text");
const tHistory = document.getElementById("tournament-history");
const tHistoryList = document.getElementById("tournament-history-list");
const tCountdownBox = document.getElementById("tournament-countdown-box");
const tCountdownFill = document.getElementById("tournament-countdown-fill");
const tCountdownSec = document.getElementById("tournament-countdown-sec");
const tChampionBox = document.getElementById("tournament-champion-box");
const tChampionName = document.getElementById("tournament-champion-name");
const btnTournamentBack = document.getElementById("btn-tournament-back");
const btnTournamentPlayAgain = document.getElementById("btn-tournament-play-again");

function renderTournamentHistory(allResults) {
  if (!allResults || allResults.length === 0) { tHistory.classList.add("hidden"); return; }
  tHistory.classList.remove("hidden");
  tHistoryList.innerHTML = "";
  allResults.forEach((r, i) => {
    const li = document.createElement("li");
    li.style.setProperty("--i", i);
    const winnerName = r.winner === r.a ? r.nicknameA : r.nicknameB;
    const loserName = r.winner === r.a ? r.nicknameB : r.nicknameA;
    const scoreW = r.winner === r.a ? r.scoreA : r.scoreB;
    const scoreL = r.winner === r.a ? r.scoreB : r.scoreA;
    li.className = "correct";
    li.innerHTML = `<span>🏆 ${escapeHtml(winnerName)} · def. ${escapeHtml(loserName)}</span><span class="points-pill">${scoreW}–${scoreL}</span>`;
    tHistoryList.appendChild(li);
  });
}

socket.on("tournament:matchStart", (data) => {
  showScreen("tournament");
  clearInterval(countdownInterval);
  stopAudioPreview();

  tRoundName.textContent = `⚔️ ${data.roundName}`;
  tMatchLabel.textContent = `Match ${data.matchIndex} di ${data.totalMatches}`;
  tNameA.textContent = data.playerA.nickname;
  tNameB.textContent = data.playerB.nickname;
  tRankA.textContent = myId === data.playerA.id ? "Tu" : "Avversario";
  tRankB.textContent = myId === data.playerB.id ? "Tu" : "Avversario";
  tFighterA.classList.remove("winner", "loser");
  tFighterB.classList.remove("winner", "loser");

  tResultBanner.classList.add("hidden");
  tChampionBox.classList.add("hidden");
  tCountdownBox.classList.add("hidden");

  renderTournamentHistory(data.allResults);

  const isActive = myId === data.playerA.id || myId === data.playerB.id;
  showToast(isActive ? `⚔️ Tocca a te! ${data.playerA.nickname} vs ${data.playerB.nickname}` : `👁 ${data.playerA.nickname} vs ${data.playerB.nickname} — stai guardando`, { duration: 3500 });
});

socket.on("tournament:matchResult", (data) => {
  showScreen("tournament");
  clearInterval(countdownInterval);
  stopAudioPreview();

  tRoundName.textContent = `⚔️ ${data.roundName} — Risultato`;
  tMatchLabel.textContent = "";

  if (data.playerA) tNameA.textContent = data.playerA.nickname;
  if (data.playerB) tNameB.textContent = data.playerB.nickname;
  tRankA.textContent = data.playerA ? `${data.playerA.score} pt` : "";
  tRankB.textContent = data.playerB ? `${data.playerB.score} pt` : "";

  if (data.winner) {
    const winnerIsA = data.playerA && data.winner.id === data.playerA.id;
    tFighterA.classList.toggle("winner", winnerIsA);
    tFighterA.classList.toggle("loser", !winnerIsA);
    tFighterB.classList.toggle("winner", !winnerIsA);
    tFighterB.classList.toggle("loser", winnerIsA);
  }

  tResultBanner.classList.remove("hidden");
  tWinnerText.textContent = data.winner ? `🏆 ${data.winner.nickname} avanza al prossimo turno!` : "Pareggio — si avanza entrambi";
  tLoserText.textContent = data.loser ? `👋 ${data.loser.nickname} è eliminato` : "";

  renderTournamentHistory(data.allResults);

  if (myId === data.winner?.id) {
    hapticFeedback("correct");
    showToast("🏆 Hai vinto questo match! Avanti!", { variant: "gold", duration: 4000 });
  } else if (data.loser && myId === data.loser.id) {
    hapticFeedback("incorrect");
    showToast("😔 Eliminato. Continua a guardare!", { duration: 4000 });
  }

  const totalMs = 8000;
  tCountdownBox.classList.remove("hidden");
  tCountdownFill.style.transition = "none";
  tCountdownFill.style.width = "100%";
  tCountdownSec.textContent = "8";
  requestAnimationFrame(() => {
    tCountdownFill.style.transition = `width ${totalMs}ms linear`;
    tCountdownFill.style.width = "0%";
  });
  const startTs = Date.now();
  countdownInterval = setInterval(() => {
    const rem = Math.max(0, totalMs - (Date.now() - startTs));
    tCountdownSec.textContent = Math.ceil(rem / 1000);
    if (rem <= 0) clearInterval(countdownInterval);
  }, 200);
});

socket.on("tournament:champion", (data) => {
  showScreen("tournament");
  clearInterval(countdownInterval);
  stopAmbient();

  tRoundName.textContent = "🏆 Torneo concluso!";
  tMatchLabel.textContent = "";
  tResultBanner.classList.add("hidden");
  tCountdownBox.classList.add("hidden");
  tChampionBox.classList.remove("hidden");
  tChampionName.textContent = data.champion ? data.champion.nickname : "—";

  renderTournamentHistory(data.allResults);

  const amChampion = data.champion && myId === data.champion.id;
  if (amChampion) {
    confettiBurst(160);
    emojiRain("🏆", 5000);
    showToast("👑 SEI IL CAMPIONE DEL TORNEO!", { variant: "gold", duration: 6000 });
  } else {
    showToast(`🏆 ${data.champion?.nickname || "?"} è il campione del torneo!`, { duration: 5000 });
  }

  btnTournamentPlayAgain.classList.toggle("hidden", !isHost);
});

btnTournamentBack.addEventListener("click", leaveRoom);
btnTournamentPlayAgain.addEventListener("click", () => {
  socket.emit("room:playAgain");
});

// ---------- Pioggia emoji (easter egg punteggio perfetto) ----------
function emojiRain(emoji, durationMs = 5000) {
  const container = document.getElementById("confetti-container");
  const intervalId = setInterval(() => {
    const piece = document.createElement("div");
    piece.className = "emoji-rain-piece";
    piece.textContent = emoji;
    piece.style.left = `${Math.random() * 100}%`;
    const duration = 1800 + Math.random() * 1400;
    piece.style.animationDuration = `${duration}ms`;
    container.appendChild(piece);
    setTimeout(() => piece.remove(), duration + 200);
  }, 120);
  setTimeout(() => clearInterval(intervalId), durationMs);
}

const ZERO_SCORE_MESSAGES = [
  "💀 Zero punti... la musica forse non è il tuo genere. Riprova!",
  "😬 Tutte sbagliate. Forse è il momento di riascoltare qualche classico.",
  "🫠 Zero a zero, ma almeno hai partecipato. Ritenta!",
  "🎤 Microfono caduto, e pure il punteggio. Su, rifatti subito!",
  "📉 Score a terra. Anche i grandi hanno iniziato da zero (letteralmente).",
  "🙈 0 punti: hai giocato in Blind anche senza essere in modalità Blind?",
];
function randomZeroScoreMessage() {
  return ZERO_SCORE_MESSAGES[Math.floor(Math.random() * ZERO_SCORE_MESSAGES.length)];
}

let lastFinalSummary = "";
let lastResultCardData = null;

const resultCardModal = document.getElementById("result-card-modal");
const resultCardCanvas = document.getElementById("result-card-canvas");
const resultCardBackdrop = document.getElementById("result-card-backdrop");

function openResultCard() {
  if (!lastResultCardData) return;
  generateResultCard(lastResultCardData);
  resultCardModal.classList.remove("hidden");
}
function closeResultCard() {
  resultCardModal.classList.add("hidden");
}

async function generateResultCard(d) {
  const canvas = resultCardCanvas;
  const ctx = canvas.getContext("2d");
  const W = 900, H = 500;
  canvas.width = W;
  canvas.height = H;

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0a0612");
  bg.addColorStop(1, "#160b28");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Glow circles (decorative)
  const glow1 = ctx.createRadialGradient(W * 0.15, H * 0.3, 0, W * 0.15, H * 0.3, 260);
  glow1.addColorStop(0, "rgba(255,61,129,0.18)");
  glow1.addColorStop(1, "rgba(255,61,129,0)");
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);

  const glow2 = ctx.createRadialGradient(W * 0.85, H * 0.7, 0, W * 0.85, H * 0.7, 220);
  glow2.addColorStop(0, "rgba(124,58,237,0.22)");
  glow2.addColorStop(1, "rgba(124,58,237,0)");
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // Accent bar top
  const bar = ctx.createLinearGradient(0, 0, W, 0);
  bar.addColorStop(0, "#ff3d81");
  bar.addColorStop(1, "#7c3aed");
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, W, 5);

  // App label
  ctx.font = "bold 14px Inter, Arial, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "left";
  ctx.fillText("MUSIC QUIZ", 48, 50);

  // Mode chip
  const modeLabel = (MODE_META[d.mode] ? MODE_META[d.mode].icon + " " + MODE_META[d.mode].title : d.mode).toUpperCase();
  ctx.font = "bold 12px Inter, Arial, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.textAlign = "right";
  ctx.fillText(modeLabel, W - 48, 50);

  // Divider
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(48, 66);
  ctx.lineTo(W - 48, 66);
  ctx.stroke();

  // Score (big center)
  ctx.textAlign = "center";
  const scoreGrad = ctx.createLinearGradient(W / 2 - 120, 0, W / 2 + 120, 0);
  scoreGrad.addColorStop(0, "#ff3d81");
  scoreGrad.addColorStop(1, "#7c3aed");
  ctx.fillStyle = scoreGrad;
  ctx.font = "bold 110px Inter, Arial, sans-serif";
  ctx.fillText(d.score, W / 2, 230);

  // "punti" label under score
  ctx.font = "600 18px Inter, Arial, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("PUNTI", W / 2, 262);

  // Nickname
  ctx.font = "bold 32px Inter, Arial, sans-serif";
  ctx.fillStyle = "#f6f4fb";
  ctx.fillText(d.nickname, W / 2, 330);

  // Correct / total
  if (d.totalRounds > 0) {
    ctx.font = "500 16px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(`${d.correctCount} / ${d.totalRounds} corrette`, W / 2, 362);
  }

  // Category chip (if set)
  if (d.category && d.category !== "all") {
    const chipLabel = d.category.charAt(0).toUpperCase() + d.category.slice(1);
    ctx.font = "600 13px Inter, Arial, sans-serif";
    const chipW = ctx.measureText(chipLabel).width + 28;
    const chipX = W / 2 - chipW / 2;
    const chipY = 382;
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    roundRect(ctx, chipX, chipY, chipW, 26, 13);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText(chipLabel, W / 2, chipY + 18);
  }

  // Badges row
  if (d.newBadges && d.newBadges.length > 0) {
    const badgeY = 430;
    ctx.font = "600 13px Inter, Arial, sans-serif";
    ctx.fillStyle = "rgba(255,176,32,0.85)";
    const badgeTexts = d.newBadges.map((b) => (BADGE_META[b] ? BADGE_META[b].icon + " " + BADGE_META[b].label : b));
    const joined = badgeTexts.join("  ·  ");
    ctx.fillText(joined, W / 2, badgeY);
  }

  // Bottom accent bar
  const barB = ctx.createLinearGradient(0, 0, W, 0);
  barB.addColorStop(0, "#7c3aed");
  barB.addColorStop(1, "#ff3d81");
  ctx.fillStyle = barB;
  ctx.fillRect(0, H - 4, W, 4);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

resultCardBackdrop.addEventListener("click", closeResultCard);
document.getElementById("btn-close-card").addEventListener("click", closeResultCard);

document.getElementById("btn-download-card").addEventListener("click", () => {
  const a = document.createElement("a");
  a.download = "music-quiz-risultato.png";
  a.href = resultCardCanvas.toDataURL("image/png");
  a.click();
});

document.getElementById("btn-share-card").addEventListener("click", async () => {
  if (!navigator.share || !navigator.canShare) {
    document.getElementById("btn-download-card").click();
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      resultCardCanvas.toBlob(async (blob) => {
        if (!blob) { reject(new Error("blob fail")); return; }
        const file = new File([blob], "music-quiz-risultato.png", { type: "image/png" });
        if (!navigator.canShare({ files: [file] })) { reject(new Error("no file share")); return; }
        try {
          await navigator.share({ files: [file], title: "Music Quiz", text: lastFinalSummary || "Ho giocato a Music Quiz! 🎤🔥" });
          resolve();
        } catch (e) { reject(e); }
      }, "image/png");
    });
  } catch {
    document.getElementById("btn-download-card").click();
  }
});

// ---------- FINALE: classifica all-time + condividi ----------
const finalLeaderboardBlock = document.getElementById("final-leaderboard-block");
const finalLeaderboardList = document.getElementById("final-leaderboard-list");

document.getElementById("btn-view-leaderboard").addEventListener("click", () => {
  const isHidden = finalLeaderboardBlock.classList.contains("hidden");
  if (!isHidden) {
    finalLeaderboardBlock.classList.add("hidden");
    return;
  }
  socket.emit("home:data", { nickname: currentNickname() }, (res) => {
    // Show this mode's leaderboard if available, else global
    const mode = lastResultCardData?.mode;
    const modeBoard = mode && res.leaderboardsByMode?.[mode];
    const entries = modeBoard?.length ? modeBoard : (res.leaderboard || []);
    const modeLabel = mode && MODE_META[mode] ? ` — ${MODE_META[mode].title}` : "";
    finalLeaderboardBlock.querySelector("h3").textContent = `🏆 Top 10${modeLabel}`;
    renderLeaderboard(finalLeaderboardList, entries);
    finalLeaderboardBlock.classList.remove("hidden");
  });
});

document.getElementById("btn-share-result").addEventListener("click", () => {
  openResultCard();
});

// ---------- HOME: classifica per modalità + Daily Challenge ----------
const homeLeaderboardList = document.getElementById("home-leaderboard");
const dailyPlayedBadge = document.getElementById("daily-played-badge");
const dailyCountdownText = document.getElementById("daily-countdown-text");
let dailyResetInterval = null;
let cachedLeaderboardAll = [];
let cachedLeaderboardsByMode = {};
let activeLeaderboardTab = "all";

function renderLeaderboard(listEl, entries) {
  listEl.innerHTML = "";
  if (!entries || entries.length === 0) {
    const li = document.createElement("li");
    li.className = "hint empty-list-message";
    li.textContent = "Nessun punteggio ancora. Sii il primo!";
    listEl.appendChild(li);
    return;
  }
  entries.forEach((e) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(e.nickname)}</span><span>${e.score} pt</span>`;
    listEl.appendChild(li);
  });
}

// Leaderboard tab switching (home screen)
document.getElementById("lb-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".lb-tab");
  if (!btn) return;
  document.querySelectorAll(".lb-tab").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
  btn.classList.add("active");
  btn.setAttribute("aria-selected", "true");
  activeLeaderboardTab = btn.dataset.mode;
  const entries = activeLeaderboardTab === "all" ? cachedLeaderboardAll : (cachedLeaderboardsByMode[activeLeaderboardTab] || []);
  renderLeaderboard(homeLeaderboardList, entries);
});

function startDailyCountdown(msUntilReset) {
  clearInterval(dailyResetInterval);
  let remaining = msUntilReset;
  function render() {
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    dailyCountdownText.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  render();
  dailyResetInterval = setInterval(() => {
    remaining = Math.max(0, remaining - 1000);
    render();
    if (remaining <= 0) clearInterval(dailyResetInterval);
  }, 1000);
}

function refreshHomeData() {
  socket.emit("home:data", { nickname: currentNickname() }, (res) => {
    cachedLeaderboardAll = res.leaderboard || [];
    cachedLeaderboardsByMode = res.leaderboardsByMode || {};
    const entries = activeLeaderboardTab === "all" ? cachedLeaderboardAll : (cachedLeaderboardsByMode[activeLeaderboardTab] || []);
    renderLeaderboard(homeLeaderboardList, entries);
    dailyPlayedBadge.classList.toggle("hidden", !res.daily.playedToday);
    startDailyCountdown(res.daily.msUntilReset);
  });
}
refreshHomeData();

// ---------- PROFILO ----------
const CATEGORY_LABELS = { hiphop90: "Hip Hop 90s", hiphop2000: "Hip Hop 2000s", raptrap2010: "Rap/Trap 2010s", trapmodern: "Trap moderna", mixed: "Mista" };
const profileNicknameEl = document.getElementById("profile-nickname");
const statGames = document.getElementById("stat-games");
const statAccuracy = document.getElementById("stat-accuracy");
const statBestStreak = document.getElementById("stat-best-streak");
const statHighScore = document.getElementById("stat-high-score");
const statStrongest = document.getElementById("stat-strongest");
const statWeakest = document.getElementById("stat-weakest");
const profileBadgesEl = document.getElementById("profile-badges");

document.getElementById("btn-profile").addEventListener("click", () => {
  const nickname = currentNickname();
  if (!nickname) return showHomeError("Inserisci un nickname per vedere il profilo.");
  socket.emit("profile:get", { nickname }, (res) => {
    if (!res.ok) return;
    renderProfile(res.profile);
    showScreen("profile");
  });
});

function renderProfile(profile) {
  profileNicknameEl.textContent = profile.nickname;
  statGames.textContent = profile.gamesPlayed;
  statAccuracy.textContent = `${profile.accuracy}%`;
  statBestStreak.textContent = profile.bestStreak;
  statHighScore.textContent = profile.highScore;
  statStrongest.textContent = profile.strongestCategory ? CATEGORY_LABELS[profile.strongestCategory] || profile.strongestCategory : "Ancora da scoprire";
  statWeakest.textContent = profile.weakestCategory ? CATEGORY_LABELS[profile.weakestCategory] || profile.weakestCategory : "Ancora da scoprire";

  profileBadgesEl.innerHTML = "";
  Object.entries(BADGE_META).forEach(([id, meta]) => {
    const unlocked = profile.badges.includes(id);
    const div = document.createElement("div");
    div.className = "badge-item" + (unlocked ? " unlocked" : "");
    div.innerHTML = `<span class="badge-icon">${meta.icon}</span><span class="badge-label">${meta.label}</span>`;
    profileBadgesEl.appendChild(div);
  });
}

// ---------- DAILY CHALLENGE ----------
const btnDaily = document.getElementById("btn-daily");
const dailyProgress = document.getElementById("daily-progress");
const dailyArt = document.getElementById("daily-art");
const dailyArtImg = document.getElementById("daily-art-img");
const dailyQuestionText = document.getElementById("daily-question-text");
const dailyOptionsGrid = document.getElementById("daily-options-grid");
const dailyFeedback = document.getElementById("daily-feedback");
const dailyFinalScore = document.getElementById("daily-final-score");
const dailyLeaderboardList = document.getElementById("daily-leaderboard");
let dailyHasAnswered = false;
let dailyTotal = 10;

btnDaily.addEventListener("click", () => {
  ensureAudio();
  const nickname = currentNickname();
  if (!nickname) return showHomeError("Inserisci un nickname per giocare la Daily Challenge.");
  saveNickname(nickname);
  socket.emit("daily:start", { nickname }, (res) => {
    if (!res.ok) return;
    dailyTotal = res.total;
    showScreen("daily");
    renderDailyQuestion(res.question, res.total);
  });
});

function renderDailyQuestion(q, total) {
  dailyHasAnswered = false;
  dailyProgress.textContent = `${q.index + 1} / ${total}`;
  dailyQuestionText.textContent = q.question;
  dailyFeedback.textContent = "";
  dailyOptionsGrid.innerHTML = "";
  if (q.imageUrl) {
    dailyArt.classList.remove("hidden");
    dailyArt.classList.add("img-loading");
    dailyArtImg.onload = () => dailyArt.classList.remove("img-loading");
    dailyArtImg.onerror = () => dailyArt.classList.remove("img-loading");
    dailyArtImg.src = q.imageUrl;
    dailyArt.classList.toggle("is-blurred", q.imageMode === "blur");
  } else {
    dailyArt.classList.add("hidden");
    dailyArt.classList.remove("img-loading");
  }
  q.options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.textContent = opt;
    btn.addEventListener("click", () => submitDailyAnswer(i, btn));
    dailyOptionsGrid.appendChild(btn);
  });
}

function submitDailyAnswer(choiceIndex, btn) {
  if (dailyHasAnswered) return;
  dailyHasAnswered = true;
  hapticFeedback("select");
  punch(btn);
  for (const b of dailyOptionsGrid.children) b.disabled = true;
  btn.classList.add("selected");
  socket.emit("daily:answer", { choiceIndex }, (res) => {
    if (!res.ok) return;
    dailyArt.classList.remove("is-blurred");
    [...dailyOptionsGrid.children].forEach((b, i) => {
      if (i === res.correctIndex) b.classList.add("correct");
      else if (b.classList.contains("selected")) b.classList.add("incorrect");
    });
    hapticFeedback(res.correct ? "correct" : "incorrect");
    if (res.done) {
      setTimeout(() => finishDaily(res), 1200);
    } else {
      dailyFeedback.textContent = res.correct ? "✔ Corretto!" : "✘ Sbagliato";
      setTimeout(() => renderDailyQuestion(res.question, dailyTotal), 1200);
    }
  });
}

function finishDaily(res) {
  showScreen("dailyFinal");
  dailyFinalScore.textContent = res.finalScore;
  renderLeaderboard(dailyLeaderboardList, res.leaderboard);
  announceNewBadges(res.newBadges);
  lastFinalSummary = `📅 Music Quiz Daily Challenge — ${res.finalScore} punti (${res.correctCount}/${res.total} corrette)! 🔥`;
  if (res.correctCount === res.total) {
    confettiBurst(160);
    emojiRain("🐐", 5000);
    showToast("🏆🔥 PUNTEGGIO PERFETTO! Sei una leggenda assoluta!", { variant: "gold", duration: 6000 });
  } else if (res.finalScore === 0) {
    showToast(randomZeroScoreMessage(), { variant: "bad", duration: 5000 });
  }
}

document.getElementById("btn-daily-back").addEventListener("click", () => showScreen("home"));

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── FEEDBACK SYSTEM ──────────────────────────────────────────────────────────

async function sendFeedback(type, content) {
  try {
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, content }),
    });
  } catch {
    // fallisce silenziosamente — il feedback non è critico
  }
}

// --- Feedback FAB & Modal ---

const feedbackFab     = document.getElementById("feedback-fab");
const feedbackModal   = document.getElementById("feedback-modal");
const feedbackBackdrop = document.getElementById("feedback-backdrop");
const feedbackClose   = document.getElementById("feedback-close");
const feedbackSuccess = document.getElementById("feedback-success");
const bodyText = document.getElementById("feedback-body-text");
const bodyBug  = document.getElementById("feedback-body-bug");

let activeFeedbackTab = "text";

function openFeedbackModal() {
  feedbackModal.classList.remove("hidden");
  // aggiorna contesto bug in tempo reale
  const nick = getSavedNickname();
  document.getElementById("fb-ctx-screen").textContent = currentScreen;
  document.getElementById("fb-ctx-nick").textContent = nick || "—";
  document.getElementById("fb-ctx-mode").textContent = lastResultCardData?.mode || "—";
  // reset stato
  feedbackSuccess.classList.add("hidden");
  bodyText.classList.remove("hidden");
  bodyBug.classList.remove("hidden");
  switchFeedbackTab(activeFeedbackTab);
}

function closeFeedbackModal() {
  feedbackModal.classList.add("hidden");
}

function switchFeedbackTab(tab) {
  activeFeedbackTab = tab;
  document.querySelectorAll(".feedback-tab").forEach((btn) => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });
  bodyText.classList.toggle("hidden", tab !== "text");
  bodyBug.classList.toggle("hidden",  tab !== "bug");
  feedbackSuccess.classList.add("hidden");
}

function showFeedbackSuccess() {
  bodyText.classList.add("hidden");
  bodyBug.classList.add("hidden");
  feedbackSuccess.classList.remove("hidden");
  setTimeout(closeFeedbackModal, 2200);
}

feedbackFab.addEventListener("click", openFeedbackModal);
feedbackClose.addEventListener("click", closeFeedbackModal);
feedbackBackdrop.addEventListener("click", closeFeedbackModal);

document.querySelectorAll(".feedback-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchFeedbackTab(btn.dataset.tab));
});

// Contatori caratteri
function wireCounter(textareaId, countId) {
  const ta = document.getElementById(textareaId);
  const ct = document.getElementById(countId);
  ta.addEventListener("input", () => { ct.textContent = ta.value.length; });
}
wireCounter("feedback-text-input", "feedback-text-count");
wireCounter("feedback-bug-input",  "feedback-bug-count");

// Submit: testo libero
document.getElementById("feedback-submit-text").addEventListener("click", async () => {
  const msg = document.getElementById("feedback-text-input").value.trim();
  if (!msg) return;
  await sendFeedback("text", { message: msg });
  document.getElementById("feedback-text-input").value = "";
  document.getElementById("feedback-text-count").textContent = "0";
  showFeedbackSuccess();
});

// Submit: bug report
document.getElementById("feedback-submit-bug").addEventListener("click", async () => {
  const msg = document.getElementById("feedback-bug-input").value.trim();
  if (!msg) return;
  await sendFeedback("bug", {
    message: msg,
    screen:   currentScreen,
    nickname: getSavedNickname() || "—",
    mode:     lastResultCardData?.mode || "—",
    timestamp: new Date().toISOString(),
  });
  document.getElementById("feedback-bug-input").value = "";
  document.getElementById("feedback-bug-count").textContent = "0";
  showFeedbackSuccess();
});

// --- Rating widget post-partita ---

const ratingWidget = document.getElementById("rating-widget");
const ratingStarsEl = document.getElementById("rating-stars");
let ratingShownForGame = false;

function showRatingWidget() {
  ratingShownForGame = false;
  ratingWidget.classList.add("hidden");
  // Reset stelle
  document.querySelectorAll(".star-btn").forEach((b) => b.classList.remove("lit"));
  // Mostra dopo 1.5s con leggero delay per non sovrapporsi ai toast
  setTimeout(() => {
    ratingWidget.classList.remove("hidden");
  }, 1500);
}

// Hover: illumina stelle fino al target
ratingStarsEl.addEventListener("mouseover", (e) => {
  const btn = e.target.closest(".star-btn");
  if (!btn) return;
  const n = Number(btn.dataset.stars);
  document.querySelectorAll(".star-btn").forEach((b) => {
    b.classList.toggle("lit", Number(b.dataset.stars) <= n);
  });
});
ratingStarsEl.addEventListener("mouseleave", () => {
  if (!ratingShownForGame) {
    document.querySelectorAll(".star-btn").forEach((b) => b.classList.remove("lit"));
  }
});

// Click: invia valutazione
ratingStarsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".star-btn");
  if (!btn || ratingShownForGame) return;
  ratingShownForGame = true;
  const stars = Number(btn.dataset.stars);
  // Mantieni stelle illuminate
  document.querySelectorAll(".star-btn").forEach((b) => {
    b.classList.toggle("lit", Number(b.dataset.stars) <= stars);
  });
  await sendFeedback("rating", {
    stars,
    mode:     lastResultCardData?.mode     || "—",
    category: lastResultCardData?.category || "—",
    score:    lastResultCardData?.score    ?? null,
  });
  setTimeout(() => ratingWidget.classList.add("hidden"), 900);
});

document.getElementById("rating-skip").addEventListener("click", () => {
  ratingWidget.classList.add("hidden");
});
