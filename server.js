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

// ---------- LOAD QUESTIONS ----------
const questionsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf-8')
);

function getQuestionKind(q) {
  if (q.type === 'truefalse') return 'truefalse';
  if (q.type === 'identification') return 'identification';
  return 'mcq';
}

// Normalize true/false questions into the same {options, correct-index} shape
// mcq/truefalse both use, so the rest of the game logic can treat them alike.
const QUESTIONS = questionsData.questions.map(q => {
  const kind = getQuestionKind(q);
  if (kind === 'truefalse') {
    const correctIndex = typeof q.correct === 'boolean' ? (q.correct ? 0 : 1) : Number(q.correct);
    return { ...q, kind, options: ['True', 'False'], correct: correctIndex };
  }
  return { ...q, kind };
});
const TOTAL_QUESTIONS = QUESTIONS.length;

// ---------- SCORING ----------
const BASE_POINTS = 1000;
const MIN_POINTS = 500;
const STREAK_STEP = 0.1;   // +10% per consecutive correct answer
const STREAK_CAP = 0.5;    // capped at +50%
const COUNTDOWN_MS = 3000;
const DEFAULT_DURATION = 20;
const MIN_DURATION = 5;
const MAX_DURATION = 120;

// ---------- STATE ----------
let players = {};            // { socketId: {...} } — live connections only
let persistentPlayers = {};  // { persistentId: {...} } — survives reconnects & restarts

let gameState = {
  status: 'lobby',           // lobby | countdown | question | reveal | ended
  currentQuestion: -1,
  startedAt: null,
  countdownEndsAt: null,
  questionDuration: DEFAULT_DURATION,
  answersThisRound: {},       // { socketId: { index, at } }
  showQuestionOnPhone: true
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
            socketId: null,
            lastAnswer: null,
            joinedAt: p.joinedAt || Date.now(),
            status: 'offline'
          };
        });
        console.log(`💾 Restored ${Object.keys(persistentPlayers).length} camper record(s) from disk`);
      }
    }
  } catch (err) {
    console.error('⚠️  Could not load saved state, starting fresh:', err.message);
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

// ---------- STATIC ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- ROUTES ----------
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));

function csvField(val) {
  const str = String(val ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

app.get('/export-results.csv', (req, res) => {
  const rows = Object.values(persistentPlayers)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => [i + 1, p.name, p.avatar, p.score, p.status === 'online' ? 'online' : 'offline']);

  const header = ['Rank', 'Name', 'Avatar', 'Score', 'Status'];
  const lines = [header, ...rows].map(row => row.map(csvField).join(',')).join('\r\n');

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kwizkamp-results-${stamp}.csv"`);
  res.send('\uFEFF' + lines);
});

// ---------- HELPERS ----------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[.,'"!?;:()-]/g, '')
    .replace(/\s+/g, ' ');
}

function isIdentificationCorrect(rawText, q) {
  const given = normalizeText(rawText);
  if (!given) return false;
  const accepted = [q.answer, ...(Array.isArray(q.acceptable) ? q.acceptable : [])]
    .map(normalizeText)
    .filter(Boolean);
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
  return Object.values(players)
    .map(p => ({ name: p.name, avatar: p.avatar || '🐶', score: p.score, streak: p.streak || 0 }))
    .sort((a, b) => b.score - a.score);
}

function getRank(score) {
  const sorted = Object.values(players).map(p => p.score).sort((a, b) => b - a);
  const idx = sorted.indexOf(score);
  return idx === -1 ? '-' : idx + 1;
}

function getCounts() {
  const counts = [0, 0, 0, 0];
  Object.values(gameState.answersThisRound).forEach(entry => {
    const idx = entry && typeof entry.index === 'number' ? entry.index : null;
    if (idx !== null && idx >= 0 && idx < 4) counts[idx]++;
  });
  return counts;
}

function computePoints(isCorrect, answeredAt, streakBefore) {
  if (!isCorrect) return { points: 0, streakMultiplier: 1 };
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
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

function broadcastQuestion() {
  const q = QUESTIONS[gameState.currentQuestion];
  const duration = Number.isFinite(q.duration) ? q.duration : gameState.questionDuration;
  gameState.questionDuration = duration;
  const isChoice = q.kind !== 'identification';

  io.to('host').emit('question-host', {
    index: gameState.currentQuestion,
    total: TOTAL_QUESTIONS,
    question: q.question,
    kind: q.kind,
    options: isChoice ? q.options : null,
    duration,
    startedAt: gameState.startedAt,
    answered: 0,
    totalPlayers: Object.keys(players).length,
    showQuestionOnPhone: gameState.showQuestionOnPhone
  });

  io.to('display').emit('question-display', {
    index: gameState.currentQuestion,
    total: TOTAL_QUESTIONS,
    question: q.question,
    kind: q.kind,
    duration,
    startedAt: gameState.startedAt
  });

  Object.entries(players).forEach(([socketId, player]) => {
    if (isChoice) {
      const shuffled = createPlayerQuestion(q);
      player.shuffleMap = shuffled.map;
      player.correctPosition = shuffled.correctPosition;

      io.to(socketId).emit('question', {
        index: gameState.currentQuestion,
        total: TOTAL_QUESTIONS,
        question: q.question,
        kind: q.kind,
        options: shuffled.options,
        duration,
        startedAt: gameState.startedAt,
        showQuestionOnPhone: gameState.showQuestionOnPhone
      });
    } else {
      player.shuffleMap = null;
      player.correctPosition = null;

      io.to(socketId).emit('question', {
        index: gameState.currentQuestion,
        total: TOTAL_QUESTIONS,
        question: q.question,
        kind: q.kind,
        options: null,
        duration,
        startedAt: gameState.startedAt,
        showQuestionOnPhone: gameState.showQuestionOnPhone
      });
    }
  });
}

function beginQuestionSequence(isFirst) {
  clearPendingTimer();
  gameState.status = 'countdown';
  gameState.countdownEndsAt = Date.now() + COUNTDOWN_MS;

  const payload = {
    index: gameState.currentQuestion,
    total: TOTAL_QUESTIONS,
    countdownMs: COUNTDOWN_MS
  };
  io.to('host').emit('get-ready', payload);
  io.to('display').emit('get-ready', payload);
  Object.keys(players).forEach(id => io.to(id).emit('get-ready', payload));

  pendingTimer = setTimeout(() => {
    gameState.status = 'question';
    gameState.answersThisRound = {};
    gameState.startedAt = Date.now();
    if (isFirst) {
      Object.values(players).forEach(p => {
        p.hasAnswered = false;
        p.lastAnswer = null;
      });
    } else {
      Object.values(players).forEach(p => {
        p.hasAnswered = false;
        p.lastAnswer = null;
      });
    }
    broadcastQuestion();
  }, COUNTDOWN_MS);
}

// Wrap a socket handler so one bad payload can't crash the whole server
function safe(fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error('⚠️  Handler error:', err);
    }
  };
}

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ---------- HOST ----------
  socket.on('host-join', safe(() => {
    socket.join('host');
    socket.emit('state', {
      status: gameState.status,
      currentQuestion: gameState.currentQuestion,
      total: TOTAL_QUESTIONS,
      players: getPlayerList(),
      showQuestionOnPhone: gameState.showQuestionOnPhone,
      questionDuration: gameState.questionDuration
    });
  }));

  // ---------- DISPLAY ----------
  socket.on('display-join', safe(() => {
    socket.join('display');
    socket.emit('display-state', {
      status: gameState.status,
      currentQuestion: gameState.currentQuestion,
      total: TOTAL_QUESTIONS
    });
  }));

  // ---------- PLAYER JOIN ----------
  socket.on('player-join', safe((data) => {
    const payload = typeof data === 'string' ? { name: data } : (data || {});
    const cleanName = escapeHtml(String(payload.name || '').trim().slice(0, 20)) || 'Camper';
    const avatar = String(payload.avatar || '🐶').slice(0, 4);
    const persistentId = typeof payload.persistentId === 'string' ? payload.persistentId.slice(0, 64) : null;

    let existing = null;
    if (persistentId && persistentPlayers[persistentId]) {
      existing = persistentPlayers[persistentId];
    }

    // RECONNECT
    if (existing) {
      const oldId = existing.socketId;
      if (oldId && oldId !== socket.id && players[oldId]) delete players[oldId];

      existing.socketId = socket.id;
      existing.name = cleanName;
      existing.avatar = avatar;
      existing.status = 'online';

      players[socket.id] = {
        name: cleanName,
        avatar: avatar,
        score: existing.score,
        streak: existing.streak || 0,
        lastAnswer: null,
        hasAnswered: false,
        persistentId: persistentId,
        shuffleMap: null,
        correctPosition: null,
        status: 'online',
        lastReactionAt: 0
      };

      console.log(`🔄 ${cleanName} reconnected`);

      socket.emit('joined', {
        name: cleanName,
        avatar: avatar,
        playerId: socket.id,
        score: existing.score,
        streak: existing.streak || 0,
        persistentId: persistentId
      });

      if (gameState.status === 'countdown') {
        socket.emit('get-ready', {
          index: gameState.currentQuestion,
          total: TOTAL_QUESTIONS,
          countdownMs: Math.max(0, gameState.countdownEndsAt - Date.now())
        });
      } else if (gameState.status === 'question') {
        const q = QUESTIONS[gameState.currentQuestion];
        const isChoice = q.kind !== 'identification';
        const prevAnswer = gameState.answersThisRound[socket.id];

        if (isChoice) {
          const shuffled = createPlayerQuestion(q);
          players[socket.id].shuffleMap = shuffled.map;
          players[socket.id].correctPosition = shuffled.correctPosition;

          socket.emit('question', {
            index: gameState.currentQuestion,
            total: TOTAL_QUESTIONS,
            question: q.question,
            kind: q.kind,
            options: shuffled.options,
            duration: gameState.questionDuration,
            startedAt: gameState.startedAt,
            showQuestionOnPhone: gameState.showQuestionOnPhone
          });

          if (prevAnswer) {
            players[socket.id].hasAnswered = true;
            players[socket.id].lastAnswer = prevAnswer.index;
            const clickedPos = shuffled.map.indexOf(prevAnswer.index);
            socket.emit('answer-locked', { optionIndex: clickedPos });
          }
        } else {
          players[socket.id].shuffleMap = null;
          players[socket.id].correctPosition = null;

          socket.emit('question', {
            index: gameState.currentQuestion,
            total: TOTAL_QUESTIONS,
            question: q.question,
            kind: q.kind,
            options: null,
            duration: gameState.questionDuration,
            startedAt: gameState.startedAt,
            showQuestionOnPhone: gameState.showQuestionOnPhone
          });

          if (prevAnswer) {
            players[socket.id].hasAnswered = true;
            players[socket.id].lastAnswer = prevAnswer.text;
            socket.emit('answer-locked', { text: prevAnswer.text });
          }
        }
      } else if (gameState.status === 'reveal') {
        const q = QUESTIONS[gameState.currentQuestion];
        const isChoice = q.kind !== 'identification';
        const ans = existing.lastAnswer;
        const isCorrect = isChoice ? ans === q.correct : isIdentificationCorrect(ans, q);
        socket.emit('result', {
          kind: q.kind,
          isCorrect,
          correctIndex: isChoice ? q.correct : null,
          correctText: isChoice ? q.options[q.correct] : q.answer,
          yourAnswer: ans,
          score: existing.score,
          streak: existing.streak || 0,
          rank: getRank(existing.score),
          counts: isChoice ? getCounts() : null
        });
      } else if (gameState.status === 'ended') {
        socket.emit('personal-final', {
          score: existing.score,
          rank: getRank(existing.score)
        });
      } else {
        socket.emit('waiting');
      }

      io.to('host').emit('player-list', getPlayerList());
      saveStateSoon();
      return;
    }

    const newPersistentId = persistentId || `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    players[socket.id] = {
      name: cleanName,
      avatar: avatar,
      score: 0,
      streak: 0,
      lastAnswer: null,
      hasAnswered: false,
      persistentId: newPersistentId,
      shuffleMap: null,
      correctPosition: null,
      status: 'online',
      lastReactionAt: 0
    };

    persistentPlayers[newPersistentId] = {
      name: cleanName,
      avatar: avatar,
      score: 0,
      streak: 0,
      socketId: socket.id,
      lastAnswer: null,
      joinedAt: Date.now(),
      status: 'online'
    };

    console.log(`👤 ${cleanName} ${avatar} joined`);

    socket.emit('joined', {
      name: cleanName,
      avatar: avatar,
      playerId: socket.id,
      score: 0,
      streak: 0,
      persistentId: newPersistentId
    });

    if (gameState.status === 'countdown') {
      socket.emit('get-ready', {
        index: gameState.currentQuestion,
        total: TOTAL_QUESTIONS,
        countdownMs: Math.max(0, gameState.countdownEndsAt - Date.now())
      });
    } else if (gameState.status === 'question') {
      const q = QUESTIONS[gameState.currentQuestion];
      if (q.kind !== 'identification') {
        const shuffled = createPlayerQuestion(q);
        players[socket.id].shuffleMap = shuffled.map;
        players[socket.id].correctPosition = shuffled.correctPosition;
        socket.emit('question', {
          index: gameState.currentQuestion,
          total: TOTAL_QUESTIONS,
          question: q.question,
          kind: q.kind,
          options: shuffled.options,
          duration: gameState.questionDuration,
          startedAt: gameState.startedAt,
          showQuestionOnPhone: gameState.showQuestionOnPhone
        });
      } else {
        socket.emit('question', {
          index: gameState.currentQuestion,
          total: TOTAL_QUESTIONS,
          question: q.question,
          kind: q.kind,
          options: null,
          duration: gameState.questionDuration,
          startedAt: gameState.startedAt,
          showQuestionOnPhone: gameState.showQuestionOnPhone
        });
      }
    } else {
      socket.emit('waiting');
    }

    io.to('host').emit('player-list', getPlayerList());
    saveStateSoon();
  }));

  socket.on('set-duration', safe((seconds) => {
    if (gameState.status !== 'lobby') return;
    const val = Math.round(Number(seconds));
    if (!Number.isFinite(val)) return;
    gameState.questionDuration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, val));
    io.to('host').emit('duration-updated', gameState.questionDuration);
  }));

  socket.on('start-quiz', safe(() => {
    if (Object.keys(players).length === 0) return;
    if (gameState.status !== 'lobby') return;
    gameState.currentQuestion = 0;
    beginQuestionSequence(true);
  }));

  socket.on('toggle-question-on-phone', safe((value) => {
    gameState.showQuestionOnPhone = !!value;
    io.to('host').emit('toggle-updated', gameState.showQuestionOnPhone);
    io.emit('question-toggle', gameState.showQuestionOnPhone);
  }));

  socket.on('reveal-answer', safe(() => {
    if (gameState.status !== 'question') return;
    clearPendingTimer();
    gameState.status = 'reveal';

    const q = QUESTIONS[gameState.currentQuestion];
    const isChoice = q.kind !== 'identification';
    const correctIndex = isChoice ? q.correct : null;
    const correctText = isChoice ? q.options[q.correct] : q.answer;

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
      const { points } = computePoints(isCorrect, entry ? entry.at : gameState.startedAt, streakBefore);

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
        playerAnswerPos = (ans !== undefined && ans !== null && p.shuffleMap)
          ? p.shuffleMap.indexOf(ans) : null;
      }

      results[id] = { isCorrect, playerCorrectPos, playerAnswerPos, score: p.score, streak: p.streak, points, ans };
    });

    const counts = isChoice ? getCounts() : null;

    Object.entries(results).forEach(([id, r]) => {
      io.to(id).emit('result', {
        kind: q.kind,
        isCorrect: r.isCorrect,
        correctIndex: r.playerCorrectPos,
        correctText,
        yourAnswer: r.playerAnswerPos,
        score: r.score,
        streak: r.streak,
        pointsEarned: r.points,
        rank: getRank(r.score),
        counts
      });
    });

    io.to('host').emit('reveal', {
      kind: q.kind,
      correctIndex,
      correctText,
      counts,
      identStats: isChoice ? null : { correct: identCorrectCount, answered: identAnsweredCount },
      leaderboard: getLeaderboard()
    });

    io.to('display').emit('reveal-display', {
      kind: q.kind,
      correctIndex,
      correctText,
      options: isChoice ? q.options : null,
      counts,
      identStats: isChoice ? null : { correct: identCorrectCount, answered: identAnsweredCount, total: Object.keys(players).length }
    });

    saveStateSoon();
  }));

  socket.on('next-question', safe(() => {
    if (gameState.status !== 'reveal') return;

    if (gameState.currentQuestion + 1 < TOTAL_QUESTIONS) {
      gameState.currentQuestion++;
      beginQuestionSequence(false);
    } else {
      gameState.status = 'ended';
      io.to('host').emit('game-ended', { leaderboard: getLeaderboard() });
      io.to('display').emit('game-ended-display', { leaderboard: getLeaderboard() });
      Object.entries(players).forEach(([id, p]) => {
        io.to(id).emit('personal-final', {
          score: p.score,
          rank: getRank(p.score)
        });
      });
      saveStateSoon();
    }
  }));

  socket.on('show-results', safe(() => {
    const leaderboard = getLeaderboard();
    io.to('display').emit('show-results-display', { leaderboard });
    io.to('host').emit('results-shown');
  }));

  socket.on('kick-player', safe((targetId) => {
    const entry = Object.entries(players).find(
      ([sid, p]) => sid === targetId || p.persistentId === targetId
    );
    if (!entry) return;
    const [sid, p] = entry;

    io.to(sid).emit('kicked');
    io.sockets.sockets.get(sid)?.disconnect(true);

    if (p.persistentId && persistentPlayers[p.persistentId]) {
      delete persistentPlayers[p.persistentId];
    }
    delete players[sid];
    delete gameState.answersThisRound[sid];

    io.to('host').emit('player-list', getPlayerList());
    saveStateSoon();
  }));

  socket.on('new-game', safe(() => {
    clearPendingTimer();
    gameState = {
      status: 'lobby',
      currentQuestion: -1,
      startedAt: null,
      countdownEndsAt: null,
      questionDuration: gameState.questionDuration,
      answersThisRound: {},
      showQuestionOnPhone: gameState.showQuestionOnPhone
    };
    Object.values(players).forEach(p => {
      p.score = 0;
      p.streak = 0;
      p.lastAnswer = null;
      p.hasAnswered = false;
    });
    Object.values(persistentPlayers).forEach(p => {
      p.score = 0;
      p.streak = 0;
      p.lastAnswer = null;
    });
    io.emit('reset');
    io.to('host').emit('player-list', getPlayerList());
    saveStateSoon();
  }));

  // ---------- PLAYER: SUBMIT/CHANGE ANSWER ----------
  socket.on('submit-answer', safe((payload) => {
    if (gameState.status !== 'question') return;
    const p = players[socket.id];
    if (!p) return;

    const q = QUESTIONS[gameState.currentQuestion];
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

    if (answered >= total && total > 0) {
      io.to('host').emit('all-answered');
    }
  }));

  // ---------- PLAYER: EMOJI REACTION ----------
  socket.on('player-reaction', safe((emoji) => {
    const p = players[socket.id];
    if (!p) return;
    if (!VALID_REACTIONS.includes(emoji)) return;

    const now = Date.now();
    if (now - (p.lastReactionAt || 0) < REACTION_COOLDOWN) return;
    p.lastReactionAt = now;

    io.to('display').emit('reaction', {
      emoji: emoji,
      avatar: p.avatar || '🐶',
      name: p.name
    });
  }));

  // ---------- DISCONNECT ----------
  socket.on('disconnect', safe(() => {
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

      io.to('host').emit('player-list', getPlayerList());
      saveStateSoon();
    }
  }));
});

// ---------- STARTUP / SHUTDOWN ----------
loadState();

server.listen(PORT, () => {
  console.log('');
  console.log('⚡ KwizKamp server running!');
  console.log('');
  console.log(`  🎓 Host:     http://localhost:${PORT}/host`);
  console.log(`  🖥️  Display:  http://localhost:${PORT}/display`);
  console.log(`  📱 Player:   http://localhost:${PORT}/play`);
  console.log(`  🌐 Landing:  http://localhost:${PORT}/`);
  console.log('');
});

function shutdown() {
  console.log('\n💾 Saving state before exit...');
  saveStateNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
