// ================================================================
// KwizKamp — Question Editor (host panel)
// Depends on window.__kwizSocket (set in host.js)
// ================================================================
(function() {
const socket = window.__kwizSocket;

const el = (id) => document.getElementById(id);

// ---------- STATE ----------
let editorQuestions = [];       // working copy
let editorMeta = {
  source: 'original',
  rounds: [],
  locked: false,
  shuffleQuestions: false
};
let editingIndex = -1;          // -1 = adding new
let formType = 'mcq';
let formCorrectMcq = 0;
let formCorrectTf = true;
let dirty = false;

const TYPE_LABELS = { mcq: 'MCQ', truefalse: 'True/False', identification: 'Identification' };
const TYPE_ICONS  = { mcq: '🅰️', truefalse: '✅', identification: '✏️' };
const ROUND_LABELS = { 1: 'Easy', 2: 'Average', 3: 'Difficult', 4: 'Clincher' };

function roundLabel(r) {
  return ROUND_LABELS[r] || `Round ${r}`;
}

function uid() {
  return 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function kindOf(q) {
  if (q.type === 'truefalse') return 'truefalse';
  if (q.type === 'identification') return 'identification';
  return 'mcq';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- DATA FROM SERVER ----------
socket.on('editor-data', (data) => {
  editorQuestions = (data.questions || []).map(q => ({ ...q }));
  editorMeta = {
    source: data.source || 'original',
    rounds: data.rounds || [],
    locked: !!data.locked,
    shuffleQuestions: !!data.shuffleQuestions,
    totalGameQuestions: data.totalGameQuestions || 0,
    totalClincherQuestions: data.totalClincherQuestions || 0
  };
  dirty = false;
  renderEditor();
});

socket.on('editor-saved', (data) => {
  dirty = false;
  renderEditor();
  toast(data.reverted
    ? `↺ Reverted to questions.json (${data.count} questions)`
    : `💾 Saved ${data.count} question(s) to custom-questions.json`);
});

socket.on('editor-error', (data) => {
  if (data.errors && data.errors.length) {
    showModalErrors(data.errors);
  }
  toast('⚠️ ' + (data.message || 'Editor error'), true);
});

socket.on('shuffle-updated', (data) => {
  editorMeta.shuffleQuestions = !!data.shuffleQuestions;
  el('shuffleToggle').checked = editorMeta.shuffleQuestions;
});

// ---------- RENDER LIST ----------
function renderEditor() {
  // Header pills
  el('editorSourcePill').textContent = `source: ${editorMeta.source === 'custom' ? 'custom-questions.json' : 'questions.json'}`;
  el('editorSourcePill').className = 'pill' + (editorMeta.source === 'custom' ? ' source-custom' : '');
  el('editorCountPill').textContent = `${editorQuestions.length} question(s) · ${editorMeta.totalGameQuestions} game · ${editorMeta.totalClincherQuestions} clincher`;

  const rounds = [...new Set(editorQuestions.map(q => q.round || 1))].sort((a, b) => a - b);
  el('editorRoundPill').textContent = rounds.length ? `rounds: ${rounds.join(', ')}` : 'rounds: —';

  // Locked banner
  el('editorLockedBanner').classList.toggle('hidden', !editorMeta.locked);
  el('saveBtn').disabled = editorMeta.locked;
  el('addQuestionBtn').disabled = editorMeta.locked;
  el('revertBtn').disabled = editorMeta.locked;

  // Shuffle toggle
  el('shuffleToggle').checked = editorMeta.shuffleQuestions;

  // List
  const list = el('editorList');
  list.innerHTML = '';

  if (editorQuestions.length === 0) {
    list.innerHTML = `<div class="editor-empty">No questions yet. Click <strong>➕ Add question</strong> to start.</div>`;
    return;
  }

  editorQuestions.forEach((q, i) => {
    const kind = kindOf(q);
    const row = document.createElement('div');
    row.className = 'editor-row' + (q.clincher ? ' clincher' : '');
    row.innerHTML = `
      <span class="ed-num">${i + 1}</span>
      <span class="ed-type type-${kind}">${TYPE_ICONS[kind]} ${TYPE_LABELS[kind]}</span>
      <span class="ed-round">R${q.round || 1} · ${roundLabel(q.round || 1)}</span>
      <span class="ed-question" title="${escapeHtml(q.question)}">${escapeHtml(q.question)}</span>
      <span class="ed-clinch">${q.clincher ? '🐝' : ''}</span>
      <span class="ed-actions">
        <button class="ed-btn" data-act="up" data-i="${i}" title="Move up">⬆️</button>
        <button class="ed-btn" data-act="down" data-i="${i}" title="Move down">⬇️</button>
        <button class="ed-btn" data-act="dup" data-i="${i}" title="Duplicate">📋</button>
        <button class="ed-btn" data-act="edit" data-i="${i}" title="Edit">✏️</button>
        <button class="ed-btn danger" data-act="del" data-i="${i}" title="Delete">🗑️</button>
      </span>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('.ed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (editorMeta.locked) return;
      const i = Number(btn.dataset.i);
      const act = btn.dataset.act;
      if (act === 'edit') openModal(i);
      else if (act === 'del') { editorQuestions.splice(i, 1); dirty = true; renderEditor(); }
      else if (act === 'dup') { editorQuestions.splice(i + 1, 0, { ...editorQuestions[i], id: uid() }); dirty = true; renderEditor(); }
      else if (act === 'up' && i > 0) { [editorQuestions[i - 1], editorQuestions[i]] = [editorQuestions[i], editorQuestions[i - 1]]; dirty = true; renderEditor(); }
      else if (act === 'down' && i < editorQuestions.length - 1) { [editorQuestions[i + 1], editorQuestions[i]] = [editorQuestions[i], editorQuestions[i + 1]]; dirty = true; renderEditor(); }
    });
  });
}

// ---------- MODAL ----------
const modal = el('editorModal');

function openModal(index) {
  editingIndex = index;
  el('modalErrors').classList.add('hidden');

  if (index === -1) {
    // New question defaults
    formType = 'mcq';
    formCorrectMcq = 0;
    formCorrectTf = true;
    el('modalTitle').textContent = '➕ Add question';
    el('formRound').value = 1;
    el('formClincher').checked = false;
    el('formQuestion').value = '';
    setFormOptions(['', '', '', '']);
    el('formIdentAnswer').value = '';
    el('formIdentAcceptable').value = '';
  } else {
    const q = editorQuestions[index];
    formType = kindOf(q);
    el('modalTitle').textContent = `✏️ Edit question #${index + 1}`;
    el('formRound').value = q.round || 1;
    el('formClincher').checked = !!q.clincher;
    el('formQuestion').value = q.question || '';
    if (formType === 'mcq') {
      formCorrectMcq = Number(q.correct) || 0;
      setFormOptions(q.options || ['', '', '', '']);
    } else if (formType === 'truefalse') {
      formCorrectTf = (typeof q.correct === 'boolean') ? q.correct : (Number(q.correct) === 0);
    } else {
      el('formIdentAnswer').value = q.answer || '';
      el('formIdentAcceptable').value = (q.acceptable || []).join(', ');
    }
  }

  applyFormType();
  updatePreview();
  modal.classList.remove('hidden');
  setTimeout(() => el('formQuestion').focus(), 50);
}

function closeModal() {
  modal.classList.add('hidden');
}

el('modalClose').addEventListener('click', closeModal);
el('modalCancel').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// ---------- FORM TYPE ----------
const typeToggle = el('formTypeToggle');
typeToggle.addEventListener('click', (e) => {
  const b = e.target.closest('.type-btn');
  if (!b) return;
  formType = b.dataset.type;
  applyFormType();
  updatePreview();
});

function applyFormType() {
  [...typeToggle.children].forEach(b => b.classList.toggle('active', b.dataset.type === formType));
  el('formMcq').classList.toggle('hidden', formType !== 'mcq');
  el('formTf').classList.toggle('hidden', formType !== 'truefalse');
  el('formIdent').classList.toggle('hidden', formType !== 'identification');

  if (formType === 'truefalse') {
    [...el('formTfToggle').children].forEach(b => {
      b.classList.toggle('active', (b.dataset.tf === 'true') === formCorrectTf);
    });
  }
}

// TF toggle
el('formTfToggle').addEventListener('click', (e) => {
  const b = e.target.closest('.type-btn');
  if (!b) return;
  formCorrectTf = b.dataset.tf === 'true';
  applyFormType();
  updatePreview();
});

// MCQ options
function setFormOptions(arr) {
  const wrap = el('formOptions');
  wrap.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'form-option-row';
    row.innerHTML = `
      <label class="form-option-radio">
        <input type="radio" name="mcqCorrect" value="${i}" ${i === formCorrectMcq ? 'checked' : ''} />
      </label>
      <input type="text" class="form-input form-option-input" data-i="${i}"
             value="${escapeHtml(arr[i] || '')}" placeholder="Option ${i + 1}" />
    `;
    wrap.appendChild(row);
  }
  wrap.querySelectorAll('input[type="radio"]').forEach(r => {
    r.addEventListener('change', () => { formCorrectMcq = Number(r.value); updatePreview(); });
  });
  wrap.querySelectorAll('.form-option-input').forEach(inp => {
    inp.addEventListener('input', updatePreview);
  });
}

// ---------- FORM CHANGE LISTENERS ----------
['formRound', 'formQuestion', 'formClincher', 'formIdentAnswer', 'formIdentAcceptable'].forEach(id => {
  el(id).addEventListener('input', updatePreview);
  el(id).addEventListener('change', updatePreview);
});

// ---------- LIVE PREVIEW ----------
function updatePreview() {
  const text = el('formQuestion').value.trim() || 'Your question will appear here…';
  const round = Number(el('formRound').value) || 1;
  const isClincher = el('formClincher').checked;

  el('previewQuestion').textContent = text;
  el('previewQNum').textContent = `Q ${editingIndex === -1 ? editorQuestions.length + 1 : editingIndex + 1} / N`;
  el('previewRound').textContent = `Round ${round} · ${roundLabel(round)}${isClincher ? ' · 🐝 Clincher' : ''}`;

  const optWrap = el('previewOptions');
  optWrap.innerHTML = '';

  if (formType === 'mcq') {
    const opts = [...el('formOptions').querySelectorAll('.form-option-input')].map(i => i.value);
    opts.forEach((o, i) => {
      const d = document.createElement('div');
      d.className = 'preview-opt' + (i === formCorrectMcq ? ' correct' : '');
      d.textContent = `${'ABCD'[i]}. ${o || '—'}`;
      optWrap.appendChild(d);
    });
  } else if (formType === 'truefalse') {
    ['True', 'False'].forEach((o, i) => {
      const isCorrect = (i === 0) === formCorrectTf;
      const d = document.createElement('div');
      d.className = 'preview-opt' + (isCorrect ? ' correct' : '');
      d.textContent = o;
      optWrap.appendChild(d);
    });
  } else {
    const d = document.createElement('div');
    d.className = 'preview-opt correct';
    d.textContent = '✏️ Identification — typed answer';
    optWrap.appendChild(d);
  }

  const ansWrap = el('previewAnswer');
  if (formType === 'identification') {
    ansWrap.classList.remove('hidden');
    ansWrap.textContent = `✅ ${el('formIdentAnswer').value.trim() || '—'}`;
  } else {
    ansWrap.classList.add('hidden');
  }
}

// ---------- MODAL ERRORS ----------
function showModalErrors(errors) {
  const wrap = el('modalErrors');
  wrap.classList.remove('hidden');
  wrap.innerHTML = errors.map(e => `<div>• ${escapeHtml(e)}</div>`).join('');
}

// ---------- APPLY ----------
el('modalApply').addEventListener('click', () => {
  const errors = validateForm();
  if (errors.length) { showModalErrors(errors); return; }
  el('modalErrors').classList.add('hidden');

  const q = buildQuestionFromForm();
  if (editingIndex === -1) {
    editorQuestions.push(q);
  } else {
    q.id = editorQuestions[editingIndex].id || q.id;
    editorQuestions[editingIndex] = q;
  }
  dirty = true;
  closeModal();
  renderEditor();
});

function validateForm() {
  const errs = [];
  const text = el('formQuestion').value.trim();
  if (!text) errs.push('Question text is required.');
  const round = Number(el('formRound').value);
  if (!Number.isFinite(round) || round < 1) errs.push('Round must be a positive number.');

  if (formType === 'mcq') {
    const opts = [...el('formOptions').querySelectorAll('.form-option-input')].map(i => i.value.trim());
    if (opts.length !== 4) errs.push('MCQ requires exactly 4 options.');
    opts.forEach((o, i) => { if (!o) errs.push(`Option ${'ABCD'[i]} is empty.`); });
    if (formCorrectMcq < 0 || formCorrectMcq > 3) errs.push('Mark one option as correct.');
  } else if (formType === 'identification') {
    if (!el('formIdentAnswer').value.trim()) errs.push('Identification answer is required.');
  }
  return errs;
}

function buildQuestionFromForm() {
  const base = {
    id: uid(),
    type: formType,
    round: Number(el('formRound').value) || 1,
    clincher: el('formClincher').checked,
    question: el('formQuestion').value.trim()
  };

  if (formType === 'mcq') {
    const opts = [...el('formOptions').querySelectorAll('.form-option-input')].map(i => i.value.trim());
    return { ...base, options: opts, correct: formCorrectMcq };
  }
  if (formType === 'truefalse') {
    return { ...base, correct: formCorrectTf };
  }
  const ans = el('formIdentAnswer').value.trim();
  const acc = el('formIdentAcceptable').value
    .split(',').map(s => s.trim()).filter(Boolean);
  return { ...base, answer: ans, acceptable: acc };
}

// ---------- ADD BUTTON ----------
el('addQuestionBtn').addEventListener('click', () => {
  if (editorMeta.locked) return;
  openModal(-1);
});

// ---------- SAVE / REVERT ----------
el('saveBtn').addEventListener('click', () => {
  if (editorMeta.locked) return;
  socket.emit('editor-save', { questions: editorQuestions });
});

el('revertBtn').addEventListener('click', () => {
  if (editorMeta.locked) return;
  if (!confirm('Revert to the original questions.json? This deletes your custom-questions.json file.')) return;
  socket.emit('editor-revert');
});

// ---------- SHUFFLE TOGGLE ----------
el('shuffleToggle').addEventListener('change', (e) => {
  socket.emit('editor-set-shuffle', e.target.checked);
});

// ---------- IMPORT ----------
const importModal = el('importModal');
el('importBtn').addEventListener('click', () => {
  if (editorMeta.locked) return;
  el('importText').value = '';
  el('importErrors').classList.add('hidden');
  importModal.classList.remove('hidden');
});
el('importClose').addEventListener('click', () => importModal.classList.add('hidden'));
el('importCancel').addEventListener('click', () => importModal.classList.add('hidden'));
importModal.addEventListener('click', (e) => { if (e.target === importModal) importModal.classList.add('hidden'); });

el('importApply').addEventListener('click', () => {
  const raw = el('importText').value.trim();
  const errWrap = el('importErrors');
  errWrap.classList.add('hidden');

  if (!raw) {
    errWrap.textContent = 'Paste JSON first.';
    errWrap.classList.remove('hidden');
    return;
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    errWrap.textContent = 'Invalid JSON: ' + err.message;
    errWrap.classList.remove('hidden');
    return;
  }

  const list = Array.isArray(parsed) ? parsed : (parsed.questions || []);
  if (!Array.isArray(list) || list.length === 0) {
    errWrap.textContent = 'Expected a non-empty array (or { questions: [...] }).';
    errWrap.classList.remove('hidden');
    return;
  }

  // Normalize lightweight — full validation happens on save
  editorQuestions = list.map(q => {
    const kind = kindOf(q);
    const out = {
      id: q.id || uid(),
      type: q.type || (kind === 'mcq' ? 'mcq' : kind),
      round: Number(q.round) || 1,
      clincher: !!q.clincher,
      question: String(q.question || '')
    };
    if (kind === 'mcq') {
      out.options = Array.isArray(q.options) ? q.options.slice(0, 4) : ['', '', '', ''];
      while (out.options.length < 4) out.options.push('');
      out.correct = Number(q.correct) || 0;
    } else if (kind === 'truefalse') {
      out.correct = (typeof q.correct === 'boolean') ? q.correct : (Number(q.correct) === 0);
    } else {
      out.answer = String(q.answer || '');
      out.acceptable = Array.isArray(q.acceptable) ? q.acceptable : [];
    }
    return out;
  });

  dirty = true;
  importModal.classList.add('hidden');
  renderEditor();
  toast(`📥 Loaded ${editorQuestions.length} question(s) into editor (not saved yet)`);
});

// ---------- EXPORT ----------
el('exportBtnQ').addEventListener('click', () => {
  const payload = { questions: editorQuestions };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kwizkamp-questions-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ---------- TOAST ----------
let toastTimer = null;
function toast(msg, isError) {
  let t = el('editorToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'editorToast';
    t.className = 'editor-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- HOOK FOR TAB SWITCH ----------
window.__editorOnShow = () => {
  socket.emit('editor-get');
};

// ---------- BEFORE UNLOAD WARNING ----------
window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
})();
