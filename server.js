const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { CATEGORIES } = require("./data/questions");
const store = require("./data/store");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// iOS Safari proba questi path a root come fallback anche quando l'HTML ha link tag espliciti
const ICON_180 = path.join(__dirname, "public", "icons", "apple-touch-icon-180.png");
app.get("/apple-touch-icon.png", (_, res) => res.sendFile(ICON_180));
app.get("/apple-touch-icon-precomposed.png", (_, res) => res.sendFile(ICON_180));

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente 0/O/1/I per evitare ambiguità
const ARTWORK_TIMEOUT_MS = 4000;
const ALL_MODES = ["classic", "blitz", "blind", "collab", "audio", "mixed", "streak", "duel", "tournament", "daily"];
const ALLOWED_EMOJI = new Set(["🔥", "😂", "💀", "🐐", "😤", "🎯", "💩", "👍"]);
const DAILY_TIME_LIMIT = 15;
const DAILY_QUESTION_COUNT = 10;

const MODE_DEFAULTS = {
  classic: { timeLimit: 15, resultDelayMs: 5000 },
  blitz: { timeLimit: 10, resultDelayMs: 1200 },
  blind: { timeLimit: 15, resultDelayMs: 5000 },
  audio: { timeLimit: 20, resultDelayMs: 5000 },
  mixed: { timeLimit: 18, resultDelayMs: 5000 },
  collab: { questionTimeLimit: 8, resultDelayMs: 900 },
  streak: { resultDelayMs: 1500 },
  duel: { timeLimit: 12, resultDelayMs: 3500 },
  tournament: { timeLimit: 12, resultDelayMs: 3000 },
  lyrics: { timeLimit: 20, resultDelayMs: 5000 },
};

/** @type {Map<string, any>} */
const rooms = new Map();
const artworkCache = new Map();
/** @type {Map<string, any>} sessione daily challenge per socket.id */
const dailySessions = new Map();
let audioMixedCounter = 0;

// ---------- Metadati domande: id stabile + categoria + difficoltà euristica ----------
const TYPE_DIFFICULTY = {
  artist: "easy",
  lyric: "easy",
  year: "medium",
  album: "medium",
  nickname: "medium",
  feature: "hard",
  label: "hard",
};
for (const [catKey, cat] of Object.entries(CATEGORIES)) {
  cat.questions.forEach((q, i) => {
    q.id = `${catKey}#${i}`;
    q.categoryKey = catKey;
    q.difficulty = TYPE_DIFFICULTY[q.type] || "medium";
  });
}

// Pool di distrattori per le domande audio (artista, titolo, album)
const DISTRACTOR_POOLS = {};
for (const [catKey, cat] of Object.entries(CATEGORIES)) {
  const qs = cat.questions;
  DISTRACTOR_POOLS[catKey] = {
    artists: [...new Set(qs.filter((q) => q.art && q.art.artist).map((q) => q.art.artist))],
    tracks: [...new Set(qs.filter((q) => q.art && q.art.track).map((q) => q.art.track))],
    albums: [...new Set([
      ...qs.filter((q) => q.art && q.art.album).map((q) => q.art.album),
      ...qs.filter((q) => q.type === "album").flatMap((q) => q.options),
    ])],
  };
}
DISTRACTOR_POOLS.mixed = {
  artists: [...new Set(Object.values(DISTRACTOR_POOLS).flatMap((p) => p.artists))],
  tracks: [...new Set(Object.values(DISTRACTOR_POOLS).flatMap((p) => p.tracks))],
  albums: [...new Set(Object.values(DISTRACTOR_POOLS).flatMap((p) => p.albums))],
};

// ---------- Easter egg: nickname ----------
const CREATOR_NICKNAME = "giupy";
const ARTIST_EASTER_EGGS = {
  tupac: "🌹 RIP a una leggenda assoluta. West Side per sempre.",
  "2pac": "🌹 RIP a una leggenda assoluta. West Side per sempre.",
  eminem: "🎤 Sta già preparando 16 rime di fila, occhio ai punteggi.",
  "slim shady": "🎤 Sta già preparando 16 rime di fila, occhio ai punteggi.",
  drake: "🦉 Qualcuno chiami subito un featuring.",
  kendrick: "🦋 Silenzio tutti, parla il GOAT della West Coast.",
  "kendrick lamar": "🦋 Silenzio tutti, parla il GOAT della West Coast.",
  kanye: "👑 Ha già qualcosa da dire al microfono.",
  "kanye west": "👑 Ha già qualcosa da dire al microfono.",
  ye: "👑 Ha già qualcosa da dire al microfono.",
  travis: "🔥 SICKO MODE ACTIVATED",
  slatt: "💚 Young Thug approves",
  "never broke again": "⛓️ YoungBoy è entrato nella chat. Rispetto o niente.",
};

function detectEasterEgg(nickname) {
  const key = nickname.trim().toLowerCase();
  if (key === CREATOR_NICKNAME) {
    return { badge: "👑", toast: "👑 Il creatore è entrato nella chat" };
  }
  const line = ARTIST_EASTER_EGGS[key];
  if (line) return { badge: "🎵", toast: line.startsWith("🔥") || line.startsWith("💚") || line.startsWith("⛓️") ? line : `🎵 ${nickname} è entrato nella chat. ${line}` };
  return null;
}

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- PRNG seedato (per la Daily Challenge: stessa sequenza per tutti) ----------
function seededRandom(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}
function seededShuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickDistractors(correct, pool, count = 3) {
  const lower = correct.toLowerCase();
  const unique = [...new Set(pool)].filter((x) => x.toLowerCase() !== lower);
  return shuffle(unique).slice(0, count);
}

function generateWrongYears(correctYear) {
  const offsets = shuffle([-3, -2, -1, 1, 2, 3]);
  return offsets
    .map((o) => correctYear + o)
    .filter((y) => y >= 1985 && y <= 2025)
    .slice(0, 3)
    .map(String);
}

function categoryPool(category, hardOnly = false) {
  const pool = category === "mixed" ? Object.values(CATEGORIES).flatMap((c) => c.questions) : CATEGORIES[category] ? CATEGORIES[category].questions : [];
  if (hardOnly) {
    const hard = pool.filter((q) => q.difficulty === "hard");
    if (hard.length >= 3) return hard; // fallback al pool intero se troppo pochi quesiti "hard" per questa categoria
  }
  return pool;
}

function computeSpeedScore(elapsedMs, timeLimitMs) {
  const speedFraction = Math.max(0, 1 - elapsedMs / timeLimitMs);
  return Math.round(500 + 500 * speedFraction); // 500-1000 punti
}

// Normalizza un nome artista per il confronto: minuscolo, senza accenti/caratteri speciali
// (iTunes a volte cataloga "JAŸ-Z" invece di "Jay-Z"), senza l'articolo iniziale "the"
// (iTunes cataloga spesso "Fugees" invece di "The Fugees").
function normalizeArtistName(name) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

// Recupera cover art + preview audio da iTunes Search API (gratuita, nessuna chiave richiesta).
async function fetchArtwork(art) {
  if (!art) return { imageUrl: null, previewUrl: null };
  const entity = art.album ? "album" : "song";
  const term = art.album ? `${art.artist} ${art.album}` : `${art.artist} ${art.track}`;
  const cacheKey = `${entity}:${term.toLowerCase()}`;
  if (artworkCache.has(cacheKey)) return artworkCache.get(cacheKey);

  const result = { imageUrl: null, previewUrl: null, releaseYear: null, albumName: null };
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ARTWORK_TIMEOUT_MS);
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=5`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      const results = data.results || [];
      const wantedArtist = normalizeArtistName(art.artist);
      const match =
        results.find((r) => {
          if (!r.artistName) return false;
          const found = normalizeArtistName(r.artistName);
          return found.includes(wantedArtist) || wantedArtist.includes(found);
        }) || results[0];
      if (match) {
        if (match.artworkUrl100) result.imageUrl = match.artworkUrl100.replace(/\d+x\d+bb/, "600x600bb");
        if (match.previewUrl) result.previewUrl = match.previewUrl;
        if (match.releaseDate) result.releaseYear = new Date(match.releaseDate).getFullYear();
        if (match.collectionName) result.albumName = match.collectionName;
      }
    }
  } catch {
    // nessuna immagine/preview disponibile: chi chiama gestisce il fallback (skip silenzioso)
  }
  artworkCache.set(cacheKey, result);
  return result;
}

function randomizeOptions(q, rng = Math.random) {
  const order = shuffle0(q.options.map((_, i) => i), rng);
  return {
    type: q.type,
    question: q.question,
    options: order.map((i) => q.options[i]),
    correctIndex: order.indexOf(q.correctIndex),
    art: q.art || null,
    id: q.id,
    categoryKey: q.categoryKey,
    difficulty: q.difficulty,
  };
}
function shuffle0(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function materializeTextQuestion(raw, mode) {
  if (mode === "blind") {
    const q = randomizeOptions(raw);
    return { type: q.type, question: q.question, options: q.options, correctIndex: q.correctIndex, imageUrl: null, imageMode: "none", id: q.id, categoryKey: q.categoryKey, difficulty: q.difficulty };
  }
  const { imageUrl } = await fetchArtwork(raw.art);
  const q = randomizeOptions(raw);
  return {
    type: q.type,
    question: q.question,
    options: q.options,
    correctIndex: q.correctIndex,
    imageUrl,
    imageMode: !imageUrl ? "none" : q.type === "artist" ? "blur" : "plain",
    id: q.id,
    categoryKey: q.categoryKey,
    difficulty: q.difficulty,
  };
}

function makeAudioQuestion(raw, meta) {
  const correctArtist = raw.art.artist;
  const correctTrack = raw.art.track;
  const catKey = raw.categoryKey;
  const pool = DISTRACTOR_POOLS[catKey] || DISTRACTOR_POOLS.mixed;
  const fallback = DISTRACTOR_POOLS.mixed;

  function artistDistractors() {
    const d = pickDistractors(correctArtist, pool.artists);
    return d.length >= 3 ? d : pickDistractors(correctArtist, fallback.artists);
  }
  function trackDistractors() {
    const d = pickDistractors(correctTrack, pool.tracks);
    return d.length >= 3 ? d : pickDistractors(correctTrack, fallback.tracks);
  }
  function albumDistractors(correct) {
    const d = pickDistractors(correct, pool.albums);
    return d.length >= 3 ? d : pickDistractors(correct, fallback.albums);
  }

  const available = ["artist", "title", "mixed"];
  if (meta.releaseYear) available.push("year");
  if (meta.albumName) available.push("album");
  const audioType = available[Math.floor(Math.random() * available.length)];

  let type, question, options, correctIndex;

  switch (audioType) {
    case "artist": {
      const d = artistDistractors();
      if (d.length < 3) return null;
      const all = shuffle([correctArtist, ...d.slice(0, 3)]);
      type = "artist"; question = "🎧 Chi sta cantando in questo estratto?";
      options = all; correctIndex = all.indexOf(correctArtist);
      break;
    }
    case "title": {
      const d = trackDistractors();
      if (d.length < 3) return null;
      const all = shuffle([correctTrack, ...d.slice(0, 3)]);
      type = "lyric"; question = "🎧 Come si chiama questo brano?";
      options = all; correctIndex = all.indexOf(correctTrack);
      break;
    }
    case "year": {
      const wrongYears = generateWrongYears(meta.releaseYear);
      if (wrongYears.length < 3) return null;
      const all = shuffle([String(meta.releaseYear), ...wrongYears.slice(0, 3)]);
      type = "year"; question = "🎧 In che anno è uscito questo brano?";
      options = all; correctIndex = all.indexOf(String(meta.releaseYear));
      break;
    }
    case "album": {
      const d = albumDistractors(meta.albumName);
      if (d.length < 3) return null;
      const all = shuffle([meta.albumName, ...d.slice(0, 3)]);
      type = "album"; question = "🎧 Da quale album è tratto questo estratto?";
      options = all; correctIndex = all.indexOf(meta.albumName);
      break;
    }
    case "mixed": {
      audioMixedCounter++;
      if (audioMixedCounter % 2 === 0) {
        const d = trackDistractors();
        if (d.length < 3) return null;
        const all = shuffle([correctTrack, ...d.slice(0, 3)]);
        type = "lyric"; question = `🎧 ${correctArtist} — come si chiama questo brano?`;
        options = all; correctIndex = all.indexOf(correctTrack);
      } else {
        const d = artistDistractors();
        if (d.length < 3) return null;
        const all = shuffle([correctArtist, ...d.slice(0, 3)]);
        type = "artist"; question = `🎧 «${correctTrack}» — chi canta questo brano?`;
        options = all; correctIndex = all.indexOf(correctArtist);
      }
      break;
    }
    default: return null;
  }

  return { type, question, options, correctIndex, imageUrl: null, imageMode: "audio", previewUrl: meta.previewUrl, id: raw.id, categoryKey: raw.categoryKey, difficulty: raw.difficulty };
}

async function tryMaterializeAudioQuestion(raw) {
  const meta = await fetchArtwork(raw.art);
  if (!meta.previewUrl) return null; // skip silenzioso: nessuna preview disponibile su iTunes
  return makeAudioQuestion(raw, meta);
}

// ---------- Selezione adattiva ----------
// Pesa le domande in base a: 1) quanto il gruppo padroneggia quella categoria (favorisce domande
// "hard" se la conoscono bene, "easy" se sono in difficoltà) 2) penalità forte (non esclusione)
// per domande sbagliate di recente nella stessa stanza, finché non se ne vedono altre nuove.
function pickAdaptiveQuestions(pool, count, room) {
  if (!room || pool.length === 0) return shuffle(pool).slice(0, count);
  const profiles = Array.from(room.players.values())
    .map((p) => store.getProfile(p.nickname))
    .filter(Boolean);

  function categoryMastery(profile, categoryKey) {
    const stat = profile.categoryStats[categoryKey];
    if (!stat || stat.total < 3) return 0.5;
    return stat.correct / stat.total;
  }
  const recentGameIds = room.gameHistory ? new Set(room.gameHistory.flatMap((s) => [...s])) : new Set();

  function weightFor(q) {
    let penalty = 1;
    if (room.recentlyMissed && room.recentlyMissed.has(q.id)) {
      const ago = (room.roundsServed || 0) - room.recentlyMissed.get(q.id);
      if (ago < 8) penalty = 0.15;
    }
    // evita che le ultime 2 partite nella stessa stanza si ripetano troppo: così su 3 partite
    // consecutive la sovrapposizione resta sotto al 30% richiesto, salvo pool troppo piccoli.
    if (recentGameIds.has(q.id)) penalty *= 0.2;
    if (profiles.length === 0) return penalty;
    const avgMastery = profiles.reduce((sum, pr) => sum + categoryMastery(pr, q.categoryKey), 0) / profiles.length;
    let fit = 1;
    if (avgMastery > 0.7) fit = q.difficulty === "hard" ? 1.6 : q.difficulty === "easy" ? 0.5 : 1;
    else if (avgMastery < 0.4) fit = q.difficulty === "easy" ? 1.6 : q.difficulty === "hard" ? 0.5 : 1;
    return fit * penalty;
  }

  const candidates = pool.map((q) => ({ q, w: Math.max(0.02, weightFor(q)) }));
  const picked = [];
  const seenArtists = new Set();
  const seenSongKeys = new Set();
  const typeCounts = {};
  const n = Math.min(count, candidates.length);
  for (let i = 0; i < n; i++) {
    // Count how many times each type is already in the pick
    const typeFreq = {};
    for (const p of picked) typeFreq[p.type] = (typeFreq[p.type] || 0) + 1;
    const minFreq = picked.length === 0 ? 0 : Math.min(...Object.values(typeFreq));

    const adjusted = candidates.map((c) => {
      let w = c.w;
      const artist = c.q.art?.artist?.toLowerCase();
      const songKey = c.q.art?.track ? (artist + "|" + c.q.art.track.toLowerCase()) : null;
      // Strong penalty for repeating the same artist within first 15 questions
      if (artist && seenArtists.has(artist) && picked.length < 15) w *= 0.08;
      // Absolute block for same song (any question type about the exact same track)
      if (songKey && seenSongKeys.has(songKey)) w *= 0.01;
      // Boost underrepresented types for even distribution
      const tFreq = typeFreq[c.q.type] || 0;
      if (tFreq <= minFreq) w *= 1.5;
      return { ...c, w: Math.max(0.001, w) };
    });

    const totalW = adjusted.reduce((s, c) => s + c.w, 0);
    let r = Math.random() * totalW;
    let idx = adjusted.length - 1;
    for (let j = 0; j < adjusted.length; j++) {
      r -= adjusted[j].w;
      if (r <= 0) { idx = j; break; }
    }
    const chosen = candidates[idx].q;
    picked.push(chosen);
    candidates.splice(idx, 1);
    if (chosen.art?.artist) seenArtists.add(chosen.art.artist.toLowerCase());
    if (chosen.art?.track) seenSongKeys.add((chosen.art.artist?.toLowerCase() || "") + "|" + chosen.art.track.toLowerCase());
  }
  return picked;
}

async function buildStandardQuestionSet(category, count, mode, room, hardMode = false) {
  if (mode === "audio") {
    const candidates = shuffle(categoryPool(category, hardMode).filter((q) => q.art && q.art.artist && q.art.track));
    const picked = [];
    for (const raw of candidates) {
      if (picked.length >= count) break;
      const q = await tryMaterializeAudioQuestion(raw);
      if (q) picked.push(q);
    }
    return picked;
  }

  if (mode === "mixed") {
    const audioCandidates = shuffle(categoryPool(category, hardMode).filter((q) => q.art && q.art.artist && q.art.track));
    let audioPtr = 0;
    const textCandidates = pickAdaptiveQuestions(categoryPool(category, hardMode), count * 3, room);
    let textPtr = 0;
    const picked = [];
    for (let i = 0; i < count; i++) {
      let materialized = null;
      if (Math.random() < 0.45) {
        while (audioPtr < audioCandidates.length && !materialized) {
          materialized = await tryMaterializeAudioQuestion(audioCandidates[audioPtr++]);
        }
      }
      if (!materialized) {
        if (textPtr >= textCandidates.length) textPtr = 0;
        materialized = await materializeTextQuestion(textCandidates[textPtr++], "mixed");
      }
      picked.push(materialized);
    }
    return picked;
  }

  const rawPicks = pickAdaptiveQuestions(categoryPool(category, hardMode), count, room);
  return Promise.all(rawPicks.map((raw) => materializeTextQuestion(raw, mode)));
}

// ---------- Profili: statistiche e badge ----------
function recordAnswer(profile, categoryKey, questionId, correct) {
  profile.totalAnswers += 1;
  if (correct) profile.correctAnswers += 1;
  if (!profile.categoryStats[categoryKey]) profile.categoryStats[categoryKey] = { correct: 0, total: 0 };
  profile.categoryStats[categoryKey].total += 1;
  if (correct) profile.categoryStats[categoryKey].correct += 1;
  if (!profile.questionStats[questionId]) profile.questionStats[questionId] = { correct: 0, incorrect: 0 };
  if (correct) profile.questionStats[questionId].correct += 1;
  else profile.questionStats[questionId].incorrect += 1;
}

function trackModePlayed(profile, mode) {
  if (!profile.modesPlayed.includes(mode)) profile.modesPlayed.push(mode);
}

function checkBadges(profile, context = {}) {
  const unlocked = [];
  function award(id) {
    if (!profile.badges.includes(id)) {
      profile.badges.push(id);
      unlocked.push(id);
    }
  }
  award("first_login");
  if (context.justWon) award("first_win");
  if (context.streakReached >= 10 || profile.bestStreak >= 10) award("streak_10");
  if (context.perfectScore) award("perfect_score");
  if (ALL_MODES.every((m) => profile.modesPlayed.includes(m))) award("all_modes");
  return unlocked;
}

function strongestWeakestCategory(profile) {
  const entries = Object.entries(profile.categoryStats).filter(([, s]) => s.total >= 3);
  if (entries.length === 0) return { strongest: null, weakest: null };
  const withRate = entries.map(([key, s]) => ({ key, rate: s.correct / s.total }));
  withRate.sort((a, b) => b.rate - a.rate);
  return { strongest: withRate[0].key, weakest: withRate[withRate.length - 1].key };
}

function publicProfile(profile) {
  const { strongest, weakest } = strongestWeakestCategory(profile);
  return {
    nickname: profile.nickname,
    gamesPlayed: profile.gamesPlayed,
    correctAnswers: profile.correctAnswers,
    totalAnswers: profile.totalAnswers,
    accuracy: profile.totalAnswers > 0 ? Math.round((profile.correctAnswers / profile.totalAnswers) * 100) : 0,
    strongestCategory: strongest,
    weakestCategory: weakest,
    bestStreak: profile.bestStreak,
    highScore: profile.highScore,
    badges: profile.badges,
    modesPlayed: profile.modesPlayed,
  };
}

function publicRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    settings: room.settings,
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score,
      badge: p.badge || null,
      streakCount: p.streakCount || 0,
    })),
  };
}

function broadcastRoomState(room) {
  io.to(room.code).emit("room:update", publicRoomState(room));
}

function broadcastAnswerCount(room) {
  const activeIds = room.tournament?.activeIds;
  const total = activeIds ? activeIds.size : room.players.size;
  const answered = activeIds ? [...room.answers.keys()].filter((id) => activeIds.has(id)).length : room.answers.size;
  io.to(room.code).emit("game:answerCount", { answered, total });
}

function currentQuestion(room) {
  return room.questions[room.questionIndex];
}

function clearRoomTimers(room) {
  clearTimeout(room.timer);
  clearInterval(room.collabTickInterval);
  if (room.disconnectedPlayers) {
    room.disconnectedPlayers.forEach((p) => clearTimeout(p.disconnectTimer));
  }
}

// ---------- Modalità standard: classic / blitz / blind / audio / mixed ----------

function sendQuestion(room) {
  const q = currentQuestion(room);
  room.answers = new Map();
  room.questionStartTs = Date.now();
  room.roundsServed = (room.roundsServed || 0) + 1;
  const payload = {
    mode: room.settings.mode,
    index: room.questionIndex,
    total: room.questions.length,
    type: q.type,
    question: q.question,
    options: q.options,
    timeLimit: room.settings.timeLimit,
    imageUrl: q.imageUrl,
    imageMode: q.imageMode,
    previewUrl: q.previewUrl || null,
  };
  if (room.settings.mode === "duel") {
    payload.duelPlayers = Array.from(room.players.values()).map((p) => ({ id: p.id, nickname: p.nickname, score: p.score }));
  }
  if (room.settings.mode === "tournament" && room.tournament) {
    payload.duelPlayers = Array.from(room.players.values())
      .filter((p) => room.tournament.activeIds.has(p.id))
      .map((p) => ({ id: p.id, nickname: p.nickname, score: p.score }));
    payload.tournamentActiveIds = [...room.tournament.activeIds];
    payload.tournamentMatchInfo = room.tournament.matchInfo;
  }
  io.to(room.code).emit("game:question", payload);
  broadcastAnswerCount(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => finishRound(room), room.settings.timeLimit * 1000);
}

function finishRound(room) {
  if (room.state !== "playing") return;
  clearTimeout(room.timer);
  const q = currentQuestion(room);
  const activeIds = room.tournament?.activeIds || null;
  const results = [];
  let anyMissed = false;
  for (const p of room.players.values()) {
    const isActive = !activeIds || activeIds.has(p.id);
    const ans = room.answers.get(p.id);
    const correct = isActive && ans && ans.choiceIndex === q.correctIndex;
    if (isActive && !correct) anyMissed = true;
    let delta = 0;
    if (correct) {
      delta = computeSpeedScore(ans.elapsedMs, room.settings.timeLimit * 1000);
      p.score += delta;
      p.correctCount += 1;
    }
    if (isActive) {
      const profile = store.getProfile(p.nickname);
      if (profile) recordAnswer(profile, q.categoryKey || room.settings.category, q.id, correct);
      results.push({ id: p.id, nickname: p.nickname, correct: !!correct, delta, score: p.score, timeMs: ans ? ans.elapsedMs : null });
    }
  }
  store.saveProfiles();
  if (anyMissed) {
    if (!room.recentlyMissed) room.recentlyMissed = new Map();
    room.recentlyMissed.set(q.id, room.roundsServed || 0);
  }

  room.state = "round-result";
  const resultDelayMs = room.settings.resultDelayMs || 5000;
  const roundResultPayload = {
    mode: room.settings.mode,
    correctIndex: q.correctIndex,
    nextInMs: resultDelayMs,
    players: results,
  };
  if (room.settings.mode === "duel") {
    roundResultPayload.duelPlayers = Array.from(room.players.values()).map((p) => ({ id: p.id, nickname: p.nickname, score: p.score }));
  }
  if (room.settings.mode === "tournament") {
    roundResultPayload.duelPlayers = results.map((r) => ({ id: r.id, nickname: r.nickname, score: r.score }));
    roundResultPayload.tournamentRound = `${room.questionIndex + 1} / ${room.questions.length}`;
  }
  io.to(room.code).emit("game:roundResult", roundResultPayload);

  room.timer = setTimeout(() => {
    room.questionIndex += 1;
    if (room.questionIndex >= room.questions.length) {
      if (room.settings.mode === "tournament") {
        finishTournamentMatch(room);
      } else {
        finishStandardGame(room);
      }
    } else {
      room.state = "playing";
      sendQuestion(room);
    }
  }, resultDelayMs);
}

function finishStandardGame(room) {
  room.state = "finished";
  const totalRounds = room.questions.length;
  const sorted = Array.from(room.players.values()).sort((a, b) => b.score - a.score);
  const badgesByPlayer = {};
  sorted.forEach((p, i) => {
    const profile = store.getProfile(p.nickname);
    if (!profile) return;
    profile.gamesPlayed += 1;
    if (p.score > profile.highScore) profile.highScore = p.score;
    trackModePlayed(profile, room.settings.mode);
    const justWon = i === 0 && room.players.size > 1 && p.score > 0;
    const perfectScore = totalRounds > 0 && p.correctCount === totalRounds;
    badgesByPlayer[p.id] = checkBadges(profile, { justWon, perfectScore });
    if (p.score > 0) {
      store.submitToLeaderboard({ nickname: p.nickname, score: p.score, mode: room.settings.mode, category: room.settings.category, achievedAt: Date.now() });
    }
  });
  store.saveProfiles();

  const final = sorted.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    score: p.score,
    correctCount: p.correctCount,
    badge: p.badge || null,
    newBadges: badgesByPlayer[p.id] || [],
  }));
  io.to(room.code).emit("game:final", { mode: room.settings.mode, category: room.settings.category, totalRounds, players: final });
}

function maybeFinishRoundEarly(room) {
  const activeIds = room.tournament?.activeIds;
  const total = activeIds ? activeIds.size : room.players.size;
  const answered = activeIds ? [...room.answers.keys()].filter((id) => activeIds.has(id)).length : room.answers.size;
  if (total > 0 && answered >= total) finishRound(room);
}

// ---------- Modalità Torneo ----------

function getTournamentRoundName(remaining) {
  if (remaining <= 2) return "Finale";
  if (remaining <= 4) return "Semifinale";
  if (remaining <= 8) return "Quarti di finale";
  return "Turno";
}

function startTournament(room) {
  const playerIds = shuffle([...room.players.keys()]);
  room.tournament = {
    remaining: playerIds,
    eliminated: [],
    currentRound: null,
    currentMatchIdx: 0,
    roundMatchResults: [],
    allResults: [],
    activeIds: null,
    matchInfo: null,
  };
  room.state = "playing";
  broadcastRoomState(room);
  startNextTournamentMatch(room);
}

async function startNextTournamentMatch(room) {
  const t = room.tournament;

  // Se il round corrente non esiste o è esaurito, genera le coppie del prossimo round
  if (!t.currentRound || t.currentMatchIdx >= t.currentRound.length) {
    if (t.remaining.length <= 1) {
      endTournament(room, t.remaining[0] || null);
      return;
    }
    const shuffled = shuffle([...t.remaining]);
    t.currentRound = [];
    for (let i = 0; i < shuffled.length; i += 2) {
      if (shuffled[i + 1]) t.currentRound.push({ a: shuffled[i], b: shuffled[i + 1] });
    }
    t.currentMatchIdx = 0;
    t.roundMatchResults = [];
  }

  const match = t.currentRound[t.currentMatchIdx];
  t.activeIds = new Set([match.a, match.b]);

  const pa = room.players.get(match.a);
  const pb = room.players.get(match.b);
  if (!pa || !pb) {
    // Un giocatore si è disconnesso: avanza automaticamente l'altro
    const survivor = room.players.get(match.a) ? match.a : match.b;
    t.roundMatchResults.push({ a: match.a, b: match.b, winner: survivor });
    t.allResults.push({ a: match.a, b: match.b, winner: survivor, roundName: getTournamentRoundName(t.remaining.length) });
    t.currentMatchIdx++;
    if (rooms.has(room.code)) startNextTournamentMatch(room);
    return;
  }

  // Reset punteggi per questo match
  pa.score = 0; pa.correctCount = 0;
  pb.score = 0; pb.correctCount = 0;
  room.answers = new Map();

  const roundName = getTournamentRoundName(t.remaining.length);
  t.matchInfo = { roundName, playerA: { id: pa.id, nickname: pa.nickname }, playerB: { id: pb.id, nickname: pb.nickname } };

  io.to(room.code).emit("tournament:matchStart", {
    roundName,
    playerA: { id: pa.id, nickname: pa.nickname },
    playerB: { id: pb.id, nickname: pb.nickname },
    matchIndex: t.currentMatchIdx + 1,
    totalMatches: t.currentRound.length,
    allResults: t.allResults,
    eliminated: t.eliminated.map((id) => { const p = room.players.get(id); return p ? p.nickname : id; }),
  });

  room.state = "loading";
  broadcastRoomState(room);

  const questions = await buildStandardQuestionSet(room.settings.category, 10, "duel", room, false);
  if (!rooms.has(room.code)) return;

  room.questions = questions;
  room.questionIndex = 0;
  room.roundsServed = 0;
  room.state = "playing";
  broadcastRoomState(room);

  room.timer = setTimeout(() => {
    if (rooms.has(room.code) && room.state === "playing") sendQuestion(room);
  }, 3000);
}

function finishTournamentMatch(room) {
  const t = room.tournament;
  const match = t.currentRound[t.currentMatchIdx];
  const pa = room.players.get(match.a);
  const pb = room.players.get(match.b);
  const scoreA = pa ? pa.score : 0;
  const scoreB = pb ? pb.score : 0;

  const winner = scoreA >= scoreB ? pa : pb;
  const loser = scoreA >= scoreB ? pb : pa;
  const roundName = getTournamentRoundName(t.remaining.length);

  t.roundMatchResults.push({ a: match.a, b: match.b, winner: winner?.id, scoreA, scoreB });
  t.allResults.push({ a: match.a, b: match.b, winner: winner?.id, scoreA, scoreB, roundName,
    nicknameA: pa?.nickname || "?", nicknameB: pb?.nickname || "?" });

  if (loser) t.eliminated.push(loser.id);

  room.state = "round-result";
  io.to(room.code).emit("tournament:matchResult", {
    roundName,
    playerA: pa ? { id: pa.id, nickname: pa.nickname, score: scoreA } : null,
    playerB: pb ? { id: pb.id, nickname: pb.nickname, score: scoreB } : null,
    winner: winner ? { id: winner.id, nickname: winner.nickname } : null,
    loser: loser ? { id: loser.id, nickname: loser.nickname } : null,
    allResults: t.allResults,
  });

  t.currentMatchIdx++;
  const delay = 8000;

  room.timer = setTimeout(async () => {
    if (!rooms.has(room.code)) return;
    // Aggiorna remaining dopo questo match
    if (t.currentMatchIdx >= t.currentRound.length) {
      // Fine round, aggiorna remaining
      const winners = t.roundMatchResults.map((r) => r.winner).filter(Boolean);
      t.remaining = winners;
      t.currentRound = null;
    }
    if (t.remaining.length <= 1) {
      endTournament(room, t.remaining[0] || null);
    } else {
      startNextTournamentMatch(room);
    }
  }, delay);
}

function endTournament(room, championId) {
  room.state = "finished";
  const champion = championId ? room.players.get(championId) : null;
  const t = room.tournament;

  for (const p of room.players.values()) {
    const profile = store.getProfile(p.nickname);
    if (!profile) continue;
    profile.gamesPlayed += 1;
    trackModePlayed(profile, "tournament");
    if (champion && p.id === champion.id) {
      checkBadges(profile, { justWon: true });
    }
  }
  store.saveProfiles();

  io.to(room.code).emit("tournament:champion", {
    champion: champion ? { id: champion.id, nickname: champion.nickname } : null,
    allResults: t?.allResults || [],
    players: Array.from(room.players.values()).map((p) => ({ id: p.id, nickname: p.nickname })),
  });
}

// ---------- Modalità collaborativa ----------

function startCollabGame(room) {
  room.collabPool = shuffle(categoryPool(room.settings.category));
  room.collabPoolIndex = 0;
  room.teamScore = 0;
  room.collabAttempted = new Set();
  for (const p of room.players.values()) {
    p.score = 0;
    p.correctCount = 0;
    const profile = store.getProfile(p.nickname);
    if (profile) trackModePlayed(profile, "collab");
  }
  store.saveProfiles();

  room.state = "playing";
  room.collabDeadline = Date.now() + room.settings.duration * 1000;
  broadcastRoomState(room);

  clearInterval(room.collabTickInterval);
  room.collabTickInterval = setInterval(() => {
    const remainingMs = room.collabDeadline - Date.now();
    if (remainingMs <= 0) {
      finishCollabGame(room);
      return;
    }
    io.to(room.code).emit("game:collabTick", { remainingMs });
  }, 1000);

  sendCollabQuestion(room);
}

async function sendCollabQuestion(room) {
  if (Date.now() >= room.collabDeadline) return finishCollabGame(room);
  if (room.collabPoolIndex >= room.collabPool.length) {
    room.collabPool = shuffle(room.collabPool);
    room.collabPoolIndex = 0;
  }
  const q = randomizeOptions(room.collabPool[room.collabPoolIndex++]);
  const { imageUrl } = await fetchArtwork(q.art);

  const stillCurrent = rooms.get(room.code) === room && room.state === "playing";
  if (!stillCurrent) return;
  if (Date.now() >= room.collabDeadline) return finishCollabGame(room);

  room.collabCurrent = q;
  room.collabAttempted = new Set();
  room.questionStartTs = Date.now();
  const timeLimit = MODE_DEFAULTS.collab.questionTimeLimit;
  io.to(room.code).emit("game:question", {
    mode: "collab",
    type: q.type,
    question: q.question,
    options: q.options,
    timeLimit,
    imageUrl,
    imageMode: imageUrl ? (q.type === "artist" ? "blur" : "plain") : "none",
    teamScore: room.teamScore,
    remainingMs: room.collabDeadline - Date.now(),
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveCollabRound(room, null), timeLimit * 1000);
}

function resolveCollabRound(room, winner) {
  clearTimeout(room.timer);
  const q = room.collabCurrent;
  if (!q) return;
  room.collabCurrent = null;
  if (winner) {
    room.teamScore += 100;
    winner.correctCount += 1;
  }
  io.to(room.code).emit("game:roundResult", {
    mode: "collab",
    correctIndex: q.correctIndex,
    teamScore: room.teamScore,
    winnerNickname: winner ? winner.nickname : null,
    nextInMs: MODE_DEFAULTS.collab.resultDelayMs,
  });

  room.timer = setTimeout(() => {
    if (Date.now() >= room.collabDeadline) finishCollabGame(room);
    else sendCollabQuestion(room);
  }, MODE_DEFAULTS.collab.resultDelayMs);
}

function finishCollabGame(room) {
  clearRoomTimers(room);
  room.state = "finished";
  const players = Array.from(room.players.values()).map((p) => ({ id: p.id, nickname: p.nickname, correctCount: p.correctCount, badge: p.badge || null }));
  io.to(room.code).emit("game:final", { mode: "collab", teamScore: room.teamScore, players });
}

// ---------- Modalità Streak (ritmo libero, individuale, nessun timer) ----------

function startStreakForPlayer(room, player) {
  player.streakCount = 0;
  player.streakPool = shuffle(categoryPool(room.settings.category));
  player.streakPoolIndex = 0;
  const profile = store.getProfile(player.nickname);
  if (profile) {
    trackModePlayed(profile, "streak");
    store.saveProfiles();
  }
  sendStreakQuestion(room, player);
}

async function sendStreakQuestion(room, player) {
  if (player.streakPoolIndex >= player.streakPool.length) {
    player.streakPool = shuffle(player.streakPool);
    player.streakPoolIndex = 0;
  }
  const raw = player.streakPool[player.streakPoolIndex++];
  const materialized = await materializeTextQuestion(raw, "streak");
  const socket = io.sockets.sockets.get(player.id);
  if (!socket || !rooms.has(room.code)) return;
  player.streakCurrent = materialized;
  player.streakStartTs = Date.now();
  socket.emit("streak:question", {
    question: materialized.question,
    options: materialized.options,
    type: materialized.type,
    imageUrl: materialized.imageUrl,
    imageMode: materialized.imageMode,
    streakCount: player.streakCount,
  });
}

function handleStreakAnswer(room, player, choiceIndex) {
  const q = player.streakCurrent;
  if (!q) return;
  player.streakCurrent = null;
  const correct = choiceIndex === q.correctIndex;
  const profile = store.getProfile(player.nickname);
  if (profile) {
    recordAnswer(profile, q.categoryKey, q.id, correct);
    if (correct) player.streakCount += 1;
    else player.streakCount = 0;
    if (player.streakCount > profile.bestStreak) profile.bestStreak = player.streakCount;
    const newBadges = checkBadges(profile, { streakReached: player.streakCount });
    store.saveProfiles();

    const socket = io.sockets.sockets.get(player.id);
    if (socket) {
      socket.emit("streak:result", { correct, correctIndex: q.correctIndex, streakCount: player.streakCount, bestStreak: profile.bestStreak, newBadges });
    }
  }
  broadcastRoomState(room);

  setTimeout(() => {
    if (rooms.has(room.code) && room.players.has(player.id)) sendStreakQuestion(room, player);
  }, MODE_DEFAULTS.streak.resultDelayMs);
}

// ---------- Daily Challenge (solo, fuori dal sistema di stanze) ----------

async function buildDailyQuestionSet() {
  const dateKey = store.todayKey();
  const rng = seededRandom(seedFromString(dateKey));
  const pool = categoryPool("mixed");
  const picked = seededShuffle(pool, rng).slice(0, DAILY_QUESTION_COUNT);
  const materialized = [];
  for (const raw of picked) {
    const q = randomizeOptions(raw, rng);
    const { imageUrl } = await fetchArtwork(raw.art);
    materialized.push({
      type: q.type,
      question: q.question,
      options: q.options,
      correctIndex: q.correctIndex,
      imageUrl,
      imageMode: !imageUrl ? "none" : q.type === "artist" ? "blur" : "plain",
      id: q.id,
      categoryKey: q.categoryKey,
    });
  }
  return materialized;
}

// ---------- Gestione connessioni ----------

io.on("connection", (socket) => {
  socket.on("room:create", ({ nickname, mode }, cb) => {
    const code = generateRoomCode();
    const cleanName = cleanNickname(nickname);
    const egg = detectEasterEgg(cleanName);
    const safeMode = MODE_DEFAULTS[mode] ? mode : "classic";
    const defaults = MODE_DEFAULTS[safeMode];
    const profile = store.getProfile(cleanName);
    const newBadges = checkBadges(profile);
    store.saveProfiles();

    const room = {
      code,
      hostId: socket.id,
      state: "lobby",
      settings: {
        mode: safeMode,
        category: "mixed",
        rounds: 10,
        timeLimit: defaults.timeLimit || 15,
        duration: 90,
        resultDelayMs: defaults.resultDelayMs,
      },
      players: new Map(),
      questions: [],
      questionIndex: 0,
      answers: new Map(),
      timer: null,
      collabTickInterval: null,
      questionStartTs: 0,
      roundsServed: 0,
    };
    room.players.set(socket.id, { id: socket.id, nickname: cleanName, score: 0, correctCount: 0, badge: egg ? egg.badge : null, streakCount: 0 });
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, room: publicRoomState(room), newBadges });
    if (egg) io.to(code).emit("room:toast", { message: egg.toast });
  });

  socket.on("room:join", ({ code, nickname }, cb) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return cb({ ok: false, error: "Stanza non trovata." });
    const cleanName = cleanNickname(nickname);

    // Riconnessione durante una partita in corso
    if (room.disconnectedPlayers && room.disconnectedPlayers.has(cleanName.toLowerCase())) {
      const player = room.disconnectedPlayers.get(cleanName.toLowerCase());
      clearTimeout(player.disconnectTimer);
      room.disconnectedPlayers.delete(cleanName.toLowerCase());
      player.id = socket.id;
      room.players.set(socket.id, player);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      io.to(room.code).emit("room:toast", { message: `✅ ${cleanName} è rientrato in partita!` });
      broadcastRoomState(room);
      return cb({ ok: true, rejoined: true, room: publicRoomState(room) });
    }

    if (room.state !== "lobby") return cb({ ok: false, error: "Partita già in corso." });
    if (room.settings.mode === "duel" && room.players.size >= 2) return cb({ ok: false, error: "Sfida 1v1: stanza al completo (max 2 giocatori)." });
    if (room.settings.mode === "tournament" && room.players.size >= 8) return cb({ ok: false, error: "Torneo: max 8 giocatori." });
    const egg = detectEasterEgg(cleanName);
    const profile = store.getProfile(cleanName);
    const newBadges = checkBadges(profile);
    store.saveProfiles();
    room.players.set(socket.id, { id: socket.id, nickname: cleanName, score: 0, correctCount: 0, badge: egg ? egg.badge : null, streakCount: 0 });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    cb({ ok: true, room: publicRoomState(room), newBadges });
    broadcastRoomState(room);
    if (egg) io.to(room.code).emit("room:toast", { message: egg.toast });
  });

  socket.on("room:start", async (settings) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;

    const mode = room.settings.mode;
    const isValidCategory = settings.category === "mixed" || Boolean(CATEGORIES[settings.category]);
    const category = isValidCategory ? settings.category : "mixed";

    if (mode === "duel") {
      if (room.players.size !== 2) {
        io.to(room.code).emit("room:toast", { message: "⚠️ La sfida 1v1 richiede esattamente 2 giocatori." });
        return;
      }
      for (const p of room.players.values()) { p.score = 0; p.correctCount = 0; }
    }

    if (mode === "tournament") {
      if (room.players.size < 2) {
        io.to(room.code).emit("room:toast", { message: "⚠️ Il torneo richiede almeno 2 giocatori." });
        return;
      }
      if (room.players.size % 2 !== 0) {
        io.to(room.code).emit("room:toast", { message: "⚠️ Il torneo richiede un numero pari di giocatori (2, 4 o 8)." });
        return;
      }
      const defaults = MODE_DEFAULTS.tournament;
      room.settings = { ...room.settings, category, rounds: 10, timeLimit: defaults.timeLimit, resultDelayMs: defaults.resultDelayMs };
      startTournament(room);
      return;
    }

    if (mode === "collab") {
      const duration = Math.min(180, Math.max(30, parseInt(settings.duration, 10) || 90));
      room.settings = { ...room.settings, category, duration };
      startCollabGame(room);
      return;
    }

    if (mode === "streak") {
      room.settings = { ...room.settings, category };
      room.state = "playing";
      broadcastRoomState(room);
      for (const p of room.players.values()) startStreakForPlayer(room, p);
      return;
    }

    const defaults = MODE_DEFAULTS[mode] || MODE_DEFAULTS.classic;
    const rounds = Math.min(20, Math.max(3, parseInt(settings.rounds, 10) || 10));
    const timeLimit =
      mode === "blitz" || mode === "audio" ? defaults.timeLimit : Math.min(30, Math.max(5, parseInt(settings.timeLimit, 10) || defaults.timeLimit));
    room.settings = { ...room.settings, category, rounds, timeLimit, resultDelayMs: defaults.resultDelayMs };

    room.settings.hardMode = Boolean(settings.hardMode);
    room.state = "loading";
    broadcastRoomState(room);

    const questions = await buildStandardQuestionSet(category, rounds, mode, room, room.settings.hardMode);

    const stillExists = rooms.get(socket.data.roomCode) === room;
    if (!stillExists || room.state !== "loading") return;
    if (questions.length === 0) {
      room.state = "lobby";
      broadcastRoomState(room);
      io.to(room.code).emit("room:toast", { message: "⚠️ Nessuna domanda disponibile per questa combinazione, riprova." });
      return;
    }

    room.questions = questions;
    room.questionIndex = 0;
    room.roundsServed = 0;
    room.state = "playing";
    room.gameHistory = room.gameHistory || [];
    room.gameHistory.push(new Set(questions.map((q) => q.id)));
    if (room.gameHistory.length > 2) room.gameHistory.shift();
    for (const p of room.players.values()) {
      p.score = 0;
      p.correctCount = 0;
    }
    broadcastRoomState(room);
    sendQuestion(room);
  });

  socket.on("answer:submit", ({ choiceIndex }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== "playing") return;

    if (room.settings.mode === "streak") {
      const player = room.players.get(socket.id);
      if (player) handleStreakAnswer(room, player, choiceIndex);
      return;
    }

    if (room.settings.mode === "collab") {
      if (!room.collabCurrent || room.collabAttempted.has(socket.id)) return;
      const player = room.players.get(socket.id);
      if (!player) return;
      if (choiceIndex === room.collabCurrent.correctIndex) {
        resolveCollabRound(room, player);
      } else {
        room.collabAttempted.add(socket.id);
        socket.emit("answer:ack");
        if (room.collabAttempted.size >= room.players.size) resolveCollabRound(room, null);
      }
      return;
    }

    if (room.tournament?.activeIds && !room.tournament.activeIds.has(socket.id)) return;
    if (room.answers.has(socket.id)) return;
    const elapsedMs = Date.now() - room.questionStartTs;
    room.answers.set(socket.id, { choiceIndex, elapsedMs });
    socket.emit("answer:ack");
    broadcastAnswerCount(room);
    maybeFinishRoundEarly(room);
  });

  socket.on("room:playAgain", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    clearRoomTimers(room);
    room.state = "lobby";
    room.questionIndex = 0;
    room.questions = [];
    room.teamScore = 0;
    room.tournament = null;
    for (const p of room.players.values()) {
      p.score = 0;
      p.correctCount = 0;
      p.streakCount = 0;
    }
    broadcastRoomState(room);
  });

  socket.on("room:leave", () => removePlayerFromRoom(socket));
  socket.on("disconnect", () => removePlayerFromRoom(socket));

  // ---------- Reaction emoji ----------
  socket.on("reaction:send", ({ emoji }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !ALLOWED_EMOJI.has(emoji)) return;
    const now = Date.now();
    const recent = (socket.data.reactionTimestamps || []).filter((t) => now - t < 10000);
    if (recent.length >= 2) return; // max 2 ogni 10 secondi
    recent.push(now);
    socket.data.reactionTimestamps = recent;
    const player = room.players.get(socket.id);
    socket.to(room.code).emit("reaction:incoming", { emoji, nickname: player ? player.nickname : "?" });
  });

  // ---------- Profilo ----------
  socket.on("profile:get", ({ nickname }, cb) => {
    const profile = store.getProfile(nickname);
    if (!profile) return cb({ ok: false });
    cb({ ok: true, profile: publicProfile(profile) });
  });

  // ---------- Home data: leaderboard globale + stato daily ----------
  socket.on("home:data", ({ nickname }, cb) => {
    const playedToday = nickname ? store.hasPlayedToday(nickname) : false;
    cb({
      leaderboard: store.getLeaderboard(),
      leaderboardsByMode: store.getLeaderboardsByMode(),
      daily: {
        playedToday,
        msUntilReset: msUntilMidnight(),
        topToday: store.getDailyBoard().slice(0, 10),
      },
    });
  });

  // ---------- Daily Challenge ----------
  socket.on("daily:start", async ({ nickname }, cb) => {
    const cleanName = cleanNickname(nickname);
    const questions = await buildDailyQuestionSet();
    const session = { nickname: cleanName, questions, index: 0, score: 0, correctCount: 0, startTs: Date.now() };
    dailySessions.set(socket.id, session);
    const profile = store.getProfile(cleanName);
    trackModePlayed(profile, "daily");
    store.saveProfiles();
    const q = questions[0];
    session.questionStartTs = Date.now();
    cb({
      ok: true,
      alreadyPlayedBest: store.getDailyBoard().find((e) => store.normalizeNickname(e.nickname) === store.normalizeNickname(cleanName)) || null,
      total: questions.length,
      timeLimit: DAILY_TIME_LIMIT,
      question: { index: 0, type: q.type, question: q.question, options: q.options, imageUrl: q.imageUrl, imageMode: q.imageMode },
    });
  });

  socket.on("daily:answer", ({ choiceIndex }, cb) => {
    const session = dailySessions.get(socket.id);
    if (!session) return cb({ ok: false });
    const q = session.questions[session.index];
    const elapsedMs = Date.now() - session.questionStartTs;
    const correct = choiceIndex === q.correctIndex;
    let delta = 0;
    if (correct) {
      delta = computeSpeedScore(elapsedMs, DAILY_TIME_LIMIT * 1000);
      session.score += delta;
      session.correctCount += 1;
    }
    const profile = store.getProfile(session.nickname);
    if (profile) {
      recordAnswer(profile, q.categoryKey, q.id, correct);
      store.saveProfiles();
    }

    session.index += 1;
    const done = session.index >= session.questions.length;
    if (done) {
      store.submitDailyScore(session.nickname, session.score);
      let newBadges = [];
      if (profile) {
        profile.gamesPlayed += 1;
        if (session.score > profile.highScore) profile.highScore = session.score;
        newBadges = checkBadges(profile, { perfectScore: session.correctCount === session.questions.length });
        store.saveProfiles();
      }
      dailySessions.delete(socket.id);
      return cb({
        ok: true,
        done: true,
        correct,
        correctIndex: q.correctIndex,
        delta,
        finalScore: session.score,
        correctCount: session.correctCount,
        total: session.questions.length,
        newBadges,
        leaderboard: store.getDailyBoard().slice(0, 10),
      });
    }

    const next = session.questions[session.index];
    session.questionStartTs = Date.now();
    cb({
      ok: true,
      done: false,
      correct,
      correctIndex: q.correctIndex,
      delta,
      question: { index: session.index, type: next.type, question: next.question, options: next.options, imageUrl: next.imageUrl, imageMode: next.imageMode },
    });
  });
});

function removePlayerFromRoom(socket) {
  dailySessions.delete(socket.id);
  const room = rooms.get(socket.data.roomCode);
  if (!room) return;

  const player = room.players.get(socket.id);
  socket.leave(room.code);
  socket.data.roomCode = null;

  // Mid-game disconnect: tieni il giocatore in un limbo per 60s per permettere la riconnessione
  if (player && room.state !== "lobby" && room.state !== "finished") {
    room.players.delete(socket.id);
    room.answers.delete(socket.id);
    if (room.collabAttempted) room.collabAttempted.delete(socket.id);

    if (!room.disconnectedPlayers) room.disconnectedPlayers = new Map();
    player.disconnectTimer = setTimeout(() => {
      if (room.disconnectedPlayers) room.disconnectedPlayers.delete(player.nickname.toLowerCase());
      io.to(room.code).emit("room:toast", { message: `👋 ${player.nickname} ha abbandonato la partita` });
      const remaining = room.players.size + (room.disconnectedPlayers ? room.disconnectedPlayers.size : 0);
      if (remaining === 0) { clearRoomTimers(room); rooms.delete(room.code); }
    }, 60000);
    room.disconnectedPlayers.set(player.nickname.toLowerCase(), player);

    io.to(room.code).emit("room:toast", { message: `📡 ${player.nickname} si è disconnesso — ha 60s per rientrare` });
    broadcastRoomState(room);

    if (room.state === "playing") {
      if (room.settings.mode === "collab") {
        if (room.collabAttempted && room.collabCurrent && room.collabAttempted.size >= room.players.size) resolveCollabRound(room, null);
      } else if (room.settings.mode !== "streak") {
        broadcastAnswerCount(room);
        maybeFinishRoundEarly(room);
      }
    }
    return;
  }

  // Lobby o partita finita: rimozione immediata
  room.players.delete(socket.id);
  room.answers.delete(socket.id);
  if (room.collabAttempted) room.collabAttempted.delete(socket.id);

  if (room.players.size === 0) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === socket.id) {
    room.hostId = room.players.values().next().value.id;
  }
  broadcastRoomState(room);
  if (room.state === "playing") {
    if (room.settings.mode === "collab") {
      if (room.collabAttempted && room.collabCurrent && room.collabAttempted.size >= room.players.size) resolveCollabRound(room, null);
    } else if (room.settings.mode !== "streak") {
      broadcastAnswerCount(room);
      maybeFinishRoundEarly(room);
    }
  }
}

function msUntilMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

function cleanNickname(raw) {
  const trimmed = (raw || "").toString().trim().slice(0, 16);
  return trimmed || "Giocatore";
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Music Quiz server in ascolto su http://localhost:${PORT}`);
});
