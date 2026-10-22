import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../src/model.js';

export interface PdfRecord { id: string; name: string; bytes: Buffer }
export class Store {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'projects.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pdfs (id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes BLOB NOT NULL);`);
  }
  list() { return this.db.prepare('SELECT id, name, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC, id').all(); }
  project(id: string): Project | undefined {
    const row = this.db.prepare('SELECT body FROM projects WHERE id=?').get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  save(p: Project) { this.db.prepare('INSERT INTO projects(id,name,updated_at,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,body=excluded.body').run(p.id, p.name, p.updatedAt, JSON.stringify(p)); }
  deleteProject(id: string) { this.db.prepare('DELETE FROM projects WHERE id=?').run(id); }
  pdf(id: string): PdfRecord | undefined {
    const row = this.db.prepare('SELECT id,name,bytes FROM pdfs WHERE id=?').get(id) as { id: string; name: string; bytes: Uint8Array } | undefined;
    return row ? { ...row, bytes: Buffer.from(row.bytes) } : undefined;
  }
  hasPdf(id: string): boolean { return !!this.db.prepare('SELECT id FROM pdfs WHERE id=?').get(id); }
  savePdf(pdf: PdfRecord) { this.db.prepare('INSERT INTO pdfs(id,name,bytes) VALUES(?,?,?)').run(pdf.id, pdf.name, pdf.bytes); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
