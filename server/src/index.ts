import { createPool } from './db.js';
import { createApp } from './app.js';

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/visites');
const port = Number(process.env.PORT ?? 3000);
createApp(pool).listen(port, () => console.log(`API sur http://localhost:${port}`));
