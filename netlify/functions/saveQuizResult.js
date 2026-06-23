const { OpenAI } = require('openai');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

// lazy-init Firebase Admin so cold starts don't re-initialize
function getAdmin() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return { auth: getAuth(), db: getFirestore() };
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function detectTopic(questions) {
  const questionTexts = questions.slice(0, 10).map(q => q.question_text).join('\n');
  const res = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{
      role: 'user',
      content: `Given these quiz questions, identify the subject and specific topic. Reply with ONLY valid JSON: {"subject":"...","topic":"..."}\n\nQuestions:\n${questionTexts}`
    }],
    temperature: 0,
    max_tokens: 40
  });
  try {
    return JSON.parse(res.choices[0].message.content.trim());
  } catch {
    return { subject: 'General', topic: 'Mixed' };
  }
}

async function generateCoachNote(questions, results) {
  const weak = results
    .filter(r => r.status !== 'correct')
    .map(r => {
      const q = questions.find(q => String(q.id) === String(r.id));
      return q ? q.question_text : null;
    })
    .filter(Boolean)
    .slice(0, 8);

  if (weak.length === 0) return "Perfect score — keep it up!";

  const res = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{
      role: 'user',
      content: `A student got these questions wrong or partially wrong:\n${weak.join('\n')}\n\nIn 2 sentences max, identify the weak concepts and suggest what to review. Be specific and direct.`
    }],
    temperature: 0.3,
    max_tokens: 80
  });
  return res.choices[0].message.content.trim();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { idToken, score, maxScore, questions, results } = JSON.parse(event.body);

    const { auth, db } = getAdmin();

    // verify the student's identity
    const decoded = await auth.verifyIdToken(idToken);
    const uid = decoded.uid;

    // run topic detection and coach note in parallel
    const [topic, coachNote] = await Promise.all([
      detectTopic(questions),
      generateCoachNote(questions, results)
    ]);

    const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;

    const quizData = {
      timestamp: new Date().toISOString(),
      subject: topic.subject,
      topic: topic.topic,
      score,
      maxScore,
      pct,
      coachNote,
      questions: questions.map(q => {
        const r = results.find(r => String(r.id) === String(q.id));
        return {
          id: q.id,
          question_text: q.question_text,
          question_type: q.question_type,
          correct_answer: q.correct_answer ?? null,
          status: r?.status ?? 'unknown',
          points_awarded: r?.points_awarded ?? 0,
          max_points: r?.max_points ?? q.max_points,
          feedback: r?.feedback ?? ''
        };
      })
    };

    await db.collection('users').doc(uid).collection('quizResults').add(quizData);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, subject: topic.subject, topic: topic.topic, coachNote })
    };
  } catch (e) {
    console.error('saveQuizResult error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
