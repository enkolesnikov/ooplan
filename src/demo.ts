import type { Project, Floor, Equipment, Route, Cable, Segment, Vertex } from './model';

let counter = 0;
const uid = (): string => `demo-${(++counter)}-${Math.random().toString(36).slice(2, 8)}`;

const floor = (id: string, name: string, elevation: number, page: number): Floor => ({
  id, name, elevation, metersPerUnit: 0.05, page, width: 1000, height: 700,
});

const vertex = (id: string, floorId: string, x: number, y: number, height = 2.5): Vertex => ({ id, floorId, x, y, height });
const segment = (id: string, a: Vertex, b: Vertex): Segment => ({ id, a, b, mode: 'orthogonal', reservePercent: 0, reserveFixed: 0 });

const equipment = (
  id: string, number: string, name: string, type: string,
  floorId: string, x: number, y: number, height: number,
): Equipment => ({ id, number, name, type, floorId, x, y, height, note: '', properties: { model: name } });

const cable = (
  id: string, number: string, name: string, brand: string, purpose: string,
  fromId: string, toId: string, segmentIds: string[], quantity = 1,
): Cable => ({ id, number, name, brand, purpose, fromId, toId, segmentIds, reservePercent: 10, reserveFixed: 0, startReserve: 0.5, endReserve: 0.5, quantity, note: '' });

/** Synthetic project for the UI walkthrough; not a substitute for real drawings. */
export function createDemoProject(): Project {
  const f1 = floor(uid(), 'Этаж 1', 0, 1);
  const f2 = floor(uid(), 'Этаж 2', 4, 2);

  const equipmentList: Equipment[] = [
    equipment(uid(), 'Ш1', 'Шкаф питания', 'Шкаф', f1.id, 100, 350, 0),
    equipment(uid(), 'К1', 'Камера входа', 'Камера', f1.id, 300, 350, 3),
    equipment(uid(), 'К2', 'Камера коридора', 'Камера', f1.id, 500, 350, 3),
    equipment(uid(), 'К3', 'Камера периметра', 'Камера', f1.id, 700, 200, 3),
    equipment(uid(), 'Ш2', 'Шкаф этажа 2', 'Шкаф', f2.id, 100, 350, 0),
    equipment(uid(), 'К4', 'Камера лестницы', 'Камера', f2.id, 300, 200, 3),
  ];
  const byNumber = (n: string) => equipmentList.find(e => e.number === n)!;

  // Этаж 1: горизонталь y=350 от Ш1 к правому краю, затем подъём до камеры К3.
  const v1 = vertex(uid(), f1.id, 100, 350);
  const v2 = vertex(uid(), f1.id, 300, 350);
  const v3 = vertex(uid(), f1.id, 500, 350);
  const v3b = vertex(uid(), f1.id, 700, 350);
  const v4 = vertex(uid(), f1.id, 700, 200);

  // Стояк между этажами, затем горизонталь y=350 и подъём до камеры К4.
  const v5 = vertex(uid(), f1.id, 100, 350);
  const v6 = vertex(uid(), f2.id, 100, 350);
  const v7 = vertex(uid(), f2.id, 300, 350);
  const v8 = vertex(uid(), f2.id, 300, 200);

  const s1 = segment(uid(), v1, v2);
  const s2 = segment(uid(), v2, v3);
  const s3 = segment(uid(), v3, v3b);
  const s4 = segment(uid(), v3b, v4);
  const s5 = segment(uid(), v5, v6); // межэтажный стояк
  const s6 = segment(uid(), v6, v7);
  const s7 = segment(uid(), v7, v8);

  const routes: Route[] = [
    { id: uid(), number: 'Т1', type: 'Лоток', note: 'Горизонтальная трасса этажа 1', segments: [s1, s2, s3, s4] },
    { id: uid(), number: 'Т2', type: 'Стояк', note: 'Межэтажный вертикальный стояк', segments: [s5] },
    { id: uid(), number: 'Т3', type: 'Лоток', note: 'Горизонтальная трасса этажа 2', segments: [s6, s7] },
  ];

  const cables: Cable[] = [
    cable(uid(), 'Л1', 'Камера входа', 'КВК-П 2×0.75', 'Видеонаблюдение', byNumber('Ш1').id, byNumber('К1').id, [s1.id]),
    cable(uid(), 'Л2', 'Камера коридора', 'КВК-П 2×0.75', 'Видеонаблюдение', byNumber('Ш1').id, byNumber('К2').id, [s1.id, s2.id]),
    cable(uid(), 'Л3', 'Камера периметра', 'КВК-П 2×0.75', 'Видеонаблюдение', byNumber('Ш1').id, byNumber('К3').id, [s1.id, s2.id, s3.id, s4.id], 2),
    cable(uid(), 'Л4', 'Камера лестницы', 'КВК-П 2×0.75', 'Видеонаблюдение', byNumber('Ш1').id, byNumber('К4').id, [s5.id, s6.id, s7.id]),
  ];

  return {
    schemaVersion: 1,
    id: uid(),
    name: 'Учебный проект',
    floors: [f1, f2],
    equipment: equipmentList,
    routes,
    cables,
    updatedAt: new Date().toISOString(),
  };
}
