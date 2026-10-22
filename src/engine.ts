import type { Cable, Equipment, Project, Segment, Vertex } from './model';

const EPS = 1e-6;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const near = (a: number, b: number) => finite(a) && finite(b) && Math.abs(a - b) <= EPS;
const samePlan = (a: Pick<Vertex, 'floorId' | 'x' | 'y'>, b: Pick<Vertex, 'floorId' | 'x' | 'y'>) =>
  a.floorId === b.floorId && near(a.x, b.x) && near(a.y, b.y);
const sameVertex = (a: Vertex, b: Vertex) => samePlan(a, b) && finite(a.height) && finite(b.height) && near(a.height, b.height);

function segmentErrors(project: Project, segment: Segment): string[] {
  const errors: string[] = [];
  const prefix = `Сегмент ${segment.id}`;
  const aFloor = project.floors.find(f => f.id === segment.a.floorId);
  const bFloor = project.floors.find(f => f.id === segment.b.floorId);
  for (const [vertex, floor] of [[segment.a, aFloor], [segment.b, bFloor]] as const) {
    if (!floor) errors.push(`${prefix}: отсутствует этаж ${vertex.floorId}`);
    else {
      if (!finite(floor.metersPerUnit) || floor.metersPerUnit <= 0) errors.push(`${prefix}: неизвестен или неверен масштаб этажа ${floor.id}`);
      if (!finite(floor.elevation)) errors.push(`${prefix}: неизвестна отметка этажа ${floor.id}`);
    }
    if (!finite(vertex.x) || !finite(vertex.y)) errors.push(`${prefix}: неверные координаты`);
    if (!finite(vertex.height)) errors.push(`${prefix}: неизвестна высота вершины ${vertex.id}`);
  }
  if (segment.mode !== 'orthogonal' && segment.mode !== 'spatial') errors.push(`${prefix}: неизвестный режим`);
  if (segment.a.floorId !== segment.b.floorId) {
    if (!near(segment.a.x, segment.b.x) || !near(segment.a.y, segment.b.y)) errors.push(`${prefix}: межэтажный переход должен быть вертикальным`);
    if (!finite(aFloor?.elevation) || !finite(bFloor?.elevation)) errors.push(`${prefix}: неизвестна отметка этажа`);
  } else if (segment.mode === 'orthogonal' && !near(segment.a.x, segment.b.x) && !near(segment.a.y, segment.b.y)) {
    errors.push(`${prefix}: ортогональный участок одновременно изменяет x и y`);
  }
  return errors;
}

/** Physical length in metres, without any reserve or quantity multiplier. */
export function segmentLength(project: Project, segment: Segment): number | null {
  if (segmentErrors(project, segment).length) return null;
  const aFloor = project.floors.find(f => f.id === segment.a.floorId)!;
  const bFloor = project.floors.find(f => f.id === segment.b.floorId)!;
  const heightA = segment.a.height!;
  const heightB = segment.b.height!;
  let result: number;
  if (aFloor.id !== bFloor.id) {
    result = Math.abs(bFloor.elevation! + heightB - aFloor.elevation! - heightA);
  } else {
    const dx = (segment.b.x - segment.a.x) * aFloor.metersPerUnit!;
    const dy = (segment.b.y - segment.a.y) * aFloor.metersPerUnit!;
    const dz = heightB - heightA;
    result = segment.mode === 'spatial' ? Math.hypot(dx, dy, dz) : Math.hypot(dx, dy) + Math.abs(dz);
  }
  return finite(result) ? result : null;
}

function segmentIndex(project: Project) {
  const segments = new Map<string, Segment>();
  const duplicates = new Set<string>();
  for (const route of project.routes) for (const segment of route.segments) {
    if (segments.has(segment.id)) duplicates.add(segment.id);
    else segments.set(segment.id, segment);
  }
  return { segments, duplicates };
}

export function chainEnds(project: Project, segmentIds: string[]): { start: Vertex; end: Vertex } | null {
  const { segments: index } = segmentIndex(project);
  const chain: Segment[] = [];
  for (const id of segmentIds) {
    const segment = index.get(id);
    if (!segment) return null;
    chain.push(segment);
  }
  if (!chain.length) return null;
  for (const reverse of [false, true]) {
    let start = reverse ? chain[0].b : chain[0].a;
    let end = reverse ? chain[0].a : chain[0].b;
    let connected = true;
    for (const segment of chain.slice(1)) {
      if (sameVertex(end, segment.a)) end = segment.b;
      else if (sameVertex(end, segment.b)) end = segment.a;
      else { connected = false; break; }
    }
    if (connected) return { start, end };
  }
  return null;
}

/** Finds a route across drawn segments between two pieces of equipment (BFS by segment count). */
export function findRoute(project: Project, fromId: string, toId: string): { segmentIds: string[]; error?: string } {
  const from = project.equipment.find(e => e.id === fromId);
  const to = project.equipment.find(e => e.id === toId);
  if (!from || !to) return { segmentIds: [], error: 'Оборудование не найдено.' };

  const key = (floorId: string, x: number, y: number) => `${floorId}|${x.toFixed(3)}|${y.toFixed(3)}`;
  const adjacency = new Map<string, { segmentId: string; other: string }[]>();
  const positions = new Map<string, { floorId: string; x: number; y: number }>();

  for (const route of project.routes) {
    for (const segment of route.segments) {
      const ka = key(segment.a.floorId, segment.a.x, segment.a.y);
      const kb = key(segment.b.floorId, segment.b.x, segment.b.y);
      if (!adjacency.has(ka)) { adjacency.set(ka, []); positions.set(ka, { floorId: segment.a.floorId, x: segment.a.x, y: segment.a.y }); }
      if (!adjacency.has(kb)) { adjacency.set(kb, []); positions.set(kb, { floorId: segment.b.floorId, x: segment.b.x, y: segment.b.y }); }
      adjacency.get(ka)!.push({ segmentId: segment.id, other: kb });
      adjacency.get(kb)!.push({ segmentId: segment.id, other: ka });
    }
  }

  const nearest = (eq: Equipment): string | null => {
    let best: { k: string; d: number } | null = null;
    for (const [k, pos] of positions) {
      if (pos.floorId !== eq.floorId) continue;
      const d = Math.hypot(pos.x - eq.x, pos.y - eq.y);
      if (!best || d < best.d) best = { k, d };
    }
    return best?.k ?? null;
  };

  const start = nearest(from);
  const end = nearest(to);
  if (!start || !end) return { segmentIds: [], error: 'На плане нет трассы для маршрута.' };
  if (start === end) return { segmentIds: [], error: 'Оба устройства подключены к одной точке трассы.' };

  const prev = new Map<string, { node: string; segmentId: string } | null>();
  prev.set(start, null);
  const queue: string[] = [start];
  let found = false;
  for (let i = 0; i < queue.length && !found; i++) {
    const cur = queue[i];
    for (const edge of adjacency.get(cur) ?? []) {
      if (prev.has(edge.other)) continue;
      prev.set(edge.other, { node: cur, segmentId: edge.segmentId });
      if (edge.other === end) { found = true; break; }
      queue.push(edge.other);
    }
  }

  if (!found) return { segmentIds: [], error: 'Между устройствами нет непрерывной трассы. Соедините трассы между собой.' };

  const segmentIds: string[] = [];
  let node: string | null = end;
  while (node !== null) {
    const parent = prev.get(node);
    if (!parent) break;
    segmentIds.unshift(parent.segmentId);
    node = parent.node;
  }
  return { segmentIds };
}

function reserveErrors(owner: string, percent: number, fixed: number): string[] {
  return nonnegative(percent) && nonnegative(fixed) ? [] : [`${owner}: запасы должны быть конечными неотрицательными числами`];
}

export interface CableCalculation {
  complete: boolean;
  errors: string[];
  geometry: number | null;
  routeReserve: number;
  cableReserve: number;
  endReserve: number;
  total: number | null;
  segments: { id: string; length: number | null }[];
}

export function calculateCable(project: Project, cable: Cable): CableCalculation {
  const errors: string[] = [];
  const { segments: index, duplicates } = segmentIndex(project);
  const equipment = (id: string) => project.equipment.find(item => item.id === id);
  const from = equipment(cable.fromId);
  const to = equipment(cable.toId);
  for (const [label, item] of [['начала', from], ['конца', to]] as const) {
    if (!item) errors.push(`Отсутствует оборудование ${label} кабеля ${cable.number}`);
    else {
      if (!project.floors.some(f => f.id === item.floorId)) errors.push(`Оборудование ${item.number}: отсутствует этаж`);
      if (!finite(item.height)) errors.push(`Оборудование ${item.number}: неизвестна высота`);
      if (!finite(item.x) || !finite(item.y)) errors.push(`Оборудование ${item.number}: неверные координаты`);
      if (project.equipment.filter(e => e.id === item.id).length > 1) errors.push(`Повтор ID оборудования ${item.id}`);
    }
  }
  errors.push(...reserveErrors(`Кабель ${cable.number}`, cable.reservePercent, cable.reserveFixed));
  if (!nonnegative(cable.startReserve) || !nonnegative(cable.endReserve)) errors.push(`Кабель ${cable.number}: неверные концевые запасы`);
  if (!Number.isInteger(cable.quantity) || cable.quantity <= 0) errors.push(`Кабель ${cable.number}: количество должно быть положительным целым`);
  if (!cable.segmentIds.length) errors.push(`Кабель ${cable.number}: не задана цепочка сегментов`);
  const seen = new Set<string>();
  let routeReserve = 0;
  let segmentGeometry = 0;
  const chain: Segment[] = [];
  const results = cable.segmentIds.map(id => {
    if (seen.has(id)) errors.push(`Кабель ${cable.number}: повтор сегмента ${id}`);
    seen.add(id);
    const segment = index.get(id);
    if (!segment) {
      errors.push(`Отсутствует сегмент ${id}`);
      return { id, length: null };
    }
    if (duplicates.has(id)) errors.push(`Неоднозначный ID сегмента ${id}`);
    chain.push(segment);
    errors.push(...segmentErrors(project, segment));
    errors.push(...reserveErrors(`Сегмент ${id}`, segment.reservePercent, segment.reserveFixed));
    const length = segmentLength(project, segment);
    if (length === null && !segmentErrors(project, segment).length) errors.push(`Сегмент ${id}: длина не является конечным числом`);
    if (length !== null) {
      segmentGeometry += length;
      if (nonnegative(segment.reservePercent) && nonnegative(segment.reserveFixed)) routeReserve += length * segment.reservePercent / 100 + segment.reserveFixed;
    }
    return { id, length };
  });

  let leads = 0;
  if (from && to && chain.length === cable.segmentIds.length && chain.length) {
    // The stored direction of any segment is independent of traversal direction.
    let oriented: { start: Vertex; end: Vertex } | undefined;
    for (const reverse of [false, true]) {
      const start = reverse ? chain[0].b : chain[0].a;
      if (!samePlan(from, start)) continue;
      let end = reverse ? chain[0].a : chain[0].b;
      let connected = true;
      for (const segment of chain.slice(1)) {
        if (sameVertex(end, segment.a)) end = segment.b;
        else if (sameVertex(end, segment.b)) end = segment.a;
        else { connected = false; break; }
      }
      if (connected && samePlan(to, end)) { oriented = { start, end }; break; }
    }
    if (!oriented) {
      const ends = chainEnds(project, cable.segmentIds);
      if (!ends) errors.push(`Кабель ${cable.number}: выбранные сегменты не образуют непрерывную цепочку. Выберите их по порядку от начала к концу.`);
      else errors.push(`Кабель ${cable.number}: концы трассы не совпадают с оборудованием «От»/«До». Начертите трассу, начиная и заканчивая на устройствах, или подвиньте устройства к концам трассы.`);
    }
    else if (finite(from.height) && finite(to.height) && finite(oriented.start.height) && finite(oriented.end.height)) {
      leads = Math.abs(from.height - oriented.start.height) + Math.abs(to.height - oriented.end.height);
    }
  }
  const geometry = errors.length ? null : segmentGeometry + leads;
  const cableReserve = geometry !== null ? geometry * cable.reservePercent / 100 + cable.reserveFixed : 0;
  const endReserve = nonnegative(cable.startReserve) && nonnegative(cable.endReserve) ? cable.startReserve + cable.endReserve : 0;
  const total = geometry === null ? null : geometry + routeReserve + cableReserve + endReserve;
  if (total !== null && !finite(total)) errors.push(`Кабель ${cable.number}: итог не является конечным числом`);
  return { complete: errors.length === 0, errors: [...new Set(errors)], geometry: errors.length ? null : geometry, routeReserve, cableReserve, endReserve, total: errors.length ? null : total, segments: results };
}

export function specifications(project: Project) {
  const equipment: { type: string; model: string; floor: string; quantity: number }[] = [];
  for (const item of project.equipment) {
    const model = item.properties.model || item.name;
    const floor = project.floors.find(f => f.id === item.floorId)?.name ?? item.floorId;
    const group = equipment.find(g => g.type === item.type && g.model === model && g.floor === floor);
    if (group) group.quantity++;
    else equipment.push({ type: item.type, model, floor, quantity: 1 });
  }
  const cables: { brand: string; lines: number; geometry: number | null; total: number | null }[] = [];
  const errors: string[] = [];
  for (const cable of project.cables) {
    const calculation = calculateCable(project, cable);
    errors.push(...calculation.errors);
    let group = cables.find(g => g.brand === cable.brand);
    if (!group) { group = { brand: cable.brand, lines: 0, geometry: 0, total: 0 }; cables.push(group); }
    const validQuantity = Number.isInteger(cable.quantity) && cable.quantity > 0;
    if (validQuantity) group.lines += cable.quantity;
    group.geometry = group.geometry === null || calculation.geometry === null || !validQuantity ? null : group.geometry + calculation.geometry * cable.quantity;
    group.total = group.total === null || calculation.total === null || !validQuantity ? null : group.total + calculation.total * cable.quantity;
  }
  const infrastructure: { type: string; length: number | null; segments: number; cables: number }[] = [];
  const { duplicates } = segmentIndex(project);
  const seen = new Set<string>();
  for (const route of project.routes) {
    let group = infrastructure.find(g => g.type === route.type);
    if (!group) { group = { type: route.type, length: 0, segments: 0, cables: 0 }; infrastructure.push(group); }
    for (const segment of route.segments) {
      if (duplicates.has(segment.id)) { group.length = null; errors.push(`Неоднозначный ID сегмента ${segment.id}`); }
      if (seen.has(segment.id)) continue;
      seen.add(segment.id);
      group.segments++;
      const length = segmentLength(project, segment);
      if (length === null) errors.push(...segmentErrors(project, segment));
      group.length = group.length === null || length === null ? null : group.length + length;
    }
  }
  for (const group of infrastructure) {
    const ids = new Set(project.routes.filter(r => r.type === group.type).flatMap(r => r.segments.map(s => s.id)));
    group.cables = project.cables.filter(c => c.segmentIds.some(id => ids.has(id))).reduce((sum, c) => sum + (Number.isInteger(c.quantity) && c.quantity > 0 ? c.quantity : 0), 0);
  }
  return { equipment, cables, infrastructure, errors: [...new Set(errors)] };
}

export function validateProject(project: Project): string[] {
  const errors: string[] = [];
  if (project.schemaVersion !== 1) errors.push('Неподдерживаемая версия проекта');
  for (const [name, items] of [['этажа', project.floors], ['оборудования', project.equipment], ['трассы', project.routes], ['кабеля', project.cables]] as const) {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.id || seen.has(item.id)) errors.push(`Пустой или повторяющийся ID ${name}: ${item.id}`);
      seen.add(item.id);
    }
  }
  for (const floor of project.floors) {
    if (!finite(floor.metersPerUnit) || floor.metersPerUnit <= 0) errors.push(`Этаж ${floor.name}: неизвестен или неверен масштаб`);
    if (!finite(floor.elevation)) errors.push(`Этаж ${floor.name}: неизвестна отметка`);
  }
  for (const item of project.equipment) {
    if (!project.floors.some(f => f.id === item.floorId)) errors.push(`Оборудование ${item.number}: отсутствует этаж`);
    if (!finite(item.height)) errors.push(`Оборудование ${item.number}: неизвестна высота`);
    if (!finite(item.x) || !finite(item.y)) errors.push(`Оборудование ${item.number}: неверные координаты`);
  }
  const { duplicates } = segmentIndex(project);
  for (const id of duplicates) errors.push(`Неоднозначный ID сегмента ${id}`);
  for (const route of project.routes) for (const segment of route.segments) {
    errors.push(...segmentErrors(project, segment), ...reserveErrors(`Сегмент ${segment.id}`, segment.reservePercent, segment.reserveFixed));
  }
  for (const cable of project.cables) errors.push(...calculateCable(project, cable).errors);
  return [...new Set(errors)];
}
