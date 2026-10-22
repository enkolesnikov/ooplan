import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCable, findRoute, segmentLength, specifications, validateProject } from '../src/engine';
import type { Equipment, Project, Segment, Vertex } from '../src/model';

const vertex = (id: string, x: number, y = 0, height: number | null = 3, floorId = 'f1'): Vertex => ({ id, x, y, height, floorId });
const segment = (id: string, a: Vertex, b: Vertex, extra: Partial<Segment> = {}): Segment => ({ id, a, b, mode: 'orthogonal', reservePercent: 0, reserveFixed: 0, ...extra });
const device = (id: string, x: number, height: number | null = 1, floorId = 'f1'): Equipment => ({ id, number: id, name: 'Датчик', type: 'Датчик', floorId, x, y: 0, height, note: '', properties: { model: 'Д-1' } });
function fixture(): Project {
  return {
    schemaVersion: 1, id: 'p', name: 'Тест', updatedAt: '2026-01-01T00:00:00Z',
    floors: [
      { id: 'f1', name: 'Первый', elevation: 0, metersPerUnit: 0.1, page: 1, width: 1000, height: 700 },
      { id: 'f2', name: 'Второй', elevation: 4, metersPerUnit: 0.1, page: 2, width: 1000, height: 700 },
    ],
    equipment: [device('a', 0), device('b', 100)],
    routes: [{ id: 'r', number: 'Т1', type: 'Лоток', note: '', segments: [segment('s', vertex('v1', 0), vertex('v2', 100))] }],
    cables: [{ id: 'c', number: 'К1', name: 'Линия', brand: 'ВВГ', purpose: '', fromId: 'a', toId: 'b', segmentIds: ['s'], reservePercent: 0, reserveFixed: 0, startReserve: 0, endReserve: 0, quantity: 1, note: '' }],
  };
}
const close = (actual: number | null, expected: number) => { assert.notEqual(actual, null); assert.ok(Math.abs(actual! - expected) < 1e-10, `${actual} != ${expected}`); };
const incomplete = (p: Project) => {
  const result = calculateCable(p, p.cables[0]);
  assert.equal(result.complete, false);
  assert.equal(result.total, null);
  assert.equal(result.geometry, null);
  assert.ok(result.errors.length > 0);
  assert.ok(validateProject(p).length > 0);
};

test('формула сохраняет точность, разделяет запасы и добавляет вертикальные подводы', () => {
  const p = fixture();
  p.routes[0].segments[0].reservePercent = 10;
  p.routes[0].segments[0].reserveFixed = 0.25;
  Object.assign(p.cables[0], { reservePercent: 20, reserveFixed: 0.3, startReserve: 1, endReserve: 2, quantity: 7 });
  const result = calculateCable(p, p.cables[0]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.errors, []);
  close(result.geometry, 14);
  close(result.routeReserve, 1.25);
  close(result.cableReserve, 3.1);
  close(result.endReserve, 3);
  close(result.total, 21.35);
  assert.deepEqual(result.segments, [{ id: 's', length: 10 }]);
  close(specifications(p).cables[0].total, 21.35 * 7);
  close(specifications(p).cables[0].geometry, 14 * 7);
  close(specifications(p).infrastructure[0].length, 10);
});

test('ортогональный участок складывает горизонтальную и вертикальную длину, spatial использует гипотенузу', () => {
  const p = fixture();
  const s = segment('s', vertex('a', 0, 0, 0), vertex('b', 30, 0, 4));
  close(segmentLength(p, s), 7);
  close(segmentLength(p, { ...s, mode: 'spatial' }), 5);
  const diagonal = { ...s, b: vertex('b', 30, 40, 12) };
  assert.equal(segmentLength(p, diagonal), null);
  close(segmentLength(p, { ...diagonal, mode: 'spatial' }), 13);
});

test('межэтажная вертикаль учитывает отметки пола и высоты', () => {
  const p = fixture();
  const s = segment('s', vertex('a', 0, 0, 3), vertex('b', 0, 0, 1, 'f2'));
  p.routes[0].segments = [s];
  p.equipment[1] = device('b', 0, 0, 'f2');
  close(segmentLength(p, s), 2);
  close(calculateCable(p, p.cables[0]).geometry, 5);
  s.b.x = 1;
  assert.equal(segmentLength(p, s), null);
  incomplete(p);
});

test('цепочка обходится в обратном направлении независимо от хранения сегментов', () => {
  const p = fixture();
  p.routes[0].segments = [
    segment('s1', vertex('b', 50), vertex('a', 0)),
    segment('s2', vertex('c', 100), vertex('b2', 50)),
  ];
  p.cables[0].segmentIds = ['s1', 's2'];
  close(calculateCable(p, p.cables[0]).total, 14);
  Object.assign(p.cables[0], { fromId: 'b', toId: 'a', segmentIds: ['s2', 's1'] });
  close(calculateCable(p, p.cables[0]).total, 14);
});

test('связность допускает погрешность 1e-6, но требует совпадения высот и этажей', () => {
  const p = fixture();
  p.routes[0].segments = [segment('s1', vertex('a', 0), vertex('b', 50)), segment('s2', vertex('c', 50 + 0.0000005), vertex('d', 100))];
  p.cables[0].segmentIds = ['s1', 's2'];
  assert.equal(calculateCable(p, p.cables[0]).complete, true);
  p.routes[0].segments[1].a.height = 3.01;
  incomplete(p);
  p.routes[0].segments[1].a.height = 3;
  p.routes[0].segments[1].a.floorId = 'f2';
  incomplete(p);
});

for (const [name, mutate] of [
  ['неизвестная высота оборудования', (p: Project) => { p.equipment[0].height = null; }],
  ['неизвестная высота трассы', (p: Project) => { p.routes[0].segments[0].a.height = null; }],
  ['неизвестный масштаб', (p: Project) => { p.floors[0].metersPerUnit = null; }],
  ['нулевой масштаб', (p: Project) => { p.floors[0].metersPerUnit = 0; }],
  ['неизвестная отметка', (p: Project) => { p.floors[0].elevation = null; }],
  ['отсутствующий этаж', (p: Project) => { p.routes[0].segments[0].a.floorId = 'missing'; }],
  ['отсутствующее оборудование', (p: Project) => { p.cables[0].fromId = 'missing'; }],
  ['неверное положение конца', (p: Project) => { p.equipment[1].x = 99; }],
  ['повтор сегмента', (p: Project) => { p.cables[0].segmentIds.push('s'); }],
  ['отсутствующий сегмент', (p: Project) => { p.cables[0].segmentIds.push('missing'); }],
  ['пустой маршрут', (p: Project) => { p.cables[0].segmentIds = []; }],
  ['разрыв цепочки', (p: Project) => { p.routes[0].segments.push(segment('s2', vertex('c', 200), vertex('d', 300))); p.cables[0].segmentIds.push('s2'); }],
  ['повтор ID сегмента в трассах', (p: Project) => { p.routes.push({ ...p.routes[0], id: 'r2' }); }],
  ['отрицательный запас', (p: Project) => { p.cables[0].reserveFixed = -1; }],
  ['нечисловой запас участка', (p: Project) => { p.routes[0].segments[0].reservePercent = Number.NaN; }],
  ['дробное количество', (p: Project) => { p.cables[0].quantity = 1.5; }],
] as const) {
  test(`${name}: расчёт неполный без фиктивного итога`, () => { const p = fixture(); mutate(p); incomplete(p); });
}

test('нулевые высоты и отметки являются известными значениями', () => {
  const p = fixture();
  p.equipment.forEach(e => { e.height = 0; });
  p.routes[0].segments.forEach(s => { s.a.height = 0; s.b.height = 0; });
  close(calculateCable(p, p.cables[0]).total, 10);
  assert.deepEqual(validateProject(p), []);
});

test('спецификация объединяет модели и марки, инфраструктуру считает один раз', () => {
  const p = fixture();
  p.cables[0].quantity = 3;
  p.cables.push({ ...p.cables[0], id: 'c2', number: 'К2', quantity: 2 });
  const spec = specifications(p);
  assert.deepEqual(spec.equipment, [{ type: 'Датчик', model: 'Д-1', floor: 'Первый', quantity: 2 }]);
  assert.deepEqual(spec.cables, [{ brand: 'ВВГ', lines: 5, geometry: 70, total: 70 }]);
  assert.deepEqual(spec.infrastructure, [{ type: 'Лоток', length: 10, segments: 1, cables: 5 }]);
  assert.deepEqual(spec.errors, []);
});

test('неполная кабельная группа не выдаёт частичную длину как полный итог', () => {
  const p = fixture();
  p.cables.push({ ...p.cables[0], id: 'c2', segmentIds: ['missing'] });
  p.cables.push({ ...p.cables[0], id: 'c3', brand: 'Другой' });
  const spec = specifications(p);
  assert.deepEqual(spec.cables[0], { brand: 'ВВГ', lines: 2, geometry: null, total: null });
  close(spec.cables[1].total, 14);
  assert.ok(spec.errors.length);
});

test('неполная инфраструктура даёт null; повторы ID не удваивают длину', () => {
  const p = fixture();
  p.routes[0].segments.push(segment('s2', vertex('c', 100), vertex('d', 200, 0, null)));
  assert.equal(specifications(p).infrastructure[0].length, null);
  p.routes[0].segments.pop();
  p.routes.push({ ...p.routes[0], id: 'r2' });
  const spec = specifications(p);
  assert.equal(spec.infrastructure[0].length, null);
  assert.equal(spec.infrastructure[0].segments, 1);
});

test('геометрия зависит только от координат страницы и масштаба, без округления', () => {
  const p = fixture();
  p.floors[0].metersPerUnit = 1 / 3;
  p.routes[0].segments[0].b.x = 1;
  p.equipment[1].x = 1;
  close(segmentLength(p, p.routes[0].segments[0]), 1 / 3);
  const before = calculateCable(p, p.cables[0]);
  p.floors[0].width *= 2;
  p.floors[0].height *= 2;
  assert.deepEqual(calculateCable(p, p.cables[0]), before);
});

test('validateProject проверяет неиспользуемую инфраструктуру и дубли сущностей', () => {
  const p = fixture();
  p.equipment.push({ ...p.equipment[0] });
  p.routes[0].segments.push(segment('unused', vertex('a', 0, 0, null), vertex('b', 10)));
  const errors = validateProject(p);
  assert.ok(errors.some(e => e.includes('ID оборудования')));
  assert.ok(errors.some(e => e.includes('unused')));
});

test('findRoute прокладывает маршрут по сегментам между устройствами', () => {
  const p = fixture();
  assert.deepEqual(findRoute(p, 'a', 'b').segmentIds, ['s']);
  assert.equal(findRoute(p, 'a', 'b').error, undefined);

  p.routes[0].segments = [
    segment('s1', vertex('a', 0), vertex('m', 50)),
    segment('s2', vertex('m', 50), vertex('b', 100)),
    segment('s3', vertex('m', 50), vertex('c', 200)),
  ];
  assert.deepEqual(findRoute(p, 'a', 'b').segmentIds, ['s1', 's2']);

  p.routes[0].segments = [
    segment('s1', vertex('a', 0), vertex('m', 50)),
    segment('s2', vertex('c', 200), vertex('d', 300)),
  ];
  p.equipment[1] = device('b', 300);
  assert.ok(findRoute(p, 'a', 'b').error);
  assert.equal(findRoute(p, 'a', 'b').segmentIds.length, 0);
});
