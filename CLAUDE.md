# KavQuiz — kavquiz.netlify.app

AI quiz generator for Kav Academy students (owner: Kavian). Students upload PDFs (lecture slides,
worksheets), OpenAI generates a quiz, grading feeds the student dashboard on kavacademy.ca.
Sister repo: `/Users/kavian/kavacademy` — see its `CLAUDE.md` and `docs/PROJECT-HISTORY.md`
for full project context.

## Deploys

Netlify site **kavquiz**, id `f4c45306-b5d2-410a-bde0-bc6d80937da0`. GitHub-linked
(github.com/Kavianald/kavquiz) but trigger builds manually to be safe:
`netlify api createSiteBuild --data '{"site_id": "f4c45306-b5d2-410a-bde0-bc6d80937da0"}'`
then poll until ready and curl-verify.

## Architecture

- Static page (`index.html` + `src/main.js`) + Netlify functions (`netlify/functions/`).
- **Auth/data**: kavacademy's Firebase project `kavacademy-5c32e` (same student logins as the
  dashboard). `saveQuizResult.js` verifies the ID token, detects subject/topic + writes the AI
  coach note (OpenAI), saves `users/{uid}/quizResults/*`, maintains `users/{uid}/quizStats/summary`
  (dashboard reads this — write-time aggregation), awards XP server-side (10 + 15 bonus ≥85%),
  and HEALS partial user docs (quiz-before-dashboard users get email/profile defaults).
- **Grading** (`gradeTest.js`): multiple-choice & multi-answer graded DETERMINISTICALLY in code
  (an LLM once marked a correct answer wrong); only short/long answers go to OpenAI. Wrong-answer
  feedback reuses the generator's `explanation` field.
- **OCR** (`ocr.js`): Google Vision REST API with `GCP_VISION_API_KEY` (GCP project
  `receipt-uploader-466806`) — NOT a service-account JSON (two SA JSONs once blew AWS Lambda's
  4KB env cap and broke every deploy).
- `netlify.toml`: `node_bundler = "esbuild"` is REQUIRED (firebase-admin's jose dep is ESM;
  default bundler crashes with ERR_REQUIRE_ESM).
- Function URLs are case-sensitive and match filenames (`generateTest.js` → /generateTest).

## Env vars (Netlify)

FIREBASE_SERVICE_ACCOUNT (kavacademy-5c32e admin SA JSON — shows as 0 chars in CLI because it's
a masked secret; it IS set), OPENAI_API_KEY, GCP_VISION_API_KEY.

## Gotchas

- `npm install` may fail on old transitive postinstalls — use `--ignore-scripts`.
- Firestore rules live in the kavacademy repo (`firestore.rules`) and deploy from there.
- Model used throughout: gpt-4.1-mini.
