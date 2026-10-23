import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Project, Floor, Equipment, Route, Cable, Segment, Vertex, Point } from './model';
import { calculateCable, specifications, validateProject, chainEnds, findRoute } from './engine';
import { createDemoProject } from './demo';

type PdfjsModule = typeof import('pdfjs-dist');
type PdfLoadingTask = ReturnType<PdfjsModule['getDocument']>;
type PdfRenderTask = ReturnType<import('pdfjs-dist').PDFPageProxy['render']>;
const SNAP_PX = 12;
const CABLE_SNAP_LIMIT = 100;
type Selection = { kind: 'equipment' | 'route' | 'cable'; id: string } | null;
type Tool = 'select' | 'pan' | 'equipment' | 'route' | 'calibrate' | 'cable';
type View = 'plan' | 'journal' | 'specs';
const uid = () => crypto.randomUUID();
const clone = <T,>(value: T): T => structuredClone(value);
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 3 }) : '—';
const freshFloor = (name = 'Этаж 1'): Floor => ({ id: uid(), name, elevation: null, metersPerUnit: null, page: 1, width: 1000, height: 700 });
const freshProject = (): Project => ({ schemaVersion: 1, id: uid(), name: 'Новый проект', floors: [freshFloor()], equipment: [], routes: [], cables: [], updatedAt: new Date().toISOString() });
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) { const text = await response.text(); throw new Error(text || `HTTP ${response.status}`); }
  return response.json() as Promise<T>;
}
const jsonOptions = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const LS_PROJECTS = 'cableplan:projects';
function lsProjects(): Project[] { try { const raw = localStorage.getItem(LS_PROJECTS); const list = JSON.parse(raw || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } }
function lsSave(project: Project) { const list = lsProjects(); const i = list.findIndex(p => p.id === project.id); if (i >= 0) list[i] = project; else list.push(project); localStorage.setItem(LS_PROJECTS, JSON.stringify(list)); }
function lsDelete(id: string) { localStorage.setItem(LS_PROJECTS, JSON.stringify(lsProjects().filter(p => p.id !== id))); }
function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cableplan', 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('pdfs')) req.result.createObjectStore('pdfs'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key: string, value: Blob): Promise<void> {
  const db = await idbOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('pdfs', 'readwrite');
    tx.objectStore('pdfs').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key: string): Promise<Blob | undefined> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pdfs', 'readonly');
    const req = tx.objectStore('pdfs').get(key);
    req.onsuccess = () => resolve(req.result as Blob | undefined);
    req.onerror = () => reject(req.error);
  });
}
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
async function idbDelete(key: string): Promise<void> {
  const db = await idbOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('pdfs', 'readwrite');
    tx.objectStore('pdfs').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export default function App() {
  const [project, setProject] = useState<Project>(freshProject);
  const [floorId, setFloorId] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState<View>('plan');
  const [menuOpen, setMenuOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  const [tab, setTab] = useState<'floors' | 'equipment' | 'routes' | 'cables'>('floors');
  const [zoom, setZoom] = useState(.8);
  const [pan, setPan] = useState({ x: 35, y: 35 });
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [ortho, setOrtho] = useState(true);
  const [gridSize, setGridSize] = useState(10);
  const [draft, setDraft] = useState<Point[]>([]);
  const [calibration, setCalibration] = useState<Point[]>([]);
  const [cableSegments, setCableSegments] = useState<string[]>([]);
  const [cableFrom, setCableFrom] = useState('');
  const [cableTo, setCableTo] = useState('');
  const [routeHeight, setRouteHeight] = useState('2.5');
  const [message, setMessage] = useState('Готово. Загрузите PDF или откройте учебный проект.');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [persisted, setPersisted] = useState(false);
  const [undo, setUndo] = useState<Project[]>([]);
  const [redo, setRedo] = useState<Project[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string; updatedAt: string }[] | null>(null);
  const [pdfPages, setPdfPages] = useState(0);
  const [pdfError, setPdfError] = useState('');
  const [pointer, setPointer] = useState<Point | null>(null);
  const [staticMode, setStaticMode] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const projectRef = useRef(project);
  const drag = useRef<{ type: 'pan' | 'equipment' | 'vertex' | 'pinch'; id?: string; vertexId?: string; start: Point; pan: Point; before: Project; startDist?: number; startZoom?: number; startPan?: Point; startPdf?: Point } | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pdfCache = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  projectRef.current = project;
  const floor = project.floors.find(f => f.id === floorId) || project.floors[0];
  const dirty = JSON.stringify(project) !== saved;
  const equipment = selection?.kind === 'equipment' ? project.equipment.find(e => e.id === selection.id) : undefined;
  const route = selection?.kind === 'route' ? project.routes.find(r => r.id === selection.id) : undefined;
  const cable = selection?.kind === 'cable' ? project.cables.find(c => c.id === selection.id) : undefined;
  const calculation = cable ? calculateCable(project, cable) : null;
  const issues = useMemo(() => validateProject(project), [project]);
  const cableCalcs = useMemo(() => new Map(project.cables.map(c => [c.id, calculateCable(project, c)])), [project]);
  const issueCount = Array.isArray(issues) ? issues.length : 0;

  function commit(next: Project | ((p: Project) => Project)) {
    const previous = projectRef.current;
    const value = typeof next === 'function' ? next(clone(previous)) : next;
    setUndo(items => [...items.slice(-59), clone(previous)]); setRedo([]);
    value.updatedAt = new Date().toISOString(); projectRef.current = value; setProject(value); setError('');
  }
  function mutate(fn: (p: Project) => void) { commit(p => { fn(p); return p; }); }
  function history(back: boolean) {
    const source = back ? undo : redo;
    if (!source.length) return;
    const next = source[source.length - 1];
    if (back) { setUndo(source.slice(0, -1)); setRedo(items => [...items, clone(project)]); }
    else { setRedo(source.slice(0, -1)); setUndo(items => [...items, clone(project)]); }
    setProject(clone(next)); projectRef.current = clone(next); setSelection(null); setDraft([]);
  }
  function load(p: Project, exists: boolean) {
    setProject(p); projectRef.current = p; setSaved(exists ? JSON.stringify(p) : ''); setPersisted(exists);
    setFloorId(p.floors[0]?.id || ''); setUndo([]); setRedo([]); setSelection(null); setDraft([]); setCableSegments([]); setView('plan'); setTool('select'); setError('');
  }
  async function run(task: () => Promise<void>) { setBusy(true); setError(''); try { await task(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function saveProject(): Promise<Project> {
    const snapshot = clone(projectRef.current);
    if (staticMode) { lsSave(snapshot); setPersisted(true); setSaved(JSON.stringify(snapshot)); setMessage(`Проект «${snapshot.name}» сохранён в браузере`); return snapshot; }
    const result = await api<Project>(persisted ? `/api/projects/${snapshot.id}` : '/api/projects', jsonOptions(persisted ? 'PUT' : 'POST', snapshot));
    setPersisted(true); setSaved(JSON.stringify(result));
    if (JSON.stringify(projectRef.current) === JSON.stringify(snapshot)) { setProject(result); projectRef.current = result; }
    setMessage(`Проект «${result.name}» сохранён`); return result;
  }
  async function deleteProject(id: string, name: string) {
    if (!window.confirm(`Удалить проект «${name}»? Это действие необратимо.`)) return;
    if (staticMode) {
      const target = lsProjects().find(p => p.id === id);
      if (target) for (const f of target.floors) if (f.pdfId?.startsWith('idb:')) { try { await idbDelete(f.pdfId.slice(4)); } catch { /* хранилище недоступно */ } }
      lsDelete(id);
    } else await api('/api/projects/' + id, { method: 'DELETE' });
    setProjects(list => list ? list.filter(p => p.id !== id) : null);
    setMessage(`Проект «${name}» удалён.`);
  }
  function mayLeave() { return !dirty || window.confirm('Есть несохранённые изменения. Продолжить без сохранения?'); }
  function fit() {
    if (!stage.current || !floor) return;
    const z = Math.max(.04, Math.min(4, Math.min((stage.current.clientWidth - 64) / floor.width, (stage.current.clientHeight - 64) / floor.height)));
    setZoom(z); setPan({ x: (stage.current.clientWidth - floor.width * z) / 2, y: (stage.current.clientHeight - floor.height * z) / 2 });
  }
  function changeZoom(value: number) {
    const z = Math.max(.04, Math.min(8, value));
    const center = { x: (stage.current?.clientWidth || 800) / 2, y: (stage.current?.clientHeight || 600) / 2 };
    setPan({ x: center.x - (center.x - pan.x) * z / zoom, y: center.y - (center.y - pan.y) * z / zoom }); setZoom(z);
  }
  useEffect(() => { const handler = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty]);
  useEffect(() => { fetch('/api/health').then(r => { if (!r.ok) setStaticMode(true); }).catch(() => setStaticMode(true)); }, []);
  useEffect(() => {
    if (!staticMode) return;
    const timer = setTimeout(() => { try { localStorage.setItem('cableplan:autosave', JSON.stringify(projectRef.current)); } catch { /* переполнение localStorage */ } }, 800);
    return () => clearTimeout(timer);
  }, [project, staticMode]);
  useEffect(() => {
    if (!staticMode) return;
    try {
      const raw = localStorage.getItem('cableplan:autosave');
      if (!raw) return;
      const saved = JSON.parse(raw) as Project;
      if (saved && saved.schemaVersion === 1 && Array.isArray(saved.floors) && projectRef.current.name === 'Новый проект' && projectRef.current.equipment.length === 0) {
        load(saved, true); setMessage('Восстановлен последний черновик из браузера.');
      }
    } catch { /* ignore */ }
  }, [staticMode]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input,select,textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void run(async () => { await saveProject(); }); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); history(!e.shiftKey); }
      if (e.key === 'Escape') { setDraft([]); setCalibration([]); setCableSegments([]); setTool('select'); }
      if (e.key === 'Enter' && draft.length > 1) finishRoute();
    }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  useEffect(() => { setDraft([]); setCalibration([]); setPdfPages(0); setPdfError(''); }, [floor?.id, floor?.pdfId]);
  useEffect(() => {
    if (!floor?.pdfId || view !== 'plan') return;
    const currentFloor = floor;
    const pdfId = floor.pdfId;
    const key = `${currentFloor.id}:${pdfId}:${currentFloor.page}`;
    const target = canvas.current; if (!target) return;
    const ctx = target.getContext('2d'); if (!ctx) return;
    if (pdfCache.current?.key === key) {
      target.width = pdfCache.current.canvas.width; target.height = pdfCache.current.canvas.height;
      ctx.drawImage(pdfCache.current.canvas, 0, 0);
      return;
    }
    let cancelled = false;
    let renderTask: PdfRenderTask | undefined;
    let loadingTask: PdfLoadingTask | undefined;
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        if (pdfId.startsWith('idb:')) {
          const blob = await idbGet(pdfId.slice(4));
          if (!blob) throw new Error('PDF не найден в хранилище браузера');
          loadingTask = pdfjs.getDocument({ data: await blob.arrayBuffer() });
        } else if (pdfId.startsWith('data:')) {
          const base64 = pdfId.slice(pdfId.indexOf(',') + 1);
          loadingTask = pdfjs.getDocument({ data: Uint8Array.from(atob(base64), c => c.charCodeAt(0)) });
        } else {
          loadingTask = pdfjs.getDocument(`/api/pdfs/${pdfId}`);
        }
        const document = await loadingTask.promise; if (cancelled) return; setPdfPages(document.numPages);
        const page = await document.getPage(Math.min(Math.max(1, currentFloor.page), document.numPages)); if (cancelled) return;
        const viewport = page.getViewport({ scale: 1 });
        if (Math.abs(viewport.width - currentFloor.width) > .01 || Math.abs(viewport.height - currentFloor.height) > .01) {
          mutate(p => { const target = p.floors.find(f => f.id === currentFloor.id)!; target.width = viewport.width; target.height = viewport.height; });
        }
        const current = canvas.current; if (!current) return;
        const scale = Math.min(2, window.devicePixelRatio || 1);
        const renderViewport = page.getViewport({ scale }); current.width = renderViewport.width; current.height = renderViewport.height;
        renderTask = page.render({ canvasContext: current.getContext('2d')!, viewport: renderViewport, canvas: current }); await renderTask.promise;
        const cached = window.document.createElement('canvas');
        cached.width = current.width; cached.height = current.height;
        cached.getContext('2d')!.drawImage(current, 0, 0);
        pdfCache.current = { key, canvas: cached };
      } catch (e) { if (!cancelled) setPdfError(`PDF не отображён: ${e instanceof Error ? e.message : String(e)}`); }
    })();
    return () => { cancelled = true; renderTask?.cancel(); loadingTask?.destroy(); };
  }, [floor?.pdfId, floor?.page, floor?.id, view]);

  function position(e: { clientX: number; clientY: number }, useSnap = true): Point {
    const rect = stage.current!.getBoundingClientRect();
    let x = (e.clientX - rect.left - pan.x) / zoom, y = (e.clientY - rect.top - pan.y) / zoom;
    if (snap && useSnap) {
      const candidates = [...project.equipment.filter(eq => eq.floorId === floor?.id), ...project.routes.flatMap(r => r.segments.flatMap(s => [s.a, s.b])).filter(v => v.floorId === floor?.id)];
      const near = candidates.find(p => Math.hypot(p.x - x, p.y - y) < SNAP_PX / zoom);
      if (near) return { x: near.x, y: near.y };
      x = Math.round(x / gridSize) * gridSize; y = Math.round(y / gridSize) * gridSize;
    }
    return { x, y };
  }
  function startDrag(e: ReactPointerEvent, type: 'equipment' | 'vertex', id: string, vertexId?: string) {
    if (tool !== 'select') return;
    e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { type, id, vertexId, start: position(e), pan, before: clone(project) };
  }
  function pointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!floor) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      const rect = stage.current!.getBoundingClientRect();
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      drag.current = { type: 'pinch', start: { x: 0, y: 0 }, pan, before: project, startDist: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, startZoom: zoom, startPan: pan, startPdf: { x: (mid.x - rect.left - pan.x) / zoom, y: (mid.y - rect.top - pan.y) / zoom } };
      return;
    }
    if (pointers.current.size > 2) return;
    if ((e.target as Element).closest('[data-object]')) return;
    if (tool === 'pan' || e.button === 1) { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { type: 'pan', start: { x: e.clientX, y: e.clientY }, pan, before: project }; return; }
    const p = position(e);
    if (p.x < 0 || p.y < 0 || p.x > floor.width || p.y > floor.height) return;
    if (tool === 'equipment') {
      const usedNumbers = new Set(project.equipment.map(e => e.number));
      let n = project.equipment.length + 1;
      while (usedNumbers.has(`E${n}`)) n++;
      const usedNames = new Set(project.equipment.map(e => e.name.trim()));
      let itemName = 'Новое оборудование';
      let suffix = 1;
      while (usedNames.has(itemName)) itemName = `Новое оборудование ${++suffix}`;
      const item: Equipment = { id: uid(), number: `E${n}`, name: itemName, type: 'Оборудование', floorId: floor.id, ...p, height: null, note: '', properties: {} };
      mutate(pr => pr.equipment.push(item)); setSelection({ kind: 'equipment', id: item.id }); setTab('equipment');
    } else if (tool === 'route') {
      setDraft(points => {
        const last = points[points.length - 1]; if (last && Math.hypot(last.x - p.x, last.y - p.y) < .001) return points;
        if (ortho && last && last.x !== p.x && last.y !== p.y) return [...points, { x: p.x, y: last.y }, p];
        return [...points, p];
      });
    } else if (tool === 'calibrate') {
      if (!calibration.length) { setCalibration([p]); setMessage('Укажите вторую точку известного размера.'); }
      else {
        const length = Math.hypot(p.x - calibration[0].x, p.y - calibration[0].y);
        if (!length) return;
        const answer = window.prompt('Расстояние между точками, в метрах:', '10');
        if (answer !== null) { const meters = Number(answer.replace(',', '.')); if (meters > 0 && Number.isFinite(meters)) { mutate(pr => { pr.floors.find(f => f.id === floor.id)!.metersPerUnit = meters / length; }); setMessage(`Масштаб: ${number(meters / length)} м/ед. PDF. Проверьте контрольный размер.`); setTool('select'); } else setError('Расстояние должно быть положительным числом.'); }
        setCalibration([]);
      }
    } else if (tool === 'select') setSelection(null);
  }
  function pointerMove(e: ReactPointerEvent) {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const active = drag.current;
    if (active?.type === 'pinch') {
      if (pointers.current.size < 2) return;
      const rect = stage.current!.getBoundingClientRect();
      const [p1, p2] = [...pointers.current.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const nextZoom = Math.max(.04, Math.min(8, (active.startZoom ?? zoom) * dist / (active.startDist || 1)));
      const origin = active.startPdf ?? { x: 0, y: 0 };
      setZoom(nextZoom);
      setPan({ x: mid.x - rect.left - origin.x * nextZoom, y: mid.y - rect.top - origin.y * nextZoom });
      return;
    }
    setPointer(position(e, false));
    if (!active) return;
    if (active.type === 'pan') { setPan({ x: active.pan.x + e.clientX - active.start.x, y: active.pan.y + e.clientY - active.start.y }); return; }
    const point = position(e); const next = clone(projectRef.current);
    if (active.type === 'equipment') { const item = next.equipment.find(eq => eq.id === active.id); if (item) Object.assign(item, point); }
    else {
      const original = active.before.routes.find(r => r.id === active.id)?.segments.flatMap(s => [s.a, s.b]).find(v => v.id === active.vertexId);
      if (original) next.routes.forEach(r => r.segments.forEach(s => [s.a, s.b].forEach(v => { if (v.id === active.vertexId || (v.floorId === original.floorId && v.x === original.x && v.y === original.y && v.height === original.height)) Object.assign(v, point); })));
    }
    projectRef.current = next; setProject(next);
  }
  function pointerUp(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId);
    const active = drag.current;
    if (active?.type === 'pinch') { if (pointers.current.size < 2) drag.current = null; return; }
    if (active && active.type !== 'pan' && JSON.stringify(active.before) !== JSON.stringify(projectRef.current)) { setUndo(items => [...items.slice(-59), active.before]); setRedo([]); }
    drag.current = null;
  }
  function finishRoute() {
    if (!floor || draft.length < 2) return;
    const h = routeHeight === '' ? null : Number(routeHeight);
    if (h !== null && !Number.isFinite(h)) { setError('Задайте числовую высоту трассы.'); return; }
    const vertices: Vertex[] = draft.map(p => ({ id: uid(), floorId: floor.id, ...p, height: h }));
    const item: Route = { id: uid(), number: `T${project.routes.length + 1}`, type: 'Лоток', note: '', segments: vertices.slice(1).map((b, i) => ({ id: uid(), a: vertices[i], b, mode: ortho ? 'orthogonal' : 'spatial', reservePercent: 0, reserveFixed: 0 })) };
    mutate(p => p.routes.push(item)); setSelection({ kind: 'route', id: item.id }); setDraft([]); setTool('select'); setTab('routes'); setMessage('Трасса создана. Проверьте высоты и привязку концов.');
  }
  function finishCable() {
    if (!cableFrom || !cableTo) { setError('Сначала выберите оборудование «От» и «До»: по очереди коснитесь двух устройств на плане.'); return; }
    if (cableFrom === cableTo) { setError('«От» и «До» должны быть разными устройствами.'); return; }
    if (!cableSegments.length) { setError('Выберите сегменты трассы по порядку: коснитесь каждого сегмента, по которому идёт кабель.'); return; }
    const ends = chainEnds(project, cableSegments);
    if (!ends) { setError('Выбранные сегменты не образуют непрерывную цепочку. Выберите их по порядку от начала к концу.'); return; }
    const fromEq = project.equipment.find(e => e.id === cableFrom);
    const toEq = project.equipment.find(e => e.id === cableTo);
    if (fromEq && toEq) {
      const dist = (v: Vertex, e: Equipment) => v.floorId === e.floorId ? Math.hypot(v.x - e.x, v.y - e.y) : Infinity;
      const dStart = dist(ends.start, fromEq), dEnd = dist(ends.end, fromEq);
      if (Math.min(dStart, dEnd) > CABLE_SNAP_LIMIT || Math.min(dist(ends.start, toEq), dist(ends.end, toEq)) > CABLE_SNAP_LIMIT) {
        setError('Концы трассы слишком далеко от выбранных устройств. Начертите трассу, начиная и заканчивая на устройствах, или подвиньте устройства к концам трассы.'); return;
      }
      const fromEnd = dStart <= dEnd ? ends.start : ends.end;
      const toEnd = dStart <= dEnd ? ends.end : ends.start;
      mutate(p => {
        const f = p.equipment.find(e => e.id === cableFrom)!;
        const t = p.equipment.find(e => e.id === cableTo)!;
        f.floorId = fromEnd.floorId; f.x = fromEnd.x; f.y = fromEnd.y;
        t.floorId = toEnd.floorId; t.x = toEnd.x; t.y = toEnd.y;
      });
    }
    let n = project.cables.length + 1;
    const used = new Set(project.cables.map(c => c.number));
    while (used.has(`K${n}`)) n++;
    const item: Cable = { id: uid(), number: `K${n}`, name: 'Новый кабель', brand: '', purpose: '', fromId: cableFrom, toId: cableTo, segmentIds: [...cableSegments], reservePercent: 0, reserveFixed: 0, startReserve: 0, endReserve: 0, quantity: 1, note: '' };
    mutate(p => p.cables.push(item)); setSelection({ kind: 'cable', id: item.id }); setTab('cables'); setTool('select'); setCableSegments([]); setMessage(`Кабель ${`K${n}`} создан. Устройства привязаны к концам трассы.`);
  }
  function removeSelection() {
    if (!selection) return;
    const segmentIds = route?.segments.map(s => s.id) || [];
    const affected = project.cables.filter(c => selection.kind === 'equipment' ? c.fromId === selection.id || c.toId === selection.id : selection.kind === 'route' ? c.segmentIds.some(id => segmentIds.includes(id)) : false);
    if (!window.confirm(`Удалить выбранный объект?${affected.length ? ` Также будут удалены связанные кабели: ${affected.map(c => c.number).join(', ')}.` : ''}`)) return;
    mutate(p => {
      if (selection.kind === 'equipment') p.equipment = p.equipment.filter(e => e.id !== selection.id);
      if (selection.kind === 'route') p.routes = p.routes.filter(r => r.id !== selection.id);
      p.cables = p.cables.filter(c => c.id !== (selection.kind === 'cable' ? selection.id : '') && !affected.some(a => a.id === c.id));
    }); setSelection(null);
  }
  function copySelection() {
    if (equipment) { const next = { ...clone(equipment), id: uid(), number: `${equipment.number}-копия`, x: equipment.x + gridSize, y: equipment.y + gridSize }; mutate(p => p.equipment.push(next)); setSelection({ kind: 'equipment', id: next.id }); }
    if (route) { const next = clone(route); next.id = uid(); next.number += '-копия'; const ids = new Map<string, string>(); next.segments.forEach(s => { s.id = uid(); [s.a, s.b].forEach(v => { if (!ids.has(v.id)) ids.set(v.id, uid()); v.id = ids.get(v.id)!; v.x += gridSize; v.y += gridSize; }); }); mutate(p => p.routes.push(next)); setSelection({ kind: 'route', id: next.id }); }
    if (cable) { const next = { ...clone(cable), id: uid(), number: `${cable.number}-копия` }; mutate(p => p.cables.push(next)); setSelection({ kind: 'cable', id: next.id }); }
  }
  function setItem(key: string, value: unknown) {
    if (!selection) return;
    mutate(p => { const collection = selection.kind === 'equipment' ? p.equipment : selection.kind === 'route' ? p.routes : p.cables; const item = collection.find(i => i.id === selection.id); if (item) Object.assign(item, { [key]: value }); });
  }
  function field(label: string, value: string | number | null, change: (value: string) => void, numeric = false, hint?: string) {
    return <label className="field">{label}<input type={numeric ? 'number' : 'text'} step="any" value={value ?? ''} placeholder={numeric ? 'Не задано' : ''} onChange={e => change(e.target.value)} />{hint && <small>{hint}</small>}</label>;
  }
  function itemField(label: string, key: string, numeric = false) {
    const item = equipment || route || cable;
    const val = item ? (item as unknown as Record<string, string | number | null>)[key] : '';
    return field(label, val ?? '', value => setItem(key, numeric ? (value === '' ? null : Number(value)) : value), numeric);
  }
  function floorSelect(value: string, change: (id: string) => void) { return <select value={value} onChange={e => change(e.target.value)}>{project.floors.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>; }
  function equipmentSelect(value: string, change: (id: string) => void) { return <select value={value} onChange={e => change(e.target.value)}><option value="">Выберите оборудование</option>{project.equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.number} · {eq.name}</option>)}</select>; }
  function segmentName(id: string) { const owner = project.routes.find(r => r.segments.some(s => s.id === id)); const index = owner?.segments.findIndex(s => s.id === id); return owner ? `${owner.number} / ${(index ?? 0) + 1}` : `Отсутствует: ${id.slice(0, 8)}`; }
  function addRiser() {
    if (!route || !floor) return;
    const other = project.floors.find(f => f.id !== floor.id);
    if (!other) { setError('Для стояка сначала добавьте ещё один этаж.'); return; }
    const previous = route.segments[route.segments.length - 1]?.b;
    const a: Vertex = previous ? clone(previous) : { id: uid(), floorId: floor.id, x: 100, y: 100, height: 2.5 };
    const b: Vertex = { ...a, id: uid(), floorId: other.id };
    mutate(p => p.routes.find(r => r.id === route.id)!.segments.push({ id: uid(), a, b, mode: 'orthogonal', reservePercent: 0, reserveFixed: 0 }));
    setMessage('Стояк добавлен. Уточните целевой этаж, x/y и высоты в свойствах сегмента.');
  }
  function segmentField(segment: Segment, endpoint: 'a' | 'b', key: keyof Vertex, value: unknown) {
    if (!route) return;
    mutate(p => { const target = p.routes.find(r => r.id === route.id)!.segments.find(s => s.id === segment.id)!; Object.assign(target[endpoint], { [key]: value }); });
  }
  async function uploadPdf(file: File) {
    if (!floor) return;
    if (staticMode) {
      const key = uid();
      await idbPut(key, file);
      mutate(p => { const target = p.floors.find(f => f.id === floor.id)!; target.pdfId = 'idb:' + key; target.page = 1; target.metersPerUnit = null; });
      setMessage(`PDF «${file.name}» загружен. Выберите страницу и откалибруйте масштаб.`);
      return;
    }
    const data = new FormData(); data.append('file', file);
    const result = await api<{ id: string; name: string }>('/api/pdfs', { method: 'POST', body: data });
    mutate(p => { const target = p.floors.find(f => f.id === floor.id)!; target.pdfId = result.id; target.page = 1; target.metersPerUnit = null; });
    setMessage(`PDF «${result.name}» загружен. Выберите страницу и откалибруйте масштаб.`);
  }
  function clientCsv(p: Project): string {
    const specs = specifications(p);
    const rows: (string | number | null)[][] = [];
    rows.push(['Кабельный журнал']);
    rows.push(['Номер', 'Наименование', 'Марка', 'От', 'До', 'Количество', 'Итог одного, м', 'Итог всего, м', 'Полный']);
    for (const c of p.cables) {
      const r = calculateCable(p, c);
      const name = (id: string) => p.equipment.find(e => e.id === id)?.number || id;
      rows.push([c.number, c.name, c.brand, name(c.fromId), name(c.toId), c.quantity, r.total, r.total === null ? null : r.total * c.quantity, r.complete ? 'Да' : 'Нет']);
    }
    rows.push([]); rows.push(['Оборудование']); rows.push(['Тип', 'Модель', 'Этаж', 'Количество']);
    for (const g of specs.equipment) rows.push([g.type, g.model, g.floor, g.quantity]);
    rows.push([]); rows.push(['Кабели (сводно)']); rows.push(['Марка', 'Линий', 'Геометрия, м', 'Итого, м']);
    for (const g of specs.cables) rows.push([g.brand, g.lines, g.geometry, g.total]);
    rows.push([]); rows.push(['Инфраструктура']); rows.push(['Тип', 'Длина, м', 'Сегментов', 'Кабелей']);
    for (const g of specs.infrastructure) rows.push([g.type, g.length, g.segments, g.cables]);
    const cell = (v: string | number | null) => {
      let text = v === null ? '' : String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    return '\uFEFF' + rows.map(r => r.map(cell).join(';')).join('\r\n');
  }
  async function download(kind: 'csv' | 'xlsx' | 'pdf' | 'backup') {
    if (staticMode) {
      if (kind === 'xlsx' || kind === 'pdf') { setError('Экспорт XLSX/PDF доступен только в локальной версии. Используйте CSV.'); return; }
      const current = projectRef.current;
      let text: string;
      if (kind === 'backup') {
        const ids = [...new Set(current.floors.flatMap(f => f.pdfId && f.pdfId.startsWith('idb:') ? [f.pdfId.slice(4)] : []))];
        const pdfs: { id: string; name: string; dataBase64: string }[] = [];
        for (const id of ids) {
          const pdfBlob = await idbGet(id);
          if (pdfBlob) pdfs.push({ id: 'idb:' + id, name: 'plan.pdf', dataBase64: await blobToBase64(pdfBlob) });
        }
        text = JSON.stringify({ schemaVersion: 1, project: current, pdfs });
      } else {
        text = clientCsv(current);
      }
      const type = kind === 'backup' ? 'application/json' : 'text/csv;charset=utf-8';
      const blob = new Blob([text], { type });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${current.name}.${kind === 'backup' ? 'json' : 'csv'}`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      setMessage(kind === 'backup' ? 'Резервная копия выгружена.' : 'Экспорт CSV готов.');
      return;
    }
    const current = await saveProject();
    const url = kind === 'backup' ? `/api/projects/${current.id}/backup` : `/api/projects/${current.id}/export?format=${kind}`;
    const response = await fetch(url); if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${current.name}.${kind === 'backup' ? 'json' : kind}`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setMessage(kind === 'backup' ? 'Резервная копия с PDF выгружена.' : `Экспорт ${kind.toUpperCase()} готов.`);
  }
  const toolHints: Record<Tool, string> = { select: 'Выберите объект • тяните оборудование и узлы трассы', pan: 'Перетаскивайте план • колесо — масштаб', equipment: 'Клик на плане — добавить оборудование', route: 'Клики — вершины • Enter — завершить • Esc — отменить', calibrate: 'Укажите две точки известного размера на PDF', cable: 'Выбирайте сегменты по порядку от начала к концу' };

  return <div className="app-shell">
    <header className="topbar"><button className="menu-toggle" aria-label="Меню" onClick={() => setMenuOpen(v => !v)}>☰</button><div className="brand"><span className="brand-mark">C</span><div>CablePlan<small>кабельный план</small></div></div><div className="project-heading"><input aria-label="Название проекта" value={project.name} onChange={e => mutate(p => { p.name = e.target.value; })} /><span className={dirty ? 'save-indicator dirty' : 'save-indicator'}>{dirty ? '● Не сохранён' : '● Сохранён'}</span></div><div className="top-actions"><button className="desk-only" onClick={() => { if (mayLeave()) load(freshProject(), false); }}>Новый</button><button className="desk-only" disabled={busy} onClick={() => void run(async () => { setProjects(staticMode ? lsProjects().map(p => ({ id: p.id, name: p.name, updatedAt: p.updatedAt })) : await api('/api/projects')); })}>Открыть</button><button disabled={busy} title="Загрузить ранее экспортированный JSON-проект" onClick={() => restoreInput.current?.click()}>Загрузить</button><button className="primary" disabled={busy} onClick={() => void run(async () => { await saveProject(); })}>{busy ? 'Подождите…' : 'Сохранить'}</button></div></header>
    <div className="commandbar"><div className="view-tabs">{([['plan', 'План'], ['journal', 'Журнал'], ['specs', 'Ведомости']] as const).map(([id, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>)}</div><div className="command-actions"><button className="desk-only" onClick={() => { if (mayLeave()) { load(createDemoProject(), false); setMessage('Учебный проект: синтетические данные, не рабочая документация.'); } }}>Учебный проект</button><details className="export-menu"><summary>Экспорт / копия ↓</summary><div>{(['csv', 'xlsx', 'pdf', 'backup'] as const).map(format => <button key={format} disabled={busy} onClick={() => void run(() => download(format))}>{format === 'backup' ? 'JSON с исходными PDF' : format.toUpperCase()}</button>)}<button onClick={() => restoreInput.current?.click()}>Восстановить JSON…</button></div></details></div></div>
    {error && <div className="banner error" role="alert"><strong>Не удалось выполнить действие.</strong> {error}<button onClick={() => setError('')}>×</button></div>}
    <div className="workspace"><aside className={`sidebar ${menuOpen ? 'open' : ''}`}><div className="sidebar-title">Структура проекта <span>{project.floors.length} эт.</span></div><div className="structure-tabs">{([['floors', 'Этажи'], ['equipment', 'Оборуд.'], ['routes', 'Трассы'], ['cables', 'Кабели']] as const).map(([id, name]) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{name}<span>{project[id].length}</span></button>)}</div>
      <div className="object-list">{tab === 'floors' ? project.floors.map((f, i) => <button key={f.id} className={`object-row ${floor?.id === f.id ? 'selected' : ''}`} onClick={() => { setFloorId(f.id); setSelection(null); setMenuOpen(false); }}><span className="object-icon">{String(i + 1).padStart(2, '0')}</span><span><strong>{f.name}</strong><small>{f.pdfId ? `PDF · страница ${f.page}` : 'Без подложки'} · {f.elevation === null ? 'отметка не задана' : `${number(f.elevation)} м`}</small></span><i className={f.metersPerUnit ? 'dot calibrated' : 'dot'} /></button>) : tab === 'equipment' ? project.equipment.map(eq => <button key={eq.id} className={`object-row ${selection?.id === eq.id ? 'selected' : ''}`} onClick={() => { setSelection({ kind: 'equipment', id: eq.id }); setFloorId(eq.floorId); setView('plan'); setMenuOpen(false); }}><span className="object-icon equipment-icon">▣</span><span><strong>{eq.number}</strong><small>{eq.name}</small></span></button>) : tab === 'routes' ? project.routes.map(r => <button key={r.id} className={`object-row ${selection?.id === r.id ? 'selected' : ''}`} onClick={() => { setSelection({ kind: 'route', id: r.id }); if (r.segments[0]) setFloorId(r.segments[0].a.floorId); setView('plan'); setMenuOpen(false); }}><span className="object-icon route-icon">⌁</span><span><strong>{r.number} · {r.type}</strong><small>{r.segments.length} сегм.</small></span></button>) : project.cables.map(c => { const calc = cableCalcs.get(c.id)!; return <button key={c.id} className={`object-row ${selection?.id === c.id ? 'selected' : ''}`} onClick={() => { setSelection({ kind: 'cable', id: c.id }); setMenuOpen(false); }}><span className="object-icon cable-icon">↝</span><span><strong>{c.number} · {c.brand || c.name}</strong><small>{calc.complete ? `${number(calc.total)} м` : 'Неполный расчёт'}</small></span><i className={calc.complete ? 'dot calibrated' : 'dot warning'} /></button>; })}
      {project[tab].length === 0 && <div className="empty-list">Объектов пока нет.<br />Добавьте их на плане.</div>}</div>
      <div className="sidebar-actions">{tab === 'floors' ? <><button onClick={() => { const f = freshFloor(`Этаж ${project.floors.length + 1}`); mutate(p => p.floors.push(f)); setFloorId(f.id); setSelection(null); }}>＋ Добавить этаж</button><button onClick={() => upload.current?.click()} disabled={!floor || busy}>↑ Загрузить PDF</button></> : <button onClick={() => { setView('plan'); setTool(tab === 'equipment' ? 'equipment' : tab === 'routes' ? 'route' : 'cable'); }}>＋ {tab === 'equipment' ? 'Оборудование на плане' : tab === 'routes' ? 'Начертить трассу' : 'Создать кабель'}</button>}</div>
      <div className="sidebar-project"><button onClick={() => { setMenuOpen(false); if (mayLeave()) load(freshProject(), false); }}>＋ Новый проект</button><button disabled={busy} onClick={() => { setMenuOpen(false); void run(async () => { setProjects(staticMode ? lsProjects().map(p => ({ id: p.id, name: p.name, updatedAt: p.updatedAt })) : await api('/api/projects')); }); }}>📂 Открыть проект</button><button disabled={busy} onClick={() => { setMenuOpen(false); restoreInput.current?.click(); }}>⬆ Загрузить JSON</button><button onClick={() => { setMenuOpen(false); if (mayLeave()) { load(createDemoProject(), false); setMessage('Учебный проект: синтетические данные, не рабочая документация.'); } }}>📘 Учебный проект</button></div>
      <div className="project-health"><span className="eyebrow">КОНТРОЛЬ ДАННЫХ</span><strong>{issueCount ? `${issueCount} замечаний` : 'Проверка проекта'}</strong><small>Неизвестные отметки, масштаб и разрывы исключают итоговый метраж.</small><button onClick={() => setView('specs')}>Показать проверку →</button></div></aside>
      <main className="main-area">{view === 'plan' ? <div className="plan-view"><div className="drawing-toolbar"><div className="tool-group">{([['select', '↖', 'Выбор'], ['pan', '✥', 'Панорама'], ['equipment', '▣', 'Оборудование'], ['route', '⌁', 'Трасса'], ['cable', '↝', 'Кабель'], ['calibrate', '↔', 'Масштаб']] as const).map(([id, icon, label]) => <button key={id} title={label} className={tool === id ? 'active' : ''} onClick={() => { setTool(id); setDraft([]); setCalibration([]); }}><b>{icon}</b><span>{label}</span></button>)}</div><div className="tool-group history"><button title="Отменить Ctrl+Z" disabled={!undo.length} onClick={() => history(true)}>↶</button><button title="Повторить Ctrl+Shift+Z" disabled={!redo.length} onClick={() => history(false)}>↷</button></div></div>
      <div className="drawing-options"><label><input type="checkbox" checked={grid} onChange={e => setGrid(e.target.checked)} />Сетка</label><label><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} />Привязка</label><label><input type="checkbox" checked={ortho} onChange={e => setOrtho(e.target.checked)} />Ортогонально</label><label>Шаг<input className="mini-input" type="number" min="1" value={gridSize} onChange={e => setGridSize(Math.max(1, Number(e.target.value) || 1))} /></label><span className="grow" />{floor?.pdfId && <label>Страница <input className="mini-input" type="number" min="1" max={pdfPages || 9999} value={floor.page} onChange={e => { const page = Math.max(1, Math.min(pdfPages || 9999, Number(e.target.value) || 1)); if (page !== floor.page && window.confirm('Смена страницы сохраняет объекты и сбрасывает масштаб. Продолжить?')) mutate(p => { const f = p.floors.find(f => f.id === floor.id)!; f.page = page; f.metersPerUnit = null; }); }} /> / {pdfPages || '…'}</label>}<button onClick={fit}>Вписать</button><button onClick={() => changeZoom(zoom / 1.2)}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => changeZoom(zoom * 1.2)}>＋</button></div>
      {tool === 'route' && <div className="contextbar"><span>Трасса: {draft.length} вершин</span><label>Высота, м <input type="number" step="any" value={routeHeight} onChange={e => setRouteHeight(e.target.value)} /></label><button className="primary" disabled={draft.length < 2} onClick={finishRoute}>Завершить · Enter</button><button onClick={() => setDraft([])}>Сбросить</button></div>}
      {tool === 'cable' && <div className="contextbar cable-builder"><label>От {equipmentSelect(cableFrom, setCableFrom)}</label><span>→</span><label>До {equipmentSelect(cableTo, setCableTo)}</label><button onClick={() => { if (!cableFrom || !cableTo) { setError('Сначала выберите «От» и «До».'); return; } const res = findRoute(project, cableFrom, cableTo); if (res.error) setError(res.error); else { setCableSegments(res.segmentIds); setMessage(`Маршрут построен: ${res.segmentIds.length} сегм.`); } }}>Автомаршрут</button><span>{cableSegments.length} сегм.</span><button className="primary" onClick={finishCable}>Создать</button><button onClick={() => setCableSegments([])}>Сброс</button><small>Выберите «От» и «До» — маршрут строится сам. Можно скорректировать сегменты кликами.</small></div>}
      {pdfError && <div className="banner error">{pdfError}</div>}
      <div className={`drawing-stage tool-${tool}`} ref={stage} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={e => { e.preventDefault(); changeZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }}>
        {floor && <div className="drawing-sheet" style={{ width: floor.width, height: floor.height, transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}>
          {floor.pdfId ? <canvas ref={canvas} style={{ width: '100%', height: '100%' }} /> : <div className="no-pdf"><span>CablePlan / {floor.name.toUpperCase()}</span><p>Рабочее поле без PDF</p><small>{project.name.includes('Учеб') ? 'Синтетическая схема для проверки расчёта' : 'Загрузите план PDF и задайте масштаб по двум точкам'}</small></div>}
          <svg className="plan-overlay" width={floor.width} height={floor.height} viewBox={`0 0 ${floor.width} ${floor.height}`}>
            <defs><pattern id="drawing-grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse"><path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#63828e" strokeOpacity=".19" strokeWidth={.5 / zoom} /></pattern></defs>
            {grid && <rect width="100%" height="100%" fill="url(#drawing-grid)" pointerEvents="none" />}
            {project.routes.flatMap(r => r.segments.map((s, index) => {
              const visibleA = s.a.floorId === floor.id, visibleB = s.b.floorId === floor.id; if (!visibleA && !visibleB) return null;
              const chosen = cableSegments.includes(s.id) || cable?.segmentIds.includes(s.id); const selected = selection?.id === r.id;
              return <g key={s.id} data-object="segment" className={`route-segment ${chosen ? 'cable-selected' : ''} ${selected ? 'is-selected' : ''}`} onPointerDown={e => { e.stopPropagation(); if (tool === 'cable') setCableSegments(ids => ids.includes(s.id) ? ids.filter(id => id !== s.id) : [...ids, s.id]); else if (tool === 'route') { const p = position(e); setDraft(points => [...points, p]); } else if (tool === 'select') setSelection({ kind: 'route', id: r.id }); }}>
                <line x1={s.a.x} y1={s.a.y} x2={s.b.x} y2={s.b.y} stroke="transparent" strokeWidth={26 / zoom} />
                <line x1={s.a.x} y1={s.a.y} x2={s.b.x} y2={s.b.y} strokeWidth={(chosen ? 5 : selected ? 4 : 3) / zoom} className="visible-route" pointerEvents="none" strokeDasharray={!visibleA || !visibleB ? `${7 / zoom} ${4 / zoom}` : undefined} />
                {(!visibleA || !visibleB) && <g transform={`translate(${s.a.x},${s.a.y})`}><circle r={9 / zoom} fill="white" stroke="#875ec5" strokeWidth={2 / zoom} /><text textAnchor="middle" y={4 / zoom} fontSize={12 / zoom} fill="#875ec5">↕</text></g>}
                {(selected || chosen) && <text x={(s.a.x + s.b.x) / 2 + 6 / zoom} y={(s.a.y + s.b.y) / 2 - 7 / zoom} fontSize={11 / zoom} fill="#126e71" className="svg-label">{tool === 'cable' ? cableSegments.indexOf(s.id) + 1 || '' : `${r.number}.${index + 1}`}</text>}
              </g>;
            }))}
            {route && tool === 'select' && Array.from(new Map(route.segments.flatMap(s => [s.a, s.b]).filter(v => v.floorId === floor.id).map(v => [v.id, v])).values()).map(v => <circle data-object="vertex" key={v.id} cx={v.x} cy={v.y} r={5 / zoom} fill="white" stroke="#008e94" strokeWidth={2 / zoom} className="vertex-handle" onPointerDown={e => startDrag(e, 'vertex', route.id, v.id)} />)}
            {project.equipment.filter(eq => eq.floorId === floor.id).map(eq => <g data-object="equipment" key={eq.id} transform={`translate(${eq.x},${eq.y})`} className={`equipment-symbol ${selection?.id === eq.id ? 'is-selected' : ''}`} onPointerDown={e => { if (tool === 'select') { setSelection({ kind: 'equipment', id: eq.id }); startDrag(e, 'equipment', eq.id); } else if (tool === 'route') { e.stopPropagation(); setDraft(points => { const p = { x: eq.x, y: eq.y }; const last = points[points.length - 1]; return ortho && last && last.x !== p.x && last.y !== p.y ? [...points, { x: p.x, y: last.y }, p] : [...points, p]; }); } else if (tool === 'cable') { e.stopPropagation(); if (!cableFrom) { setCableFrom(eq.id); setMessage(`Начало: ${eq.number}. Коснитесь конечного устройства.`); } else if (cableTo !== eq.id) { setCableTo(eq.id); const res = findRoute(project, cableFrom, eq.id); if (res.error) { setCableSegments([]); setError(res.error); } else { setCableSegments(res.segmentIds); setMessage(`Конец: ${eq.number}. Маршрут построен автоматически: ${res.segmentIds.length} сегм.`); } } } }}>
              <circle r={16 / zoom} fill="transparent" /><rect x={-7 / zoom} y={-7 / zoom} width={14 / zoom} height={14 / zoom} rx={2 / zoom} strokeWidth={2 / zoom} /><path d={`M ${-3 / zoom} 0 H ${3 / zoom} M 0 ${-3 / zoom} V ${3 / zoom}`} stroke="#fff" strokeWidth={1.5 / zoom} pointerEvents="none" /><text x={11 / zoom} y={4 / zoom} fontSize={12 / zoom} className="svg-label">{eq.number}</text>
            </g>)}
            {draft.length > 0 && <g pointerEvents="none"><polyline points={draft.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#e78c22" strokeWidth={3 / zoom} strokeDasharray={`${6 / zoom} ${3 / zoom}`} />{draft.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4 / zoom} fill="#e78c22" />)}</g>}
            {calibration.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={6 / zoom} fill="#dc5071" pointerEvents="none" />)}
          </svg>
        </div>}
        <div className="plan-badge"><span className="dot calibrated" />{floor?.name || 'Нет этажей'}<span> / </span>{floor?.metersPerUnit ? `${number(floor.metersPerUnit)} м/ед.` : 'Масштаб не задан'}</div>
        <div className="plan-legend"><span className="legend-line" /> Трасса <span className="legend-equipment" /> Оборудование <span className="legend-cable" /> Выбранный кабель</div>
      </div><div className="tool-hint"><span>{toolHints[tool]}</span><small>Координаты PDF: {pointer ? `${number(pointer.x)}; ${number(pointer.y)}` : '—'}</small></div></div> : view === 'journal' ? <section className="document-view"><div className="document-title"><div><span className="eyebrow">ДОКУМЕНТАЦИЯ</span><h1>Кабельный журнал</h1><p>Расчёт по выбранным сегментам, высотам и запасам. Единица измерения — метр.</p></div><button className="primary" onClick={() => { setView('plan'); setTool('cable'); }}>＋ Кабель</button></div><div className="table-scroll"><table><thead><tr><th>Кабель / марка</th><th>От → до</th><th>Геометрия</th><th>Запас трасс</th><th>Запас кабеля</th><th>Концы</th><th>Итог / шт.</th><th>Кол.</th><th>Статус</th></tr></thead><tbody>{project.cables.map(c => { const calc = cableCalcs.get(c.id)!; return <tr key={c.id} className={selection?.id === c.id ? 'selected' : ''} onClick={() => setSelection({ kind: 'cable', id: c.id })}><td><strong>{c.number}</strong><small>{c.brand || c.name}</small></td><td>{project.equipment.find(e => e.id === c.fromId)?.number || '?'} → {project.equipment.find(e => e.id === c.toId)?.number || '?'}</td><td>{number(calc.geometry)}</td><td>{number(calc.routeReserve)}</td><td>{number(calc.cableReserve)}</td><td>{number(calc.endReserve)}</td><td><strong>{number(calc.total)}</strong></td><td>{c.quantity}</td><td><span className={`badge ${calc.complete ? 'good' : 'warn'}`}>{calc.complete ? 'Рассчитан' : 'Неполный'}</span></td></tr>; })}</tbody></table>{!project.cables.length && <div className="document-empty">Создайте кабель: выберите оборудование и упорядоченную цепочку сегментов на плане.</div>}</div><div className="document-note">Итог указан для одного кабеля. Количество применяется в ведомости. Неполные значения не подменяются нулём.</div></section> : <section className="document-view"><div className="document-title"><div><span className="eyebrow">ДОКУМЕНТАЦИЯ</span><h1>Ведомости и проверка</h1><p>Кабельная продукция и инфраструктура. Общие сегменты инфраструктуры учитываются один раз.</p></div></div><SpecificationTables value={specifications(project)} /><h2>Замечания к проекту</h2><IssueList value={issues} /><div className="document-note">Расчёт не заменяет проверку проектировщиком. PDF может содержать разные масштабы: калибруйте каждый этаж и страницу отдельно. Совмещение осей этажей выполняется вручную.</div></section>}</main>
      <aside className={`properties ${propsOpen ? 'open' : ''}`}><div className="properties-title">Свойства<span>{equipment ? 'ОБОРУДОВАНИЕ' : route ? 'ТРАССА' : cable ? 'КАБЕЛЬ' : 'ЭТАЖ'}</span><button className="properties-close" aria-label="Закрыть" onClick={() => setPropsOpen(false)}>×</button></div><div className="properties-content">{selection && (equipment || route || cable) ? <><div className="object-heading"><span className="eyebrow">{equipment ? 'ОБОРУДОВАНИЕ' : route ? 'КАБЕЛЬНАЯ ТРАССА' : 'КАБЕЛЬ'}</span><h2>{(equipment || route || cable)?.number}</h2></div>{itemField('Обозначение', 'number')}{!route && itemField('Наименование', 'name')}{(equipment || route) && itemField('Тип', 'type')}
      {equipment && <><label className="field">Этаж{floorSelect(equipment.floorId, value => setItem('floorId', value))}</label><div className="field-pair">{itemField('X, ед. PDF', 'x', true)}{itemField('Y, ед. PDF', 'y', true)}</div>{itemField('Высота от пола, м', 'height', true)}<p className="help">Пустая высота означает неизвестное значение. Для подводов кабеля задайте высоту явно, в том числе 0.</p><details><summary>Дополнительные свойства</summary>{Object.entries(equipment.properties).map(([key, value]) => field(key, value, v => setItem('properties', { ...equipment.properties, [key]: v })))}<button onClick={() => { const key = window.prompt('Название свойства'); if (key) setItem('properties', { ...equipment.properties, [key]: '' }); }}>＋ Свойство</button></details></>}
      {route && <><div className="section-label">Сегменты <span>{route.segments.length}</span></div><p className="help">Вершины тянутся на плане. Координаты и высоты можно задать точно ниже. При ручном изменении согласуйте соседние вершины.</p>{route.segments.map((s, index) => <details className="segment-editor" key={s.id}><summary>Сегмент {index + 1} {s.a.floorId !== s.b.floorId ? ' · стояк ↕' : ''}</summary><label className="field">Геометрия<select value={s.mode} onChange={e => mutate(p => { p.routes.find(r => r.id === route.id)!.segments.find(segment => segment.id === s.id)!.mode = e.target.value as Segment['mode']; })}><option value="orthogonal">Ортогональная</option><option value="spatial">Пространственная</option></select></label>{(['a', 'b'] as const).map(end => <div className="endpoint" key={end}><strong>{end === 'a' ? 'Начало' : 'Конец'}</strong><label className="field">Этаж{floorSelect(s[end].floorId, value => segmentField(s, end, 'floorId', value))}</label><div className="field-pair">{field('X', s[end].x, v => segmentField(s, end, 'x', Number(v)), true)}{field('Y', s[end].y, v => segmentField(s, end, 'y', Number(v)), true)}</div>{field('Высота, м', s[end].height, v => segmentField(s, end, 'height', v === '' ? null : Number(v)), true)}</div>)}<div className="field-pair">{field('Запас, %', s.reservePercent, v => mutate(p => { p.routes.find(r => r.id === route.id)!.segments.find(seg => seg.id === s.id)!.reservePercent = Number(v); }), true)}{field('Запас, м', s.reserveFixed, v => mutate(p => { p.routes.find(r => r.id === route.id)!.segments.find(seg => seg.id === s.id)!.reserveFixed = Number(v); }), true)}</div><button className="danger" onClick={() => { const linked = project.cables.filter(c => c.segmentIds.includes(s.id)); if (window.confirm(`Удалить сегмент? ${linked.length ? `Связанных кабелей: ${linked.length}. Они будут удалены.` : ''}`)) mutate(p => { p.routes.find(r => r.id === route.id)!.segments = p.routes.find(r => r.id === route.id)!.segments.filter(seg => seg.id !== s.id); p.cables = p.cables.filter(c => !c.segmentIds.includes(s.id)); }); }}>Удалить сегмент</button></details>)}<button className="wide" onClick={addRiser}>＋ Межэтажный стояк</button></>}
      {cable && <>{itemField('Марка', 'brand')}{itemField('Назначение', 'purpose')}<label className="field">От{equipmentSelect(cable.fromId, value => setItem('fromId', value))}</label><label className="field">До{equipmentSelect(cable.toId, value => setItem('toId', value))}</label><div className="field-pair">{itemField('Запас, %', 'reservePercent', true)}{itemField('Запас, м', 'reserveFixed', true)}</div><div className="field-pair">{itemField('На начале, м', 'startReserve', true)}{itemField('На конце, м', 'endReserve', true)}</div>{itemField('Количество', 'quantity', true)}<div className="section-label">Порядок обхода</div><ol className="segment-order">{cable.segmentIds.map((id, i) => <li key={id}><span>{segmentName(id)}</span><button disabled={!i} title="Выше" onClick={() => { const next = [...cable.segmentIds]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; setItem('segmentIds', next); }}>↑</button><button disabled={i === cable.segmentIds.length - 1} title="Ниже" onClick={() => { const next = [...cable.segmentIds]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; setItem('segmentIds', next); }}>↓</button><button title="Удалить из цепочки" onClick={() => setItem('segmentIds', cable.segmentIds.filter(s => s !== id))}>×</button></li>)}</ol><button className="wide" onClick={() => { setCableSegments([...cable.segmentIds]); setCableFrom(cable.fromId); setCableTo(cable.toId); setTool('cable'); setView('plan'); setMessage('Измените цепочку кликами. Кнопка «Применить» в свойствах сохранит выбор.'); }}>Выбрать сегменты на плане</button>{tool === 'cable' && <button className="primary wide" onClick={() => { setItem('segmentIds', [...cableSegments]); setItem('fromId', cableFrom); setItem('toId', cableTo); setTool('select'); setCableSegments([]); }}>Применить цепочку к {cable.number}</button>}{calculation && <div className={`calculation-card ${calculation.complete ? '' : 'incomplete'}`}><span>ИТОГ / 1 КАБЕЛЬ</span><strong>{number(calculation.total)} <small>м</small></strong><dl><dt>Геометрия</dt><dd>{number(calculation.geometry)} м</dd><dt>Запас трассы</dt><dd>{number(calculation.routeReserve)} м</dd><dt>Запас кабеля</dt><dd>{number(calculation.cableReserve)} м</dd><dt>Запас концов</dt><dd>{number(calculation.endReserve)} м</dd></dl>{calculation.errors.map((e, i) => <p key={i}>{e}</p>)}</div>}</>}
      <label className="field">Примечание<textarea value={(equipment || route || cable)?.note || ''} onChange={e => setItem('note', e.target.value)} /></label><div className="property-actions"><button onClick={copySelection}>Копировать</button><button className="danger" onClick={removeSelection}>Удалить</button></div></> : floor ? <><div className="object-heading"><span className="eyebrow">ТЕКУЩИЙ ЭТАЖ</span><h2>{floor.name}</h2></div>{field('Название', floor.name, v => mutate(p => { p.floors.find(f => f.id === floor.id)!.name = v; }))}{field('Отметка пола, м', floor.elevation, v => mutate(p => { p.floors.find(f => f.id === floor.id)!.elevation = v === '' ? null : Number(v); }), true, 'Абсолютная отметка для расчёта межэтажных стояков.')}<div className="scale-card"><span className="eyebrow">МАСШТАБ ПОДЛОЖКИ</span><strong>{floor.metersPerUnit ? `${number(floor.metersPerUnit)} м/ед.` : 'Не откалиброван'}</strong><button onClick={() => { setTool('calibrate'); setView('plan'); setCalibration([]); }}>↔ Калибровка по 2 точкам</button></div>{field('Метров в единице PDF', floor.metersPerUnit, v => mutate(p => { p.floors.find(f => f.id === floor.id)!.metersPerUnit = v === '' ? null : Number(v); }), true)}<div className="section-label">Подложка</div><p className="help">{floor.pdfId ? `Исходный PDF подключён. Страница ${floor.page}; ${number(floor.width)} × ${number(floor.height)} ед.` : 'PDF не загружен. Можно чертить на чистом листе; для метража необходим масштаб.'}</p>{floor.pdfId && pdfPages > 0 && <label className="field mobile-only">Страница PDF<input type="number" min="1" max={pdfPages} value={floor.page} onChange={e => { const page = Math.max(1, Math.min(pdfPages, Number(e.target.value) || 1)); if (page !== floor.page) mutate(p => { const f = p.floors.find(f => f.id === floor.id)!; f.page = page; f.metersPerUnit = null; }); }} /></label>}<button className="wide" disabled={busy} onClick={() => upload.current?.click()}>↑ {floor.pdfId ? 'Заменить PDF…' : 'Загрузить PDF…'}</button><p className="help">При замене PDF или страницы объекты остаются на прежних координатах. Проверьте положение и повторите калибровку.</p><div className="section-label">Система координат</div><p className="help">X/Y хранятся в единицах PDF. Зум не влияет на длины. Для стояка совпадающие X/Y на разных этажах должны соответствовать одной физической оси.</p><button className="danger wide" disabled={project.floors.length < 2} onClick={() => { const eqIds = project.equipment.filter(eq => eq.floorId === floor.id).map(eq => eq.id); const segmentIds = project.routes.flatMap(r => r.segments).filter(s => s.a.floorId === floor.id || s.b.floorId === floor.id).map(s => s.id); if (window.confirm('Удалить этаж, его оборудование, связанные сегменты и кабели?')) { mutate(p => { p.floors = p.floors.filter(f => f.id !== floor.id); p.equipment = p.equipment.filter(eq => eq.floorId !== floor.id); p.routes.forEach(r => { r.segments = r.segments.filter(s => !segmentIds.includes(s.id)); }); p.routes = p.routes.filter(r => r.segments.length); p.cables = p.cables.filter(c => !eqIds.includes(c.fromId) && !eqIds.includes(c.toId) && !c.segmentIds.some(id => segmentIds.includes(id))); }); setFloorId(''); } }}>Удалить этаж</button></> : <p className="help">Добавьте этаж для начала работы.</p>}</div></aside>
    </div><footer className="statusbar"><span><i className="dot calibrated" />{message}</span><span>{project.equipment.length} оборуд. · {project.routes.length} трасс · {project.cables.length} кабелей <b>{staticMode ? 'БРАУЗЕР' : 'СЕРВЕР'}</b></span></footer>
    {(menuOpen || propsOpen) && <div className="scrim" onClick={() => { setMenuOpen(false); setPropsOpen(false); }} />}
    <button className={`props-fab ${propsOpen ? 'active' : ''}`} aria-label="Свойства" onClick={() => setPropsOpen(v => !v)}>⚙</button>
    <input hidden ref={upload} type="file" accept="application/pdf,.pdf" onChange={e => { const file = e.target.files?.[0]; if (file) void run(() => uploadPdf(file)); e.target.value = ''; }} />
    <input hidden ref={restoreInput} type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (file && mayLeave()) void run(async () => { const parsed = JSON.parse(await file.text()) as Record<string, unknown>; if (staticMode) { const proj = (parsed && typeof parsed === 'object' && 'project' in parsed) ? parsed.project : parsed; if (proj && (proj as Partial<Project>).schemaVersion === 1 && Array.isArray((proj as Partial<Project>).floors)) { const rawPdfs = (parsed && typeof parsed === 'object' && 'pdfs' in parsed && Array.isArray(parsed.pdfs)) ? parsed.pdfs as { id: string; dataBase64?: string }[] : []; for (const pdf of rawPdfs) { if (pdf && pdf.id && pdf.dataBase64) { const bytes = Uint8Array.from(atob(pdf.dataBase64), c => c.charCodeAt(0)); await idbPut(pdf.id.replace(/^idb:/, ''), new Blob([bytes], { type: 'application/pdf' })); } } load(proj as unknown as Project, true); setMessage('Проект загружен из файла.'); } else { setError('Файл не является проектом CablePlan.'); } } else if (parsed && typeof parsed === 'object' && 'project' in parsed) { const result = await api<Project>('/api/restore', jsonOptions('POST', parsed)); load(result, true); setMessage('Резервная копия с PDF восстановлена.'); } else if (parsed && (parsed as Partial<Project>).schemaVersion === 1 && Array.isArray((parsed as Partial<Project>).floors)) { load(parsed as unknown as Project, false); setMessage('Проект загружен из файла. Подложку PDF при необходимости загрузите заново.'); } else { setError('Файл не является проектом или резервной копией CablePlan.'); } }); e.target.value = ''; }} />
    {projects && <div className="modal-backdrop"><section className="modal"><div className="modal-heading"><h2>Открыть проект</h2><button onClick={() => setProjects(null)}>×</button></div>{projects.length ? projects.map(p => <div className="project-row" key={p.id}><button className="project-option" disabled={busy} onClick={() => { if (mayLeave()) void run(async () => { const result = staticMode ? lsProjects().find(x => x.id === p.id)! : await api<Project>(`/api/projects/${p.id}`); load(result, true); setProjects(null); setMessage(`Проект «${result.name}» открыт.`); }); }}><strong>{p.name}</strong><small>{new Date(p.updatedAt).toLocaleString('ru-RU')}</small><span>→</span></button><button className="project-delete" disabled={busy} title="Удалить проект" onClick={() => void run(() => deleteProject(p.id, p.name))}>🗑</button></div>) : <p className="help">Сохранённых проектов пока нет.</p>}</section></div>}
  </div>;
}

function IssueList({ value }: { value: unknown }) {
  if (Array.isArray(value)) return value.length ? <ul className="issues-list">{value.map((item, index) => <li key={index}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>)}</ul> : <div className="validation-good">✓ Структурных замечаний не найдено. Проверьте рабочую документацию перед применением.</div>;
  return <pre className="data-json">{JSON.stringify(value, null, 2)}</pre>;
}
const labels: Record<string, string> = { cables: 'Кабельная продукция', cable: 'Кабельная продукция', infrastructure: 'Кабельная инфраструктура', routes: 'Кабельная инфраструктура', errors: 'Замечания', warnings: 'Предупреждения', name: 'Наименование', brand: 'Марка', type: 'Тип', purpose: 'Назначение', number: 'Обозначение', quantity: 'Количество', length: 'Длина, м', total: 'Всего, м', totalLength: 'Всего, м', complete: 'Полный расчёт', unit: 'Ед.', routeId: 'ID трассы', cableId: 'ID кабеля', segmentId: 'ID сегмента', reserve: 'Запас', geometry: 'Геометрия, м', totalQuantity: 'Количество', totalMeters: 'Всего, м', incomplete: 'Неполные', id: 'ID' };
function SpecificationTables({ value }: { value: unknown }) {
  function render(data: unknown, key: string): React.ReactNode {
    if (Array.isArray(data)) {
      if (!data.length) return <p className="help">Нет данных.</p>;
      if (data.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))) {
        const rows = data as Record<string, unknown>[]; const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
        return <div className="table-scroll"><table><thead><tr>{columns.map(col => <th key={col}>{labels[col] || col}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{columns.map(col => <td key={col}>{typeof row[col] === 'number' ? number(row[col]) : typeof row[col] === 'boolean' ? row[col] ? 'Да' : 'Нет' : row[col] === null ? '—' : typeof row[col] === 'object' ? JSON.stringify(row[col]) : String(row[col] ?? '—')}</td>)}</tr>)}</tbody></table></div>;
      }
      return <IssueList value={data} />;
    }
    if (data && typeof data === 'object') return <>{Object.entries(data).map(([name, item]) => <section className="spec-section" key={name}><h2>{labels[name] || name}</h2>{render(item, name)}</section>)}</>;
    return <div className="spec-value" style={{ '--spec-key': key } as CSSProperties}>{typeof data === 'number' ? number(data) : String(data ?? '—')}</div>;
  }
  return <div className="specifications">{render(value, 'root')}</div>;
}
