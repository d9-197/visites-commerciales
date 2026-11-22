// Faux serveur Mistral pour le test de bout en bout : aucune clé, aucun appel réel. Port : FAKE_MISTRAL_PORT (défaut 4010).
const http = require('node:http');
const requests = [];
const transcriptions = [];
const CONTENT = {
  fields: { summary: 'M. Martin est intéressé par l\'offre B (réponse simulée).', needs: 'Offre B pour son atelier.', objections: 'Budget de 50 000 euros non confirmé.', competitors: '', decisions: '', next_step: 'Envoyer un devis.' },
  actions: [{ title: 'Préparer la démo', due_date: '2026-11-27', relative_date: true }, { title: 'Rappeler M. Martin', due_date: null, relative_date: false }],
};
const BRIEF = { summary: 'Relation active avec ce client (brief simulé).', where_we_left: 'Offre B présentée lors de la dernière visite.', to_address: ['Relancer le devis'], watch_out: ['Budget à confirmer'], questions: ['Quel calendrier de décision ?'] };
const REVIEW = { issues: [{ field: 'objections', severity: 'warning', message: 'Les notes évoquent un budget absent du compte rendu (contrôle simulé).' }] };
http.createServer((req, res) => {
  if (req.url === '/__transcriptions') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(transcriptions)); }
  if (req.url === '/__requests') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(requests)); }
  if (req.url === '/v1/audio/transcriptions') {      // Voxtral simulé : on note ce qui est reçu (modèle, langue, taille de l'audio)
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks); const raw = buf.toString('latin1');
      const field = n => new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`).exec(raw)?.[1];
      transcriptions.push({ auth: req.headers.authorization, contentType: req.headers['content-type'], bytes: buf.length, model: field('model'), language: field('language'), filename: /filename="([^"]*)"/.exec(raw)?.[1], fileType: /Content-Type:\s*([^\r]+)/i.exec(raw.split('filename=')[1] ?? '')?.[1] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'voxtral-simule', text: 'Dictée simulée : le client confirme un budget de 40 000 euros.', language: 'fr', usage: { prompt_audio_seconds: 2 } }));
    });
    return;
  }
  let raw = ''; req.on('data', c => raw += c);
  req.on('end', () => {
    requests.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    const sys = String(requests.at(-1).body?.messages?.[0]?.content ?? '');
    const content = sys.includes('Tu prépares un commercial') ? BRIEF : sys.includes('Tu relis le compte rendu') ? REVIEW : CONTENT;
    res.end(JSON.stringify({ model: 'mistral-small-simule', choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }], usage: { prompt_tokens: 900, completion_tokens: 250 } }));
  });
}).listen(Number(process.env.FAKE_MISTRAL_PORT ?? 4010), '127.0.0.1');
