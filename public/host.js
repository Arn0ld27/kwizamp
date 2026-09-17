const socket = io();

document.getElementById('playUrl').textContent = `${location.origin}/play`;

const stages = {
  lobby: document.getElementById('stageLobby'),
  getReady: document.getElementById('stageGetReady'),
  question: document.getElementById('stageQuestion'),
  reveal: document.getElementById('stageReveal'),
  ended: document.getElementById('stageEnded')
};
function showStage(name) {
  Object.values(stages).forEach(s => s.classList.add('hidden'));
  stages[name].classList.remove('hidden');
}

const statusPill = document.getElementById('statusPill');
const startBtn = document.getElementById('startBtn');
const rosterList = document.getElementById('rosterList');
const rosterCount = document.getElementById('rosterCount');
const leaderboardMini = document.getElementById('leaderboardMini');
const progressFill = document.getElementById('progressFill');

let totalQuestions = 0;

socket.on('connect', () => socket.emit('host-join'));

socket.on('state', (state) => {
  totalQuestions = state.total;
  renderRoster(state.players);
  document.getElementById('phoneToggle').checked = state.showQuestionOnPhone;
  document.getElementById('durationSlider').value = state.questionDuration;
  document.getElementById('durationLabel').textContent = state.questionDuration + 's';

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

// ---------- LOBBY CONTROLS ----------
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

// ---------- GET READY ----------
socket.on('get-ready', (data) => {
  statusPill.textContent = 'Get ready';
  document.getElementById('grHostNum').textContent = data.index + 1;
  document.getElementById('grHostTotal').textContent = data.total;
  showStage('getReady');
});

// ---------- QUESTION ----------
const KIND_LABELS = { mcq: 'Multiple choice', truefalse: 'True or False', identification: 'Identification' };

socket.on('question-host', (data) => {
  statusPill.textContent = 'Question live';
  const kindLabel = KIND_LABELS[data.kind] || 'Multiple choice';
  document.getElementById('qCounter').textContent = `Q ${data.index + 1} / ${data.total} · ${kindLabel}`;
  document.getElementById('hostQuestionText').textContent = data.question;
  document.getElementById('answerCount').textContent = `0 / ${data.totalPlayers} answered`;
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
  statusPill.textContent = 'Reveal';
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
});

document.getElementById('showResultsBtn').addEventListener('click', () => socket.emit('show-results'));

// ---------- NEW GAME ----------
document.getElementById('newGameBtn').addEventListener('click', () => {
  if (confirm('Start a brand new game? Everyone\'s score resets to 0.')) {
    socket.emit('new-game');
  }
});
socket.on('reset', () => {
  statusPill.textContent = 'Lobby';
  progressFill.style.width = '0%';
  showStage('lobby');
});
