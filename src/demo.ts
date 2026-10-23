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

/** Простейший схематичный план здания в виде PDF (вектор, стандартный шрифт, без внешних файлов). */
export function demoPlanPdf(): string {
  const W = 1000, H = 700;
  const ops: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => ops.push(`${x1} ${y1} m ${x2} ${y2} l S`);
  const rect = (x: number, y: number, w: number, h: number) => ops.push(`${x} ${y} ${w} ${h} re S`);
  // Наружные стены
  rect(60, 60, 880, 580);
  // Коридор по центру (вдоль него идут трассы)
  line(60, 300, 940, 300);
  line(60, 400, 940, 400);
  // Верхние комнаты
  line(250, 400, 250, 640);
  line(450, 400, 450, 640);
  line(650, 400, 650, 640);
  // Нижние комнаты
  line(300, 60, 300, 300);
  line(600, 60, 600, 300);
  // Дверные проёмы в коридор
  line(240, 300, 240, 380);
  line(440, 300, 440, 380);
  line(640, 300, 640, 380);
  // Подписи (латиница — стандартный Helvetica)
  ops.push('BT /F1 20 Tf 70 650 Td (CABLEPLAN - DEMO FLOOR PLAN) Tj ET');
  ops.push('BT /F1 12 Tf 70 30 Td (Synthetic training plan. Not a working drawing.) Tj ET');
  const content = ops.join('\n');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${W} ${H}]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>`,
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new TextEncoder().encode(pdf);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return 'data:application/pdf;base64,' + btoa(binary);
}

/** Synthetic project for the UI walkthrough; not a substitute for real drawings. */
export function createDemoProject(): Project {
  const plan = demoPlanPdf();
  const f1: Floor = { ...floor(uid(), 'Этаж 1', 0, 1), pdfId: plan };
  const f2: Floor = { ...floor(uid(), 'Этаж 2', 4, 2), pdfId: plan };

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
