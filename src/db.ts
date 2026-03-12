import pg from 'pg';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AthleteProfile } from './coach/types';
import type { StoredPlan } from './coach/plan-store';

const { Pool } = pg;

const rawUrl = process.env.DATABASE_URL ?? '';
const sslConfig = rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1')
  ? false
  : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: rawUrl.replace(/[?&]ssl=\w+/gi, ''),
  ssl: sslConfig,
  max: 10,
});

function getEncKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY env var required');
  return key.length === 64 && /^[0-9a-f]+$/i.test(key)
    ? Buffer.from(key, 'hex')
    : scryptSync(key, 'garmin-coach-salt-v1', 32);
}

function encrypt(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(data: string): string {
  const [ivHex, tagHex, encHex] = data.split(':');
  const decipher = createDecipheriv('aes-256-gcm', getEncKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

export type DbSession = {
  userId: string;
  token: string;
  email: string;
  password: string;
  anthropicKey: string;
};

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      garmin_password_enc TEXT NOT NULL,
      anthropic_key_enc TEXT NOT NULL,
      session_token TEXT UNIQUE,
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS athlete_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      profile JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS training_plans (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan JSONB NOT NULL,
      saved_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS garmin_history_cache (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      context_md TEXT NOT NULL,
      generated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS generated_analyses (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, type)
    );
    CREATE TABLE IF NOT EXISTS garmin_tokens (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      oauth1_token JSONB,
      oauth2_token JSONB,
      garmin_profile JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.error('[db] Tables ready');
}

export async function loadAllSessions(): Promise<DbSession[]> {
  const res = await pool.query<{
    id: string; email: string; garmin_password_enc: string;
    anthropic_key_enc: string; session_token: string;
  }>(`SELECT id, email, garmin_password_enc, anthropic_key_enc, session_token
      FROM users
      WHERE session_token IS NOT NULL
        AND last_seen > NOW() - INTERVAL '30 days'`);
  return res.rows.map(r => ({
    userId: r.id,
    token: r.session_token,
    email: r.email,
    password: decrypt(r.garmin_password_enc),
    anthropicKey: decrypt(r.anthropic_key_enc),
  }));
}

export async function upsertSession(email: string, password: string, anthropicKey: string): Promise<DbSession> {
  const token = randomUUID();
  const res = await pool.query<{ id: string }>(`
    INSERT INTO users (email, garmin_password_enc, anthropic_key_enc, session_token, last_seen)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (email) DO UPDATE SET
      garmin_password_enc = EXCLUDED.garmin_password_enc,
      anthropic_key_enc   = EXCLUDED.anthropic_key_enc,
      session_token       = EXCLUDED.session_token,
      last_seen           = NOW()
    RETURNING id
  `, [email, encrypt(password), encrypt(anthropicKey), token]);
  return { userId: res.rows[0].id, token, email, password, anthropicKey };
}

export async function touchSession(userId: string): Promise<void> {
  await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
}

export async function clearSession(userId: string): Promise<void> {
  await pool.query('UPDATE users SET session_token = NULL WHERE id = $1', [userId]);
}

export async function dbGetProfile(userId: string): Promise<AthleteProfile | null> {
  const res = await pool.query<{ profile: AthleteProfile }>(
    'SELECT profile FROM athlete_profiles WHERE user_id = $1', [userId],
  );
  return res.rows[0]?.profile ?? null;
}

export async function dbSaveProfile(userId: string, profile: AthleteProfile): Promise<void> {
  await pool.query(`
    INSERT INTO athlete_profiles (user_id, profile, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (user_id) DO UPDATE SET profile = $2::jsonb, updated_at = NOW()
  `, [userId, JSON.stringify(profile)]);
}

export async function dbGetPlan(userId: string): Promise<StoredPlan | null> {
  const res = await pool.query<{ plan: StoredPlan }>(
    'SELECT plan FROM training_plans WHERE user_id = $1', [userId],
  );
  return res.rows[0]?.plan ?? null;
}

export async function dbSavePlan(userId: string, plan: Record<string, unknown>): Promise<void> {
  const data = { savedAt: new Date().toISOString(), ...plan };
  await pool.query(`
    INSERT INTO training_plans (user_id, plan, saved_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (user_id) DO UPDATE SET plan = $2::jsonb, saved_at = NOW()
  `, [userId, JSON.stringify(data)]);
}

export async function dbDeletePlan(userId: string): Promise<void> {
  await pool.query('DELETE FROM training_plans WHERE user_id = $1', [userId]);
}

export async function dbGetChatHistory(userId: string): Promise<Array<{ role: string; content: string }>> {
  const res = await pool.query<{ role: string; content: string }>(
    'SELECT role, content FROM chat_messages WHERE user_id = $1 ORDER BY created_at ASC', [userId],
  );
  return res.rows;
}

export async function dbSaveChatHistory(userId: string, messages: Array<{ role: string; content: string }>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chat_messages WHERE user_id = $1', [userId]);
    for (const m of messages) {
      await client.query(
        'INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)',
        [userId, m.role, m.content],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function dbDeleteChatHistory(userId: string): Promise<void> {
  await pool.query('DELETE FROM chat_messages WHERE user_id = $1', [userId]);
}

export async function dbHistoryExists(userId: string): Promise<boolean> {
  const res = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM garmin_history_cache WHERE user_id = $1) AS exists', [userId],
  );
  return res.rows[0].exists;
}

export async function dbGetHistoryCache(userId: string): Promise<string | null> {
  const res = await pool.query<{ context_md: string }>(
    'SELECT context_md FROM garmin_history_cache WHERE user_id = $1', [userId],
  );
  return res.rows[0]?.context_md ?? null;
}

export async function dbSaveHistoryCache(userId: string, contextMd: string): Promise<void> {
  await pool.query(`
    INSERT INTO garmin_history_cache (user_id, context_md, generated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id) DO UPDATE SET context_md = $2, generated_at = NOW()
  `, [userId, contextMd]);
}

export async function dbGetAnalysis(userId: string, type: string): Promise<string | null> {
  const res = await pool.query<{ content: string }>(
    'SELECT content FROM generated_analyses WHERE user_id = $1 AND type = $2', [userId, type],
  );
  return res.rows[0]?.content ?? null;
}

export async function dbSaveAnalysis(userId: string, type: string, content: string): Promise<void> {
  await pool.query(`
    INSERT INTO generated_analyses (user_id, type, content, created_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (user_id, type) DO UPDATE SET content = $3, created_at = NOW()
  `, [userId, type, content]);
}

export async function populateTokenDir(userId: string, dir: string): Promise<void> {
  const res = await pool.query<{
    oauth1_token: unknown; oauth2_token: unknown; garmin_profile: unknown;
  }>('SELECT oauth1_token, oauth2_token, garmin_profile FROM garmin_tokens WHERE user_id = $1', [userId]);
  if (!res.rows[0]) return;
  mkdirSync(dir, { recursive: true });
  const { oauth1_token: o1, oauth2_token: o2, garmin_profile: p } = res.rows[0];
  if (o1) writeFileSync(join(dir, 'oauth1_token.json'), JSON.stringify(o1));
  if (o2) writeFileSync(join(dir, 'oauth2_token.json'), JSON.stringify(o2));
  if (p) writeFileSync(join(dir, 'profile.json'), JSON.stringify(p));
}

export async function saveTokensFromDir(userId: string, dir: string): Promise<void> {
  const read = (f: string) => {
    try { return existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf-8')) : null; } catch { return null; }
  };
  const o1 = read('oauth1_token.json');
  const o2 = read('oauth2_token.json');
  const p = read('profile.json');
  if (!o1 && !o2) return;
  await pool.query(`
    INSERT INTO garmin_tokens (user_id, oauth1_token, oauth2_token, garmin_profile, updated_at)
    VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      oauth1_token   = $2::jsonb,
      oauth2_token   = $3::jsonb,
      garmin_profile = $4::jsonb,
      updated_at     = NOW()
  `, [userId, o1 ? JSON.stringify(o1) : null, o2 ? JSON.stringify(o2) : null, p ? JSON.stringify(p) : null]);
}
