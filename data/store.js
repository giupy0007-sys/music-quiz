const fs = require("fs");
const path = require("path");

const DATA_DIR = __dirname;

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ---------- Profili giocatore ----------
let profiles = loadJson("profiles.json", {});

function normalizeNickname(nickname) {
  return (nickname || "").trim().toLowerCase();
}

function getProfile(nickname) {
  const key = normalizeNickname(nickname);
  if (!key) return null;
  if (!profiles[key]) {
    profiles[key] = {
      nickname: nickname.trim(),
      gamesPlayed: 0,
      correctAnswers: 0,
      totalAnswers: 0,
      categoryStats: {},
      bestStreak: 0,
      highScore: 0,
      badges: [],
      modesPlayed: [],
      questionStats: {},
      firstSeenAt: Date.now(),
    };
  }
  return profiles[key];
}

function saveProfiles() {
  saveJson("profiles.json", profiles);
}

// ---------- Leaderboard globale (all-time) ----------
let leaderboard = loadJson("leaderboard.json", []);

// ---------- Leaderboard per modalità ----------
// Migra i vecchi dati: se un entry non ha mode, finisce in "classic"
let leaderboardsByMode = loadJson("leaderboard_modes.json", {});
(function migrateOldEntries() {
  for (const entry of leaderboard) {
    const mode = entry.mode || "classic";
    if (!leaderboardsByMode[mode]) leaderboardsByMode[mode] = [];
    const modeBoard = leaderboardsByMode[mode];
    const key = normalizeNickname(entry.nickname);
    const existing = modeBoard.find((e) => normalizeNickname(e.nickname) === key);
    if (!existing) modeBoard.push(entry);
    else if (entry.score > existing.score) Object.assign(existing, entry);
  }
  for (const board of Object.values(leaderboardsByMode)) {
    board.sort((a, b) => b.score - a.score);
    board.splice(10);
  }
})();

function submitToLeaderboard(entry) {
  // Global all-time top 10
  leaderboard.push(entry);
  leaderboard.sort((a, b) => b.score - a.score);
  leaderboard = leaderboard.slice(0, 10);
  saveJson("leaderboard.json", leaderboard);

  // Per-mode top 10 (best score per nickname per mode)
  const mode = entry.mode || "classic";
  if (!leaderboardsByMode[mode]) leaderboardsByMode[mode] = [];
  const modeBoard = leaderboardsByMode[mode];
  const key = normalizeNickname(entry.nickname);
  const existing = modeBoard.find((e) => normalizeNickname(e.nickname) === key);
  if (!existing) {
    modeBoard.push({ ...entry });
  } else if (entry.score > existing.score) {
    Object.assign(existing, entry);
  }
  modeBoard.sort((a, b) => b.score - a.score);
  modeBoard.splice(10);
  saveJson("leaderboard_modes.json", leaderboardsByMode);
}

function getLeaderboard() {
  return leaderboard;
}

function getLeaderboardsByMode() {
  return leaderboardsByMode;
}

// ---------- Daily challenge ----------
let daily = loadJson("daily.json", {});

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getDailyBoard(dateKey = todayKey()) {
  return daily[dateKey] || [];
}

function submitDailyScore(nickname, score) {
  const dateKey = todayKey();
  if (!daily[dateKey]) daily[dateKey] = [];
  const board = daily[dateKey];
  const key = normalizeNickname(nickname);
  const existing = board.find((e) => normalizeNickname(e.nickname) === key);
  if (existing) {
    if (score > existing.score) existing.score = score;
  } else {
    board.push({ nickname: nickname.trim(), score, completedAt: Date.now() });
  }
  board.sort((a, b) => b.score - a.score);

  // tiene solo gli ultimi 30 giorni per non far crescere il file all'infinito
  const dates = Object.keys(daily).sort();
  while (dates.length > 30) {
    delete daily[dates.shift()];
  }
  saveJson("daily.json", daily);
  return hasPlayedToday(nickname);
}

function hasPlayedToday(nickname) {
  const dateKey = todayKey();
  const board = daily[dateKey] || [];
  const key = normalizeNickname(nickname);
  return board.some((e) => normalizeNickname(e.nickname) === key);
}

module.exports = {
  getProfile,
  saveProfiles,
  normalizeNickname,
  submitToLeaderboard,
  getLeaderboard,
  getLeaderboardsByMode,
  getDailyBoard,
  submitDailyScore,
  hasPlayedToday,
  todayKey,
};
