// netlify/functions/ocr.js

/**
 * OCR via Google Cloud Vision using a Service Account JSON
 *
 * Expects: { base64PagePNGs: string[] }
 * Returns: { text: string }
 *
 * Requires env var GCP_SERVICE_ACCOUNT containing your service‑account JSON.
 */

const { ImageAnnotatorClient } = require('@google-cloud/vision');

let client;
try {
  const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
  client = new ImageAnnotatorClient({
    credentials: creds,
    projectId: creds.project_id
  });
} catch (e) {
  console.error('Failed to init Vision client:', e);
  throw new Error('Vision credentials misconfigured');
}

exports.handler = async (event) => {
  try {
    const { base64PagePNGs } = JSON.parse(event.body || '{}');
    if (!Array.isArray(base64PagePNGs) || base64PagePNGs.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No pages provided' }) };
    }

    // Build batch request
    const requests = base64PagePNGs.map(dataUrl => {
      const [, b64] = dataUrl.split(',');
      return {
        image: { content: b64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
      };
    });

    const [response] = await client.batchAnnotateImages({ requests });
    const fullText = response.responses
      .map(r => (r.fullTextAnnotation || {}).text || '')
      .join('\n\n')
      .trim();

    return { statusCode: 200, body: JSON.stringify({ text: fullText }) };
  } catch (err) {
    console.error('OCR function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
