import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// base relative : l'application fonctionne sous n'importe quel sous-chemin (https://exemple.fr/visit/admin/).
export default defineConfig({ base: './', plugins: [react()], build: { outDir: 'dist', sourcemap: false } });
