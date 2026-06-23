// src/main.js

// ─── Loading Screen Helpers ───────────────────────────────────────────
const quotes = [
  "Uploading your document...",
  "Scanning pages...",
  "Designing questions...",
  "Shoutout to u for putting in the work",
  "Finalizing questions...",
  "Give it a sec",
  "So what's new with u",
  "I swear it'll be done in like 3 seconds",
  "The thing u uploaded was probably huge"
];
let loadingTimer, quoteTimer;

function showLoading(totalMs = 25000) {
  const overlay = document.getElementById('loadingOverlay');
  const fill    = document.getElementById('loadingProgress');
  const quoteEl = document.getElementById('loadingQuote');
  overlay.style.display = 'flex';
  fill.style.width = '0%';

  let qi = 0;
  quoteEl.textContent = quotes[0];
  clearInterval(quoteTimer);
  quoteTimer = setInterval(() => {
    qi = (qi + 1) % quotes.length;
    quoteEl.textContent = quotes[qi];
  }, 5000);

  const start = Date.now();
  clearInterval(loadingTimer);
  loadingTimer = setInterval(() => {
    const pct = ((Date.now() - start) / totalMs) * 100;
    fill.style.width = Math.min(pct, 100) + '%';
    if (pct >= 100) clearInterval(loadingTimer);
  }, 100);
}

function hideLoading() {
  document.getElementById('loadingOverlay').style.display = 'none';
  clearInterval(quoteTimer);
  clearInterval(loadingTimer);
}

// ─── PDF.js setup ─────────────────────────────────────────────────────
const pdfjsLib = window['pdfjs-dist/build/pdf'];
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.9.179/pdf.worker.min.js';

// ─── Render each PDF page to a PNG data‑URL ───────────────────────────
async function pdfToDataUrls(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const dataUrls = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    dataUrls.push(canvas.toDataURL('image/png'));
  }

  return dataUrls;
}

// ─── Send each page to your OCR Netlify Function ──────────────────────
async function ocrPdf(file) {
  const dataUrls = await pdfToDataUrls(file);
  let fullText = '';

  for (const dataUrl of dataUrls) {
    const res = await fetch('/.netlify/functions/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64PagePNGs: [dataUrl] })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
    const { text } = await res.json();
    fullText += text + '\n\n';
  }

  return fullText.trim();
}

// ─── Helpers to collect PDFs ──────────────────────────────────────────
function serializeFiles(input) {
  return Array.from(input.files || []);
}

async function collectTexts(input) {
  let combined = '';
  for (const f of serializeFiles(input)) {
    combined += await ocrPdf(f) + '\n\n';
  }
  return combined.trim();
}

// ─── Helper to call your Netlify Functions ───────────────────────────
async function callFunction(path, payload) {
  const res = await fetch(`/.netlify/functions/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ─── Fisher–Yates shuffle ─────────────────────────────────────────────
function shuffle(arr) {
  if (!Array.isArray(arr)) return [];
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Generate Test ─────────────────────────────────────────────────────
document.getElementById('btn_generate').addEventListener('click', async () => {
  const nMC    = +document.getElementById('num_mc').value;
  const nMulti = +document.getElementById('num_multi').value;
  const nShort = +document.getElementById('num_short').value;
  const nLong  = +document.getElementById('num_long').value;

  if (nMC + nMulti + nShort + nLong === 0) {
    return alert('Please specify at least one question.');
  }

  const btn = document.getElementById('btn_generate');
  btn.disabled = true;
  try {
    showLoading(35000);
    const contentText = await collectTexts(document.getElementById('content_files'));
    const gradingText = await collectTexts(document.getElementById('grading_files'));
    const params = {
      num_mc:    nMC,
      num_multi: nMulti,
      num_short: nShort,
      num_long:  nLong,
      mc_options: +document.getElementById('mc_options').value,
      difficulty: +document.getElementById('difficulty').value
    };
    const questions = await callFunction('generateTest', { testParams: params, contentText, gradingText });
    hideLoading();
    renderQuestions(questions);
  } catch (e) {
    hideLoading();
    alert(`Error: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ─── Render Questions ─────────────────────────────────────────────────
function renderQuestions(questions) {
  const form = document.getElementById('test_form');
  form.innerHTML = '';
  form.questions = questions;

  questions.forEach(q => {
    const div = document.createElement('div');
    div.className = 'question';
    div.id = `question-${q.id}`;
    div.innerHTML = `<h4>Q${q.id}: ${q.question_text}</h4>`;

    if (q.question_type === 'multiple_choice') {
      for (const opt of shuffle(q.options)) {
        div.innerHTML += `
          <label>
            <input type="radio" name="q${q.id}" value="${opt}" />
            <span>${opt}</span>
          </label>`;
      }
    } else if (q.question_type === 'multi_answer') {
      for (const opt of shuffle(q.options)) {
        div.innerHTML += `
          <label>
            <input type="checkbox" name="q${q.id}" value="${opt}" />
            <span>${opt}</span>
          </label>`;
      }
    } else if (q.question_type === 'short_answer') {
      div.innerHTML += `<input type="text" name="q${q.id}" style="width:100%" />`;
    } else {
      div.innerHTML += `<textarea name="q${q.id}" rows="4" style="width:100%"></textarea>`;
    }

    form.appendChild(div);
  });

  document.getElementById('setup').style.display     = 'none';
  document.getElementById('questions').style.display = 'block';
}

// ─── Submit & Grade ────────────────────────────────────────────────────
document.getElementById('btn_submit').addEventListener('click', async () => {
  const form = document.getElementById('test_form');
  const resp = {};

  form.questions.forEach(q => {
    const key = `q${q.id}`;
    if (q.question_type === 'multiple_choice') {
      const sel = form.querySelector(`input[name="${key}"]:checked`);
      resp[q.id] = sel ? sel.value : '';
    } else if (q.question_type === 'multi_answer') {
      resp[q.id] = Array.from(
        form.querySelectorAll(`input[name="${key}"]:checked`)
      ).map(c => c.value);
    } else if (q.question_type === 'short_answer') {
      const inp = form.querySelector(`input[name="${key}"]`);
      resp[q.id] = inp ? inp.value : '';
    } else {
      const ta = form.querySelector(`textarea[name="${key}"]`);
      resp[q.id] = ta ? ta.value : '';
    }
  });

// ─── After your existing btn_submit handler ─────────────────────────────
// Add this NEW Test listener:
document.getElementById('btn_new').addEventListener('click', () => {
  // hide questions view, show setup again
  document.getElementById('questions').style.display = 'none';
  document.getElementById('setup').style.display     = 'block';
  // hide the New Test button again
  document.getElementById('btn_new').style.display   = 'none';
  // clear previous summary/comment
  document.getElementById('result_summary').textContent = '';
  const oldC = document.getElementById('overall_comment');
  if (oldC) oldC.remove();
});


  // stash for local multi-answer re‑scoring
  window._lastResponses = resp;

  const btn = document.getElementById('btn_submit');
  btn.disabled = true;
  try {
    showLoading(15000);
    const gradingText = await collectTexts(document.getElementById('grading_files'));
    const results = await callFunction('gradeTest', {
      studentResponses: resp,
      questions: form.questions,
      gradingText
    });
    hideLoading();
    applyGrading(results);
  } catch (e) {
    hideLoading();
    alert(`Error: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ─── Apply Grading & Feedback ─────────────────────────────────────────
function applyGrading(results) {
  let totalAwarded = 0, totalMax = 0;
  const summaryEl = document.getElementById('result_summary');
  summaryEl.textContent = '';

  // remove old comment
  const oldC = document.getElementById('overall_comment');
  if (oldC) oldC.remove();

  results.forEach(r => {
    const qDiv = document.getElementById(`question-${r.id}`);
    if (!qDiv) return;

    // highlight correct answers
    const orig = document
      .getElementById('test_form')
      .questions.find(q => String(q.id) === String(r.id));

    if (orig.question_type === 'multiple_choice') {
      qDiv.querySelectorAll('input[type=radio]').forEach(inp => {
        if (inp.value === orig.correct_answer) {
          inp.parentElement.style.color = 'var(--correct)';
        }
      });
    } else if (orig.question_type === 'multi_answer') {
      qDiv.querySelectorAll('input[type=checkbox]').forEach(inp => {
        if (
          Array.isArray(orig.correct_answer) &&
          orig.correct_answer.includes(inp.value)
        ) {
          inp.parentElement.style.color = 'var(--correct)';
        }
      });

      // override multi-answer scoring
      const studentSel = Array.isArray(window._lastResponses[r.id])
        ? window._lastResponses[r.id]
        : [];
      const correctList = Array.isArray(orig.correct_answer)
        ? orig.correct_answer
        : [];
      const correctCount = studentSel.filter(o => correctList.includes(o)).length;
      const incorrectCount = studentSel.filter(o => !correctList.includes(o)).length;
      let aw = correctCount - incorrectCount;
      if (aw < 0) aw = 0;
      if (aw > orig.max_points) aw = orig.max_points;
      r.points_awarded = aw;
      if (aw === orig.max_points) r.status = 'correct';
      else if (aw > 0)            r.status = 'partial';
      else                        r.status = 'incorrect';
    }

    totalAwarded += r.points_awarded;
    totalMax     += r.max_points;

    // render result block
    const resDiv = document.createElement('div');
    resDiv.className = 'result';
    const header = document.createElement('div');
    header.className = 'result-header';

    let icon, cls;
    if (r.status === 'correct')    { icon = '✔'; cls = 'correct'; }
    else if (r.status === 'partial'){ icon = '⚠'; cls = 'partial'; }
    else                            { icon = '✘'; cls = 'wrong'; }

    header.innerHTML = `
      <span class="icon ${cls}">${icon}</span>
      <span class="score-text">${r.points_awarded}/${r.max_points}</span>
    `;
    resDiv.appendChild(header);

    if (r.status !== 'correct') {
      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = 'btn-feedback';
      btn.textContent = 'Show Feedback';
      const fb = document.createElement('div');
      fb.className   = 'feedback-text';
      fb.textContent = r.feedback;

      btn.addEventListener('click', () => {
        fb.classList.toggle('visible');
        btn.textContent = fb.classList.contains('visible')
          ? 'Hide Feedback'
          : 'Show Feedback';
      });

      resDiv.appendChild(btn);
      resDiv.appendChild(fb);
    }

    qDiv.appendChild(resDiv);
  });

  // overall score
  const pct = totalMax > 0
    ? (totalAwarded / totalMax) * 100
    : 0;
  const pctText = pct.toFixed(2);

  summaryEl.textContent = `Overall Score: ${pctText}% (${totalAwarded}/${totalMax})`;

  // comment
  let commentText;
  if (pct === 100)            commentText = "💯 DAMN BRO";
  else if (pct >= 90)         commentText = "🎉 Insane. Einstein level performance";
  else if (pct >= 86)         commentText = "💪 Bagged the A, light work";
  else if (pct >= 80)         commentText = "🙂 We take those, easy A-";
  else if (pct >= 70)         commentText = "👌 Gotta review a little more";
  else if (pct >= 60)         commentText = "🤔 We can do better";
  else if (pct >= 50)         commentText = "😐 You passed, but you could do better";
  else                        commentText = "🚀 You failed, which means nothing if you don't give up";

  const commentEl = document.createElement('div');
  commentEl.id = 'overall_comment';
  commentEl.style.marginTop = '8px';
  commentEl.style.fontSize   = '1rem';
  commentEl.style.color      = 'var(--text)';
  commentEl.textContent      = commentText;

  summaryEl.parentNode.insertBefore(commentEl, summaryEl.nextSibling);

  document.getElementById('btn_new').style.display = 'inline-block';
}
