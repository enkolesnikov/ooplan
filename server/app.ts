import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Store, type PdfRecord } from './store.js';
import { ApiError, assertProject, decodePdf, isPdf } from './validation.js';
import { csv, exportSheets, pdf, xlsx } from './export.js';
import { validateProject } from '../src/engine.js';

export function createApp(options?: { dataDir: string }) {
  const app = express();
  const store = new Store(options?.dataDir ?? resolve(process.cwd(), 'data'));
  app.locals.store = store;
  app.locals.close = () => store.close();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '150mb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 0 } });
  const getProject = (id: string) => { const p = store.project(id); if (!p) throw new ApiError(404, 'Проект не найден'); return p; };
  const warnings = (res: express.Response, project: Parameters<typeof validateProject>[0]) => {
    res.setHeader('X-Project-Warnings', String(validateProject(project).length));
  };
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/projects', (_req, res) => { res.json(store.list()); });
  app.post('/api/projects', (req, res) => {
    assertProject(req.body, id => store.hasPdf(id));
    if (store.project(req.body.id)) throw new ApiError(409, 'Проект с таким ID уже существует');
    const p = { ...req.body, updatedAt: new Date().toISOString() };
    store.save(p); warnings(res, p); res.status(201).json(p);
  });
  app.get('/api/projects/:id', (req, res) => { res.json(getProject(req.params.id)); });
  app.put('/api/projects/:id', (req, res) => {
    getProject(req.params.id);
    assertProject(req.body, id => store.hasPdf(id));
    if (req.body.id !== req.params.id) throw new ApiError(422, 'ID URL и проекта должны совпадать');
    const p = { ...req.body, updatedAt: new Date().toISOString() };
    store.save(p); warnings(res, p); res.json(p);
  });
  app.delete('/api/projects/:id', (req, res) => {
    getProject(req.params.id);
    store.deleteProject(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/pdfs', upload.single('file'), (req, res) => {
    if (!req.file || !isPdf(req.file.buffer)) throw new ApiError(422, 'Требуется PDF в поле file (до 30 МБ)');
    const record = { id: randomUUID(), name: req.file.originalname.replace(/[\r\n\0]/g, '').slice(0, 250) || 'plan.pdf', bytes: req.file.buffer };
    store.savePdf(record); res.status(201).json({ id: record.id, name: record.name });
  });
  app.get('/api/pdfs/:id', (req, res) => {
    const record = store.pdf(req.params.id); if (!record) throw new ApiError(404, 'PDF не найден');
    res.setHeader('Content-Disposition', `inline; filename="plan.pdf"; filename*=UTF-8''${encodeURIComponent(record.name)}`);
    res.type('application/pdf').setHeader('X-Content-Type-Options', 'nosniff'); res.send(record.bytes);
  });
  app.get('/api/projects/:id/backup', (req, res) => {
    const project = getProject(req.params.id);
    const ids = [...new Set(project.floors.flatMap(f => f.pdfId ? [f.pdfId] : []))];
    const pdfs = ids.map(id => { const record = store.pdf(id); if (!record) throw new ApiError(409, `Отсутствует PDF: ${id}`); return { id, name: record.name, dataBase64: record.bytes.toString('base64') }; });
    res.setHeader('Content-Disposition', 'attachment; filename="project-backup.json"');
    res.json({ schemaVersion: 1, project, pdfs });
  });
  app.post('/api/restore', (req, res) => {
    const backup = req.body;
    if (!backup || typeof backup !== 'object' || (backup.schemaVersion !== undefined && backup.schemaVersion !== 1) || !Array.isArray(backup.pdfs) || backup.pdfs.length > 1000) throw new ApiError(422, 'Некорректный backup');
    const ids = new Set<string>();
    const records: PdfRecord[] = backup.pdfs.map((raw: any) => {
      if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 10000 || ids.has(raw.id) || typeof raw.name !== 'string' || raw.name.length > 10000) throw new ApiError(422, 'Некорректный или повторяющийся PDF ID');
      ids.add(raw.id); return { id: raw.id, name: raw.name, bytes: decodePdf(raw.dataBase64) };
    });
    // A portable backup must supply every referenced original, even if one exists locally.
    assertProject(backup.project, id => ids.has(id));
    const project = backup.project;
    store.transaction(() => {
      for (const record of records) {
        const existing = store.pdf(record.id);
        if (existing && (!existing.bytes.equals(record.bytes) || existing.name !== record.name)) throw new ApiError(409, `Конфликт PDF ID: ${record.id}`);
        if (!existing) store.savePdf(record);
      }
      store.save(project);
    });
    warnings(res, project); res.status(201).json(project);
  });
  app.get('/api/projects/:id/export', async (req, res, next) => {
    try {
      const project = getProject(req.params.id); const sheets = exportSheets(project);
      switch (req.query.format ?? 'csv') {
        case 'csv': res.type('text/csv; charset=utf-8').attachment('project.csv').send(csv(sheets)); break;
        case 'xlsx': res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('project.xlsx').send(xlsx(sheets)); break;
        case 'pdf': res.type('application/pdf').attachment('project.pdf').send(await pdf(project, sheets)); break;
        default: throw new ApiError(400, 'Формат должен быть csv, xlsx или pdf');
      }
    } catch (error) { next(error); }
  });
  app.use('/api', (_req, _res, next) => { next(new ApiError(404, 'API endpoint не найден')); });
  const dist = resolve(process.cwd(), 'dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.use((req, res, next) => { if (req.method === 'GET' && req.accepts('html')) res.sendFile(resolve(dist, 'index.html')); else next(); });
  }
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = error instanceof ApiError ? error.status : error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 422) : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'Внутренняя ошибка сервера' : error.message });
  };
  app.use(errorHandler);
  return app;
}
