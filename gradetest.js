const { OpenAI } = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

exports.handler = async (event) => {
  try {
    const { studentResponses, questions, gradingText } = JSON.parse(event.body);

    const prompt = `
You are a lenient but fair grader. You have two JSON inputs:
1) Test key (with correct answers and max_points per question):
${JSON.stringify(questions)}

2) Student responses:
${JSON.stringify(studentResponses)}

Grading context:
${gradingText}

Rules:
- multiple_choice: full marks if match, else zero.
- multi_answer: full marks if exact set match; partial credit proportional to overlap.
- short/long answer: award full marks if essential points covered; partial otherwise.

Return a JSON array where each object has:
id, status ("correct"/"partial"/"incorrect"), points_awarded, max_points, feedback.
Valid JSON only.
    `.trim();

    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'You are a lenient but fair grader.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1
    });

    const json = completion.choices[0].message.content;
    return { statusCode: 200, body: json };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
