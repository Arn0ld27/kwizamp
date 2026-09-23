(function() {
  const socket = io();

  const views = {
    idle: document.getElementById('viewIdle'),
    getReady: document.getElementById('viewGetReady'),
    question: document.getElementById('viewQuestion'),
    reveal: document.getElementById('viewReveal'),
    ranking: document.getElementById('viewRanking'),
    roulette: document.getElementById('viewRoulette'),
    tieIntro: document.getElementById('viewTieIntro'),
    tieQuestion: document.getElementById('viewTieQuestion'),
    tieResult: document.getElementById('viewTieResult'),
    tieWinner: document.getElementById('viewTieWinner')
  };

  function showView(name) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[name].classList.remove('hidden');
  }

  // Ambient embers
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

  // GET READY
  let countdownInterval = null;
  socket.on('get-ready', (data) => {
    clearInterval(countdownInterval);
    document.getElementById('grQNum').textContent = data.index + 1;
    document.getElementById('grTotal').textContent = data.total;

    const roundBadge = document.getElementById('grRoundBadge');
    const lightningBadge = document.getElementById('grLightningBadge');

    if (data.isLightning) {
      lightningBadge.classList.remove('hidden');
      roundBadge.classList.add('hidden');
    } else {
      lightningBadge.classList.add('hidden');
      if (data.quizMode === 'quizbee' && data.round) {
        const label = data.roundLabel || `Round ${data.round}`;
        const pts = { 1: 1, 2: 2, 3: 3 }[data.round] || 5;
        roundBadge.textContent = `Round ${data.round} · ${label} · ${pts} pt`;
        roundBadge.classList.remove('hidden');
      } else {
        roundBadge.classList.add('hidden');
      }
    }

    const el = document.getElementById('grCount');
    let msLeft = data.countdownMs;
    el.textContent = Math.ceil(msLeft / 1000);
    showView('getReady');

    countdownInterval = setInterval(() => {
      msLeft -= 1000;
      if (msLeft <= 0) { clearInterval(countdownInterval); return; }
      el.textContent = Math.ceil(msLeft / 1000);
    }, 1000);
  });

  // QUESTION
  let timerInterval = null;
  let currentQuestionDuration = 20;

  socket.on('question-display', (data) => {
    clearInterval(countdownInterval);
    clearInterval(timerInterval);
    currentQuestionDuration = data.duration;

    document.getElementById('displayQNum').textContent = `Q ${data.index + 1} / ${data.total}`;
    document.getElementById('displayQuestion').textContent = data.question;

    const roundBadge = document.getElementById('displayRoundBadge');
    const lightningBadge = document.getElementById('displayLightningBadge');
    const lightningCounter = document.getElementById('displayLightningCounter');
    const waitingTimerEl = document.getElementById('displayWaitingTimer');

    if (data.isLightning) {
      lightningBadge.classList.remove('hidden');
      if (Number.isFinite(data.lightningIndex) && Number.isFinite(data.lightningTotal)) {
        lightningCounter.textContent = `${data.lightningIndex} / ${data.lightningTotal}`;
      } else {
        lightningCounter.textContent = '';
      }
      roundBadge.classList.add('hidden');
    } else {
      lightningBadge.classList.add('hidden');
      if (data.quizMode === 'quizbee' && data.round) {
        const label = data.roundLabel || `Round ${data.round}`;
        const pts = { 1: 1, 2: 2, 3: 3 }[data.round] || 5;
        roundBadge.textContent = `Round ${data.round} · ${label} · ${pts} pt`;
        roundBadge.classList.remove('hidden');
      } else {
        roundBadge.classList.add('hidden');
      }
    }

    showView('question');

    const timerEl = document.getElementById('displayTimer');

    if (data.timerRunning === false) {
      waitingTimerEl.classList.remove('hidden');
      timerEl.textContent = `⏸ ${data.duration}s`;
      timerEl.classList.add('frozen');
      timerEl.style.display = '';
      return;
    }

    waitingTimerEl.classList.add('hidden');
    timerEl.classList.remove('frozen');
    timerEl.style.display = '';

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

  socket.on('timer-started', (data) => {
    document.getElementById('displayWaitingTimer').classList.add('hidden');
    const timerEl = document.getElementById('displayTimer');
    timerEl.classList.remove('frozen');

    clearInterval(timerInterval);
    function tick() {
      const elapsed = (Date.now() - data.startedAt) / 1000;
      const remaining = Math.max(0, Math.ceil(currentQuestionDuration - elapsed));
      timerEl.textContent = `⏱ ${remaining}s`;
      timerEl.classList.toggle('low', remaining <= 5);
      if (remaining <= 0) clearInterval(timerInterval);
    }
    tick();
    timerInterval = setInterval(tick, 250);
  });

  // REVEAL
  const LETTERS = ['A', 'B', 'C', 'D'];
  socket.on('reveal-display', (data) => {
    clearInterval(timerInterval);

    document.getElementById('displayQNum2').textContent = document.getElementById('displayQNum').textContent;

    if (data.isLightning) {
      document.getElementById('displayQuestion2').textContent = '⚡ LIGHTNING ROUND ⚡';
      document.getElementById('displayCorrect').textContent = data.correctText || '⚡ Lightning Round complete';
      document.getElementById('displayCounts').innerHTML = '';
      showView('reveal');
      return;
    }

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

  // RANKING
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
    document.getElementById('rankingTitle').textContent = '🏆 Final Ranking';
    renderRanking(data.leaderboard);
    showView('ranking');
  });

  socket.on('game-ended-display', (data) => {
    document.getElementById('rankingTitle').textContent = '🏆 Final Ranking';
    if (data && data.leaderboard) renderRanking(data.leaderboard);
    showView('ranking');
  });

  // ROULETTE WAITING — idle screen
  socket.on('roulette-waiting', (data) => {
    showView('idle');
    const idleText = document.querySelector('#viewIdle .display-idle-text');
    if (idleText) idleText.textContent = '🎲 Waiting for host to start the roulette...';
  });

  // ROULETTE CLOSE — hide overlay, back to idle
  socket.on('roulette-close', () => {
    rouletteZoomOverlay.classList.remove('show');
    setTimeout(() => {
      rouletteGrid.innerHTML = '';
      rouletteBoxes = [];
      rouletteRunning = false;
      const idleText = document.querySelector('#viewIdle .display-idle-text');
      if (idleText) idleText.textContent = 'Waiting for host to show the leaderboard...';
      showView('idle');
    }, 400);
  });

  // ============================================================
  // BOX ROULETTE
  // ============================================================
  const rouletteGrid = document.getElementById('rouletteGrid');
  const rouletteStatus = document.getElementById('rouletteStatus');
  const rouletteTitle = document.getElementById('rouletteTitle');
  const rouletteZoomOverlay = document.getElementById('rouletteZoomOverlay');
  const rouletteZoomBox = document.getElementById('rouletteZoomBox');
  const rouletteZoomNum = document.getElementById('rouletteZoomNum');
  const rouletteZoomLabel = document.getElementById('rouletteZoomLabel');
  const rouletteZoomWinner = document.getElementById('rouletteZoomWinner');

  let rouletteBoxes = [];
  let rouletteRunning = false;
  let rouletteAudioCtx = null;

  // AUDIO
  function ensureAudio() {
    if (!rouletteAudioCtx) {
      try { rouletteAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
    if (rouletteAudioCtx && rouletteAudioCtx.state === 'suspended') rouletteAudioCtx.resume();
  }

  function beep(freq = 800, duration = 0.05, type = 'square', vol = 0.06) {
    try {
      ensureAudio();
      if (!rouletteAudioCtx) return;
      const osc = rouletteAudioCtx.createOscillator();
      const gain = rouletteAudioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = vol;
      gain.gain.exponentialRampToValueAtTime(0.0001, rouletteAudioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(rouletteAudioCtx.destination);
      osc.start();
      osc.stop(rouletteAudioCtx.currentTime + duration);
    } catch (e) {}
  }

  function tickSound() { beep(1200, 0.02, 'square', 0.025); }
  function boing() { beep(300, 0.15, 'sine', 0.1); setTimeout(() => beep(500, 0.12, 'sine', 0.08), 70); }
  function heartbeat() { beep(80, 0.12, 'sine', 0.15); setTimeout(() => beep(70, 0.15, 'sine', 0.13), 180); }
  function tension() { beep(200, 0.3, 'sawtooth', 0.05); }

  function tensionDrone(duration = 3000) {
    try {
      ensureAudio();
      if (!rouletteAudioCtx) return;
      const osc = rouletteAudioCtx.createOscillator();
      const gain = rouletteAudioCtx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(80, rouletteAudioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(200, rouletteAudioCtx.currentTime + duration / 1000);
      gain.gain.setValueAtTime(0.03, rouletteAudioCtx.currentTime);
      gain.gain.linearRampToValueAtTime(0.08, rouletteAudioCtx.currentTime + duration / 1000);
      gain.gain.exponentialRampToValueAtTime(0.0001, rouletteAudioCtx.currentTime + duration / 1000 + 0.3);
      osc.connect(gain);
      gain.connect(rouletteAudioCtx.destination);
      osc.start();
      osc.stop(rouletteAudioCtx.currentTime + duration / 1000 + 0.3);
    } catch (e) {}
  }

  function drumRoll(count = 20) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => beep(100 + Math.random() * 50, 0.05, 'triangle', 0.05), i * 80);
    }
  }

  function crowdCheer() {
    try {
      ensureAudio();
      if (!rouletteAudioCtx) return;
      const bufferSize = rouletteAudioCtx.sampleRate * 2;
      const buffer = rouletteAudioCtx.createBuffer(1, bufferSize, rouletteAudioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.15;
      const source = rouletteAudioCtx.createBufferSource();
      source.buffer = buffer;
      const filter = rouletteAudioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 800;
      filter.Q.value = 0.5;
      const gain = rouletteAudioCtx.createGain();
      gain.gain.setValueAtTime(0.08, rouletteAudioCtx.currentTime);
      gain.gain.linearRampToValueAtTime(0.15, rouletteAudioCtx.currentTime + 0.3);
      gain.gain.exponentialRampToValueAtTime(0.0001, rouletteAudioCtx.currentTime + 2);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(rouletteAudioCtx.destination);
      source.start();
      source.stop(rouletteAudioCtx.currentTime + 2);
    } catch (e) {}
  }

  function chime() {
    beep(660, 0.2, 'sine', 0.12);
    setTimeout(() => beep(990, 0.2, 'sine', 0.12), 140);
    setTimeout(() => beep(1320, 0.5, 'sine', 0.14), 280);
    setTimeout(() => crowdCheer(), 400);
  }

  function zoomSound() {
    try {
      ensureAudio();
      if (!rouletteAudioCtx) return;
      const osc = rouletteAudioCtx.createOscillator();
      const gain = rouletteAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300, rouletteAudioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, rouletteAudioCtx.currentTime + 0.5);
      gain.gain.setValueAtTime(0.1, rouletteAudioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, rouletteAudioCtx.currentTime + 0.6);
      osc.connect(gain);
      gain.connect(rouletteAudioCtx.destination);
      osc.start();
      osc.stop(rouletteAudioCtx.currentTime + 0.6);
    } catch (e) {}
  }

  // CONFETTI
  function launchConfetti() {
    const colors = ['#ff0044', '#ff6600', '#ffcc00', '#00ff88', '#00ccff', '#cc00ff', '#ff00ff', '#ffffff', '#ffee88'];
    for (let i = 0; i < 150; i++) {
      setTimeout(() => {
        const piece = document.createElement('div');
        piece.className = 'roulette-confetti';
        const shapes = ['rect', 'circle', 'triangle'];
        const shape = shapes[Math.floor(Math.random() * shapes.length)];
        piece.classList.add(shape);
        const color = colors[Math.floor(Math.random() * colors.length)];
        if (shape === 'triangle') piece.style.borderBottomColor = color;
        else piece.style.background = color;
        const startX = Math.random() * window.innerWidth;
        const startY = -20 - Math.random() * 100;
        piece.style.left = startX + 'px';
        piece.style.top = startY + 'px';
        const duration = 2 + Math.random() * 3;
        const scale = 0.5 + Math.random() * 1.2;
        piece.style.transform = `scale(${scale})`;
        piece.style.animation = `rouletteConfettiFall ${duration}s linear forwards`;
        document.body.appendChild(piece);
        setTimeout(() => piece.remove(), duration * 1000 + 500);
      }, i * 15);
    }
  }

  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // BUILD GRID
  function buildRouletteGrid(players, winners) {
    rouletteGrid.innerHTML = '';
    rouletteBoxes = [];

    const boxCount = Math.max(players.length * 3, 15);
    const items = players.map(p => ({ type: 'player', name: p.name, avatar: p.avatar }));

    const placeholderCount = boxCount - items.length;
    for (let i = 0; i < placeholderCount; i++) {
      items.push({ type: 'placeholder' });
    }

    const shuffled = shuffle([...items]);

    for (let i = 0; i < shuffled.length; i++) {
      const item = shuffled[i];
      const box = document.createElement('div');
      box.className = 'roulette-box';
      if (item.type === 'player') {
        box.dataset.name = item.name;
        box.dataset.avatar = item.avatar || '🐶';
        box.dataset.type = 'player';
        box.innerHTML = `
          <span class="rbox-avatar">${item.avatar || '🐶'}</span>
          <span class="rbox-name">${item.name}</span>
        `;
      } else {
        box.dataset.name = '🎲';
        box.dataset.type = 'placeholder';
        box.innerHTML = `<span class="rbox-placeholder">🎲</span>`;
      }
      rouletteGrid.appendChild(box);
      rouletteBoxes.push(box);
    }

    updateRouletteLayout();
  }

  function updateRouletteLayout() {
    const total = rouletteBoxes.length;
    if (total === 0) return;

    const screenW = window.innerWidth;
    const screenH = window.innerHeight - 60;

    let bestCols = 12;
    let bestScore = -Infinity;

    for (let cols = 3; cols <= 25; cols++) {
      const rows = Math.ceil(total / cols);
      const boxW = screenW / cols;
      const boxH = screenH / rows;
      if (boxW < 50 || boxH < 30) continue;

      const aspect = boxW / boxH;
      let score = 0;
      score -= Math.abs(aspect - 1.8) * 20;
      const emptyCells = (rows * cols) - total;
      score -= emptyCells * 5;
      score += Math.min(boxW, 250) * 0.3;

      if (score > bestScore) {
        bestScore = score;
        bestCols = cols;
      }
    }

    const cols = bestCols;
    const rows = Math.ceil(total / cols);

    rouletteGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    rouletteGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    rouletteGrid.style.gap = '0';
  }

  function getCurrentCols() {
    const colsStr = getComputedStyle(rouletteGrid).gridTemplateColumns;
    if (!colsStr || colsStr === 'none') return 12;
    return colsStr.split(' ').length;
  }

  // PATH
  function generatePath(total) {
    const patterns = ['zigzag', 'reverse-zigzag', 'random', 'spiral', 'column'];
    const pattern = patterns[Math.floor(Math.random() * patterns.length)];
    let path = [];
    const cols = getCurrentCols();
    const rows = Math.ceil(total / cols);

    if (pattern === 'column') {
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < rows; r++) {
          const idx = r * cols + c;
          if (idx < total) path.push(idx);
        }
    } else if (pattern === 'zigzag') {
      for (let r = 0; r < rows; r++) {
        if (r % 2 === 0) {
          for (let c = 0; c < cols; c++) { const idx = r * cols + c; if (idx < total) path.push(idx); }
        } else {
          for (let c = cols - 1; c >= 0; c--) { const idx = r * cols + c; if (idx < total) path.push(idx); }
        }
      }
    } else if (pattern === 'reverse-zigzag') {
      for (let r = rows - 1; r >= 0; r--) {
        if (r % 2 === 0) {
          for (let c = cols - 1; c >= 0; c--) { const idx = r * cols + c; if (idx < total) path.push(idx); }
        } else {
          for (let c = 0; c < cols; c++) { const idx = r * cols + c; if (idx < total) path.push(idx); }
        }
      }
    } else if (pattern === 'spiral') {
      let top = 0, bottom = rows - 1, left = 0, right = cols - 1;
      const visited = new Set();
      while (top <= bottom && left <= right) {
        for (let c = left; c <= right; c++) { const idx = top * cols + c; if (idx < total && !visited.has(idx)) { path.push(idx); visited.add(idx); } }
        top++;
        for (let r = top; r <= bottom; r++) { const idx = r * cols + right; if (idx < total && !visited.has(idx)) { path.push(idx); visited.add(idx); } }
        right--;
        if (top <= bottom) { for (let c = right; c >= left; c--) { const idx = bottom * cols + c; if (idx < total && !visited.has(idx)) { path.push(idx); visited.add(idx); } } bottom--; }
        if (left <= right) { for (let r = bottom; r >= top; r--) { const idx = r * cols + left; if (idx < total && !visited.has(idx)) { path.push(idx); visited.add(idx); } } left++; }
      }
    } else {
      const arr = [];
      for (let i = 0; i < total; i++) arr.push(i);
      path = shuffle(arr);
    }
    return path;
  }

  function setActiveBox(box) {
    rouletteBoxes.forEach(b => b.classList.remove('active', 'decoy', 'backward', 'hesitating'));
    box.classList.add('active');
  }

  function setActiveBoxBackward(box) {
    rouletteBoxes.forEach(b => b.classList.remove('active', 'decoy', 'backward', 'hesitating'));
    box.classList.add('backward');
  }

  // MAIN SPIN
  async function runRouletteSpin(players, winners, durationMs) {
    if (rouletteRunning) return;
    rouletteRunning = true;
    rouletteStatus.textContent = 'SPINNING...';
    rouletteStatus.className = 'roulette-status spinning';
    rouletteTitle.textContent = '🎲 SPINNING...';

    buildRouletteGrid(players, winners);
    await sleep(400);

    if (rouletteBoxes.length === 0) {
      rouletteRunning = false;
      return;
    }

    // ✅ FIX: Find ALL winner boxes (support ties)
    const winnerNames = winners.map(w => w.name);
    const winnerBoxes = rouletteBoxes.filter(box =>
      box.dataset.type === 'player' && winnerNames.includes(box.dataset.name)
    );
    const primaryWinnerBox = winnerBoxes.length > 0
      ? winnerBoxes[0]
      : (rouletteBoxes.find(b => b.dataset.type === 'player') || rouletteBoxes[0]);

    const path = generatePath(rouletteBoxes.length);
    let pathIndex = Math.floor(Math.random() * path.length);
    setActiveBox(rouletteBoxes[path[pathIndex]]);
    await sleep(200);

    // Phase 1: FAST
    tensionDrone(2800);
    const p1End = Date.now() + 2800;
    while (Date.now() < p1End) {
      pathIndex = (pathIndex + 1) % path.length;
      setActiveBox(rouletteBoxes[path[pathIndex]]);
      tickSound();
      await sleep(35);
    }

    // Phase 2: SLOW
    drumRoll(12);
    const p2End = Date.now() + 2000;
    let interval = 60;
    while (Date.now() < p2End) {
      interval += 8;
      pathIndex = (pathIndex + 1) % path.length;
      setActiveBox(rouletteBoxes[path[pathIndex]]);
      tickSound();
      await sleep(interval);
    }

    // Phase 3: DECOY
    for (let i = 0; i < 3; i++) {
      pathIndex = (pathIndex + 1) % path.length;
      setActiveBox(rouletteBoxes[path[pathIndex]]);
      beep(500, 0.05, 'square', 0.05);
      await sleep(350);
    }
    const decoyBox = rouletteBoxes[path[pathIndex]];
    decoyBox.classList.remove('active');
    decoyBox.classList.add('decoy');
    const hb1 = setInterval(() => heartbeat(), 400);
    await sleep(900);
    clearInterval(hb1);
    decoyBox.classList.remove('decoy');

    // Phase 4: FAKE-OUT
    boing();
    await sleep(150);
    for (let i = 0; i < 18; i++) {
      pathIndex = (pathIndex + 1) % path.length;
      setActiveBox(rouletteBoxes[path[pathIndex]]);
      tickSound();
      await sleep(80);
    }

    // Phase 5: SLOW AGAIN
    const p5End = Date.now() + 1500;
    let interval5 = 120;
    while (Date.now() < p5End) {
      interval5 += 12;
      pathIndex = (pathIndex + 1) % path.length;
      setActiveBox(rouletteBoxes[path[pathIndex]]);
      tickSound();
      await sleep(interval5);
    }

    // Phase 6: ALMOST STOP
    for (let i = 0; i < 3; i++) {
      pathIndex = (pathIndex + 1) % path.length;
      setActiveBox(rouletteBoxes[path[pathIndex]]);
      beep(500, 0.05, 'square', 0.05);
      await sleep(500);
    }

    // Phase 7: BACKWARD
    for (let i = 0; i < 4; i++) {
      pathIndex = (pathIndex - 1 + path.length) % path.length;
      setActiveBoxBackward(rouletteBoxes[path[pathIndex]]);
      boing();
      await sleep(350);
    }

    // Phase 8: FINAL HOP → primary winner
    const winnerPathIdx = path.indexOf(rouletteBoxes.indexOf(primaryWinnerBox));
    if (winnerPathIdx !== -1) {
      pathIndex = (winnerPathIdx - 3 + path.length) % path.length;
    }

    for (let i = 0; i < 3; i++) {
      pathIndex = (pathIndex + 1) % path.length;
      setActiveBox(rouletteBoxes[path[pathIndex]]);
      boing();
      await sleep(400);
    }

    // Phase 9: HESITATION
    const finalBox = rouletteBoxes[path[pathIndex]];
    finalBox.classList.remove('active');
    finalBox.classList.add('hesitating');
    const hb2 = setInterval(() => heartbeat(), 400);
    await sleep(1200);
    clearInterval(hb2);
    finalBox.classList.remove('hesitating');

    // Phase 10: FINALIZE
    tension();
    await sleep(600);
    chime();

    // ✅ FIX: Highlight ALL tied winners
    rouletteBoxes.forEach(b => b.classList.remove('active', 'decoy', 'backward', 'hesitating'));
    winnerBoxes.forEach(box => box.classList.add('active'));

    await sleep(600);
    openRouletteZoom(winners);

    rouletteRunning = false;
    rouletteStatus.textContent = 'WINNER!';
    rouletteStatus.className = 'roulette-status done';
    rouletteTitle.textContent = '🏆 WINNER!';
  }

  // ZOOM
  function openRouletteZoom(winners) {
    rouletteZoomWinner.innerHTML = '';
    if (winners.length === 1) {
      const w = winners[0];
      rouletteZoomWinner.innerHTML = `
        <span class="rzw-avatar">${w.avatar || '🐶'}</span>
        <span class="rzw-name">${w.name}</span>
        <span class="rzw-score">${w.score} pts</span>
      `;
    } else {
      winners.forEach(w => {
        const item = document.createElement('div');
        item.className = 'rzw-item';
        item.innerHTML = `
          <span class="rzw-avatar">${w.avatar || '🐶'}</span>
          <span class="rzw-name">${w.name}</span>
          <span class="rzw-score">${w.score} pts</span>
        `;
        rouletteZoomWinner.appendChild(item);
      });
    }

    rouletteZoomNum.textContent = '#1';
    rouletteZoomLabel.textContent = winners.length > 1 ? 'TIE!' : 'WINNER';

    rouletteZoomBox.style.transition = 'none';
    rouletteZoomBox.style.transform = 'scale(0.3)';
    void rouletteZoomBox.offsetWidth;
    rouletteZoomBox.style.transition = '';
    rouletteZoomOverlay.classList.add('show');
    zoomSound();

    setTimeout(() => launchConfetti(), 300);
    setTimeout(() => launchConfetti(), 1200);
  }

  // SOCKET EVENT
  socket.on('roulette-reveal', (data) => {
    const players = data.players || [];
    const winners = data.winners || [];
    const duration = data.duration || 6500;

    if (players.length === 0 || winners.length === 0) {
      if (data.leaderboard) {
        document.getElementById('rankingTitle').textContent = '🏆 Final Ranking';
        renderRanking(data.leaderboard);
        showView('ranking');
      }
      return;
    }

    rouletteZoomOverlay.classList.remove('show');
    showView('roulette');

    setTimeout(() => {
      runRouletteSpin(players, winners, duration);
    }, 300);
  });

  // TIE BREAKER
  socket.on('tiebreaker-started-display', (data) => {
    document.getElementById('tieIntroText').textContent =
      `${data.participants.length} players tied at rank #${data.rank} (${data.score} pts)`;
    document.getElementById('tieIntroPlayers').innerHTML =
      data.participants.map(p => `<span class="tie-player-chip">${p.avatar} ${p.name}</span>`).join('');
    showView('tieIntro');
  });

  let tbTimerInterval = null;
  socket.on('tiebreaker-question-display', (data) => {
    clearInterval(tbTimerInterval);
    const badge = document.getElementById('tbRoundBadge');
    const counter = document.getElementById('tbDisplayQNum');

    if (data.isSpeedRound) {
      counter.textContent = `⚡ SPEED ROUND — first correct answer wins!`;
      badge.textContent = '⚡ Speed Round';
      badge.style.color = 'var(--danger)';
    } else {
      counter.textContent = `Tie Breaker — Q ${data.index + 1} / ${data.total}`;
      badge.textContent = '🐝 Clincher Round';
      badge.style.color = '';
    }

    document.getElementById('tbDisplayQuestion').textContent = data.question;
    showView('tieQuestion');
  });

  socket.on('tiebreaker-result-display', (data) => {
    document.getElementById('tbResultCorrect').textContent = `✅ ${data.correctText}`;

    const elimEl = document.getElementById('tbResultEliminated');
    const remEl = document.getElementById('tbResultRemaining');

    if (data.allWrong) {
      elimEl.innerHTML = `<span style="color:var(--danger);">Everyone got it wrong — repeating question...</span>`;
      remEl.innerHTML = '';
    } else {
      elimEl.innerHTML = data.eliminated.length > 0
        ? `<span class="tie-label">Eliminated:</span> ` +
          data.eliminated.map(p => `<span class="tie-player-chip out">${p.avatar} ${p.name}</span>`).join('')
        : '';
      remEl.innerHTML = data.remaining.length > 0
        ? `<span class="tie-label">Still in:</span> ` +
          data.remaining.map(p => `<span class="tie-player-chip in">${p.avatar} ${p.name}</span>`).join('')
        : '';
    }

    showView('tieResult');
  });

  socket.on('tiebreaker-ended-display', (data) => {
    if (data.winner) {
      document.getElementById('tieWinnerTitle').textContent = `🏆 RANK #1`;
      document.getElementById('tieWinnerAvatar').textContent = data.winner.avatar;
      document.getElementById('tieWinnerName').textContent = data.winner.name;
      showView('tieWinner');

      setTimeout(() => {
        document.getElementById('rankingTitle').textContent = '🏆 Final Ranking';
        renderRanking(data.leaderboard);
        showView('ranking');
      }, 4000);
    } else {
      document.getElementById('rankingTitle').textContent = '🏆 Final Ranking';
      renderRanking(data.leaderboard);
      showView('ranking');
    }
  });

  // REACTIONS
  const reactionLayer = document.getElementById('reactionLayer');
  socket.on('reaction', (data) => {
    const el = document.createElement('div');
    el.className = 'reaction-pop';
    el.textContent = data.emoji;
    el.style.left = (Math.random() * 80 + 10) + 'vw';
    reactionLayer.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  });

  // RESET
  socket.on('reset', () => {
    clearInterval(timerInterval);
    clearInterval(countdownInterval);
    clearInterval(tbTimerInterval);
    rouletteRunning = false;
    rouletteZoomOverlay.classList.remove('show');
    const idleText = document.querySelector('#viewIdle .display-idle-text');
    if (idleText) idleText.textContent = 'Waiting for the host to start the quiz...';
    showView('idle');
  });

  let resizeTimeout;
  window.addEventListener('resize', () => {
    if (rouletteRunning) return;
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (rouletteBoxes.length > 0 && !views.roulette.classList.contains('hidden')) {
        updateRouletteLayout();
      }
    }, 300);
  });
})();
