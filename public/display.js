const socket = io();
socket.emit('display-join');

const views = {
  idle: document.getElementById('viewIdle'),
  question: document.getElementById('viewQuestion'),
  reveal: document.getElementById('viewReveal'),
  ranking: document.getElementById('viewRanking')
};

function showView(v) {
  Object.values(views).forEach(el => el.classList.add('hidden'));
  views[v].classList.remove('hidden');
}

let currentQ = null;
let timerInterval = null;

socket.on('display-state', (s) => {
  if (s.status === 'lobby') showView('idle');
});

socket.on('question-display', (data) => {
  currentQ = data;
  document.getElementById('displayQNum').textContent = `Q ${data.index + 1} / ${data.total}`;
  document.getElementById('displayQuestion').textContent = data.question;
  showView('question');
  startTimer(data.duration, data.startedAt);
});

socket.on('reveal-display', (data) => {
  stopTimer();
  document.getElementById('displayQNum2').textContent = `Q ${currentQ.index + 1} / ${currentQ.total}`;
  document.getElementById('displayQuestion2').textContent = currentQ.question;
  document.getElementById('displayCorrect').textContent = `✅ Correct: ${data.correctText}`;

  const letters = ['A', 'B', 'C', 'D'];
  const countsHtml = data.options.map((opt, i) => {
    return `<div class="count-item"><span class="count-letter">${letters[i]}</span><span class="count-opt">${opt}</span><span class="count-num">${data.counts[i]}</span></div>`;
  }).join('');
  document.getElementById('displayCounts').innerHTML = countsHtml;

  showView('reveal');
});

socket.on('game-ended-display', () => {
  showView('idle');
});

socket.on('show-results-display', (data) => {
  const chart = document.getElementById('rankingChart');
  chart.innerHTML = '';

  const lb = data.leaderboard.slice(0, 10);
  const maxScore = Math.max(1, ...lb.map(p => p.score));

  lb.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'rank-row';
    const pct = (p.score / maxScore) * 100;
    row.innerHTML = `
      <div class="rank-pos">#${i + 1}</div>
      <div class="rank-name">${p.avatar || '🐶'} ${p.name}</div>
      <div class="rank-bar-wrap">
        <div class="rank-bar" style="width: ${pct}%"></div>
      </div>
      <div class="rank-score">${p.score}</div>
    `;
    chart.appendChild(row);
  });

  showView('ranking');
});

socket.on('reset', () => {
  stopTimer();
  showView('idle');
});

// ---------- REACTION ANIMATION ----------
socket.on('reaction', (data) => {
  const layer = document.getElementById('reactionLayer');
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = data.emoji;

  // Random horizontal position (10% - 90%)
  const left = 10 + Math.random() * 80;
  el.style.left = left + '%';

  // Random size
  const size = 3 + Math.random() * 2.5; // 3rem - 5.5rem
  el.style.fontSize = size + 'rem';

  // Random rotation
  const rot = (Math.random() - 0.5) * 40;
  el.style.setProperty('--rot', rot + 'deg');

  layer.appendChild(el);

  // Remove after animation (3s)
  setTimeout(() => el.remove(), 3000);
});

// ---------- TIMER ----------
function startTimer(duration, startedAt) {
  stopTimer();
  const el = document.getElementById('displayTimer');
  const endTime = startedAt + duration * 1000;

  const update = () => {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    el.textContent = `⏱ ${remaining}s`;
    if (remaining <= 5 && remaining > 0) {
      el.classList.add('timer-tense');
    } else {
      el.classList.remove('timer-tense');
    }
    if (remaining <= 0) {
      el.textContent = `⏱ 0s`;
      stopTimer();
    }
  };
  update();
  timerInterval = setInterval(update, 250);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}