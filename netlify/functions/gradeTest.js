const { OpenAI } = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Tolerant normalization for exact-match comparison of objective answers.
// Handles the small formatting drift the generator sometimes introduces
// between an option string and correct_answer (trailing period, casing, spacing).
function norm(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '');
}

// Feedback for a missed objective question — uses the explanation the
// generator already produced, so this costs no tokens.
function objectiveFeedback(q) {
  const correct = Array.isArray(q.correct_answer)
    ? q.correct_answer.join(', ')
    : q.correct_answer;
  const base = `Correct answer: ${correct}.`;
  return q.explanation ? `${base} ${q.explanation}` : base;
}

// Multiple choice: exact match, graded in code — never sent to the LLM.
function gradeMultipleChoice(q, studentAns) {
  const max = Number(q.max_points) || 1;
  const isCorrect = norm(studentAns) !== '' && norm(studentAns) === norm(q.correct_answer);
  return {
    id: q.id,
    status: isCorrect ? 'correct' : 'incorrect',
    points_awarded: isCorrect ? max : 0,
    max_points: max,
    feedback: isCorrect ? '' : objectiveFeedback(q)
  };
}

// Multi-answer: proportional credit (correct picks minus wrong picks),
// graded in code.
function gradeMultiAnswer(q, studentAns) {
  const correctList = (Array.isArray(q.correct_answer) ? q.correct_answer : [q.correct_answer]).map(norm);
  const max = Number(q.max_points) || correctList.length || 1;
  const given = (Array.isArray(studentAns) ? studentAns : (studentAns ? [studentAns] : [])).map(norm);

  const correctCount   = given.filter(g => correctList.includes(g)).length;
  const incorrectCount = given.filter(g => !correctList.includes(g)).length;
  let aw = Math.max(0, Math.min(max, correctCount - incorrectCount));

  let status;
  if (aw === max && aw > 0) status = 'correct';
  else if (aw > 0)          status = 'partial';
  else                      status = 'incorrect';

  return {
    id: q.id,
    status,
    points_awarded: aw,
    max_points: max,
    feedback: status === 'correct' ? '' : objectiveFeedback(q)
  };
}

// Written answers still need judgment — only these go to the LLM.
async function gradeWritten(written, studentResponses, gradingText) {
  const forModel = written.map(q => ({
    id: q.id,
    question_type: q.question_type,
    question_text: q.question_text,
    correct_answer: q.correct_answer,
    max_points: q.max_points,
    student_response: studentResponses[q.id] ?? ''
  }));

  const prompt = `
You are a lenient but fair grader for short and long answer questions only.

Questions with model answers and the student's response:
${JSON.stringify(forModel)}

Grading context:
${gradingText || '(none provided)'}

Rules:
- Award full marks if the essential points are covered; partial credit otherwise.
- Base status on points: "correct" if full marks, "partial" if some, "incorrect" if none.
- Keep feedback to one or two helpful sentences.

Return ONLY a valid JSON array; one object per question with:
id, status ("correct"/"partial"/"incorrect"), points_awarded, max_points, feedback.
No markdown fences, no extra text.
  `.trim();

  const completion = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: 'You are a lenient but fair grader. Output pure JSON only.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.1
  });

  let raw = completion.choices[0].message.content.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''); // strip any fences
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

exports.handler = async (event) => {
  try {
    const { studentResponses, questions, gradingText } = JSON.parse(event.body);
    const responses = studentResponses || {};

    const results = [];
    const written = [];

    for (const q of (questions || [])) {
      const ans = responses[q.id];
      if (q.question_type === 'multiple_choice') {
        results.push(gradeMultipleChoice(q, ans));
      } else if (q.question_type === 'multi_answer') {
        results.push(gradeMultiAnswer(q, ans));
      } else {
        written.push(q); // short_answer / long_answer
      }
    }

    // Only call the LLM if there are written answers to grade.
    if (written.length) {
      try {
        const writtenResults = await gradeWritten(written, responses, gradingText);
        const byId = new Map(writtenResults.map(r => [String(r.id), r]));
        for (const q of written) {
          const r = byId.get(String(q.id));
          results.push(r || {
            id: q.id,
            status: 'partial',
            points_awarded: 0,
            max_points: Number(q.max_points) || 1,
            feedback: 'Could not auto-grade this answer — please review with your tutor.'
          });
        }
      } catch (e) {
        // If written grading fails, don't lose the objective scores.
        console.error('Written grading failed:', e);
        for (const q of written) {
          results.push({
            id: q.id,
            status: 'partial',
            points_awarded: 0,
            max_points: Number(q.max_points) || 1,
            feedback: 'Could not auto-grade this answer — please review with your tutor.'
          });
        }
      }
    }

    // Preserve original question order.
    const order = new Map((questions || []).map((q, i) => [String(q.id), i]));
    results.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));

    return { statusCode: 200, body: JSON.stringify(results) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
