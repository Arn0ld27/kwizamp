const socket = io();

const AVATARS = ['🐶', '🐱', '🐼', '🦊', '🦁', '🐸', '🐧', '🦄', '🐝', '🐬', '🦖', '🐙'];
const LS_KEYS = { pid: 'kwizkamp_pid', name: 'kwizkamp_name', avatar: 'kwizkamp_avatar' };

const views = {
  join: document.getElementById('viewJoin'),
  waiting: document.getElementById('viewWaiting'),
  getReady: document.getElementById('viewGetReadyP'),
  question: document.getElementById('viewQuestionP'),
  result: document.getElementById('viewResult'),
  final: document.getElementById('viewFinal')
};
function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
  document.getElementById('reactionBar').classList.toggle('hidden', name === 'join' || name === 'final');
}

// ---------- Ambient embers ----------
const emberLayer = document.getElementById('embers');
for (let i = 0; i < 14; i++) {
  const s = document.createElement('span');
  s.style.left = Math.random() * 100 + 'vw';
  s.style.setProperty('--drift', (Math.random() * 60 - 30) + 'px');
  s.style.animationDuration = (7 + Math.random() * 8) + 's';
  s.style.animationDelay = (Math.random() * 8) + 's';
  emberLayer.appendChild(s);
}

// ---------- AVATAR PICKER ----------
let selectedAvatar = localStorage.getItem(LS_KEYS.avatar) || AVATARS[0];
const avatarGrid = document.getElementById('avatarGrid');
AVATARS.forEach(a => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'avatar-choice' + (a === selectedAvatar ? ' selected' : '');
  btn.textContent = a;
  btn.addEventListener('click', () => {
    selectedAvatar = a;
    [...avatarGrid.children].forEach(c => c.classList.remove('selected'));
    btn.classList.add('selected');
  });
  avatarGrid.appendChild(btn);
});

const nameInput = document.getElementById('nameInput');
nameInput.value = localStorage.getItem(LS_KEYS.name) || '';

let showQuestionOnPhone = true;
let currentDuration = 20;
let currentStartedAt = null;
let timerInterval = null;

// ---------- JOIN ----------
document.getElementById('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim().slice(0, 20) || 'Camper';
  doJoin(name, selectedAvatar);
});

function doJoin(name, avatar) {
  socket.emit('player-join', {
    name,
    avatar,
    persistentId: localStorage.getItem(LS_KEYS.pid) || null
  });
}

socket.on('connect', () => {
  const storedPid = localStorage.getItem(LS_KEYS.pid);
  const storedName = localStorage.getItem(LS_KEYS.name);
  if (storedPid && storedName) {
    doJoin(storedName, selectedAvatar);
  }
});

socket.on('joined', (data) => {
  localStorage.setItem(LS_KEYS.pid, data.persistentId);
  localStorage.setItem(LS_KEYS.name, data.name);
  localStorage.setItem(LS_KEYS.avatar, data.avatar);
  document.getElementById('waitingName').textContent = data.name;
});

socket.on('waiting', () => showView('waiting'));

socket.on('kicked', () => {
  localStorage.removeItem(LS_KEYS.pid);
  alert('The host removed you from this game.');
  location.reload();
});

// ---------- GET READY ----------
socket.on('get-ready', (data) => {
  clearInterval(timerInterval);
  document.getElementById('pGrNum').textContent = data.index + 1;
  document.getElementById('pGrTotal').textContent = data.total;
  let msLeft = data.countdownMs;
  document.getElementById('pGrCount').textContent = Math.ceil(msLeft / 1000);
  showView('getReady');
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    msLeft -= 1000;
    if (msLeft <= 0) { clearInterval(timerInterval); return; }
    document.getElementById('pGrCount').textContent = Math.ceil(msLeft / 1000);
  }, 1000);
});

// ---------- QUESTION ----------
const optionGrid = document.getElementById('optionGrid');
const SHAPES = ['▲', '◆', '●', '■'];

let currentKind = 'mcq';
const identForm = document.getElementById('identForm');
const identInput = document.getElementById('identInput');

socket.on('question', (data) => {
  clearInterval(timerInterval);
  showQuestionOnPhone = data.showQuestionOnPhone;
  currentDuration = data.duration;
  currentStartedAt = data.startedAt;
  currentKind = data.kind || 'mcq';

  document.getElementById('pQNum').textContent = `Q ${data.index + 1} / ${data.total}`;
  const qText = document.getElementById('pQuestionText');
  qText.textContent = data.question;
  qText.style.visibility = showQuestionOnPhone ? 'visible' : 'hidden';

  if (currentKind === 'identification') {
    optionGrid.classList.add('hidden');
    identForm.classList.remove('hidden');
    identInput.value = '';
    identInput.disabled = false;
    identInput.focus();
  } else {
    identForm.classList.add('hidden');
    optionGrid.classList.remove('hidden');
    optionGrid.innerHTML = '';
    data.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = `option-btn opt-${i}`;
      btn.innerHTML = `<span class="shape">${SHAPES[i]}</span><span>${opt}</span>`;
      btn.addEventListener('click', () => {
        socket.emit('submit-answer', i);
      });
      optionGrid.appendChild(btn);
    });
  }

  showView('question');
  runTimerRing();
});

identForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = identInput.value.trim();
  if (!text) return;
  socket.emit('submit-answer', text);
});

socket.on('question-toggle', (val) => {
  showQuestionOnPhone = val;
  const qText = document.getElementById('pQuestionText');
  if (qText) qText.style.visibility = showQuestionOnPhone ? 'visible' : 'hidden';
});

function runTimerRing() {
  const ring = document.getElementById('timerRing');
  const num = document.getElementById('timerNum');
  clearInterval(timerInterval);
  function tick() {
    const elapsed = (Date.now() - currentStartedAt) / 1000;
    const remaining = Math.max(0, currentDuration - elapsed);
    const pct = Math.max(0, (remaining / currentDuration) * 100);
    ring.style.setProperty('--pct', pct.toFixed(1));
    num.textContent = Math.ceil(remaining);
    if (remaining <= 0) {
      clearInterval(timerInterval);
      [...optionGrid.children].forEach(b => b.disabled = true);
      identInput.disabled = true;
    }
  }
  tick();
  timerInterval = setInterval(tick, 200);
}

socket.on('answer-locked', (data) => {
  if (data.text !== undefined) {
    identInput.disabled = true;
    identInput.value = data.text;
  } else {
    [...optionGrid.children].forEach((b, i) => {
      b.classList.toggle('locked-in', i === data.optionIndex);
    });
  }
});

// ---------- RESULT ----------
socket.on('result', (data) => {
  clearInterval(timerInterval);

  const identResult = document.getElementById('identResult');
  if (data.kind === 'identification') {
    identResult.classList.remove('hidden');
    document.getElementById('identYourAnswer').textContent = data.yourAnswer || '(no answer)';
    document.getElementById('identCorrectAnswer').textContent = data.correctText;
  } else {
    identResult.classList.add('hidden');
    [...optionGrid.children].forEach((b, i) => {
      b.disabled = true;
      if (i === data.correctIndex) b.classList.add('correct-answer');
      if (i === data.yourAnswer && !data.isCorrect) b.classList.add('wrong-answer');
    });
  }

  document.getElementById('resultEmoji').textContent = data.isCorrect ? '🎉' : '💨';
  const title = document.getElementById('resultTitle');
  title.textContent = data.isCorrect ? 'Correct!' : (data.yourAnswer == null ? "Time's up" : 'Not quite');
  title.className = 'result-title ' + (data.isCorrect ? 'good' : 'bad');

  document.getElementById('pointsEarned').textContent = data.pointsEarned ? `+${data.pointsEarned}` : '+0';

  const streakChip = document.getElementById('streakChip');
  if (data.isCorrect && data.streak > 1) {
    streakChip.textContent = `🔥 ${data.streak} in a row`;
    streakChip.classList.remove('hidden');
  } else {
    streakChip.classList.add('hidden');
  }

  document.getElementById('resultRank').textContent = data.rank;
  document.getElementById('resultScore').textContent = data.score;

  showView('result');
});

// ---------- FINAL ----------
socket.on('personal-final', (data) => {
  clearInterval(timerInterval);
  document.getElementById('finalRank').textContent = '#' + data.rank;
  document.getElementById('finalScore').textContent = data.score;
  showView('final');
});

// ---------- REACTIONS ----------
document.querySelectorAll('.reaction-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    socket.emit('player-reaction', btn.dataset.emoji);
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 2000);
  });
});

// ---------- RESET ----------
socket.on('reset', () => {
  clearInterval(timerInterval);
  showView('waiting');
});
