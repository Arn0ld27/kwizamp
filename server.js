const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const CUSTOM_QUESTIONS_FILE = path.join(__dirname, 'data', 'custom-questions.json');
const ORIGINAL_QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// ---------- HOST SECURITY ----------
function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
const HOST_PASSWORD = process.env.HOST_PASSWORD || generatePin();
const hostSockets = new Set();
const hostAttempts = new Map();
const MAX_HOST_ATTEMPTS = 8;

// ---------- QUESTION LOADING ----------
function getQuestionKind(q) {
  if (q.type === 'truefalse') return 'truefalse';
  if (q.type === 'identification') return 'identification';
  return 'mcq';
}

function makeId() {
  return 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function normalizeQuestion(q) {
  const kind = getQuestionKind(q);
  const round = Number.isFinite(Number(q.round)) ? Number(q.round) : 1;
  const clincher = !!q.clincher || round === 4;

  const base = {
    id: q.id || makeId(),
    type: q.type || (kind === 'truefalse' ? 'truefalse' : kind === 'identification' ? 'identification' : 'mcq'),
    kind,
    round,
    clincher,
    question: String(q.question || '').trim()
  };

  if (kind === 'truefalse') {
    const correctIndex = typeof q.correct === 'boolean' ? (q.correct ? 0 : 1) : Number(q.correct);
    return { ...base, options: ['True', 'False'], correct: correctIndex === 1 ? 1 : 0 };
  }

  if (kind === 'identification') {
    const answer = String(q.answer || '').trim();
    const acceptable = Array.isArray(q.acceptable)
      ? q.acceptable.map(a => String(a).trim()).filter(Boolean)
      : [];
    return { ...base, answer, acceptable };
  }

  const options = Array.isArray(q.options)
    ? q.options.map(o => String(o || '').trim())
    : [];
  return { ...base, options, correct: Number(q.correct) || 0 };
}

function loadQuestionsFromDisk() {
  if (fs.existsSync(CUSTOM_QUESTIONS_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CUSTOM_QUESTIONS_FILE, 'utf-8'));
      const list = Array.isArray(raw) ? raw : (raw.questions || []);
      if (list.length > 0) {
        console.log(`📝 Loaded ${list.length} custom question(s)`);
        return { source: 'custom', questions: list.map(normalizeQuestion) };
      }
    } catch (err) {
      console.error('⚠️  custom-questions.json parse error:', err.message);
    }
  }

  const raw = JSON.parse(fs.readFileSync(ORIGINAL_QUESTIONS_FILE, 'utf-8'));
  const list = Array.isArray(raw) ? raw : (raw.questions || []);
  console.log(`📚 Loaded ${list.length} question(s) from questions.json`);
  return { source: 'original', questions: list.map(normalizeQuestion) };
}

let QUESTIONS = [];
let QUESTIONS_SOURCE = 'original';
let shuffleQuestions = false;

function reloadQuestions() {
  const loaded = loadQuestionsFromDisk();
  QUESTIONS = loaded.questions;
  QUESTIONS_SOURCE = loaded.source;
  recomputeQuestionBuckets();
}

let GAME_QUESTIONS = [];
let CLINCHER_QUESTIONS = [];
let TOTAL_QUESTIONS = 0;
let UNIQUE_ROUNDS = [];

function recomputeQuestionBuckets() {
  GAME_QUESTIONS = QUESTIONS.filter(q => !q.clincher);
  CLINCHER_QUESTIONS = QUESTIONS.filter(q => q.clincher);
  TOTAL_QUESTIONS = GAME_QUESTIONS.length;
  UNIQUE_ROUNDS = [...new Set(GAME_QUESTIONS.map(q => q.round || 1))].sort((a, b) => a - b);
  if (UNIQUE_ROUNDS.length === 0) UNIQUE_ROUNDS = [1];
}

reloadQuestions();

// ---------- SCORING ----------
const BASE_POINTS = 1000;
const MIN_POINTS = 500;
const STREAK_STEP = 0.1;
const STREAK_CAP = 0.5;
const COUNTDOWN_MS = 3000;
const DEFAULT_DURATION = 20;
const MIN_DURATION = 5;
const MAX_DURATION = 120;
const DEFAULT_FLAT_POINTS = 1000;
const MIN_FLAT_POINTS = 1;
const MAX_FLAT_POINTS = 100000;
const DEFAULT_CUSTOM_POINTS = { mcq: 1000, truefalse: 1000, identification: 1000 };

const QUIZBEE_POINTS = { 1: 1, 2: 2, 3: 3, 4: 5 };
function getRoundPoints(round) {
  return QUIZBEE_POINTS[round] || (round >= 4 ? 5 : 1);
}
function getRoundLabel(round) {
  const labels = { 1: 'Easy', 2: 'Average', 3: 'Difficult', 4: 'Clincher' };
  return labels[round] || `Round ${round}`;
}

function buildDefaultRoundDurations() {
  const d = {};
  UNIQUE_ROUNDS.forEach(r => { d[r] = DEFAULT_DURATION; });
  return d;
}

const DEFAULT_LIGHTNING_ROUNDS = 3;
const MIN_LIGHTNING_ROUNDS = 1;
const MAX_LIGHTNING_ROUNDS = 20;
const DEFAULT_ROULETTE_DURATION = 6500;
const MIN_ROULETTE_DURATION = 3000;
const MAX_ROULETTE_DURATION = 15000;

// ---------- STATE ----------
let players = {};
let persistentPlayers = {};

let gameState = {
  status: 'lobby',
  currentQuestion: -1,
  startedAt: null,
  countdownEndsAt: null,
  questionDuration: DEFAULT_DURATION,
  answersThisRound: {},
  showQuestionOnPhone: true,
  showScoresToPlayers: false,
  quizMode: 'school',
  schoolScoring: 'speed',
  schoolFlatPoints: DEFAULT_FLAT_POINTS,
  customPoints: { ...DEFAULT_CUSTOM_POINTS },
  roundDurations: buildDefaultRoundDurations(),
  lightningRounds: DEFAULT_LIGHTNING_ROUNDS,
  rouletteDuration: DEFAULT_ROULETTE_DURATION,
  playerQuestionMap: {},
  usedQuestionIds: new Set(),
  manualTimerStart: false,
  timerRunning: false,

  lastLeaderboard: [],
  lastPlayers: [],
  lastWinners: [],

  tieBreaker: {
    active: false, isSpeedRound: false,
    participants: [], questions: [], currentIndex: -1,
    answers: {}, eliminated: [], winner: null,
    targetRank: 1, targetScore: 0
  }
};

let pendingTimer = null;
const REACTION_COOLDOWN = 2000;
const VALID_REACTIONS = ['👍', '❤️', '😂', '🎉', '🔥', '😮'];

// ---------- PERSISTENCE ----------
let saveTimer = null;
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      if (raw && typeof raw === 'object' && raw.persistentPlayers) {
        Object.entries(raw.persistentPlayers).forEach(([pid, p]) => {
          persistentPlayers[pid] = {
            name: p.name || 'Camper',
            avatar: p.avatar || '🐶',
            score: Number.isFinite(p.score) ? p.score : 0,
            streak: Number.isFinite(p.streak) ? p.streak : 0,
            socketId: null, lastAnswer: null,
            joinedAt: p.joinedAt || Date.now(),
            status: 'offline'
          };
        });
        console.log(`💾 Restored ${Object.keys(persistentPlayers).length} camper record(s)`);
      }
    }
  } catch (err) {
    console.error('⚠️  Could not load saved state:', err.message);
  }
}

function saveStateNow() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const snapshot = { persistentPlayers, savedAt: Date.now() };
    fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.error('⚠️  Failed to save state:', err.message);
  }
}

function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 500);
}

// ---------- STATIC + ROUTES ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));

function csvField(val) {
  const str = String(val ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

app.get('/export-results.csv', (req, res) => {
  const activePlayers = Object.values(players).map(p => ({
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    status: p.status || 'online'
  }));

  const sorted = activePlayers.sort((a, b) => b.score - a.score);
  const rows = sorted.map((p, i) => [i + 1, p.name, p.avatar, p.score, p.status]);
  const header = ['Rank', 'Name', 'Avatar', 'Score', 'Status'];
  const lines = [header, ...rows].map(row => row.map(csvField).join(',')).join('\r\n');

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kwizkamp-results-${stamp}.csv"`);
  res.send('\uFEFF' + lines);
});

// ---------- HELPERS ----------
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function normalizeText(str) {
  return String(str || '').trim().toLowerCase()
    .replace(/[.,'"!?;:()-]/g, '').replace(/\s+/g, ' ');
}

function isIdentificationCorrect(rawText, q) {
  const given = normalizeText(rawText);
  if (!given) return false;
  const accepted = [q.answer, ...(Array.isArray(q.acceptable) ? q.acceptable : [])]
    .map(normalizeText).filter(Boolean);
  return accepted.includes(given);
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getPlayerList() {
  return Object.values(players).map(p => ({
    id: p.persistentId || p.name,
    name: p.name,
    avatar: p.avatar || '🐶',
    score: p.score,
    streak: p.streak || 0,
    status: p.status || 'online'
  }));
}

function getLeaderboard() {
  const list = Object.values(players).map(p => ({
    name: p.name, avatar: p.avatar || '🐶',
    score: p.score, streak: p.streak || 0,
    persistentId: p.persistentId
  }));
  if (gameState.quizMode === 'quizbee') {
    return list.sort((a, b) => b.score - a.score || b.streak - a.streak || a.name.localeCompare(b.name));
  }
  return list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function getRank(score) {
  const sorted = Object.values(players).map(p => p.score).sort((a, b) => b - a);
  const idx = sorted.indexOf(score);
  return idx === -1 ? '-' : idx + 1;
}

function detectTies() {
  const lb = getLeaderboard();
  const groups = {};
  lb.forEach(p => { if (!groups[p.score]) groups[p.score] = []; groups[p.score].push(p); });
  const ties = [];
  let rank = 1;
  Object.keys(groups).map(Number).sort((a, b) => b - a).forEach(score => {
    if (groups[score].length > 1) ties.push({ rank, score, players: groups[score] });
    rank += groups[score].length;
  });
  return ties;
}

function getCounts() {
  const counts = [0, 0, 0, 0];
  Object.values(gameState.answersThisRound).forEach(entry => {
    const idx = entry && typeof entry.index === 'number' ? entry.index : null;
    if (idx !== null && idx >= 0 && idx < 4) counts[idx]++;
  });
  return counts;
}

function isLightningQuestion(index) {
  if (gameState.lightningRounds <= 0) return false;
  return index >= (TOTAL_QUESTIONS - gameState.lightningRounds);
}

function getCustomPoints(kind) {
  const c = gameState.customPoints || DEFAULT_CUSTOM_POINTS;
  if (kind === 'truefalse') return Number(c.truefalse) || DEFAULT_CUSTOM_POINTS.truefalse;
  if (kind === 'identification') return Number(c.identification) || DEFAULT_CUSTOM_POINTS.identification;
  return Number(c.mcq) || DEFAULT_CUSTOM_POINTS.mcq;
}

function computePoints(isCorrect, answeredAt, streakBefore, round, kind) {
  if (!isCorrect) return { points: 0, streakMultiplier: 1 };
  if (gameState.quizMode === 'quizbee') return { points: getRoundPoints(round), streakMultiplier: 1 };
  if (gameState.schoolScoring === 'flat') return { points: gameState.schoolFlatPoints, streakMultiplier: 1 };
  if (gameState.schoolScoring === 'custom') return { points: getCustomPoints(kind), streakMultiplier: 1 };

  const duration = gameState.questionDuration * 1000;
  const elapsed = gameState.startedAt ? (answeredAt - gameState.startedAt) : duration;
  const fraction = Math.min(Math.max(elapsed / duration, 0), 1);
  const base = Math.round(MIN_POINTS + (BASE_POINTS - MIN_POINTS) * (1 - fraction));
  const streakMultiplier = 1 + Math.min(streakBefore * STREAK_STEP, STREAK_CAP);
  return { points: Math.round(base * streakMultiplier), streakMultiplier };
}

function createPlayerQuestion(question) {
  const n = question.options.length;
  const indices = Array.from({ length: n }, (_, i) => i);
  const shuffled = shuffleArray(indices);
  return {
    options: shuffled.map(i => question.options[i]),
    map: shuffled,
    correctPosition: shuffled.indexOf(question.correct)
  };
}

function clearPendingTimer() {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
}

function buildLightningPool(targetRound) {
  const sameRound = GAME_QUESTIONS.filter(q => (q.round || 1) === targetRound);
  if (sameRound.length > 0) return sameRound;

  const availableRounds = UNIQUE_ROUNDS.filter(r => r !== targetRound);
  if (availableRounds.length === 0) return [...GAME_QUESTIONS];
  availableRounds.sort((a, b) => Math.abs(a - targetRound) - Math.abs(b - targetRound));
  for (const r of availableRounds) {
    const pool = GAME_QUESTIONS.filter(q => (q.round || 1) === r);
    if (pool.length > 0) return pool;
  }
  return [...GAME_QUESTIONS];
}

function assignLightningQuestions(currentQuestion) {
  const targetRound = currentQuestion.round || 1;
  const pool = buildLightningPool(targetRound);
  const playerIds = Object.keys(players);
  const shuffled = shuffleArray(pool);
  const assignments = {};
  const usedInThisRound = new Set();

  playerIds.forEach((sid, idx) => {
    let picked = null;
    for (const q of shuffled) {
      if (!usedInThisRound.has(q.id)) { picked = q; break; }
    }
    if (!picked) picked = shuffled[idx % shuffled.length];
    usedInThisRound.add(picked.id);
    assignments[sid] = picked;
  });
  return assignments;
}

function emitQuestionDisplay() {
  const q = GAME_QUESTIONS[gameState.currentQuestion];
  const roundNum = q.round || 1;
  const roundLabel = getRoundLabel(roundNum);
  const isLightning = isLightningQuestion(gameState.currentQuestion);

  let duration = gameState.questionDuration;
  if (gameState.quizMode === 'quizbee') {
    duration = gameState.roundDurations[roundNum];
    if (!Number.isFinite(duration)) duration = DEFAULT_DURATION;
  }
  if (Number.isFinite(q.duration)) duration = q.duration;
  gameState.questionDuration = duration;

  if (isLightning) {
    const lightningIndex = gameState.currentQuestion - (TOTAL_QUESTIONS - gameState.lightningRounds);
    io.to('host').emit('question-host', {
      index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
      question: `⚡ Lightning Round — each player has a different question`,
      kind: q.kind, options: null,
      duration, startedAt: gameState.startedAt,
      answered: 0, totalPlayers: Object.keys(players).length,
      showQuestionOnPhone: true,
      round: roundNum, roundLabel,
      roundPoints: getRoundPoints(roundNum),
      quizMode: gameState.quizMode,
      isLightning: true,
      lightningIndex: lightningIndex + 1,
      lightningTotal: gameState.lightningRounds,
      timerRunning: gameState.timerRunning,
      manualTimerStart: gameState.manualTimerStart
    });
    io.to('display').emit('question-display', {
      index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
      question: '⚡ LIGHTNING ROUND ⚡',
      kind: q.kind, duration,
      startedAt: gameState.startedAt,
      round: roundNum, roundLabel,
      roundPoints: getRoundPoints(roundNum),
      quizMode: gameState.quizMode,
      isLightning: true,
      lightningIndex: lightningIndex + 1,
      lightningTotal: gameState.lightningRounds,
      timerRunning: gameState.timerRunning
    });
    return;
  }

  io.to('host').emit('question-host', {
    index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
    question: q.question, kind: q.kind,
    options: q.kind !== 'identification' ? q.options : null,
    duration, startedAt: gameState.startedAt,
    answered: 0, totalPlayers: Object.keys(players).length,
    showQuestionOnPhone: gameState.showQuestionOnPhone,
    round: roundNum, roundLabel,
    roundPoints: getRoundPoints(roundNum),
    quizMode: gameState.quizMode, isLightning: false,
    timerRunning: gameState.timerRunning,
    manualTimerStart: gameState.manualTimerStart
  });
  io.to('display').emit('question-display', {
    index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
    question: q.question, kind: q.kind, duration,
    startedAt: gameState.startedAt,
    round: roundNum, roundLabel,
    roundPoints: getRoundPoints(roundNum),
    quizMode: gameState.quizMode, isLightning: false,
    timerRunning: gameState.timerRunning
  });
}

function emitPlayerQuestions() {
  const q = GAME_QUESTIONS[gameState.currentQuestion];
  const roundNum = q.round || 1;
  const roundLabel = getRoundLabel(roundNum);
  const isLightning = isLightningQuestion(gameState.currentQuestion);
  const duration = gameState.questionDuration;

  if (isLightning) {
    const assignments = assignLightningQuestions(q);
    gameState.playerQuestionMap = assignments;

    Object.entries(players).forEach(([sid, player]) => {
      const assignedQ = assignments[sid];
      if (!assignedQ) return;
      const isChoice = assignedQ.kind !== 'identification';

      if (isChoice) {
        const shuffled = createPlayerQuestion(assignedQ);
        player.shuffleMap = shuffled.map;
        player.correctPosition = shuffled.correctPosition;
        player.assignedQuestionId = assignedQ.id;
        io.to(sid).emit('question', {
          index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
          question: assignedQ.question, kind: assignedQ.kind,
          options: shuffled.options,
          duration, startedAt: gameState.startedAt,
          showQuestionOnPhone: true,
          round: roundNum, roundLabel,
          roundPoints: getRoundPoints(roundNum),
          quizMode: gameState.quizMode, isLightning: true,
          timerRunning: gameState.timerRunning,
          manualTimerStart: gameState.manualTimerStart
        });
      } else {
        player.shuffleMap = null;
        player.correctPosition = null;
        player.assignedQuestionId = assignedQ.id;
        io.to(sid).emit('question', {
          index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
          question: assignedQ.question, kind: assignedQ.kind, options: null,
          duration, startedAt: gameState.startedAt,
          showQuestionOnPhone: true,
          round: roundNum, roundLabel,
          roundPoints: getRoundPoints(roundNum),
          quizMode: gameState.quizMode, isLightning: true,
          timerRunning: gameState.timerRunning,
          manualTimerStart: gameState.manualTimerStart
        });
      }
    });
    return;
  }

  const isChoice = q.kind !== 'identification';

  Object.entries(players).forEach(([socketId, player]) => {
    if (isChoice) {
      const shuffled = createPlayerQuestion(q);
      player.shuffleMap = shuffled.map;
      player.correctPosition = shuffled.correctPosition;
      player.assignedQuestionId = q.id;
      io.to(socketId).emit('question', {
        index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
        question: q.question, kind: q.kind, options: shuffled.options,
        duration, startedAt: gameState.startedAt,
        showQuestionOnPhone: gameState.showQuestionOnPhone,
        round: roundNum, roundLabel,
        roundPoints: getRoundPoints(roundNum),
        quizMode: gameState.quizMode, isLightning: false,
        timerRunning: gameState.timerRunning,
        manualTimerStart: gameState.manualTimerStart
      });
    } else {
      player.shuffleMap = null;
      player.correctPosition = null;
      player.assignedQuestionId = q.id;
      io.to(socketId).emit('question', {
        index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
        question: q.question, kind: q.kind, options: null,
        duration, startedAt: gameState.startedAt,
        showQuestionOnPhone: gameState.showQuestionOnPhone,
        round: roundNum, roundLabel,
        roundPoints: getRoundPoints(roundNum),
        quizMode: gameState.quizMode, isLightning: false,
        timerRunning: gameState.timerRunning,
        manualTimerStart: gameState.manualTimerStart
      });
    }
  });
}

function broadcastQuestion() {
  emitQuestionDisplay();

  const isLightning = isLightningQuestion(gameState.currentQuestion);

  if (gameState.manualTimerStart && !isLightning) {
    gameState.timerRunning = false;
    gameState.startedAt = Date.now();
    console.log('⏸ Manual timer mode — waiting for host to start');
  } else {
    gameState.timerRunning = true;
    gameState.startedAt = Date.now();
    emitPlayerQuestions();
  }
}

function beginQuestionSequence() {
  clearPendingTimer();
  gameState.status = 'countdown';
  gameState.countdownEndsAt = Date.now() + COUNTDOWN_MS;
  gameState.timerRunning = false;

  const q = GAME_QUESTIONS[gameState.currentQuestion];
  const isLightning = isLightningQuestion(gameState.currentQuestion);

  const payload = {
    index: gameState.currentQuestion,
    total: TOTAL_QUESTIONS,
    countdownMs: COUNTDOWN_MS,
    round: q.round || 1,
    roundLabel: getRoundLabel(q.round || 1),
    quizMode: gameState.quizMode,
    isLightning
  };
  io.to('host').emit('get-ready', payload);
  io.to('display').emit('get-ready', payload);
  Object.keys(players).forEach(id => io.to(id).emit('get-ready', payload));

  pendingTimer = setTimeout(() => {
    gameState.status = 'question';
    gameState.answersThisRound = {};
    Object.values(players).forEach(p => {
      p.hasAnswered = false;
      p.lastAnswer = null;
      p.assignedQuestionId = null;
    });
    broadcastQuestion();
  }, COUNTDOWN_MS);
}

// ---------- TIE BREAKER ----------
function startTieBreakerQuestion() {
  const tb = gameState.tieBreaker;
  tb.currentIndex++;
  if (tb.currentIndex >= tb.questions.length) { startSpeedTieBreaker(); return; }

  const q = tb.questions[tb.currentIndex];
  const isChoice = q.kind !== 'identification';
  tb.answers = {};

  io.to('host').emit('tiebreaker-question-host', {
    index: tb.currentIndex, total: tb.questions.length,
    question: q.question, kind: q.kind,
    options: isChoice ? q.options : null,
    remaining: tb.participants.filter(pid => !tb.eliminated.includes(pid)).length,
    isSpeedRound: false
  });
  io.to('display').emit('tiebreaker-question-display', {
    index: tb.currentIndex, total: tb.questions.length,
    question: q.question, kind: q.kind,
    options: isChoice ? q.options : null, isSpeedRound: false
  });

  Object.entries(players).forEach(([sid, p]) => {
    if (!tb.participants.includes(p.persistentId)) return;
    if (tb.eliminated.includes(p.persistentId)) return;
    if (isChoice) {
      const shuffled = createPlayerQuestion(q);
      p.shuffleMap = shuffled.map;
      p.correctPosition = shuffled.correctPosition;
      io.to(sid).emit('tiebreaker-question', {
        index: tb.currentIndex, total: tb.questions.length,
        question: q.question, kind: q.kind,
        options: shuffled.options, isSpeedRound: false
      });
    } else {
      p.shuffleMap = null;
      io.to(sid).emit('tiebreaker-question', {
        index: tb.currentIndex, total: tb.questions.length,
        question: q.question, kind: q.kind,
        options: null, isSpeedRound: false
      });
    }
  });
}

function handleTieBreakerAnswer(socketId, payload) {
  const tb = gameState.tieBreaker;
  if (!tb.active) return;
  const p = players[socketId];
  if (!p) return;
  if (!tb.participants.includes(p.persistentId)) return;
  if (tb.eliminated.includes(p.persistentId)) return;
  if (tb.answers[p.persistentId]) return;

  const q = tb.questions[tb.currentIndex];
  const isChoice = q.kind !== 'identification';

  if (isChoice) {
    const idx = Number(payload);
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) return;
    const originalIndex = p.shuffleMap ? p.shuffleMap[idx] : idx;
    tb.answers[p.persistentId] = { index: originalIndex, at: Date.now() };
    io.to(socketId).emit('tiebreaker-answer-locked', { optionIndex: idx });
  } else {
    const text = String(payload || '').trim().slice(0, 120);
    if (!text) return;
    tb.answers[p.persistentId] = { text, at: Date.now() };
    io.to(socketId).emit('tiebreaker-answer-locked', { text });
  }

  if (tb.isSpeedRound) {
    const isCorrect = isChoice
      ? tb.answers[p.persistentId].index === q.correct
      : isIdentificationCorrect(tb.answers[p.persistentId].text, q);
    if (isCorrect) { tb.winner = p.persistentId; setTimeout(() => endTieBreaker(), 500); return; }
  }

  const remaining = tb.participants.filter(pid => !tb.eliminated.includes(pid));
  const answeredCount = remaining.filter(pid => tb.answers[pid]).length;
  if (answeredCount >= remaining.length) {
    setTimeout(() => {
      if (tb.isSpeedRound) evaluateSpeedTieBreakerRound();
      else evaluateTieBreakerRound();
    }, 500);
  }
}

function evaluateTieBreakerRound() {
  const tb = gameState.tieBreaker;
  const q = tb.questions[tb.currentIndex];
  const isChoice = q.kind !== 'identification';
  const remaining = tb.participants.filter(pid => !tb.eliminated.includes(pid));
  const newlyEliminated = [];

  remaining.forEach(pid => {
    const ans = tb.answers[pid];
    let isCorrect = false;
    if (ans) {
      if (isChoice) isCorrect = ans.index === q.correct;
      else isCorrect = isIdentificationCorrect(ans.text, q);
    }
    if (!isCorrect) newlyEliminated.push(pid);
  });

  if (newlyEliminated.length === remaining.length) {
    io.to('display').emit('tiebreaker-result-display', {
      correctText: isChoice ? q.options[q.correct] : q.answer,
      eliminated: [],
      remaining: remaining.map(pid => {
        const p = Object.values(players).find(pl => pl.persistentId === pid);
        return p ? { name: p.name, avatar: p.avatar } : { name: '?', avatar: '🐶' };
      }),
      allWrong: true
    });
    io.to('host').emit('tiebreaker-result-host', {
      correctText: isChoice ? q.options[q.correct] : q.answer,
      eliminated: 0, remaining: remaining.length, allWrong: true
    });
    return;
  }

  newlyEliminated.forEach(pid => tb.eliminated.push(pid));
  const nowIn = tb.participants.filter(pid => !tb.eliminated.includes(pid));

  io.to('display').emit('tiebreaker-result-display', {
    correctText: isChoice ? q.options[q.correct] : q.answer,
    eliminated: newlyEliminated.map(pid => {
      const p = Object.values(players).find(pl => pl.persistentId === pid);
      return p ? { name: p.name, avatar: p.avatar } : { name: '?', avatar: '🐶' };
    }),
    remaining: nowIn.map(pid => {
      const p = Object.values(players).find(pl => pl.persistentId === pid);
      return p ? { name: p.name, avatar: p.avatar } : { name: '?', avatar: '🐶' };
    }),
    allWrong: false
  });
  io.to('host').emit('tiebreaker-result-host', {
    correctText: isChoice ? q.options[q.correct] : q.answer,
    eliminated: newlyEliminated.length, remaining: nowIn.length, allWrong: false
  });

  tb.participants.forEach(pid => {
    const p = Object.values(players).find(pl => pl.persistentId === pid);
    if (!p) return;
    const sid = Object.keys(players).find(k => players[k] === p);
    if (!sid) return;
    if (tb.eliminated.includes(pid)) io.to(sid).emit('tiebreaker-eliminated');
    else if (nowIn.length === 1) io.to(sid).emit('tiebreaker-won');
    else io.to(sid).emit('tiebreaker-still-in');
  });

  if (nowIn.length === 1) {
    tb.winner = nowIn[0];
    setTimeout(() => endTieBreaker(), 2000);
  } else {
    io.to('host').emit('tiebreaker-await-next');
  }
}

function startSpeedTieBreaker() {
  const tb = gameState.tieBreaker;
  tb.isSpeedRound = true;
  tb.answers = {};
  const allQuestions = [...GAME_QUESTIONS, ...CLINCHER_QUESTIONS];
  const q = allQuestions[Math.floor(Math.random() * allQuestions.length)];
  tb.questions = [q];
  tb.currentIndex = 0;
  const isChoice = q.kind !== 'identification';
  const stillIn = tb.participants.filter(pid => !tb.eliminated.includes(pid));

  io.to('host').emit('tiebreaker-question-host', {
    index: 0, total: 1, question: q.question, kind: q.kind,
    options: isChoice ? q.options : null,
    remaining: stillIn.length, isSpeedRound: true
  });
  io.to('display').emit('tiebreaker-question-display', {
    index: 0, total: 1, question: q.question, kind: q.kind,
    options: isChoice ? q.options : null, isSpeedRound: true
  });

  stillIn.forEach(pid => {
    const p = Object.values(players).find(pl => pl.persistentId === pid);
    if (!p) return;
    const sid = Object.keys(players).find(k => players[k] === p);
    if (!sid) return;
    if (isChoice) {
      const shuffled = createPlayerQuestion(q);
      p.shuffleMap = shuffled.map;
      p.correctPosition = shuffled.correctPosition;
      io.to(sid).emit('tiebreaker-question', {
        index: 0, total: 1, question: q.question, kind: q.kind,
        options: shuffled.options, isSpeedRound: true
      });
    } else {
      p.shuffleMap = null;
      io.to(sid).emit('tiebreaker-question', {
        index: 0, total: 1, question: q.question, kind: q.kind,
        options: null, isSpeedRound: true
      });
    }
  });
}

function evaluateSpeedTieBreakerRound() {
  const tb = gameState.tieBreaker;
  const q = tb.questions[0];
  const isChoice = q.kind !== 'identification';

  io.to('display').emit('tiebreaker-result-display', {
    correctText: isChoice ? q.options[q.correct] : q.answer,
    eliminated: [],
    remaining: tb.participants.filter(pid => !tb.eliminated.includes(pid)).map(pid => {
      const p = Object.values(players).find(pl => pl.persistentId === pid);
      return p ? { name: p.name, avatar: p.avatar } : { name: '?', avatar: '🐶' };
    }),
    allWrong: true
  });
  io.to('host').emit('tiebreaker-result-host', {
    correctText: isChoice ? q.options[q.correct] : q.answer,
    eliminated: 0,
    remaining: tb.participants.filter(pid => !tb.eliminated.includes(pid)).length,
    allWrong: true
  });

  tb.participants.forEach(pid => {
    const p = Object.values(players).find(pl => pl.persistentId === pid);
    if (!p) return;
    const sid = Object.keys(players).find(k => players[k] === p);
    if (!sid) return;
    if (!tb.eliminated.includes(pid)) io.to(sid).emit('tiebreaker-still-in');
  });

  setTimeout(() => startSpeedTieBreaker(), 3000);
}

function endTieBreaker() {
  const tb = gameState.tieBreaker;
  tb.active = false;
  gameState.status = 'ended';
  const winner = Object.values(players).find(p => p.persistentId === tb.winner);
  const leaderboard = getLeaderboard();

  io.to('host').emit('tiebreaker-ended', {
    winner: winner ? { name: winner.name, avatar: winner.avatar } : null,
    leaderboard
  });
  io.to('display').emit('tiebreaker-ended-display', {
    winner: winner ? { name: winner.name, avatar: winner.avatar } : null,
    leaderboard
  });
  Object.entries(players).forEach(([sid, p]) => {
    io.to(sid).emit('personal-final', { score: p.score, rank: getRank(p.score) });
  });
  console.log(`🐝 Tie breaker ended. Winner: ${winner ? winner.name : 'none'}`);
}

function safe(fn) {
  return (...args) => {
    try { fn(...args); }
    catch (err) { console.error('⚠️  Handler error:', err); }
  };
}

// ---------- EDITOR HELPERS ----------
function validateQuestionsArray(list) {
  const errors = [];
  if (!Array.isArray(list)) return ['Payload is not an array.'];
  if (list.length === 0) return ['At least one question is required.'];
  const seenIds = new Set();
  list.forEach((q, i) => {
    const idx = i + 1; const prefix = `Q${idx}: `;
    if (!q || typeof q !== 'object') { errors.push(prefix + 'Invalid question object.'); return; }
    const kind = getQuestionKind(q);
    if (!String(q.question || '').trim()) errors.push(prefix + 'Question text is required.');
    const round = Number(q.round);
    if (!Number.isFinite(round) || round < 1) errors.push(prefix + 'Round must be a positive number.');
    if (q.id) {
      if (seenIds.has(q.id)) errors.push(prefix + `Duplicate question id "${q.id}".`);
      seenIds.add(q.id);
    }
    if (kind === 'mcq') {
      if (!Array.isArray(q.options) || q.options.length !== 4) errors.push(prefix + 'MCQ requires exactly 4 options.');
      else {
        q.options.forEach((o, oi) => { if (!String(o || '').trim()) errors.push(prefix + `Option ${oi + 1} is empty.`); });
        const correct = Number(q.correct);
        if (!Number.isInteger(correct) || correct < 0 || correct > 3) errors.push(prefix + 'MCQ correct index must be 0–3.');
      }
    } else if (kind === 'identification') {
      if (!String(q.answer || '').trim()) errors.push(prefix + 'Identification answer is required.');
    }
  });
  return errors;
}

function buildEditorPayload() {
  return {
    questions: QUESTIONS,
    rounds: UNIQUE_ROUNDS,
    totalGameQuestions: GAME_QUESTIONS.length,
    totalClincherQuestions: CLINCHER_QUESTIONS.length,
    source: QUESTIONS_SOURCE,
    shuffleQuestions,
    locked: gameState.status !== 'lobby',
    status: gameState.status
  };
}

function buildRoulettePayload() {
  const lb = getLeaderboard();
  const allPlayers = Object.values(players).map(p => ({
    name: p.name,
    avatar: p.avatar || '🐶'
  }));
  const topScore = lb.length > 0 ? lb[0].score : 0;
  const winners = lb
    .filter(p => p.score === topScore)
    .map(p => ({
      name: p.name,
      avatar: p.avatar || '🐶',
      score: p.score
    }));
  return { players: allPlayers, winners, leaderboard: lb };
}

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on('host-join', safe((password) => {
    const attempts = hostAttempts.get(socket.id) || 0;
    if (attempts >= MAX_HOST_ATTEMPTS) { socket.emit('host-auth-failed', { locked: true }); return; }
    if (String(password) !== HOST_PASSWORD) {
      hostAttempts.set(socket.id, attempts + 1);
      socket.emit('host-auth-failed', { locked: false });
      return;
    }
    hostAttempts.delete(socket.id);
    hostSockets.add(socket.id);
    socket.join('host');
    socket.emit('host-auth-ok');
    socket.emit('state', {
      status: gameState.status,
      currentQuestion: gameState.currentQuestion,
      total: TOTAL_QUESTIONS,
      players: getPlayerList(),
      showQuestionOnPhone: gameState.showQuestionOnPhone,
      showScoresToPlayers: gameState.showScoresToPlayers,
      questionDuration: gameState.questionDuration,
      quizMode: gameState.quizMode,
      schoolScoring: gameState.schoolScoring,
      schoolFlatPoints: gameState.schoolFlatPoints,
      customPoints: gameState.customPoints,
      lightningRounds: gameState.lightningRounds,
      rouletteDuration: gameState.rouletteDuration,
      manualTimerStart: gameState.manualTimerStart,
      uniqueRounds: UNIQUE_ROUNDS,
      roundDurations: gameState.roundDurations
    });
    socket.emit('editor-data', buildEditorPayload());
  }));

  socket.on('display-join', safe(() => {
    socket.join('display');
    socket.emit('display-state', {
      status: gameState.status,
      currentQuestion: gameState.currentQuestion,
      total: TOTAL_QUESTIONS,
      quizMode: gameState.quizMode
    });
  }));

  socket.on('player-join', safe((data) => {
    const payload = typeof data === 'string' ? { name: data } : (data || {});
    const cleanName = escapeHtml(String(payload.name || '').trim().slice(0, 20)) || 'Camper';
    const avatar = String(payload.avatar || '🐶').slice(0, 4);
    const persistentId = typeof payload.persistentId === 'string' ? payload.persistentId.slice(0, 64) : null;

    let existing = null;
    if (persistentId && persistentPlayers[persistentId]) existing = persistentPlayers[persistentId];

    if (existing) {
      const oldId = existing.socketId;
      if (oldId && oldId !== socket.id && players[oldId]) delete players[oldId];
      existing.socketId = socket.id;
      existing.name = cleanName;
      existing.avatar = avatar;
      existing.status = 'online';

      players[socket.id] = {
        name: cleanName, avatar: avatar,
        score: existing.score, streak: existing.streak || 0,
        lastAnswer: null, hasAnswered: false,
        persistentId: persistentId,
        shuffleMap: null, correctPosition: null,
        assignedQuestionId: null,
        status: 'online', lastReactionAt: 0
      };

      socket.emit('joined', {
        name: cleanName, avatar: avatar, playerId: socket.id,
        score: existing.score, streak: existing.streak || 0,
        persistentId: persistentId
      });

      if (gameState.status === 'countdown') {
        const q = GAME_QUESTIONS[gameState.currentQuestion];
        socket.emit('get-ready', {
          index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
          countdownMs: Math.max(0, gameState.countdownEndsAt - Date.now()),
          round: q.round || 1,
          roundLabel: getRoundLabel(q.round || 1),
          quizMode: gameState.quizMode,
          isLightning: isLightningQuestion(gameState.currentQuestion)
        });
      } else if (gameState.status === 'question') {
        if (gameState.manualTimerStart && !gameState.timerRunning) {
          socket.emit('waiting-for-timer', { index: gameState.currentQuestion, total: TOTAL_QUESTIONS });
        } else {
          const isLightning = isLightningQuestion(gameState.currentQuestion);
          let q;
          if (isLightning) {
            const pool = buildLightningPool(GAME_QUESTIONS[gameState.currentQuestion].round || 1);
            q = pool[Math.floor(Math.random() * pool.length)];
          } else {
            q = GAME_QUESTIONS[gameState.currentQuestion];
          }
          const isChoice = q.kind !== 'identification';
          const prevAnswer = gameState.answersThisRound[socket.id];

          if (isChoice) {
            const shuffled = createPlayerQuestion(q);
            players[socket.id].shuffleMap = shuffled.map;
            players[socket.id].correctPosition = shuffled.correctPosition;
            players[socket.id].assignedQuestionId = q.id;
            socket.emit('question', {
              index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
              question: q.question, kind: q.kind, options: shuffled.options,
              duration: gameState.questionDuration, startedAt: gameState.startedAt,
              showQuestionOnPhone: isLightning ? true : gameState.showQuestionOnPhone,
              round: q.round || 1, roundLabel: getRoundLabel(q.round || 1),
              roundPoints: getRoundPoints(q.round || 1),
              quizMode: gameState.quizMode, isLightning,
              timerRunning: gameState.timerRunning,
              manualTimerStart: gameState.manualTimerStart
            });
            if (prevAnswer) {
              players[socket.id].hasAnswered = true;
              players[socket.id].lastAnswer = prevAnswer.index;
              const clickedPos = shuffled.map.indexOf(prevAnswer.index);
              socket.emit('answer-locked', { optionIndex: clickedPos });
            }
          } else {
            socket.emit('question', {
              index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
              question: q.question, kind: q.kind, options: null,
              duration: gameState.questionDuration, startedAt: gameState.startedAt,
              showQuestionOnPhone: isLightning ? true : gameState.showQuestionOnPhone,
              round: q.round || 1, roundLabel: getRoundLabel(q.round || 1),
              roundPoints: getRoundPoints(q.round || 1),
              quizMode: gameState.quizMode, isLightning,
              timerRunning: gameState.timerRunning,
              manualTimerStart: gameState.manualTimerStart
            });
            if (prevAnswer) {
              players[socket.id].hasAnswered = true;
              players[socket.id].lastAnswer = prevAnswer.text;
              socket.emit('answer-locked', { text: prevAnswer.text });
            }
          }
        }
      } else if (gameState.status === 'reveal') {
        socket.emit('waiting');
      } else if (gameState.status === 'tiebreaker') {
        const tb = gameState.tieBreaker;
        const isParticipant = tb.participants.includes(persistentId);
        socket.emit('tiebreaker-notice', {
          isParticipant,
          participants: tb.participants.map(pid => {
            const p = Object.values(players).find(pl => pl.persistentId === pid);
            return p ? { name: p.name, avatar: p.avatar } : null;
          }).filter(Boolean)
        });
      } else if (gameState.status === 'ended') {
        socket.emit('personal-final', { score: existing.score, rank: getRank(existing.score) });
      } else {
        socket.emit('waiting');
      }

      io.to('host').emit('player-list', getPlayerList());
      saveStateSoon();
      return;
    }

    const newPersistentId = persistentId || `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    players[socket.id] = {
      name: cleanName, avatar: avatar, score: 0, streak: 0,
      lastAnswer: null, hasAnswered: false,
      persistentId: newPersistentId,
      shuffleMap: null, correctPosition: null,
      assignedQuestionId: null,
      status: 'online', lastReactionAt: 0
    };
    persistentPlayers[newPersistentId] = {
      name: cleanName, avatar: avatar, score: 0, streak: 0,
      socketId: socket.id, lastAnswer: null,
      joinedAt: Date.now(), status: 'online'
    };

    socket.emit('joined', {
      name: cleanName, avatar: avatar, playerId: socket.id,
      score: 0, streak: 0, persistentId: newPersistentId
    });

    if (gameState.status === 'countdown') {
      const q = GAME_QUESTIONS[gameState.currentQuestion];
      socket.emit('get-ready', {
        index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
        countdownMs: Math.max(0, gameState.countdownEndsAt - Date.now()),
        round: q.round || 1, roundLabel: getRoundLabel(q.round || 1),
        quizMode: gameState.quizMode,
        isLightning: isLightningQuestion(gameState.currentQuestion)
      });
    } else if (gameState.status === 'question') {
      if (gameState.manualTimerStart && !gameState.timerRunning) {
        socket.emit('waiting-for-timer', { index: gameState.currentQuestion, total: TOTAL_QUESTIONS });
      } else {
        const isLightning = isLightningQuestion(gameState.currentQuestion);
        let q;
        if (isLightning) {
          const pool = buildLightningPool(GAME_QUESTIONS[gameState.currentQuestion].round || 1);
          q = pool[Math.floor(Math.random() * pool.length)];
        } else {
          q = GAME_QUESTIONS[gameState.currentQuestion];
        }
        if (q.kind !== 'identification') {
          const shuffled = createPlayerQuestion(q);
          players[socket.id].shuffleMap = shuffled.map;
          players[socket.id].correctPosition = shuffled.correctPosition;
          players[socket.id].assignedQuestionId = q.id;
          socket.emit('question', {
            index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
            question: q.question, kind: q.kind, options: shuffled.options,
            duration: gameState.questionDuration, startedAt: gameState.startedAt,
            showQuestionOnPhone: isLightning ? true : gameState.showQuestionOnPhone,
            round: q.round || 1, roundLabel: getRoundLabel(q.round || 1),
            roundPoints: getRoundPoints(q.round || 1),
            quizMode: gameState.quizMode, isLightning,
            timerRunning: gameState.timerRunning,
            manualTimerStart: gameState.manualTimerStart
          });
        } else {
          socket.emit('question', {
            index: gameState.currentQuestion, total: TOTAL_QUESTIONS,
            question: q.question, kind: q.kind, options: null,
            duration: gameState.questionDuration, startedAt: gameState.startedAt,
            showQuestionOnPhone: isLightning ? true : gameState.showQuestionOnPhone,
            round: q.round || 1, roundLabel: getRoundLabel(q.round || 1),
            roundPoints: getRoundPoints(q.round || 1),
            quizMode: gameState.quizMode, isLightning,
            timerRunning: gameState.timerRunning,
            manualTimerStart: gameState.manualTimerStart
          });
        }
      }
    } else {
      socket.emit('waiting');
    }

    io.to('host').emit('player-list', getPlayerList());
    saveStateSoon();
  }));

  socket.on('set-duration', safe((seconds) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') return;
    const val = Math.round(Number(seconds));
    if (!Number.isFinite(val)) return;
    gameState.questionDuration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, val));
    io.to('host').emit('duration-updated', gameState.questionDuration);
  }));

  socket.on('set-round-duration', safe((data) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') return;
    const round = Number(data.round);
    const secs = Number(data.seconds);
    if (!UNIQUE_ROUNDS.includes(round)) return;
    if (!Number.isFinite(secs)) return;
    gameState.roundDurations[round] = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(secs)));
    io.to('host').emit('round-durations-updated', gameState.roundDurations);
  }));

  socket.on('set-mode', safe((mode) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') return;
    if (!['school', 'quizbee'].includes(mode)) return;
    gameState.quizMode = mode;
    io.to('host').emit('mode-updated', mode);
  }));

  socket.on('set-school-scoring', safe((mode) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') return;
    if (!['speed', 'flat', 'custom'].includes(mode)) return;
    gameState.schoolScoring = mode;
    io.to('host').emit('school-scoring-updated', mode);
  }));

  socket.on('set-school-flat-points', safe((points) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') return;
    const val = Math.round(Number(points));
    if (!Number.isFinite(val)) return;
    gameState.schoolFlatPoints = Math.min(MAX_FLAT_POINTS, Math.max(MIN_FLAT_POINTS, val));
    io.to('host').emit('school-flat-points-updated', gameState.schoolFlatPoints);
  }));

  socket.on('set-custom-points', safe((data) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') return;
    const d = data || {};
    const clamp = (v, def) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return def;
      return Math.min(MAX_FLAT_POINTS, Math.max(MIN_FLAT_POINTS, n));
    };
    gameState.customPoints = {
      mcq: clamp(d.mcq, DEFAULT_CUSTOM_POINTS.mcq),
      truefalse: clamp(d.truefalse, DEFAULT_CUSTOM_POINTS.truefalse),
      identification: clamp(d.identification, DEFAULT_CUSTOM_POINTS.identification)
    };
    io.to('host').emit('custom-points-updated', gameState.customPoints);
  }));

  socket.on('set-lightning-rounds', safe((n) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') return;
    const val = Math.round(Number(n));
    if (!Number.isFinite(val)) return;
    gameState.lightningRounds = Math.min(MAX_LIGHTNING_ROUNDS, Math.max(0, val));
    io.to('host').emit('lightning-rounds-updated', gameState.lightningRounds);
  }));

  socket.on('set-roulette-duration', safe((ms) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') return;
    const val = Math.round(Number(ms));
    if (!Number.isFinite(val)) return;
    gameState.rouletteDuration = Math.min(MAX_ROULETTE_DURATION, Math.max(MIN_ROULETTE_DURATION, val));
    io.to('host').emit('roulette-duration-updated', gameState.rouletteDuration);
  }));

  socket.on('set-manual-timer', safe((value) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') return;
    gameState.manualTimerStart = !!value;
    io.to('host').emit('manual-timer-updated', gameState.manualTimerStart);
  }));

  socket.on('host-start-timer', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'question') return;
    if (!gameState.manualTimerStart) return;
    if (gameState.timerRunning) return;

    gameState.timerRunning = true;
    gameState.startedAt = Date.now();

    io.to('host').emit('timer-started', { startedAt: gameState.startedAt });
    io.to('display').emit('timer-started', { startedAt: gameState.startedAt });
    Object.keys(players).forEach(id => io.to(id).emit('timer-started', { startedAt: gameState.startedAt }));

    emitPlayerQuestions();
  }));

  // ✅ Host clicks "Start Roulette"
  socket.on('host-start-roulette', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'ended') return;

    const payload = buildRoulettePayload();
    if (payload.players.length === 0 || payload.winners.length === 0) {
      socket.emit('roulette-error', { message: 'No players or winners to display.' });
      return;
    }

    gameState.lastLeaderboard = payload.leaderboard;
    gameState.lastPlayers = payload.players;
    gameState.lastWinners = payload.winners;

    io.to('display').emit('roulette-reveal', {
      players: payload.players,
      winners: payload.winners,
      leaderboard: payload.leaderboard,
      duration: gameState.rouletteDuration
    });

    console.log(`🎲 Roulette started — ${payload.players.length} players, ${payload.winners.length} winner(s)`);
  }));

  // ✅ NEW: Host clicks "Close Roulette"
  socket.on('host-close-roulette', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    io.to('display').emit('roulette-close');
    console.log('✕ Roulette closed');
  }));

  socket.on('toggle-show-scores', safe((value) => {
    if (!hostSockets.has(socket.id)) return;
    gameState.showScoresToPlayers = !!value;
    io.to('host').emit('show-scores-updated', gameState.showScoresToPlayers);
  }));

  socket.on('start-quiz', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    if (Object.keys(players).length === 0) return;
    if (gameState.status !== 'lobby') return;
    if (shuffleQuestions) GAME_QUESTIONS = shuffleArray(GAME_QUESTIONS);
    if (GAME_QUESTIONS.length === 0) {
      socket.emit('quiz-error', { message: 'No game questions found.' });
      return;
    }
    gameState.currentQuestion = 0;
    beginQuestionSequence();
  }));

  socket.on('toggle-question-on-phone', safe((value) => {
    if (!hostSockets.has(socket.id)) return;
    gameState.showQuestionOnPhone = !!value;
    io.to('host').emit('toggle-updated', gameState.showQuestionOnPhone);
    io.emit('question-toggle', gameState.showQuestionOnPhone);
  }));

  socket.on('reveal-answer', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'question') return;
    if (gameState.manualTimerStart && !gameState.timerRunning) {
      socket.emit('reveal-blocked', { message: 'Start the timer first.' });
      return;
    }
    clearPendingTimer();
    gameState.status = 'reveal';

    const isLightning = isLightningQuestion(gameState.currentQuestion);

    if (isLightning) {
      const results = {};
      Object.entries(players).forEach(([id, p]) => {
        const assignedQ = gameState.playerQuestionMap[id];
        if (!assignedQ) {
          results[id] = { isCorrect: false, points: 0, score: p.score, streak: p.streak };
          return;
        }
        const entry = gameState.answersThisRound[id];
        const isChoice = assignedQ.kind !== 'identification';
        let isCorrect, ans;
        if (isChoice) {
          ans = entry ? entry.index : undefined;
          isCorrect = ans === assignedQ.correct;
        } else {
          ans = entry ? entry.text : undefined;
          isCorrect = ans !== undefined ? isIdentificationCorrect(ans, assignedQ) : false;
        }
        const streakBefore = p.streak || 0;
        const { points } = computePoints(isCorrect, entry ? entry.at : gameState.startedAt, streakBefore, assignedQ.round || 1, assignedQ.kind);
        p.score += points;
        p.streak = isCorrect ? streakBefore + 1 : 0;
        if (p.persistentId && persistentPlayers[p.persistentId]) {
          persistentPlayers[p.persistentId].score = p.score;
          persistentPlayers[p.persistentId].streak = p.streak;
          persistentPlayers[p.persistentId].lastAnswer = ans;
        }
        results[id] = { isCorrect, points, score: p.score, streak: p.streak, ans, assignedQ };
      });

      Object.entries(results).forEach(([id, r]) => {
        const q = r.assignedQ;
        if (!q) return;
        const isChoice = q.kind !== 'identification';
        const correctText = isChoice ? q.options[q.correct] : q.answer;
        let playerCorrectPos = null;
        let playerAnswerPos = r.ans;
        const p = players[id];
        if (isChoice && p) {
          playerCorrectPos = p.shuffleMap ? p.shuffleMap.indexOf(q.correct) : q.correct;
          playerAnswerPos = (r.ans !== undefined && r.ans !== null && p.shuffleMap)
            ? p.shuffleMap.indexOf(r.ans) : null;
        }
        const payload = {
          kind: q.kind, isCorrect: r.isCorrect,
          correctIndex: playerCorrectPos, correctText,
          yourAnswer: playerAnswerPos,
          pointsEarned: r.points, isLightning: true
        };
        if (gameState.showScoresToPlayers) {
          payload.score = r.score; payload.streak = r.streak; payload.rank = getRank(r.score);
        }
        io.to(id).emit('result', payload);
      });

      io.to('host').emit('reveal', {
        kind: 'lightning', correctIndex: null,
        correctText: '⚡ Lightning Round complete',
        counts: null, identStats: null,
        leaderboard: getLeaderboard(),
        round: GAME_QUESTIONS[gameState.currentQuestion].round || 1,
        quizMode: gameState.quizMode, isLightning: true
      });
      io.to('display').emit('reveal-display', {
        kind: 'lightning', correctIndex: null,
        correctText: '⚡ Lightning Round complete',
        options: null, counts: null, identStats: null,
        round: GAME_QUESTIONS[gameState.currentQuestion].round || 1,
        quizMode: gameState.quizMode, isLightning: true
      });
      saveStateSoon();
      return;
    }

    const q = GAME_QUESTIONS[gameState.currentQuestion];
    const isChoice = q.kind !== 'identification';
    const correctIndex = isChoice ? q.correct : null;
    const correctText = isChoice ? q.options[q.correct] : q.answer;
    const qRound = q.round || 1;

    const results = {};
    let identCorrectCount = 0;
    let identAnsweredCount = 0;

    Object.entries(players).forEach(([id, p]) => {
      const entry = gameState.answersThisRound[id];
      let isCorrect, ans;
      if (isChoice) {
        ans = entry ? entry.index : undefined;
        isCorrect = ans === correctIndex;
      } else {
        ans = entry ? entry.text : undefined;
        isCorrect = ans !== undefined ? isIdentificationCorrect(ans, q) : false;
        if (ans !== undefined) {
          identAnsweredCount++;
          if (isCorrect) identCorrectCount++;
        }
      }
      const streakBefore = p.streak || 0;
      const { points } = computePoints(isCorrect, entry ? entry.at : gameState.startedAt, streakBefore, qRound, q.kind);
      p.score += points;
      p.streak = isCorrect ? streakBefore + 1 : 0;
      if (p.persistentId && persistentPlayers[p.persistentId]) {
        persistentPlayers[p.persistentId].score = p.score;
        persistentPlayers[p.persistentId].streak = p.streak;
        persistentPlayers[p.persistentId].lastAnswer = ans;
      }
      let playerCorrectPos = null;
      let playerAnswerPos = ans;
      if (isChoice) {
        playerCorrectPos = p.shuffleMap ? p.shuffleMap.indexOf(correctIndex) : correctIndex;
        playerAnswerPos = (ans !== undefined && ans !== null && p.shuffleMap) ? p.shuffleMap.indexOf(ans) : null;
      }
      results[id] = { isCorrect, playerCorrectPos, playerAnswerPos, score: p.score, streak: p.streak, points, ans };
    });

    const counts = isChoice ? getCounts() : null;

    Object.entries(results).forEach(([id, r]) => {
      const payload = {
        kind: q.kind, isCorrect: r.isCorrect,
        correctIndex: r.playerCorrectPos, correctText,
        yourAnswer: r.playerAnswerPos, pointsEarned: r.points
      };
      if (gameState.showScoresToPlayers) {
        payload.score = r.score; payload.streak = r.streak; payload.rank = getRank(r.score);
      }
      io.to(id).emit('result', payload);
    });

    io.to('host').emit('reveal', {
      kind: q.kind, correctIndex, correctText, counts,
      identStats: isChoice ? null : { correct: identCorrectCount, answered: identAnsweredCount },
      leaderboard: getLeaderboard(),
      round: qRound, quizMode: gameState.quizMode, isLightning: false
    });

    io.to('display').emit('reveal-display', {
      kind: q.kind, correctIndex, correctText,
      options: isChoice ? q.options : null,
      counts,
      identStats: isChoice ? null : { correct: identCorrectCount, answered: identAnsweredCount, total: Object.keys(players).length },
      round: qRound, quizMode: gameState.quizMode, isLightning: false
    });

    saveStateSoon();
  }));

  socket.on('next-question', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'reveal') return;

    if (gameState.currentQuestion + 1 < TOTAL_QUESTIONS) {
      gameState.currentQuestion++;
      beginQuestionSequence();
    } else {
      gameState.status = 'ended';
      const leaderboard = getLeaderboard();
      const ties = gameState.quizMode === 'quizbee' ? detectTies() : [];

      const payload = buildRoulettePayload();
      gameState.lastLeaderboard = payload.leaderboard;
      gameState.lastPlayers = payload.players;
      gameState.lastWinners = payload.winners;

      io.to('host').emit('game-ended', {
        leaderboard, ties, quizMode: gameState.quizMode,
        hadLightning: gameState.lightningRounds > 0,
        hasPlayers: payload.players.length > 0 && payload.winners.length > 0
      });

      io.to('display').emit('roulette-waiting', {
        message: 'Waiting for host to start the roulette...'
      });

      Object.entries(players).forEach(([id, p]) => {
        io.to(id).emit('personal-final', { score: p.score, rank: getRank(p.score) });
      });
      saveStateSoon();
    }
  }));

  socket.on('show-results', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    const leaderboard = getLeaderboard();
    io.to('display').emit('show-results-display', { leaderboard });
    io.to('host').emit('results-shown');
  }));

  socket.on('start-tiebreaker', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.quizMode !== 'quizbee') return;
    if (gameState.status !== 'ended') return;
    if (CLINCHER_QUESTIONS.length === 0) {
      socket.emit('tiebreaker-error', { message: 'No clincher questions found.' });
      return;
    }
    const ties = detectTies();
    if (ties.length === 0) {
      socket.emit('tiebreaker-error', { message: 'No ties detected.' });
      return;
    }
    const targetTie = ties[0];
    const tiedPids = targetTie.players.map(p => p.persistentId).filter(Boolean);

    gameState.status = 'tiebreaker';
    gameState.tieBreaker = {
      active: true, isSpeedRound: false,
      participants: tiedPids,
      questions: shuffleArray(CLINCHER_QUESTIONS),
      currentIndex: -1, answers: {}, eliminated: [], winner: null,
      targetRank: targetTie.rank, targetScore: targetTie.score
    };

    io.to('host').emit('tiebreaker-started', {
      participants: targetTie.players, rank: targetTie.rank, score: targetTie.score
    });
    io.to('display').emit('tiebreaker-started-display', {
      participants: targetTie.players, rank: targetTie.rank, score: targetTie.score
    });
    Object.entries(players).forEach(([sid, p]) => {
      const isParticipant = tiedPids.includes(p.persistentId);
      io.to(sid).emit('tiebreaker-notice', { isParticipant, participants: targetTie.players });
    });
    setTimeout(() => startTieBreakerQuestion(), 2000);
  }));

  socket.on('next-tiebreaker-question', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'tiebreaker') return;
    if (!gameState.tieBreaker.active) return;
    if (gameState.tieBreaker.isSpeedRound) return;
    startTieBreakerQuestion();
  }));

  socket.on('kick-player', safe((targetId) => {
    if (!hostSockets.has(socket.id)) return;
    const entry = Object.entries(players).find(
      ([sid, p]) => sid === targetId || p.persistentId === targetId
    );
    if (!entry) return;
    const [sid, p] = entry;
    io.to(sid).emit('kicked');
    io.sockets.sockets.get(sid)?.disconnect(true);
    if (p.persistentId && persistentPlayers[p.persistentId]) delete persistentPlayers[p.persistentId];
    delete players[sid];
    delete gameState.answersThisRound[sid];
    delete gameState.playerQuestionMap[sid];
    io.to('host').emit('player-list', getPlayerList());
    saveStateSoon();
  }));

  socket.on('new-game', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    clearPendingTimer();
    const keepSettings = {
      questionDuration: gameState.questionDuration,
      showQuestionOnPhone: gameState.showQuestionOnPhone,
      showScoresToPlayers: gameState.showScoresToPlayers,
      quizMode: gameState.quizMode,
      schoolScoring: gameState.schoolScoring,
      schoolFlatPoints: gameState.schoolFlatPoints,
      customPoints: gameState.customPoints,
      roundDurations: gameState.roundDurations,
      lightningRounds: gameState.lightningRounds,
      rouletteDuration: gameState.rouletteDuration,
      manualTimerStart: gameState.manualTimerStart
    };
    gameState = {
      status: 'lobby',
      currentQuestion: -1,
      startedAt: null,
      countdownEndsAt: null,
      answersThisRound: {},
      playerQuestionMap: {},
      usedQuestionIds: new Set(),
      timerRunning: false,
      lastLeaderboard: [],
      lastPlayers: [],
      lastWinners: [],
      tieBreaker: {
        active: false, isSpeedRound: false,
        participants: [], questions: [], currentIndex: -1,
        answers: {}, eliminated: [], winner: null, targetRank: 1, targetScore: 0
      },
      ...keepSettings
    };
    Object.values(players).forEach(p => {
      p.score = 0; p.streak = 0; p.lastAnswer = null; p.hasAnswered = false;
      p.assignedQuestionId = null;
    });
    Object.values(persistentPlayers).forEach(p => { p.score = 0; p.streak = 0; p.lastAnswer = null; });
    io.emit('reset');
    io.to('host').emit('player-list', getPlayerList());
    io.to('host').emit('editor-data', buildEditorPayload());
    saveStateSoon();
  }));

  socket.on('submit-answer', safe((payload) => {
    if (gameState.status === 'tiebreaker') {
      handleTieBreakerAnswer(socket.id, payload);
      return;
    }
    if (gameState.status !== 'question') return;
    if (gameState.manualTimerStart && !gameState.timerRunning) return;

    const p = players[socket.id];
    if (!p) return;

    const isLightning = isLightningQuestion(gameState.currentQuestion);
    let q;
    if (isLightning) {
      q = gameState.playerQuestionMap[socket.id];
      if (!q) return;
    } else {
      q = GAME_QUESTIONS[gameState.currentQuestion];
    }

    const elapsed = (Date.now() - gameState.startedAt) / 1000;
    if (elapsed > gameState.questionDuration) return;

    if (q.kind === 'identification') {
      const text = String(payload || '').trim().slice(0, 120);
      if (!text) return;
      p.lastAnswer = text;
      p.hasAnswered = true;
      gameState.answersThisRound[socket.id] = { text, at: Date.now() };
      socket.emit('answer-locked', { text });
    } else {
      const idx = Number(payload);
      if (!Number.isInteger(idx) || idx < 0 || idx > 3) return;
      const originalIndex = p.shuffleMap ? p.shuffleMap[idx] : idx;
      if (originalIndex === undefined) return;
      p.lastAnswer = originalIndex;
      p.hasAnswered = true;
      gameState.answersThisRound[socket.id] = { index: originalIndex, at: Date.now() };
      socket.emit('answer-locked', { optionIndex: idx });
    }

    const answered = Object.keys(gameState.answersThisRound).length;
    const total = Object.keys(players).length;
    io.to('host').emit('answer-count-update', { answered, total });
    if (answered >= total && total > 0) io.to('host').emit('all-answered');
  }));

  socket.on('player-reaction', safe((emoji) => {
    const p = players[socket.id];
    if (!p) return;
    if (!VALID_REACTIONS.includes(emoji)) return;
    const now = Date.now();
    if (now - (p.lastReactionAt || 0) < REACTION_COOLDOWN) return;
    p.lastReactionAt = now;
    io.to('display').emit('reaction', { emoji: emoji, avatar: p.avatar || '🐶', name: p.name });
  }));

  socket.on('editor-get', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    socket.emit('editor-data', buildEditorPayload());
  }));

  socket.on('editor-save', safe((payload) => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') {
      socket.emit('editor-error', { message: 'Editing is locked while a game is in progress.' });
      return;
    }
    const list = payload && Array.isArray(payload.questions) ? payload.questions : null;
    if (!list) {
      socket.emit('editor-error', { message: 'Invalid payload — expected { questions: [...] }.' });
      return;
    }
    const errors = validateQuestionsArray(list);
    if (errors.length > 0) {
      socket.emit('editor-error', { message: 'Validation failed.', errors });
      return;
    }
    const normalized = list.map(q => {
      const n = normalizeQuestion(q);
      return {
        id: n.id, type: n.type, round: n.round, clincher: n.clincher, question: n.question,
        ...(n.kind === 'truefalse' ? { correct: n.correct === 0 } : {}),
        ...(n.kind === 'mcq' ? { options: n.options, correct: n.correct } : {}),
        ...(n.kind === 'identification' ? { answer: n.answer, acceptable: n.acceptable } : {})
      };
    });
    try {
      fs.mkdirSync(path.dirname(CUSTOM_QUESTIONS_FILE), { recursive: true });
      fs.writeFileSync(CUSTOM_QUESTIONS_FILE, JSON.stringify({ questions: normalized }, null, 2));
    } catch (err) {
      socket.emit('editor-error', { message: 'Could not write custom-questions.json: ' + err.message });
      return;
    }
    reloadQuestions();
    UNIQUE_ROUNDS.forEach(r => {
      if (!Number.isFinite(gameState.roundDurations[r])) gameState.roundDurations[r] = DEFAULT_DURATION;
    });
    io.to('host').emit('editor-data', buildEditorPayload());
    io.to('host').emit('editor-saved', { ok: true, count: normalized.length });
    io.to('host').emit('state', {
      status: gameState.status, currentQuestion: gameState.currentQuestion,
      total: TOTAL_QUESTIONS, players: getPlayerList(),
      showQuestionOnPhone: gameState.showQuestionOnPhone,
      showScoresToPlayers: gameState.showScoresToPlayers,
      questionDuration: gameState.questionDuration,
      quizMode: gameState.quizMode,
      schoolScoring: gameState.schoolScoring,
      schoolFlatPoints: gameState.schoolFlatPoints,
      customPoints: gameState.customPoints,
      lightningRounds: gameState.lightningRounds,
      rouletteDuration: gameState.rouletteDuration,
      manualTimerStart: gameState.manualTimerStart,
      uniqueRounds: UNIQUE_ROUNDS,
      roundDurations: gameState.roundDurations
    });
  }));

  socket.on('editor-revert', safe(() => {
    if (!hostSockets.has(socket.id)) return;
    if (gameState.status !== 'lobby') {
      socket.emit('editor-error', { message: 'Editing is locked while a game is in progress.' });
      return;
    }
    try {
      if (fs.existsSync(CUSTOM_QUESTIONS_FILE)) fs.unlinkSync(CUSTOM_QUESTIONS_FILE);
    } catch (err) {
      socket.emit('editor-error', { message: 'Could not delete custom file: ' + err.message });
      return;
    }
    reloadQuestions();
    io.to('host').emit('editor-data', buildEditorPayload());
    io.to('host').emit('editor-saved', { ok: true, count: QUESTIONS.length, reverted: true });
    io.to('host').emit('state', {
      status: gameState.status, currentQuestion: gameState.currentQuestion,
      total: TOTAL_QUESTIONS, players: getPlayerList(),
      showQuestionOnPhone: gameState.showQuestionOnPhone,
      showScoresToPlayers: gameState.showScoresToPlayers,
      questionDuration: gameState.questionDuration,
      quizMode: gameState.quizMode,
      schoolScoring: gameState.schoolScoring,
      schoolFlatPoints: gameState.schoolFlatPoints,
      customPoints: gameState.customPoints,
      lightningRounds: gameState.lightningRounds,
      rouletteDuration: gameState.rouletteDuration,
      manualTimerStart: gameState.manualTimerStart,
      uniqueRounds: UNIQUE_ROUNDS,
      roundDurations: gameState.roundDurations
    });
  }));

  socket.on('editor-set-shuffle', safe((value) => {
    if (!hostSockets.has(socket.id)) return;
    shuffleQuestions = !!value;
    io.to('host').emit('shuffle-updated', { shuffleQuestions });
  }));

  socket.on('disconnect', safe(() => {
    hostSockets.delete(socket.id);
    hostAttempts.delete(socket.id);
    if (players[socket.id]) {
      const pid = players[socket.id].persistentId;
      const playerName = players[socket.id].name;
      if (pid && persistentPlayers[pid]) {
        persistentPlayers[pid].socketId = null;
        persistentPlayers[pid].status = 'offline';
      }
      console.log(`👋 ${playerName} disconnected`);
      delete players[socket.id];
      delete gameState.answersThisRound[socket.id];
      delete gameState.playerQuestionMap[socket.id];
      io.to('host').emit('player-list', getPlayerList());
      saveStateSoon();
    }
  }));
});

loadState();
server.listen(PORT, () => {
  console.log('');
  console.log('⚡ KwizKamp server running!');
  console.log(`  🎓 Host:     http://localhost:${PORT}/host`);
  console.log(`  🖥️  Display:  http://localhost:${PORT}/display`);
  console.log(`  📱 Player:   http://localhost:${PORT}/play`);
  console.log(`  🔑 Host PIN: ${HOST_PASSWORD}`);
  console.log('');
});

function shutdown() {
  console.log('\n💾 Saving state before exit...');
  saveStateNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
