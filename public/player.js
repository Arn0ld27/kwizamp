const socket = io();

let persistentId = sessionStorage.getItem('persistentId');
if (!persistentId) {
  persistentId = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  sessionStorage.setItem('persistentId', persistentId);
}

const name = sessionStorage.getItem('playerName') || 'Anonymous';
const avatar = sessionStorage.getItem('playerAvatar') || '🐶';
document.getElementById('playerName').textContent = `${avatar} ${name}`;

let myScore = 0;
let currentQuestionData = null;
let timerInterval = null;
let showQuestionOnPhone = true;

const views = {
  waiting: document.getElementById('viewWaiting'),
  question: document.getElementById('viewQuestion'),
  result: document.getElementById('viewResult'),
  final: document.getElementById('viewFinal')
};

function showView(viewName) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[viewName].classList.remove('hidden');
}

// ---------- CONNECTION ----------
socket.on('connect', () => {
  document.getElementById('connLost').classList.add('hidden');
  socket.emit('player-join', { name, avatar, persistentId });
});

socket.on('disconnect', () => {
  document.getElementById('connLost').classList.remove('hidden');
  stopTimer();
});

socket.on('connect_error', () => {
  document.getElementById('connLost').classList.remove('hidden');
});

socket.on('joined', (data) => {
  document.getElementById('playerName').textContent = `${data.avatar || avatar} ${data.name}`;
  myScore = data.score || 0;
  document.getElementById('playerScore').textContent = myScore;
});

socket.on('waiting', () => showView('waiting'));

socket.on('question-toggle', (val) => {
  showQuestionOnPhone = val;
  renderQuestionText();
});

function renderQuestionText() {
  const qEl = document.getElementById('questionOnPhone');
  const hint = document.getElementById('hintText');
  if (showQuestionOnPhone && currentQuestionData) {
    qEl.textContent = currentQuestionData.question;
    qEl.classList.remove('hidden');
    hint.classList.add('hidden');
  } else {
    qEl.textContent = '';
    qEl.classList.add('hidden');
    hint.classList.remove('hidden');
  }
}

socket.on('question', (data) => {
  currentQuestionData = data;
  showQuestionOnPhone = data.showQuestionOnPhone !== false;

  renderQuestionText();

  const optsContainer = document.getElementById('playerOptions');
  optsContainer.innerHTML = '';

  data.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = 'player-option';
    btn.textContent = opt;
    btn.addEventListener('click', () => submitAnswer(idx, btn));
    optsContainer.appendChild(btn);
  });

  const timerEl = document.getElementById('timerPill');
  timerEl.classList.remove('timer-over');
  removeTimeUpOverlay();

  document.body.classList.remove('body-correct', 'body-wrong');
  showView('question');
  startTimer(data.duration, data.startedAt);
});

function submitAnswer(idx, btn) {
  if (!currentQuestionData) return;

  const elapsed = (Date.now() - currentQuestionData.startedAt) / 1000;
  if (elapsed >= currentQuestionData.duration) {
    lockOptionsAndShowTimeUp();
    return;
  }

  socket.emit('submit-answer', idx);

  const allBtns = document.querySelectorAll('.player-option');
  allBtns.forEach(b => b.classList.remove('chosen'));
  btn.classList.add('chosen');
}

socket.on('answer-locked', (data) => {
  if (data && typeof data.optionIndex === 'number') {
    const allBtns = document.querySelectorAll('.player-option');
    allBtns.forEach((b, i) => {
      b.classList.remove('chosen');
      if (i === data.optionIndex) b.classList.add('chosen');
    });
  }
});

socket.on('result', (data) => {
  stopTimer();
  removeTimeUpOverlay();

  myScore = data.score;
  document.getElementById('playerScore').textContent = myScore;

  const isCorrect = data.isCorrect;
  document.body.classList.remove('body-correct', 'body-wrong');
  document.body.classList.add(isCorrect ? 'body-correct' : 'body-wrong');

  document.getElementById('resultIcon').textContent = isCorrect ? '✅' : '❌';
  document.getElementById('resultTitle').textContent = isCorrect ? 'CORRECT!' : 'WRONG';
  document.getElementById('resultDetail').textContent = isCorrect
    ? '+1 point'
    : `Correct answer: ${currentQuestionData?.options[data.correctIndex] || '—'}`;
  document.getElementById('resultScore').textContent = `${myScore} pts`;
  document.getElementById('resultRank').textContent = `🏅 Rank: #${data.rank}`;

  showView('result');
});

socket.on('personal-final', (data) => {
  stopTimer();
  document.body.classList.remove('body-correct', 'body-wrong');
  document.getElementById('finalScore').textContent = `${data.score} pts`;
  document.getElementById('finalRank').textContent = `🏅 Rank: #${data.rank}`;
  showView('final');
});

socket.on('reset', () => {
  myScore = 0;
  document.body.classList.remove('body-correct', 'body-wrong');
  document.getElementById('playerScore').textContent = '0';
  removeTimeUpOverlay();
  showView('waiting');
});

// ---------- TIMER ----------
function startTimer(duration, startedAt) {
  stopTimer();
  const timerEl = document.getElementById('timerPill');
  const endTime = startedAt + duration * 1000;

  const update = () => {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    timerEl.textContent = `⏱ ${remaining}s`;

    if (remaining <= 5 && remaining > 0) {
      timerEl.classList.add('timer-tense');
    }

    if (remaining <= 0) {
      timerEl.textContent = `⏱ 0s`;
      timerEl.classList.add('timer-over');
      stopTimer();
      lockOptionsAndShowTimeUp();
    }
  };
  update();
  timerInterval = setInterval(update, 250);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function lockOptionsAndShowTimeUp() {
  const allBtns = document.querySelectorAll('.player-option');
  allBtns.forEach(b => {
    b.disabled = true;
    b.classList.add('locked');
  });
  showTimeUpOverlay();
}

function showTimeUpOverlay() {
  if (document.getElementById('timeUpOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'timeUpOverlay';
  overlay.className = 'time-up-overlay';
  overlay.innerHTML = `
    <div class="time-up-icon">⏰</div>
    <div class="time-up-text">TIME'S UP!</div>
    <div class="time-up-sub">Waiting for reveal...</div>
  `;

  const questionView = document.getElementById('viewQuestion');
  if (questionView) questionView.appendChild(overlay);
}

function removeTimeUpOverlay() {
  const overlay = document.getElementById('timeUpOverlay');
  if (overlay) overlay.remove();
  const timerEl = document.getElementById('timerPill');
  timerEl.classList.remove('timer-tense');
}

// ---------- EMOJI REACTION ----------
document.querySelectorAll('.reaction-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const emoji = btn.dataset.emoji;
    socket.emit('player-reaction', emoji);

    // Local feedback (small bounce)
    btn.classList.add('sent');
    setTimeout(() => btn.classList.remove('sent'), 300);
  });
});