const socket = io();

const views = {
  idle: document.getElementById('viewIdle'),
  getReady: document.getElementById('viewGetReady'),
  question: document.getElementById('viewQuestion'),
  reveal: document.getElementById('viewReveal'),
  ranking: document.getElementById('viewRanking')
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}

// ---------- Ambient embers ----------
const emberLayer = document.getElementById('embers');
for (let i = 0; i < 24; i++) {
  const s = document.createElement('span');
  s.style.left = Math.random() * 100 + 'vw';
  s.style.setProperty('--drift', (Math.random() * 80 - 40) + 'px');
  s.style.animationDuration = (6 + Math.random() * 10) + 's';
  s.style.animationDelay = (Math.random() * 10) + 's';
  emberLayer.appendChild(s);
}

socket.on('connect', () => socket.emit('display-join'));

socket.on('display-state', (state) => {
  if (state.status === 'lobby') showView('idle');
});

// ---------- GET READY ----------
let countdownInterval = null;
socket.on('get-ready', (data) => {
  clearInterval(countdownInterval);
  document.getElementById('grQNum').textContent = data.index + 1;
  document.getElementById('grTotal').textContent = data.total;
  const el = document.getElementById('grCount');

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((data.countdownMs) / 1000));
    return remaining;
  };

  let msLeft = data.countdownMs;
  el.textContent = Math.ceil(msLeft / 1000);
  showView('getReady');

  countdownInterval = setInterval(() => {
    msLeft -= 1000;
    if (msLeft <= 0) {
      clearInterval(countdownInterval);
      return;
    }
    el.textContent = Math.ceil(msLeft / 1000);
  }, 1000);
});

// ---------- QUESTION ----------
let timerInterval = null;
socket.on('question-display', (data) => {
  clearInterval(countdownInterval);
  clearInterval(timerInterval);

  document.getElementById('displayQNum').textContent = `Q ${data.index + 1} / ${data.total}`;
  document.getElementById('displayQuestion').textContent = data.question;
  showView('question');

  const timerEl = document.getElementById('displayTimer');

  function tick() {
    const elapsed = (Date.now() - data.startedAt) / 1000;
    const remaining = Math.max(0, Math.ceil(data.duration - elapsed));
    timerEl.textContent = `⏱ ${remaining}s`;
    timerEl.classList.toggle('low', remaining <= 5);
    if (remaining <= 0) clearInterval(timerInterval);
  }
  tick();
  timerInterval = setInterval(tick, 250);
});

// ---------- REVEAL ----------
const LETTERS = ['A', 'B', 'C', 'D'];
socket.on('reveal-display', (data) => {
  clearInterval(timerInterval);

  document.getElementById('displayQNum2').textContent = document.getElementById('displayQNum').textContent;
  document.getElementById('displayQuestion2').textContent = document.getElementById('displayQuestion').textContent;
  document.getElementById('displayCorrect').textContent = `✅ ${data.correctText}`;

  const countsEl = document.getElementById('displayCounts');
  countsEl.innerHTML = '';

  if (data.kind === 'identification') {
    const total = Math.max(data.identStats.total, 1);
    const pct = Math.round((data.identStats.correct / total) * 100);
    const wrap = document.createElement('div');
    wrap.className = 'ident-stat-bar';
    wrap.innerHTML = `
      <span class="stat-label">${data.identStats.correct} of ${data.identStats.total} campers got it right</span>
      <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
      <span class="stat-num">${pct}%</span>
    `;
    countsEl.appendChild(wrap);
    requestAnimationFrame(() => {
      wrap.querySelector('.bar-fill').style.width = pct + '%';
    });
  } else {
    const total = data.counts.reduce((a, b) => a + b, 0) || 1;
    data.counts.forEach((c, i) => {
      const pct = Math.round((c / total) * 100);
      const div = document.createElement('div');
      div.className = 'count-bar' + (i === data.correctIndex ? ' correct' : '');
      div.innerHTML = `
        <span class="letter">${LETTERS[i]}</span>
        <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
        <span class="num">${c}</span>
      `;
      countsEl.appendChild(div);
      requestAnimationFrame(() => {
        div.querySelector('.bar-fill').style.width = pct + '%';
      });
    });
  }

  showView('reveal');
});

// ---------- RANKING ----------
function renderRanking(leaderboard) {
  const el = document.getElementById('rankingChart');
  el.innerHTML = '';
  leaderboard.slice(0, 10).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'rank-row' + (i === 0 ? ' p1' : i === 1 ? ' p2' : i === 2 ? ' p3' : '');
    row.style.animationDelay = (i * 0.08) + 's';
    row.innerHTML = `
      <span class="place">#${i + 1}</span>
      <span class="r-avatar">${p.avatar}</span>
      <span class="r-name">${p.name}</span>
      <span class="r-score">${p.score}</span>
    `;
    el.appendChild(row);
  });
}

socket.on('show-results-display', (data) => {
  renderRanking(data.leaderboard);
  showView('ranking');
});

socket.on('game-ended-display', (data) => {
  if (data && data.leaderboard) renderRanking(data.leaderboard);
  showView('ranking');
});

// ---------- REACTIONS ----------
const reactionLayer = document.getElementById('reactionLayer');
socket.on('reaction', (data) => {
  const el = document.createElement('div');
  el.className = 'reaction-pop';
  el.textContent = data.emoji;
  el.style.left = (Math.random() * 80 + 10) + 'vw';
  reactionLayer.appendChild(el);
  setTimeout(() => el.remove(), 2500);
});

// ---------- RESET ----------
socket.on('reset', () => {
  clearInterval(timerInterval);
  clearInterval(countdownInterval);
  showView('idle');
});
