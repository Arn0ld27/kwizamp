const socket = io();

document.getElementById('playUrl').textContent = `${location.origin}/play`;

// ---------- PIN GATE ----------
const hostGate = document.getElementById('hostGate');
const hostShell = document.getElementById('hostShell');
const pinForm = document.getElementById('pinForm');
const pinInput = document.getElementById('pinInput');
const pinError = document.getElementById('pinError');

pinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  socket.emit('host-join', pinInput.value.trim());
});

socket.on('connect', () => {
  const rememberedPin = sessionStorage.getItem('kwizkamp_host_pin');
  if (rememberedPin) socket.emit('host-join', rememberedPin);
});

socket.on('host-auth-ok', () => {
  sessionStorage.setItem('kwizkamp_host_pin', pinInput.value.trim() || sessionStorage.getItem('kwizkamp_host_pin'));
  hostGate.classList.add('hidden');
  hostShell.classList.remove('hidden');
});

socket.on('host-auth-failed', (data) => {
  pinError.classList.remove('hidden');
  pinError.textContent = data && data.locked
    ? 'Too many wrong attempts — reload the page to try again.'
    : 'Wrong PIN — try again.';
  pinInput.value = '';
  pinInput.focus();
});

// ---------- TAB SWITCHING ----------
const hostTabs = document.getElementById('hostTabs');
const tabGame = document.getElementById('tabGame');
const tabEditor = document.getElementById('tabEditor');

function switchTab(name) {
  [...hostTabs.children].forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  tabGame.classList.toggle('hidden', name !== 'game');
  tabEditor.classList.toggle('hidden', name !== 'editor');
  if (name === 'editor' && window.__editorOnShow) window.__editorOnShow();
}
hostTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.host-tab');
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

const stages = {
  lobby: document.getElementById('stageLobby'),
  getReady: document.getElementById('stageGetReady'),
  question: document.getElementById('stageQuestion'),
  reveal: document.getElementById('stageReveal'),
  ended: document.getElementById('stageEnded'),
  tiebreaker: document.getElementById('stageTieBreaker')
};
function showStage(name) {
  Object.values(stages).forEach(s => s.classList.add('hidden'));
  stages[name].classList.remove('hidden');
}

const statusPill = document.getElementById('statusPill');
const modePill = document.getElementById('modePill');
const startBtn = document.getElementById('startBtn');
const rosterList = document.getElementById('rosterList');
const rosterCount = document.getElementById('rosterCount');
const leaderboardMini = document.getElementById('leaderboardMini');
const progressFill = document.getElementById('progressFill');
const modeToggle = document.getElementById('modeToggle');
const durationRow = document.getElementById('durationRow');
const roundSlidersWrap = document.getElementById('roundSlidersWrap');
const roundSliders = document.getElementById('roundSliders');
const schoolScoringWrap = document.getElementById('schoolScoringWrap');
const schoolScoringToggle = document.getElementById('schoolScoringToggle');
const flatPointsWrap = document.getElementById('flatPointsWrap');
const flatPointsInput = document.getElementById('flatPointsInput');
const customPointsWrap = document.getElementById('customPointsWrap');
const customMcq = document.getElementById('customMcq');
const customTf = document.getElementById('customTf');
const customIdent = document.getElementById('customIdent');
const lightningInput = document.getElementById('lightningInput');
const rouletteInput = document.getElementById('rouletteInput');
const manualTimerToggle = document.getElementById('manualTimerToggle');
const manualTimerControls = document.getElementById('manualTimerControls');
const mtcStatus = document.getElementById('mtcStatus');
const startTimerBtn = document.getElementById('startTimerBtn');
const startRouletteBtn = document.getElementById('startRouletteBtn');
const closeRouletteBtn = document.getElementById('closeRouletteBtn');

let totalQuestions = 0;
let currentMode = 'school';
let uniqueRounds = [];
let roundDurations = {};

// ---------- MODE TOGGLE ----------
modeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (mode === currentMode) return;
  currentMode = mode;
  [...modeToggle.children].forEach(b => b.classList.toggle('active', b === btn));
  socket.emit('set-mode', mode);
});

function applyModeUI(mode) {
  currentMode = mode;
  [...modeToggle.children].forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  if (mode === 'quizbee') {
    durationRow.classList.add('hidden');
    schoolScoringWrap.classList.add('hidden');
    roundSlidersWrap.classList.remove('hidden');
    modePill.style.display = '';
    modePill.textContent = '🐝 Quiz Bee';
  } else {
    durationRow.classList.remove('hidden');
    schoolScoringWrap.classList.remove('hidden');
    roundSlidersWrap.classList.add('hidden');
    modePill.style.display = 'none';
  }
}

socket.on('mode-updated', applyModeUI);

// ---------- SCHOOL SCORING ----------
schoolScoringToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  const scoring = btn.dataset.scoring;
  [...schoolScoringToggle.children].forEach(b => b.classList.toggle('active', b === btn));
  socket.emit('set-school-scoring', scoring);
  updateScoringUI(scoring);
});

function updateScoringUI(mode) {
  flatPointsWrap.classList.toggle('hidden', mode !== 'flat');
  customPointsWrap.classList.toggle('hidden', mode !== 'custom');
}

socket.on('school-scoring-updated', (mode) => {
  [...schoolScoringToggle.children].forEach(b => {
    b.classList.toggle('active', b.dataset.scoring === mode);
  });
  updateScoringUI(mode);
});

// ---------- FLAT POINTS ----------
let flatPointsTimeout = null;
flatPointsInput.addEventListener('input', (e) => {
  clearTimeout(flatPointsTimeout);
  const val = Number(e.target.value);
  if (!Number.isFinite(val) || val < 1) return;
  flatPointsTimeout = setTimeout(() => socket.emit('set-school-flat-points', val), 400);
});
flatPointsInput.addEventListener('change', (e) => {
  clearTimeout(flatPointsTimeout);
  const val = Number(e.target.value);
  if (!Number.isFinite(val) || val < 1) return;
  socket.emit('set-school-flat-points', val);
});
socket.on('school-flat-points-updated', (val) => { flatPointsInput.value = val; });

// ---------- CUSTOM POINTS ----------
let customTimeout = null;
function pushCustomPoints() {
  clearTimeout(customTimeout);
  const data = {
    mcq: Number(customMcq.value),
    truefalse: Number(customTf.value),
    identification: Number(customIdent.value)
  };
  if (!Number.isFinite(data.mcq) || !Number.isFinite(data.truefalse) || !Number.isFinite(data.identification)) return;
  customTimeout = setTimeout(() => socket.emit('set-custom-points', data), 400);
}
[customMcq, customTf, customIdent].forEach(inp => {
  inp.addEventListener('input', pushCustomPoints);
  inp.addEventListener('change', pushCustomPoints);
});
socket.on('custom-points-updated', (data) => {
  customMcq.value = data.mcq;
  customTf.value = data.truefalse;
  customIdent.value = data.identification;
});

// ---------- LIGHTNING ----------
let lightningTimeout = null;
lightningInput.addEventListener('input', (e) => {
  clearTimeout(lightningTimeout);
  const val = Number(e.target.value);
  if (!Number.isFinite(val) || val < 0) return;
  lightningTimeout = setTimeout(() => socket.emit('set-lightning-rounds', val), 400);
});
lightningInput.addEventListener('change', (e) => {
  clearTimeout(lightningTimeout);
  const val = Number(e.target.value);
  if (!Number.isFinite(val) || val < 0) return;
  socket.emit('set-lightning-rounds', val);
});
socket.on('lightning-rounds-updated', (val) => { lightningInput.value = val; });

let rouletteTimeout = null;
rouletteInput.addEventListener('input', (e) => {
  clearTimeout(rouletteTimeout);
  const val = Number(e.target.value);
  if (!Number.isFinite(val) || val < 3000) return;
  rouletteTimeout = setTimeout(() => socket.emit('set-roulette-duration', val), 400);
});
rouletteInput.addEventListener('change', (e) => {
  clearTimeout(rouletteTimeout);
  const val = Number(e.target.value);
  if (!Number.isFinite(val) || val < 3000) return;
  socket.emit('set-roulette-duration', val);
});
socket.on('roulette-duration-updated', (val) => { rouletteInput.value = val; });

// ---------- MANUAL TIMER ----------
manualTimerToggle.addEventListener('change', (e) => {
  socket.emit('set-manual-timer', e.target.checked);
});
socket.on('manual-timer-updated', (val) => {
  manualTimerToggle.checked = !!val;
});

startTimerBtn.addEventListener('click', () => {
  socket.emit('host-start-timer');
});

socket.on('reveal-blocked', (data) => {
  alert(data.message || 'Cannot reveal yet.');
});

socket.on('timer-started', () => {
  manualTimerControls.classList.add('hidden');
  statusPill.textContent = 'Question live';
});

// ---------- 🎲 START ROULETTE ----------
startRouletteBtn.addEventListener('click', () => {
  socket.emit('host-start-roulette');
  startRouletteBtn.disabled = true;
  startRouletteBtn.textContent = '⏳ Roulette playing...';
  setTimeout(() => {
    closeRouletteBtn.classList.remove('hidden');
  }, 500);
});

closeRouletteBtn.addEventListener('click', () => {
  socket.emit('host-close-roulette');
  closeRouletteBtn.classList.add('hidden');
  startRouletteBtn.disabled = false;
  startRouletteBtn.textContent = '🎲 Start Roulette';
});

socket.on('roulette-error', (data) => {
  alert(data.message || 'Cannot start roulette.');
  startRouletteBtn.disabled = false;
  startRouletteBtn.textContent = '🎲 Start Roulette';
});

// ---------- ROUND SLIDERS ----------
const ROUND_LABELS = { 1: 'Easy', 2: 'Average', 3: 'Difficult', 4: 'Clincher' };
function renderRoundSliders() {
  roundSliders.innerHTML = '';
  uniqueRounds.forEach(round => {
    const label = ROUND_LABELS[round] || `Round ${round}`;
    const val = roundDurations[round] ?? 20;
    const row = document.createElement('div');
    row.className = 'round-slider-row';
    row.innerHTML = `
      <span class="round-slider-label">Round ${round} · ${label}</span>
      <input type="range" min="5" max="60" value="${val}" data-round="${round}" />
      <span class="round-slider-val" id="rdVal${round}">${val}s</span>
    `;
    roundSliders.appendChild(row);
  });

  roundSliders.querySelectorAll('input[type="range"]').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const r = e.target.dataset.round;
      document.getElementById(`rdVal${r}`).textContent = e.target.value + 's';
    });
    slider.addEventListener('change', (e) => {
      const r = Number(e.target.dataset.round);
      const secs = Number(e.target.value);
      socket.emit('set-round-duration', { round: r, seconds: secs });
    });
  });
}
socket.on('round-durations-updated', (data) => {
  roundDurations = data;
  renderRoundSliders();
});

// ---------- STATE ----------
socket.on('state', (state) => {
  totalQuestions = state.total;
  renderRoster(state.players);
  document.getElementById('phoneToggle').checked = state.showQuestionOnPhone;
  document.getElementById('showScoresToggle').checked = !!state.showScoresToPlayers;
  document.getElementById('durationSlider').value = state.questionDuration;
  document.getElementById('durationLabel').textContent = state.questionDuration + 's';

  uniqueRounds = state.uniqueRounds || [];
  roundDurations = state.roundDurations || {};
  renderRoundSliders();

  applyModeUI(state.quizMode || 'school');

  if (state.schoolScoring) {
    [...schoolScoringToggle.children].forEach(b => {
      b.classList.toggle('active', b.dataset.scoring === state.schoolScoring);
    });
    updateScoringUI(state.schoolScoring);
  }
  if (state.schoolFlatPoints) flatPointsInput.value = state.schoolFlatPoints;
  if (state.customPoints) {
    customMcq.value = state.customPoints.mcq;
    customTf.value = state.customPoints.truefalse;
    customIdent.value = state.customPoints.identification;
  }
  if (Number.isFinite(state.lightningRounds)) lightningInput.value = state.lightningRounds;
  if (Number.isFinite(state.rouletteDuration)) rouletteInput.value = state.rouletteDuration;
  if (typeof state.manualTimerStart === 'boolean') {
    manualTimerToggle.checked = state.manualTimerStart;
  }

  if (state.status === 'lobby') {
    statusPill.textContent = 'Lobby';
    showStage('lobby');
    progressFill.style.width = '0%';
  } else if (state.status === 'ended') {
    statusPill.textContent = 'Finished';
    showStage('ended');
    progressFill.style.width = '100%';
  }
});

function renderRoster(players) {
  rosterCount.textContent = players.length;
  startBtn.disabled = players.length === 0;
  rosterList.innerHTML = '';
  players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'roster-item' + (p.status === 'offline' ? ' offline' : '');
    row.innerHTML = `
      <span class="badge-avatar" style="width:30px;height:30px;font-size:1rem;">${p.avatar}</span>
      <span class="r-name">${p.name}</span>
      <span class="r-status"></span>
      <button class="kick-btn" title="Remove player">✕</button>
    `;
    row.querySelector('.kick-btn').addEventListener('click', () => {
      if (confirm(`Remove ${p.name} from the game?`)) {
        socket.emit('kick-player', p.id);
      }
    });
    rosterList.appendChild(row);
  });
}
socket.on('player-list', renderRoster);

function renderLeaderboard(leaderboard) {
  leaderboardMini.innerHTML = '';
  leaderboard.slice(0, 12).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row';
    row.innerHTML = `
      <span>#${i + 1}</span>
      <span>${p.avatar}</span>
      <span class="lb-name">${p.name}</span>
      <span class="lb-score">${p.score}</span>
    `;
    leaderboardMini.appendChild(row);
  });
}

// ---------- LOBBY ----------
document.getElementById('durationSlider').addEventListener('input', (e) => {
  document.getElementById('durationLabel').textContent = e.target.value + 's';
});
document.getElementById('durationSlider').addEventListener('change', (e) => {
  socket.emit('set-duration', Number(e.target.value));
});
socket.on('duration-updated', (val) => {
  document.getElementById('durationLabel').textContent = val + 's';
});

startBtn.addEventListener('click', () => socket.emit('start-quiz'));

document.getElementById('phoneToggle').addEventListener('change', (e) => {
  socket.emit('toggle-question-on-phone', e.target.checked);
});

document.getElementById('showScoresToggle').addEventListener('change', (e) => {
  socket.emit('toggle-show-scores', e.target.checked);
});
socket.on('show-scores-updated', (val) => {
  document.getElementById('showScoresToggle').checked = !!val;
});

// ---------- GET READY ----------
socket.on('get-ready', (data) => {
  statusPill.textContent = 'Get ready';
  document.getElementById('grHostNum').textContent = data.index + 1;
  document.getElementById('grHostTotal').textContent = data.total;

  const gr = document.getElementById('grHostRound');
  const lightningBadge = document.getElementById('grLightningBadge');

  if (data.isLightning) {
    lightningBadge.classList.remove('hidden');
    gr.textContent = '';
  } else {
    lightningBadge.classList.add('hidden');
    if (data.quizMode === 'quizbee' && data.round) {
      const label = data.roundLabel || ROUND_LABELS[data.round] || `Round ${data.round}`;
      const pts = { 1: 1, 2: 2, 3: 3 }[data.round] || 5;
      gr.textContent = `Round ${data.round} · ${label} · ${pts} pt`;
    } else {
      gr.textContent = '';
    }
  }
  showStage('getReady');
});

// ---------- QUESTION ----------
const KIND_LABELS = { mcq: 'Multiple choice', truefalse: 'True or False', identification: 'Identification' };

socket.on('question-host', (data) => {
  statusPill.textContent = data.isLightning ? '⚡ Lightning' : 'Question live';
  const kindLabel = KIND_LABELS[data.kind] || 'Multiple choice';
  document.getElementById('qCounter').textContent = `Q ${data.index + 1} / ${data.total} · ${kindLabel}`;
  document.getElementById('hostQuestionText').textContent = data.question;
  document.getElementById('answerCount').textContent = `0 / ${data.totalPlayers} answered`;

  const roundBadge = document.getElementById('roundBadge');
  const lightningBadge = document.getElementById('qLightningBadge');
  const lightningCounter = document.getElementById('qLightningCounter');

  if (data.isLightning) {
    lightningBadge.classList.remove('hidden');
    lightningCounter.textContent = `${data.lightningIndex} / ${data.lightningTotal}`;
    roundBadge.style.display = 'none';
  } else {
    lightningBadge.classList.add('hidden');
    if (data.quizMode === 'quizbee' && data.round) {
      roundBadge.style.display = '';
      roundBadge.textContent = `Round ${data.round} · ${data.roundLabel} · ${data.roundPoints} pt`;
    } else {
      roundBadge.style.display = 'none';
    }
  }

  if (data.manualTimerStart && !data.timerRunning && !data.isLightning) {
    manualTimerControls.classList.remove('hidden');
    mtcStatus.textContent = '⏸ Waiting for host to start timer';
    startTimerBtn.disabled = false;
    startTimerBtn.textContent = '▶ Start timer';
    statusPill.textContent = '⏸ Waiting for timer';
  } else {
    manualTimerControls.classList.add('hidden');
  }

  progressFill.style.width = `${Math.round((data.index / data.total) * 100)}%`;
  showStage('question');
});

socket.on('answer-count-update', (data) => {
  document.getElementById('answerCount').textContent = `${data.answered} / ${data.total} answered`;
});

socket.on('all-answered', () => {
  document.getElementById('answerCount').textContent += ' — everyone\'s in!';
});

document.getElementById('revealBtn').addEventListener('click', () => socket.emit('reveal-answer'));

// ---------- REVEAL ----------
socket.on('reveal', (data) => {
  statusPill.textContent = data.isLightning ? '⚡ Lightning reveal' : 'Reveal';
  document.getElementById('revealCorrectText').textContent = data.correctText;
  renderLeaderboard(data.leaderboard);
  showStage('reveal');
});

document.getElementById('nextBtn').addEventListener('click', () => socket.emit('next-question'));

// ---------- ENDED ----------
socket.on('game-ended', (data) => {
  statusPill.textContent = 'Finished';
  renderLeaderboard(data.leaderboard);
  progressFill.style.width = '100%';
  showStage('ended');

  const tiePanel = document.getElementById('tiePanel');
  if (data.quizMode === 'quizbee' && data.ties && data.ties.length > 0) {
    const t = data.ties[0];
    document.getElementById('tieTitle').textContent = `Tie detected at rank #${t.rank} (${t.score} pts)`;
    document.getElementById('tieList').innerHTML = t.players.map(p => `${p.avatar} ${p.name}`).join(' &nbsp;·&nbsp; ');
    tiePanel.classList.remove('hidden');
  } else {
    tiePanel.classList.add('hidden');
  }

  startRouletteBtn.disabled = !data.hasPlayers;
  startRouletteBtn.textContent = '🎲 Start Roulette';
  closeRouletteBtn.classList.add('hidden');
});

document.getElementById('startTieBtn').addEventListener('click', () => socket.emit('start-tiebreaker'));

socket.on('tiebreaker-error', (data) => { alert(data.message || 'Tie breaker error'); });
socket.on('tiebreaker-started', () => {
  statusPill.textContent = 'Tie Breaker';
  document.getElementById('tiePanel').classList.add('hidden');
  showStage('tiebreaker');
});

socket.on('tiebreaker-question-host', (data) => {
  statusPill.textContent = data.isSpeedRound ? '⚡ Speed Round' : 'Tie Breaker';
  document.getElementById('tbCounter').textContent = data.isSpeedRound
    ? `⚡ SPEED ROUND — first correct answer wins!`
    : `Tie Breaker — Q ${data.index + 1} / ${data.total}`;
  document.getElementById('tbQuestionText').textContent = data.question;
  document.getElementById('tbRemaining').textContent = `${data.remaining} remaining`;
  document.getElementById('tbCorrectText').textContent = '';
  document.getElementById('tbNextBtn').classList.add('hidden');
  document.getElementById('tbFinishBtn').classList.add('hidden');
  showStage('tiebreaker');
});

socket.on('tiebreaker-result-host', (data) => {
  document.getElementById('tbCorrectText').textContent =
    `Correct answer: ${data.correctText} — ${data.eliminated} eliminated, ${data.remaining} remaining`;
  if (data.allWrong) {
    document.getElementById('tbCorrectText').textContent += ' (everyone wrong — repeating)';
  } else if (data.remaining > 1) {
    document.getElementById('tbNextBtn').classList.remove('hidden');
  }
});

document.getElementById('tbNextBtn').addEventListener('click', () => socket.emit('next-tiebreaker-question'));
socket.on('tiebreaker-await-next', () => {
  document.getElementById('tbNextBtn').classList.remove('hidden');
});

socket.on('tiebreaker-ended', (data) => {
  statusPill.textContent = 'Finished';
  renderLeaderboard(data.leaderboard);
  document.getElementById('tiePanel').classList.add('hidden');
  showStage('ended');
  if (data.winner) alert(`🐝 Tie breaker winner: ${data.winner.avatar} ${data.winner.name}`);
});

document.getElementById('showResultsBtn').addEventListener('click', () => socket.emit('show-results'));

// ---------- NEW GAME ----------
document.getElementById('newGameBtn').addEventListener('click', () => {
  if (confirm('Start a brand new game? Everyone\'s scores reset to 0.')) {
    socket.emit('new-game');
  }
});
socket.on('reset', () => {
  statusPill.textContent = 'Lobby';
  progressFill.style.width = '0%';
  document.getElementById('tiePanel').classList.add('hidden');
  showStage('lobby');
});

// ---------- EXPOSE ----------
window.__kwizSocket = socket;
