import { openDB, type DBSchema } from 'idb';
import type { CountSession } from '../types/counting';
interface CountAiDB extends DBSchema { sessions: { key: string; value: CountSession; indexes: { 'by-createdAt': string } } }
const dbPromise = openDB<CountAiDB>('countai-local', 1, { upgrade(db) { const store = db.createObjectStore('sessions', { keyPath: 'id' }); store.createIndex('by-createdAt', 'createdAt'); } });
export async function saveSession(session: CountSession): Promise<void> { (await dbPromise).put('sessions', session); }
export async function listSessions(): Promise<CountSession[]> { return (await dbPromise).getAllFromIndex('sessions', 'by-createdAt').then(v => v.reverse()); }
export async function deleteSession(id: string): Promise<void> { (await dbPromise).delete('sessions', id); }
