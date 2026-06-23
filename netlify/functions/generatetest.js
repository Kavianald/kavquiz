const { OpenAI } = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

exports.handler = async (event) => {
  try {
    const { testParams, contentText, gradingText } = JSON.parse(event.body);

    const prompt = `
You are a knowledgeable test generator. Generate a JSON array of questions with exactly:
- ${testParams.num_mc} multiple_choice (with ${testParams.mc_options} options each; set max_points to 1)
- ${testParams.num_multi} multi_answer (set max_points equal to the number of correct options)
- ${testParams.num_short} short_answer
- ${testParams.num_long} long_answer

Use the following content materials:
${contentText}

Use this grading context:
${gradingText}

Difficulty level: ${testParams.difficulty}
Lower difficulty (1-3) → options are clearly wrong/unrelated.
Medium difficulty (4-7) → options are mostly related, not obviously wrong
Higher difficulty (8-10)→ distractors differ only by a subtle detail; include "all of the above", "none of the above", "x of the above are correct" type answer options

Each question object must have:
id,
question_type,
question_text,
options (if applicable),
correct_answer,
max_points,
explanation.

Return valid JSON only: a single JSON array, no trailing commas, no markdown fences, no extra text.
    `.trim();

    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful test generator that ensures its output is a pure JSON array with correct max_points as instructed.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    });

    const json = completion.choices[0].message.content;
    return { statusCode: 200, body: json };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
