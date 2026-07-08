// netlify/functions/ocr.js

/**
 * OCR via Google Cloud Vision REST API using an API key
 *
 * Expects: { base64PagePNGs: string[] }
 * Returns: { text: string }
 *
 * Requires env var GCP_VISION_API_KEY (an API key restricted to the
 * Cloud Vision API). Replaces the old GCP_SERVICE_ACCOUNT JSON, which
 * pushed the functions' combined env size past Netlify's 4KB limit.
 */

exports.handler = async (event) => {
  try {
    const { base64PagePNGs } = JSON.parse(event.body || '{}');
    if (!Array.isArray(base64PagePNGs) || base64PagePNGs.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No pages provided' }) };
    }

    const requests = base64PagePNGs.map(dataUrl => {
      const [, b64] = dataUrl.split(',');
      return {
        image: { content: b64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
      };
    });

    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GCP_VISION_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Vision API error ${res.status}`);
    }

    const data = await res.json();
    const fullText = (data.responses || [])
      .map(r => (r.fullTextAnnotation || {}).text || '')
      .join('\n\n')
      .trim();

    return { statusCode: 200, body: JSON.stringify({ text: fullText }) };
  } catch (err) {
    console.error('OCR function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
