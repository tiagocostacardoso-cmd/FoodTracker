/**
 * Cloudflare Worker — Airtable proxy for the Dubai Grocery Price Tracker.
 *
 * Purpose: the static site (GitHub Pages) can't call Airtable directly —
 * that would expose the API token in the browser. This Worker sits between
 * them: it holds the token as a secret and exposes two safe, narrow
 * endpoints the site calls instead.
 *
 * Routes:
 *   GET  /api/prices        -> returns all records from the Prices table
 *   POST /api/prices        -> creates one price record { store, item, category, price, url }
 *
 * Setup (Cloudflare dashboard, one-time):
 *   1. Workers & Pages -> Create -> Create Worker -> paste this file's contents
 *   2. Settings -> Variables and Secrets -> add secret AIRTABLE_TOKEN
 *      (an Airtable personal access token scoped to just this base,
 *      with data.records:read + data.records:write)
 *   3. Settings -> Variables and Secrets -> add var AIRTABLE_BASE_ID = appNACAjjtIM1iv3X
 *   4. Settings -> Variables and Secrets -> add var AIRTABLE_TABLE_ID = tblUotcepDkfJpoSe
 *   5. Settings -> Triggers -> Custom domain (optional) or use the workers.dev URL
 *   6. Update ALLOWED_ORIGIN below to your GitHub Pages URL before deploying
 */

const ALLOWED_ORIGIN = 'https://prices.tiagoacc.com'; // <-- set this

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (url.pathname !== '/api/prices') {
      return new Response('Not found', { status: 404, headers });
    }

    const airtableUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`;
    const authHeaders = {
      'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    };

    if (request.method === 'GET') {
      // Paginate through all records (Airtable caps at 100 per page)
      let records = [];
      let offset = null;
      do {
        const pageUrl = new URL(airtableUrl);
        pageUrl.searchParams.set('pageSize', '100');
        if (offset) pageUrl.searchParams.set('offset', offset);
        const res = await fetch(pageUrl.toString(), { headers: authHeaders });
        if (!res.ok) {
          return new Response(JSON.stringify({ error: await res.text() }), { status: res.status, headers });
        }
        const data = await res.json();
        records = records.concat(data.records);
        offset = data.offset || null;
      } while (offset);

      return new Response(JSON.stringify({ records }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
      }

      const { store, item, category, price, url: productUrl, date } = body;
      if (!store || !item || !category || typeof price !== 'number') {
        return new Response(JSON.stringify({ error: 'Missing required fields: store, item, category, price' }), {
          status: 400,
          headers,
        });
      }

      const fields = {
        'Date': date || new Date().toISOString().slice(0, 10),
        'Store': store,
        'Item': item,
        'Category': category,
        'Price AED/kg': price,
      };
      if (productUrl) fields['Product URL'] = productUrl;

      const res = await fetch(airtableUrl, {
        method: 'POST',
        headers: authHeaders,
        // typecast:true lets Airtable auto-create a new Item/Category/Store
        // select option if one doesn't exist yet (e.g. an item added via the UI).
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
      });

      if (!res.ok) {
        return new Response(JSON.stringify({ error: await res.text() }), { status: res.status, headers });
      }

      const data = await res.json();
      return new Response(JSON.stringify(data), {
        status: 201,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Method not allowed', { status: 405, headers });
  },
};
