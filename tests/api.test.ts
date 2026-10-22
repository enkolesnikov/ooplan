import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as XLSX from 'xlsx';
import { createApp } from '../server/app.js';
import type { Project } from '../src/model.js';

const originalPdf = Buffer.from('%PDF-1.4\n% synthetic integration fixture\n%%EOF');
function fixture(): Project {
  return {
    schemaVersion: 1, id: 'project-1', name: 'Синтетический тест', updatedAt: '2025-01-01T00:00:00.000Z',
    floors: [{ id: 'floor-1', name: 'Первый этаж', elevation: 0, metersPerUnit: 1, page: 1, width: 100, height: 100 }],
    equipment: [
      { id: 'equipment-1', number: 'Ш1', name: 'Щит', type: 'Щит', floorId: 'floor-1', x: 0, y: 0, height: 0, note: '', properties: {} },
      { id: 'equipment-2', number: 'П1', name: 'Прибор', type: 'Прибор', floorId: 'floor-1', x: 3, y: 0, height: 0, note: '', properties: {} },
    ],
    routes: [{ id: 'route-1', number: 'Т1', type: 'Лоток', note: '', segments: [{ id: 'segment-1', a: { id: 'v1', floorId: 'floor-1', x: 0, y: 0, height: 0 }, b: { id: 'v2', floorId: 'floor-1', x: 3, y: 0, height: 0 }, mode: 'orthogonal', reservePercent: 0, reserveFixed: 0 }] }],
    cables: [{ id: 'cable-1', number: 'К1', name: 'Кабель', brand: 'ВВГ', purpose: 'Питание', fromId: 'equipment-1', toId: 'equipment-2', segmentIds: ['segment-1'], reservePercent: 0, reserveFixed: 0, startReserve: 0, endReserve: 0, quantity: 2, note: '' }],
  };
}
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'ooplan-api-'));
  const app = createApp({ dataDir: dir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, app, dir,
    request: (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }),
    close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); app.locals.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('CRUD persists across app restart; failed PUT leaves previous data', async () => {
  const h = await harness();
  try {
    assert.deepEqual(await (await h.request('/api/health')).json(), { ok: true });
    assert.equal((await h.request('/api/projects/missing')).status, 404);
    const created = await h.request('/api/projects', 'POST', fixture()); assert.equal(created.status, 201);
    assert.equal((await h.request('/api/projects', 'POST', fixture())).status, 409);
    assert.equal((await (await h.request('/api/projects')).json()).length, 1);
    const p = fixture(); p.name = 'Изменённый';
    assert.equal((await h.request('/api/projects/project-1', 'PUT', p)).status, 200);
    p.cables[0].toId = 'missing';
    assert.equal((await h.request('/api/projects/project-1', 'PUT', p)).status, 422);
    assert.equal((await (await h.request('/api/projects/project-1')).json()).name, 'Изменённый');
    const second = createApp({ dataDir: h.dir });
    try { assert.equal(second.locals.store.project('project-1').name, 'Изменённый'); } finally { second.locals.close(); }
  } finally { await h.close(); }
});

test('engineering incompleteness is saved; malformed structure, references and duplicate IDs are rejected', async () => {
  const h = await harness();
  try {
    const p = fixture(); p.floors[0].metersPerUnit = null; p.equipment[0].height = null;
    const response = await h.request('/api/projects', 'POST', p); assert.equal(response.status, 201); assert.ok(Number(response.headers.get('x-project-warnings')) > 0);
    const cases: Array<(p: Project) => void> = [
      p => { p.equipment[1].id = p.equipment[0].id; },
      p => { p.equipment[1].number = p.equipment[0].number; },
      p => { p.cables[0].segmentIds = ['missing']; },
      p => { p.cables[0].segmentIds = ['segment-1', 'segment-1']; },
      p => { p.equipment[0].floorId = 'missing'; },
      p => { p.floors[0].pdfId = 'missing'; },
      p => { p.cables[0].quantity = -1; },
      p => { p.routes[0].segments[0].b.id = 'v1'; },
    ];
    for (const mutate of cases) { const invalid = fixture(); mutate(invalid); assert.equal((await h.request('/api/projects/project-1', 'PUT', invalid)).status, 422); }
    assert.equal((await h.request('/api/projects/project-1', 'PUT', { ...fixture(), id: 'other' })).status, 422);
    assert.equal((await h.request('/api/projects/project-1', 'PUT', { id: 'project-1' })).status, 422);
  } finally { await h.close(); }
});

test('PDF multipart and portable backup restore preserve original bytes; restore is atomic', async () => {
  const a = await harness(); const b = await harness();
  try {
    const form = new FormData(); form.append('file', new Blob([originalPdf], { type: 'application/pdf' }), 'plan.pdf');
    const uploaded = await fetch(a.base + '/api/pdfs', { method: 'POST', body: form }); assert.equal(uploaded.status, 201);
    const record = await uploaded.json() as { id: string; name: string };
    const p = fixture(); p.floors[0].pdfId = record.id;
    assert.equal((await a.request('/api/projects', 'POST', p)).status, 201);
    const backup = await (await a.request('/api/projects/project-1/backup')).json();
    assert.equal(backup.pdfs[0].dataBase64, originalPdf.toString('base64'));
    const broken = structuredClone(backup); broken.project.cables[0].fromId = 'missing';
    assert.equal((await b.request('/api/restore', 'POST', broken)).status, 422);
    assert.equal((await b.request('/api/pdfs/' + record.id)).status, 404);
    assert.equal((await b.request('/api/restore', 'POST', backup)).status, 201);
    assert.deepEqual(Buffer.from(await (await b.request('/api/pdfs/' + record.id)).arrayBuffer()), originalPdf);
    assert.equal((await b.request('/api/restore', 'POST', backup)).status, 201);
    const invalid = new FormData(); invalid.append('file', new Blob(['not a PDF']), 'bad.pdf');
    assert.equal((await fetch(a.base + '/api/pdfs', { method: 'POST', body: invalid })).status, 422);
    const conflict = structuredClone(backup); conflict.project.id = 'different'; conflict.pdfs[0].name = 'different.pdf';
    assert.equal((await b.request('/api/restore', 'POST', conflict)).status, 409);
    assert.equal((await b.request('/api/projects/different')).status, 404);
  } finally { await a.close(); await b.close(); }
});

test('exports contain journal and specifications, BOM CSV, workbook sheets and PDF font diagnostics', async () => {
  const h = await harness();
  try {
    const p = fixture(); p.cables[0].note = '=1+1';
    await h.request('/api/projects', 'POST', p);
    const response = await h.request('/api/projects/project-1/export?format=csv'); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8'); assert.match(text, /Кабельный журнал/); assert.match(text, /Инфраструктура/); assert.match(text, /ВВГ/); assert.match(text, /'\=1\+1/);
    const workbookResponse = await h.request('/api/projects/project-1/export?format=xlsx'); assert.equal(workbookResponse.status, 200);
    const wb = XLSX.read(Buffer.from(await workbookResponse.arrayBuffer()), { type: 'buffer' });
    assert.equal(wb.SheetNames.length, 5); assert.ok(wb.SheetNames.includes('Кабельный журнал'));
    const journal = XLSX.utils.sheet_to_json<any[]>(wb.Sheets['Кабельный журнал'], { header: 1 });
    assert.equal(journal[1][12], 3); assert.equal(journal[1][13], 6);
    const result = await h.request('/api/projects/project-1/export?format=pdf');
    if (result.status === 503) assert.match((await result.json()).error, /PDF_FONT_PATH/);
    else { assert.equal(result.status, 200); assert.equal(Buffer.from(await result.arrayBuffer()).subarray(0, 5).toString(), '%PDF-'); }
    assert.equal((await h.request('/api/projects/project-1/export?format=invalid')).status, 400);
  } finally { await h.close(); }
});

test('DELETE удаляет проект из хранилища', async () => {
  const h = await harness();
  try {
    assert.equal((await h.request('/api/projects', 'POST', fixture())).status, 201);
    assert.equal((await h.request('/api/projects/project-1', 'DELETE')).status, 200);
    assert.equal((await h.request('/api/projects/project-1')).status, 404);
    assert.equal((await (await h.request('/api/projects')).json()).length, 0);
    assert.equal((await h.request('/api/projects/project-1', 'DELETE')).status, 404);
  } finally { await h.close(); }
});
