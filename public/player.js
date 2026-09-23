(function() {
  const socket = io();

  const AVATARS = ['🐶', '🐱', '🐼', '🦊', '🦁', '🐸', '🐧', '🦄', '🐝', '🐬', '🦖', '🐙'];
  const LS_KEYS = { pid: 'kwizkamp_pid', name: 'kwizkamp_name', avatar: 'kwizkamp_avatar' };

  const views = {
    join: document.getElementById('viewJoin'),
    waiting: document.getElementById('viewWaiting'),
    getReady: document.getElementById('viewGetReadyP'),
    question: document.getElementById('viewQuestionP'),
    result: document.getElementById('viewResult'),
    final: document.getElementById('viewFinal'),
    tieWatch: document.getElementById('viewTieWatch'),
    tieIntroP: document.getElementById('viewTieIntroP'),
    tieQuestionP: document.getElementById('viewTieQuestionP'),
    tieStillIn: document.getElementById('viewTieStillIn'),
    tieOut: document.getElementById('viewTieOut'),
    tieWon: document.getElementById('viewTieWon')
  };

  function showView(name) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[name].classList.remove('hidden');
    const hideBar = ['join', 'final', 'tieWatch', 'tieIntroP', 'tieStillIn', 'tieOut', 'tieWon'].includes(name);
    document.getElementById('reactionBar').classList.toggle('hidden', hideBar);
  }

  // Embers
  const emberLayer = document.getElementById('embers');
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('span');
    s.style.left = Math.random() * 100 + 'vw';
    s.style.setProperty('--drift', (Math.random() * 60 - 30) + 'px');
    s.style.animationDuration = (7 + Math.random() * 8) + 's';
    s.style.animationDelay = (Math.random() * 8) + 's';
    emberLayer.appendChild(s);
  }

  // Avatar picker
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
  let currentMode = 'school';

  // Waiting timer element
  const pWaitingTimer = document.getElementById('pWaitingTimer');

  // JOIN
  document.getElementById('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim().slice(0, 20) || 'Camper';
    doJoin(name, selectedAvatar);
  });

  function doJoin(name, avatar) {
    socket.emit('player-join', {
      name, avatar,
      persistentId: localStorage.getItem(LS_KEYS.pid) || null
    });
  }

  socket.on('connect', () => {
    const storedPid = localStorage.getItem(LS_KEYS.pid);
    const storedName = localStorage.getItem(LS_KEYS.name);
    if (storedPid && storedName) doJoin(storedName, selectedAvatar);
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

  // GET READY
  socket.on('get-ready', (data) => {
    clearInterval(timerInterval);
    if (data.quizMode) currentMode = data.quizMode;
    document.getElementById('pGrNum').textContent = data.index + 1;
    document.getElementById('pGrTotal').textContent = data.total;

    const lightning = document.getElementById('pGrLightning');
    if (data.isLightning) lightning.classList.remove('hidden');
    else lightning.classList.add('hidden');

    let msLeft = data.countdownMs;
    document.getElementById('pGrCount').textContent = Math.ceil(msLeft / 1000);
    showView('getReady');
    timerInterval = setInterval(() => {
      msLeft -= 1000;
      if (msLeft <= 0) { clearInterval(timerInterval); return; }
      document.getElementById('pGrCount').textContent = Math.ceil(msLeft / 1000);
    }, 1000);
  });

  // QUESTION
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
    if (data.quizMode) currentMode = data.quizMode;

    const lightningBadge = document.getElementById('pLightningBadge');
    if (data.isLightning) lightningBadge.classList.remove('hidden');
    else lightningBadge.classList.add('hidden');

    document.getElementById('pQNum').textContent = `Q ${data.index + 1} / ${data.total}`;

    const roundBadge = document.getElementById('pRoundBadge');
    if (!data.isLightning && currentMode === 'quizbee' && data.round) {
      const label = data.roundLabel || `Round ${data.round}`;
      const pts = { 1: 1, 2: 2, 3: 3 }[data.round] || 5;
      roundBadge.textContent = `Round ${data.round} · ${label} · ${pts} pt`;
      roundBadge.classList.remove('hidden');
    } else {
      roundBadge.classList.add('hidden');
    }

    const qText = document.getElementById('pQuestionText');
    qText.textContent = data.question;
    qText.style.visibility = (data.isLightning || showQuestionOnPhone) ? 'visible' : 'hidden';

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
        btn.addEventListener('click', () => socket.emit('submit-answer', i));
        optionGrid.appendChild(btn);
      });
    }

    showView('question');

    // Manual timer mode check
    if (data.timerRunning === false) {
      pWaitingTimer.classList.remove('hidden');
      optionGrid.classList.add('hidden');
      identForm.classList.add('hidden');
      document.getElementById('timerRing').style.display = 'none';
      // Don't start timer yet
    } else {
      pWaitingTimer.classList.add('hidden');
      document.getElementById('timerRing').style.display = '';
      if (currentKind === 'identification') {
        identForm.classList.remove('hidden');
        optionGrid.classList.add('hidden');
      } else {
        optionGrid.classList.remove('hidden');
        identForm.classList.add('hidden');
      }
      runTimerRing();
    }
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

  // ✅ NEW: timer started by host (manual mode)
  socket.on('timer-started', (data) => {
    currentStartedAt = data.startedAt;
    pWaitingTimer.classList.add('hidden');
    document.getElementById('timerRing').style.display = '';
    if (currentKind === 'identification') {
      identForm.classList.remove('hidden');
      optionGrid.classList.add('hidden');
      identInput.disabled = false;
      identInput.focus();
    } else {
      optionGrid.classList.remove('hidden');
      identForm.classList.add('hidden');
    }
    runTimerRing();
  });

  // ✅ NEW: waiting-for-timer (late join)
  socket.on('waiting-for-timer', (data) => {
    clearInterval(timerInterval);
    document.getElementById('pQNum').textContent = `Q ${data.index + 1} / ${data.total}`;
    document.getElementById('pQuestionText').textContent = '';
    optionGrid.innerHTML = '';
    optionGrid.classList.add('hidden');
    identForm.classList.add('hidden');
    document.getElementById('timerRing').style.display = 'none';
    pWaitingTimer.classList.remove('hidden');
    showView('question');
  });

  // RESULT
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

    const rankPill = document.getElementById('rankPill');
    if (data.score !== undefined && data.rank !== undefined) {
      rankPill.classList.remove('hidden');
      document.getElementById('resultRank').textContent = data.rank;
      document.getElementById('resultScore').textContent = data.score;
    } else {
      rankPill.classList.add('hidden');
    }

    const streakChip = document.getElementById('streakChip');
    if (currentMode === 'school' && data.isCorrect && data.streak > 1) {
      streakChip.textContent = `🔥 ${data.streak} in a row`;
      streakChip.classList.remove('hidden');
    } else {
      streakChip.classList.add('hidden');
    }

    showView('result');
  });

  // FINAL
  socket.on('personal-final', (data) => {
    clearInterval(timerInterval);
    document.getElementById('finalRank').textContent = '#' + data.rank;
    document.getElementById('finalScore').textContent = data.score;
    showView('final');
  });

  // TIE BREAKER
  socket.on('tiebreaker-notice', (data) => {
    clearInterval(timerInterval);
    if (data.isParticipant) {
      showView('tieIntroP');
    } else {
      document.getElementById('tieWatchText').textContent =
        `Tie breaker between: ${data.participants.map(p => `${p.avatar} ${p.name}`).join(' · ')}`;
      showView('tieWatch');
    }
  });

  const tbOptionGrid = document.getElementById('tbOptionGrid');
  const tbIdentForm = document.getElementById('tbIdentForm');
  const tbIdentInput = document.getElementById('tbIdentInput');

  socket.on('tiebreaker-question', (data) => {
    const badge = document.getElementById('tbPRoundBadge');
    const counter = document.getElementById('tbPQNum');

    if (data.isSpeedRound) {
      counter.textContent = `⚡ SPEED ROUND`;
      badge.textContent = 'Unang tama, panalo!';
      badge.classList.remove('hidden');
      badge.style.color = 'var(--danger)';
    } else {
      counter.textContent = `Tie Breaker — Q ${data.index + 1} / ${data.total}`;
      badge.textContent = '🐝 Clincher';
      badge.classList.remove('hidden');
      badge.style.color = '';
    }

    document.getElementById('tbPQuestionText').textContent = data.question;

    if (data.kind === 'identification') {
      tbOptionGrid.classList.add('hidden');
      tbIdentForm.classList.remove('hidden');
      tbIdentInput.value = '';
      tbIdentInput.disabled = false;
      tbIdentInput.focus();
    } else {
      tbIdentForm.classList.add('hidden');
      tbOptionGrid.classList.remove('hidden');
      tbOptionGrid.innerHTML = '';
      data.options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = `option-btn opt-${i}`;
        btn.innerHTML = `<span class="shape">${SHAPES[i]}</span><span>${opt}</span>`;
        btn.addEventListener('click', () => {
          socket.emit('submit-answer', i);
          [...tbOptionGrid.children].forEach(b => b.classList.toggle('locked-in', b === btn));
        });
        tbOptionGrid.appendChild(btn);
      });
    }

    showView('tieQuestionP');
  });

  tbIdentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = tbIdentInput.value.trim();
    if (!text) return;
    socket.emit('submit-answer', text);
  });

  socket.on('tiebreaker-answer-locked', (data) => {
    if (data.text !== undefined) {
      tbIdentInput.disabled = true;
      tbIdentInput.value = data.text;
    }
  });

  socket.on('tiebreaker-still-in', () => showView('tieStillIn'));
  socket.on('tiebreaker-eliminated', () => showView('tieOut'));
  socket.on('tiebreaker-won', () => showView('tieWon'));

  // REACTIONS
  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('player-reaction', btn.dataset.emoji);
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 2000);
    });
  });

  // RESET
  socket.on('reset', () => {
    clearInterval(timerInterval);
    showView('waiting');
  });
})();
