const socket = io();
socket.emit('host-join');

const views = {
  lobby: document.getElementById('viewLobby'),
  question: document.getElementById('viewQuestion'),
  reveal: document.getElementById('viewReveal'),
  end: document.getElementById('viewEnd')
};

const hostStatus = document.getElementById('hostStatus');
const hostTimer = document.getElementById('hostTimer');
let currentQuestion = null;
let timerInterval = null;
let showQuestionOnPhone = true;
let latestLeaderboard = [];

function showView(v) {
  Object.values(views).forEach(el => el.classList.add('hidden'));
  views[v].classList.remove('hidden');
  hostStatus.textContent = v.charAt(0).toUpperCase() + v.slice(1);
}

document.getElementById('playerUrl').textContent = `${location.origin}/play`;

document.getElementById('toggleQBtn').addEventListener('click', () => {
  showQuestionOnPhone = !showQuestionOnPhone;
  socket.emit('toggle-question-on-phone', showQuestionOnPhone);
  updateToggleBtn();
});

function updateToggleBtn() {
  const btn = document.getElementById('toggleQBtn');
  btn.textContent = `👁 Q on 📱: ${showQuestionOnPhone ? 'ON' : 'OFF'}`;
  btn.classList.toggle('off', !showQuestionOnPhone);
}

socket.on('state', (s) => {
  showQuestionOnPhone = s.showQuestionOnPhone !== false;
  updateToggleBtn();
  if (s.status === 'lobby') showView('lobby');
});

socket.on('toggle-updated', (val) => {
  showQuestionOnPhone = val;
  updateToggleBtn();
});

socket.on('player-list', (players) => {
  document.getElementById('lobbyCount').textContent = players.length;
  const c = document.getElementById('lobbyPlayers');
  c.innerHTML = '';
  players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    const statusIcon = p.status === 'online' ? '🟢' : '🔴';
    chip.textContent = `${statusIcon} ${p.avatar || '🐶'} ${p.name}`;
    c.appendChild(chip);
  });
  document.getElementById('startBtn').disabled = players.length === 0;
});

document.getElementById('startBtn').addEventListener('click', () => socket.emit('start-quiz'));

socket.on('question-host', (data) => {
  currentQuestion = data;
  document.getElementById('hostQNumber').textContent = `Q ${data.index + 1} / ${data.total}`;
  document.getElementById('hostQuestion').textContent = data.question;
  document.getElementById('answeredCount').textContent = '0';
  document.getElementById('totalPlayers').textContent = data.totalPlayers;
  document.getElementById('hostProgressBar').style.width = '0%';

  const opts = document.getElementById('hostOptions');
  opts.innerHTML = '';
  data.options.forEach((opt, idx) => {
    const div = document.createElement('div');
    div.className = 'host-option';
    div.innerHTML = `${opt}<span class="count" id="hostCount-${idx}"></span>`;
    opts.appendChild(div);
  });

  showView('question');
  startTimer(data.duration, data.startedAt);
});

socket.on('answer-count-update', ({ answered, total }) => {
  document.getElementById('answeredCount').textContent = answered;
  document.getElementById('totalPlayers').textContent = total;
  const pct = total > 0 ? (answered / total) * 100 : 0;
  document.getElementById('hostProgressBar').style.width = pct + '%';
});

document.getElementById('revealBtn').addEventListener('click', () => socket.emit('reveal-answer'));

socket.on('reveal', (data) => {
  stopTimer();

  document.getElementById('revealQNumber').textContent = `Q ${currentQuestion.index + 1} / ${currentQuestion.total}`;
  document.getElementById('revealQuestion').textContent = currentQuestion.question;

  const opts = document.getElementById('revealOptions');
  opts.innerHTML = '';
  currentQuestion.options.forEach((opt, idx) => {
    const div = document.createElement('div');
    div.className = 'host-option';
    if (idx === data.correctIndex) div.classList.add('correct');
    div.innerHTML = `${opt}<span class="count">${data.counts[idx]}</span>`;
    opts.appendChild(div);
  });

  document.getElementById('correctAnswer').textContent = `✅ Correct: ${currentQuestion.options[data.correctIndex]}`;

  latestLeaderboard = data.leaderboard || [];
  showView('reveal');
});

document.getElementById('nextBtn').addEventListener('click', () => socket.emit('next-question'));

socket.on('game-ended', (data) => {
  stopTimer();
  latestLeaderboard = data.leaderboard || [];
  showView('end');
});

document.getElementById('showResultsBtn').addEventListener('click', () => {
  socket.emit('show-results');
  document.getElementById('showResultsBtn').textContent = '✅ Results Shown';
  document.getElementById('showResultsBtn').disabled = true;
});

document.getElementById('newGameBtn').addEventListener('click', () => {
  socket.emit('new-game');
});

document.getElementById('downloadBtn').addEventListener('click', () => {
  const lines = [];
  lines.push('Quiz Results');
  lines.push(`Date: ${new Date().toLocaleString()}`);
  lines.push(`Total Players: ${latestLeaderboard.length}`);
  lines.push('');
  lines.push('Rank,Name,Score');
  latestLeaderboard.forEach((p, i) => {
    lines.push(`${i + 1},"${p.name.replace(/"/g, '""')}",${p.score}`);
  });
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `quiz-results-${ts}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

socket.on('reset', () => {
  showView('lobby');
  document.getElementById('lobbyPlayers').innerHTML = '';
  document.getElementById('lobbyCount').textContent = '0';
  document.getElementById('startBtn').disabled = true;
  document.getElementById('showResultsBtn').disabled = false;
  document.getElementById('showResultsBtn').textContent = '🏆 SHOW RESULTS';
  hostTimer.textContent = '';
});

function startTimer(duration, startedAt) {
  stopTimer();
  const endTime = startedAt + duration * 1000;
  const update = () => {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    hostTimer.textContent = `⏱ ${remaining}s`;
    if (remaining <= 0) { hostTimer.textContent = `⏱ 0s`; stopTimer(); }
  };
  update();
  timerInterval = setInterval(update, 250);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}