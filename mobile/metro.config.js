// Le cœur de synchro est partagé avec le back (dossier voisin) : Metro doit le surveiller et le transformer.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
const shared = path.resolve(__dirname, '../packages/sync-core');
config.watchFolders = [shared];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
module.exports = config;
