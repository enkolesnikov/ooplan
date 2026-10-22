import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import * as XLSX from 'xlsx';
import type { Project } from '../src/model.js';
import { calculateCable, specifications, validateProject } from '../src/engine.js';
import { ApiError } from './validation.js';

type Cell = string | number | boolean | null;
export interface ExportSheet { name: string; rows: Cell[][] }
export function exportSheets(project: Project): ExportSheet[] {
  const specs = specifications(project);
  const journal: Cell[][] = [['Номер', 'Наименование', 'Марка', 'Назначение', 'От', 'До', 'Трасса (ID)', 'Количество', 'Геометрия, м', 'Запас трассы, м', 'Запас кабеля, м', 'Запас концов, м', 'Итог одного, м', 'Итог с количеством, м', 'Расчёт полный', 'Предупреждения', 'Примечание']];
  for (const cable of project.cables) {
    const result = calculateCable(project, cable);
    const name = (id: string) => project.equipment.find(e => e.id === id)?.number || id;
    journal.push([cable.number, cable.name, cable.brand, cable.purpose, name(cable.fromId), name(cable.toId), cable.segmentIds.join(' → '), cable.quantity, result.geometry, result.routeReserve, result.cableReserve, result.endReserve, result.total, result.total === null ? null : result.total * cable.quantity, result.complete, result.errors.join('; '), cable.note]);
  }
  const sheets: ExportSheet[] = [
    { name: 'Кабельный журнал', rows: journal },
    { name: 'Оборудование', rows: [['Тип', 'Модель', 'Этаж', 'Количество'], ...specs.equipment.map(r => [r.type, r.model, r.floor, r.quantity])] },
    { name: 'Кабели', rows: [['Марка', 'Количество линий', 'Геометрия, м', 'Итого, м'], ...specs.cables.map(r => [r.brand, r.lines, r.geometry, r.total])] },
    { name: 'Инфраструктура', rows: [['Тип', 'Длина, м', 'Сегментов', 'Кабелей'], ...specs.infrastructure.map(r => [r.type, r.length, r.segments, r.cables])] },
    { name: 'Предупреждения', rows: [['Предупреждение'], ...[...new Set([...validateProject(project), ...specs.errors])].map(e => [e])] },
  ];
  return sheets;
}
function csvCell(cell: Cell): string {
  let value = cell === null ? '' : String(cell);
  // Spreadsheet formula injection is prevented for user-entered text.
  if (typeof cell === 'string' && /^[=+\-@\t\r]/.test(value)) value = `'${value}`;
  return `"${value.replaceAll('"', '""')}"`;
}
export function csv(sheets: ExportSheet[]): Buffer {
  return Buffer.from('\uFEFF' + sheets.map(s => [[s.name], ...s.rows].map(row => row.map(csvCell).join(';')).join('\r\n')).join('\r\n\r\n'), 'utf8');
}
export function xlsx(sheets: ExportSheet[]): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
export const fontCandidates = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  '/system/fonts/Roboto-Regular.ttf',
  '/system/fonts/NotoSans-Regular.ttf',
];
/** PDF export requires a system TTF supporting Cyrillic; no silent broken glyphs. */
export function pdf(project: Project, sheets: ExportSheet[]): Promise<Buffer> {
  const font = [process.env.PDF_FONT_PATH, ...fontCandidates].find((path): path is string => !!path && existsSync(path));
  if (!font) throw new ApiError(503, 'Для PDF требуется системный TTF-шрифт с кириллицей. Установите DejaVu Sans или задайте PDF_FONT_PATH. CSV и XLSX доступны.');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    try {
      doc.font(font).fontSize(16).text(project.name || 'Проект');
      doc.fontSize(9).text(`Дата экспорта: ${new Date().toISOString()}`);
      for (const sheet of sheets) {
        doc.addPage(); doc.fontSize(15).text(sheet.name); doc.moveDown(0.5);
        // Vertical records retain all journal fields on readable PDF pages.
        const [headers, ...rows] = sheet.rows;
        if (!rows.length) doc.fontSize(10).text('Нет записей');
        for (const row of rows) {
          doc.fontSize(9).text(row.map((value, i) => `${headers[i]}: ${value === null ? 'не определено' : value}`).join('  |  '), { width: 780 });
          doc.moveDown(0.7);
        }
      }
      doc.end();
    } catch (error) { reject(error); }
  });
}
