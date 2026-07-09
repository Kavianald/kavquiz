const { OpenAI } = require('openai');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// lazy-init Firebase Admin so cold starts don't re-initialize
function getAdmin() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return { auth: getAuth(), db: getFirestore() };
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// XP awarded server-side so it can't be gamed from the client
function xpForQuiz(pct) {
  return 10 + (pct >= 85 ? 15 : 0);
}

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
    const { idToken, score, maxScore, questions, results, studentResponses } = JSON.parse(event.body);

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
    const xpEarned = xpForQuiz(pct);
    const nowIso = new Date().toISOString();

    const quizData = {
      timestamp: nowIso,
      subject: topic.subject,
      topic: topic.topic,
      score,
      maxScore,
      pct,
      xpEarned,
      coachNote,
      questions: questions.map(q => {
        const r = results.find(r => String(r.id) === String(q.id));
        return {
          id: q.id,
          question_text: q.question_text,
          question_type: q.question_type,
          correct_answer: q.correct_answer ?? null,
          student_answer: studentResponses?.[q.id] ?? null,
          status: r?.status ?? 'unknown',
          points_awarded: r?.points_awarded ?? 0,
          max_points: r?.max_points ?? q.max_points,
          feedback: r?.feedback ?? ''
        };
      })
    };

    const userRef = db.collection('users').doc(uid);
    const quizRef = userRef.collection('quizResults').doc();
    const summaryRef = userRef.collection('quizStats').doc('summary');

    // one transaction: save quiz, update the dashboard summary doc, award XP.
    // The summary doc keeps dashboard loads at 2 reads regardless of quiz count.
    await db.runTransaction(async (tx) => {
      const [summarySnap, userSnap] = await Promise.all([tx.get(summaryRef), tx.get(userRef)]);

      // heal partial user docs: if the student quizzed before ever opening
      // the dashboard, this function created their doc with only xp — the
      // missing profile fields then break the dashboard's security rules
      const u = userSnap.exists ? userSnap.data() : {};
      const heal = {};
      if (u.email == null && decoded.email) heal.email = decoded.email;
      if (typeof u.hoursTrained !== 'number') heal.hoursTrained = 0;
      if (typeof u.xpSpent !== 'number') heal.xpSpent = 0;
      if (!u.skills) heal.skills = { algebra: 0, factoring: 0, reasoning: 0, wordProblems: 0, effort: 0 };
      if (!u.createdAt) heal.createdAt = FieldValue.serverTimestamp();
      const s = summarySnap.exists
        ? summarySnap.data()
        : { totalQuizzes: 0, overallAvgPct: 0, bestPct: 0, bySubject: {}, recent: [] };

      const subj = s.bySubject[topic.subject] || { attempts: 0, avgPct: 0, topics: {} };
      const t = subj.topics[topic.topic] || { attempts: 0, avgPct: 0, lastPct: 0 };

      t.avgPct = Math.round((t.avgPct * t.attempts + pct) / (t.attempts + 1));
      t.attempts += 1;
      t.lastPct = pct;
      subj.topics[topic.topic] = t;

      subj.avgPct = Math.round((subj.avgPct * subj.attempts + pct) / (subj.attempts + 1));
      subj.attempts += 1;
      s.bySubject[topic.subject] = subj;

      s.overallAvgPct = Math.round((s.overallAvgPct * s.totalQuizzes + pct) / (s.totalQuizzes + 1));
      s.totalQuizzes += 1;
      s.bestPct = Math.max(s.bestPct || 0, pct);
      s.lastQuizAt = nowIso;
      s.latestCoachNote = coachNote;
      s.recent = [
        ...(s.recent || []),
        { date: nowIso, subject: topic.subject, topic: topic.topic, pct, quizId: quizRef.id }
      ].slice(-15);

      // weak topics: avg below 75, weakest first
      const weak = [];
      for (const [subName, sub] of Object.entries(s.bySubject)) {
        for (const [topName, top] of Object.entries(sub.topics)) {
          if (top.avgPct < 75) weak.push({ name: topName, subject: subName, avgPct: top.avgPct });
        }
      }
      weak.sort((a, b) => a.avgPct - b.avgPct);
      s.weakTopics = weak.slice(0, 4);

      tx.set(quizRef, quizData);
      tx.set(summaryRef, s);
      tx.set(userRef, { ...heal, xp: FieldValue.increment(xpEarned), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });

    await userRef.collection('xpHistory')
      .add({ delta: xpEarned, reason: 'quiz_completed', createdAt: FieldValue.serverTimestamp() })
      .catch(() => {});

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, subject: topic.subject, topic: topic.topic, coachNote, xpEarned })
    };
  } catch (e) {
    console.error('saveQuizResult error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
