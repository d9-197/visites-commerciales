// Faux serveur Mistral pour le test de bout en bout : aucune clé, aucun appel réel. Port : FAKE_MISTRAL_PORT (défaut 4010).
const http = require('node:http');
const requests = [];
const CONTENT = {
  fields: { summary: 'M. Martin est intéressé par l\'offre B (réponse simulée).', needs: 'Offre B pour son atelier.', objections: 'Budget de 50 000 euros non confirmé.', competitors: '', decisions: '', next_step: 'Envoyer un devis.' },
  actions: [{ title: 'Préparer la démo', due_date: '2026-11-27', relative_date: true }, { title: 'Rappeler M. Martin', due_date: null, relative_date: false }],
};
http.createServer((req, res) => {
  if (req.url === '/__requests') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(requests)); }
  let raw = ''; req.on('data', c => raw += c);
  req.on('end', () => {
    requests.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'mistral-small-simule', choices: [{ message: { role: 'assistant', content: JSON.stringify(CONTENT) } }], usage: { prompt_tokens: 900, completion_tokens: 250 } }));
  });
}).listen(Number(process.env.FAKE_MISTRAL_PORT ?? 4010), '127.0.0.1');
