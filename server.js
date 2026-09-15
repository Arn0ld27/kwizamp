const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
// ---------- LOAD QUESTIONS ----------
const questionsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf-8')
);
const QUESTIONS = questionsData.questions;
const TOTAL_QUESTIONS = QUESTIONS.length;

// ---------- STATE ----------
let players = {};            // { socketId: { name, avatar, score, lastAnswer, hasAnswered, persistentId, shuffleMap, correctPosition, status, lastReactionAt } }
let persistentPlayers = {};  // { persistentId: { name, avatar, score, socketId, lastAnswer, joinedAt, status } }

let gameState = {
  status: 'lobby',
  currentQuestion: -1,
  startedAt: null,
  questionDuration: 20,
  answersThisRound: {},
  showQuestionOnPhone: true
};

// Reaction rate limit: 2 seconds
const REACTION_COOLDOWN = 2000;
const VALID_REACTIONS = ['👍', '❤️', '😂', '🎉', '🔥', '😮'];

// ---------- STATIC ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- ROUTES ----------
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));

// ---------- HELPERS ----------
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
    status: p.status || 'online'
  }));
}

function getLeaderboard() {
  return Object.values(players)
    .map(p => ({ name: p.name, avatar: p.avatar || '🐶', score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function getRank(score) {
  const sorted = Object.values(players).map(p => p.score).sort((a, b) => b - a);
  const idx = sorted.indexOf(score);
  return idx === -1 ? '-' : idx + 1;
}

function getCounts() {
  const counts = [0, 0, 0, 0];
  Object.values(gameState.answersThisRound).forEach(idx => {
    if (typeof idx === 'number' && idx >= 0 && idx < 4) counts[idx]++;
  });
  return counts;
}

function createPlayerQuestion(question) {
  const indices = [0, 1, 2, 3];
  const shuffled = shuffleArray(indices);
  return {
    options: shuffled.map(i => question.options[i]),
    map: shuffled,
    correctPosition: shuffled.indexOf(question.correct)
  };
}

function broadcastQuestion() {
  const q = QUESTIONS[gameState.currentQuestion];

  io.to('host').emit('question-host', {
    index: gameState.currentQuestion,
    total: TOTAL_QUESTIONS,
    question: q.question,
    options: q.options,
    duration: gameState.questionDuration,
    startedAt: gameState.startedAt,
    answered: 0,
    totalPlayers: Object.keys(players).length,
    showQuestionOnPhone: gameState.showQuestionOnPhone
  });

  io.to('display').emit('question-display', {
    index: gameState.currentQuestion,
    total: TOTAL_QUESTIONS,
    question: q.question,
    duration: gameState.questionDuration,
    startedAt: gameState.startedAt
  });

  Object.entries(players).forEach(([socketId, player]) => {
    const shuffled = createPlayerQuestion(q);
    player.shuffleMap = shuffled.map;
    player.correctPosition = shuffled.correctPosition;

    io.to(socketId).emit('question', {
      index: gameState.currentQuestion,
      total: TOTAL_QUESTIONS,
      question: q.question,
      options: shuffled.options,
      duration: gameState.questionDuration,
      startedAt: gameState.startedAt,
      showQuestionOnPhone: gameState.showQuestionOnPhone
    });
  });
}

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ---------- HOST ----------
  socket.on('host-join', () => {
    socket.join('host');
    socket.emit('state', {
      status: gameState.status,
      currentQuestion: gameState.currentQuestion,
      total: TOTAL_QUESTIONS,
      players: getPlayerList(),
      showQuestionOnPhone: gameState.showQuestionOnPhone
    });
  });

  // ---------- DISPLAY ----------
  socket.on('display-join', () => {
    socket.join('display');
    socket.emit('display-state', {
      status: gameState.status,
      currentQuestion: gameState.currentQuestion,
      total: TOTAL_QUESTIONS
    });
  });

  // ---------- PLAYER JOIN ----------
  socket.on('player-join', (data) => {
    const payload = typeof data === 'string' ? { name: data } : data;
    const cleanName = String(payload.name || '').trim().slice(0, 20) || 'Anonymous';
    const avatar = String(payload.avatar || '🐶').slice(0, 4);
    const persistentId = payload.persistentId || null;

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
        persistentId: persistentId
      });


      if (gameState.status === 'question') {
        const q = QUESTIONS[gameState.currentQuestion];
        const shuffled = createPlayerQuestion(q);
        players[socket.id].shuffleMap = shuffled.map;
        players[socket.id].correctPosition = shuffled.correctPosition;

        socket.emit('question', {
          index: gameState.currentQuestion,
          total: TOTAL_QUESTIONS,
          question: q.question,
          options: shuffled.options,
          duration: gameState.questionDuration,
          startedAt: gameState.startedAt,
          showQuestionOnPhone: gameState.showQuestionOnPhone
        });

        if (gameState.answersThisRound[socket.id] !== undefined) {
          players[socket.id].hasAnswered = true;
          players[socket.id].lastAnswer = gameState.answersThisRound[socket.id];
          const clickedPos = shuffled.map.indexOf(gameState.answersThisRound[socket.id]);
          socket.emit('answer-locked', { optionIndex: clickedPos });
        }
      } else if (gameState.status === 'reveal') {
        const q = QUESTIONS[gameState.currentQuestion];
        const ans = existing.lastAnswer;
        socket.emit('result', {
          isCorrect: ans === q.correct,
          correctIndex: q.correct,
          yourAnswer: ans,
          score: existing.score,
          rank: getRank(existing.score),
          counts: getCounts()
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
      return;
    }


    const newPersistentId = persistentId || `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    players[socket.id] = {
      name: cleanName,
      avatar: avatar,
      score: 0,
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
      persistentId: newPersistentId
    });

    if (gameState.status === 'question') {
      const q = QUESTIONS[gameState.currentQuestion];
      const shuffled = createPlayerQuestion(q);
      players[socket.id].shuffleMap = shuffled.map;
      players[socket.id].correctPosition = shuffled.correctPosition;
      socket.emit('question', {
        index: gameState.currentQuestion,
        total: TOTAL_QUESTIONS,
        question: q.question,
        options: shuffled.options,
        duration: gameState.questionDuration,
        startedAt: gameState.startedAt,
        showQuestionOnPhone: gameState.showQuestionOnPhone
      });
    } else {
      socket.emit('waiting');
    }

    io.to('host').emit('player-list', getPlayerList());
  });


  socket.on('start-quiz', () => {
    if (Object.keys(players).length === 0) return;
    gameState.status = 'question';
    gameState.currentQuestion = 0;
    gameState.answersThisRound = {};
    gameState.startedAt = Date.now();

    Object.values(players).forEach(p => {
      p.hasAnswered = false;
      p.lastAnswer = null;
    });

    broadcastQuestion();
  });


  socket.on('toggle-question-on-phone', (value) => {
    gameState.showQuestionOnPhone = !!value;
    io.to('host').emit('toggle-updated', gameState.showQuestionOnPhone);
    io.emit('question-toggle', gameState.showQuestionOnPhone);
  });


  socket.on('reveal-answer', () => {
    if (gameState.status !== 'question') return;
    gameState.status = 'reveal';

    const q = QUESTIONS[gameState.currentQuestion];
    const correctIndex = q.correct;

    const results = {};
    Object.entries(players).forEach(([id, p]) => {
      const ans = gameState.answersThisRound[id];
      const isCorrect = ans === correctIndex;
      if (isCorrect) p.score += 1;

      if (p.persistentId && persistentPlayers[p.persistentId]) {
        persistentPlayers[p.persistentId].score = p.score;
        persistentPlayers[p.persistentId].lastAnswer = ans;
      }

      const playerCorrectPos = p.shuffleMap ? p.shuffleMap.indexOf(correctIndex) : correctIndex;
      const playerAnswerPos = (ans !== undefined && ans !== null && p.shuffleMap)
        ? p.shuffleMap.indexOf(ans) : null;

      results[id] = { isCorrect, playerCorrectPos, playerAnswerPos, score: p.score, ans };
    });

    const counts = getCounts();

    Object.entries(results).forEach(([id, r]) => {
      io.to(id).emit('result', {
        isCorrect: r.isCorrect,
        correctIndex: r.playerCorrectPos,
        yourAnswer: r.playerAnswerPos,
        score: r.score,
        rank: getRank(r.score),
        counts
      });
    });

    io.to('host').emit('reveal', {
      correctIndex,
      counts,
      leaderboard: getLeaderboard()
    });

    io.to('display').emit('reveal-display', {
      correctIndex,
      correctText: q.options[correctIndex],
      options: q.options,
      counts
    });
  });


  socket.on('next-question', () => {
    if (gameState.status !== 'reveal') return;

    if (gameState.currentQuestion + 1 < TOTAL_QUESTIONS) {
      gameState.currentQuestion++;
      gameState.status = 'question';
      gameState.answersThisRound = {};
      gameState.startedAt = Date.now();

      Object.values(players).forEach(p => {
        p.hasAnswered = false;
        p.lastAnswer = null;
      });

      broadcastQuestion();
    } else {
      gameState.status = 'ended';
      io.to('host').emit('game-ended', { leaderboard: getLeaderboard() });
      io.to('display').emit('game-ended-display');
      Object.entries(players).forEach(([id, p]) => {
        io.to(id).emit('personal-final', {
          score: p.score,
          rank: getRank(p.score)
        });
      });
    }
  });


  socket.on('show-results', () => {
    const leaderboard = getLeaderboard();
    io.to('display').emit('show-results-display', { leaderboard });
    io.to('host').emit('results-shown');
  });


  socket.on('new-game', () => {
    gameState = {
      status: 'lobby',
      currentQuestion: -1,
      startedAt: null,
      questionDuration: 20,
      answersThisRound: {},
      showQuestionOnPhone: gameState.showQuestionOnPhone
    };
    Object.values(players).forEach(p => {
      p.score = 0;
      p.lastAnswer = null;
      p.hasAnswered = false;
    });
    Object.values(persistentPlayers).forEach(p => {
      p.score = 0;
      p.lastAnswer = null;
    });
    io.emit('reset');
    io.to('host').emit('player-list', getPlayerList());
  });

  // ---------- PLAYER: SUBMIT/CHANGE ANSWER ----------
  socket.on('submit-answer', (clickedIndex) => {
    if (gameState.status !== 'question') return;
    const p = players[socket.id];
    if (!p) return;

    const elapsed = (Date.now() - gameState.startedAt) / 1000;
    if (elapsed > gameState.questionDuration) return;

    const originalIndex = p.shuffleMap ? p.shuffleMap[clickedIndex] : clickedIndex;

    p.lastAnswer = originalIndex;
    p.hasAnswered = true;
    gameState.answersThisRound[socket.id] = originalIndex;

    socket.emit('answer-locked', { optionIndex: clickedIndex });

    const answered = Object.keys(gameState.answersThisRound).length;
    const total = Object.keys(players).length;

    io.to('host').emit('answer-count-update', { answered, total });

    if (answered >= total && total > 0) {
      io.to('host').emit('all-answered');
    }
  });

  // ---------- PLAYER: EMOJI REACTION ----------
  socket.on('player-reaction', (emoji) => {
    const p = players[socket.id];
    if (!p) return;
    if (!VALID_REACTIONS.includes(emoji)) return;

    const now = Date.now();
    if (now - (p.lastReactionAt || 0) < REACTION_COOLDOWN) return;
    p.lastReactionAt = now;

    // Broadcast sa display
    io.to('display').emit('reaction', {
      emoji: emoji,
      avatar: p.avatar || '🐶',
      name: p.name
    });
  });

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
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

      // I-broadcast yung updated list, pero yung score, preserved pa rin sa persistentPlayers
      io.to('host').emit('player-list', getPlayerList());
    }
  });
});

// ---------- START ----------
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
