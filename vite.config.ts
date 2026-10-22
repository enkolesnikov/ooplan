import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({base: process.env.BASE_URL || '/', plugins:[react()],server:{host:'0.0.0.0',port:5173,proxy:{'/api':'http://127.0.0.1:3001'}},build:{outDir:'dist'}});
