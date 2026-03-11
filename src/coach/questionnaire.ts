import { createInterface, Interface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AthleteProfile, DailyCheckin, SportLevel } from './types';

function question(rl: Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

const PROFILE_DIR = join(homedir(), '.garmin-mcp');
const PROFILE_PATH = join(PROFILE_DIR, 'athlete-profile.json');

function ensureDir(): void {
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });
}

function loadProfile(): AthleteProfile | null {
  try {
    if (existsSync(PROFILE_PATH)) {
      return JSON.parse(readFileSync(PROFILE_PATH, 'utf-8')) as AthleteProfile;
    }
  } catch {}
  return null;
}

function saveProfile(profile: AthleteProfile): void {
  ensureDir();
  writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
}

export async function runQuestionnaire(): Promise<{ profile: AthleteProfile; checkin: DailyCheckin }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = async (q: string): Promise<string> => {
    const answer = await question(rl, `\n  ${q}\n  → `);
    return answer.trim();
  };

  const askNumber = async (question: string, min: number, max: number): Promise<number> => {
    while (true) {
      const raw = await ask(`${question} (${min}–${max})`);
      const num = parseFloat(raw);
      if (!isNaN(num) && num >= min && num <= max) return num;
      process.stdout.write(`  Opciones: número entre ${min} y ${max}\n`);
    }
  };

  const askChoice = async <T extends string>(question: string, choices: readonly T[]): Promise<T> => {
    while (true) {
      const raw = await ask(`${question} [${choices.join('/')}]`);
      const match = choices.find(c => c.toLowerCase() === raw.toLowerCase());
      if (match !== undefined) return match;
      process.stdout.write(`  Opciones válidas: ${choices.join(', ')}\n`);
    }
  };

  const askYesNo = async (question: string): Promise<boolean> => {
    const answer = await askChoice(question, ['si', 'no'] as const);
    return answer === 'si';
  };

  let profile = loadProfile();

  if (!profile) {
    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║         CONFIGURACIÓN INICIAL DEL ATLETA          ║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('\n  Solo necesitás hacer esto una vez. Tu perfil se guarda\n  en ~/.garmin-mcp/athlete-profile.json\n');

    console.log('─── 🎯 OBJETIVO ─────────────────────────────────────');
    const eventName = await ask('¿Cuál es tu próximo evento o competencia?');
    const eventDistance = await ask('¿Cuál es la disciplina y distancia? (ej: Maratón 42km, Ironman 70.3)');
    const eventDate = await ask('¿Cuándo es el evento? (YYYY-MM-DD o "sin fecha")');
    const eventPriority = await askChoice('¿Cuál es la prioridad del evento?', ['A', 'B', 'C'] as const);
    const secondaryObjective = await ask('¿Algún objetivo secundario en los próximos 3–6 meses? (Enter para omitir)');

    console.log('\n─── 📅 DISPONIBILIDAD SEMANAL ───────────────────────');
    const runningDays = await askNumber('Running: ¿cuántos días/semana podés entrenar?', 0, 7);
    const runningMaxMinutes = runningDays > 0 ? await askNumber('Running: ¿duración máxima por sesión (minutos)?', 15, 300) : 0;
    const swimmingDays = await askNumber('Natación: ¿cuántos días/semana?', 0, 7);
    const swimmingMaxMinutes = swimmingDays > 0 ? await askNumber('Natación: ¿duración máxima por sesión (minutos)?', 15, 180) : 0;
    const cyclingDays = await askNumber('Ciclismo: ¿cuántos días/semana?', 0, 7);
    const cyclingMaxMinutes = cyclingDays > 0 ? await askNumber('Ciclismo: ¿duración máxima por sesión (minutos)?', 15, 360) : 0;
    const gymDays = await askNumber('Gimnasio/fuerza: ¿cuántos días/semana?', 0, 7);
    const gymMaxMinutes = gymDays > 0 ? await askNumber('Gimnasio: ¿duración máxima por sesión (minutos)?', 20, 120) : 0;
    const restDays = await ask('¿Días absolutamente inamovibles sin entrenamiento? (ej: "lunes y jueves" o "ninguno")');

    console.log('\n─── 🩺 ESTADO FÍSICO ────────────────────────────────');
    const activeInjury = await askYesNo('¿Tenés alguna lesión o dolor activo actualmente?');
    let injuryDescription = '';
    let injuryPain = 0;
    if (activeInjury) {
      injuryDescription = await ask('¿Dónde y qué tipo de dolor/lesión?');
      injuryPain = await askNumber('¿Qué tan fuerte del 0 al 10?', 0, 10);
    }
    const recentInjuries = await ask('¿Tuviste lesiones relevantes en los últimos 6 meses? (fractura, tendinitis, muscular; Enter para omitir)');
    const levelRunning = await askChoice('Nivel de experiencia en running', ['principiante', 'intermedio', 'avanzado'] as const) as SportLevel;
    const levelSwimming = await askChoice('Nivel de experiencia en natación', ['principiante', 'intermedio', 'avanzado'] as const) as SportLevel;
    const levelCycling = await askChoice('Nivel de experiencia en ciclismo', ['principiante', 'intermedio', 'avanzado'] as const) as SportLevel;

    console.log('\n─── ⚖  MÉTRICAS Y LOGEO ─────────────────────────────');
    const weightGoal = await askYesNo('¿Tenés algún objetivo de composición corporal (además del rendimiento)?');
    const logsAllActivities = await askYesNo('¿Logeás TODAS tus actividades en Garmin?');
    const missingDisciplines = !logsAllActivities ? await ask('¿Cuáles disciplinas no logeás?') : '';

    profile = {
      savedAt: new Date().toISOString(),
      eventName,
      eventDistance,
      eventDate,
      eventPriority,
      secondaryObjective,
      runningDays,
      runningMaxMinutes,
      swimmingDays,
      swimmingMaxMinutes,
      cyclingDays,
      cyclingMaxMinutes,
      gymDays,
      gymMaxMinutes,
      restDays,
      activeInjury,
      injuryDescription,
      injuryPain,
      recentInjuries,
      levelRunning,
      levelSwimming,
      levelCycling,
      weightGoal,
      logsAllActivities,
      missingDisciplines,
    };

    saveProfile(profile);
    console.log('\n  ✅ Perfil guardado.');
  } else {
    console.log('\n  ✅ Perfil cargado.');
    console.log(`     Evento: ${profile.eventName} (${profile.eventDistance}) — ${profile.eventDate}`);

    const updateProfile = await askYesNo('¿Querés actualizar algún dato del perfil?');
    if (updateProfile) {
      console.log('\n  1. Evento/Objetivo');
      console.log('  2. Disponibilidad semanal');
      console.log('  3. Estado físico/lesiones');
      const choice = await askNumber('¿Qué campo querés actualizar?', 1, 3);
      if (choice === 1) {
        profile.eventName = await ask('Nombre del evento');
        profile.eventDistance = await ask('Disciplina y distancia');
        profile.eventDate = await ask('Fecha del evento (YYYY-MM-DD)');
        profile.eventPriority = await askChoice('Prioridad', ['A', 'B', 'C'] as const);
      } else if (choice === 2) {
        profile.runningDays = await askNumber('Running: días/semana', 0, 7);
        profile.runningMaxMinutes = profile.runningDays > 0 ? await askNumber('Running: minutos máx/sesión', 15, 300) : 0;
        profile.swimmingDays = await askNumber('Natación: días/semana', 0, 7);
        profile.swimmingMaxMinutes = profile.swimmingDays > 0 ? await askNumber('Natación: minutos máx/sesión', 15, 180) : 0;
        profile.cyclingDays = await askNumber('Ciclismo: días/semana', 0, 7);
        profile.cyclingMaxMinutes = profile.cyclingDays > 0 ? await askNumber('Ciclismo: minutos máx/sesión', 15, 360) : 0;
        profile.gymDays = await askNumber('Gimnasio: días/semana', 0, 7);
        profile.gymMaxMinutes = profile.gymDays > 0 ? await askNumber('Gimnasio: minutos máx/sesión', 20, 120) : 0;
      } else {
        profile.activeInjury = await askYesNo('¿Tenés lesión o dolor activo?');
        if (profile.activeInjury) {
          profile.injuryDescription = await ask('¿Dónde y qué tipo?');
          profile.injuryPain = await askNumber('Intensidad del dolor (0–10)', 0, 10);
        } else {
          profile.injuryDescription = '';
          profile.injuryPain = 0;
        }
        profile.recentInjuries = await ask('¿Lesiones en los últimos 6 meses? (Enter para omitir)');
      }
      saveProfile(profile);
      console.log('\n  ✅ Perfil actualizado.');
    }
  }

  console.log('\n─── 📊 CHECK-IN DEL DÍA ────────────────────────────');
  const today = new Date().toISOString().split('T')[0];

  const weightRaw = await ask('¿Cuánto pesás hoy? (kg, Enter para omitir)');
  const weightParsed = parseFloat(weightRaw);
  const weight = !isNaN(weightParsed) ? weightParsed : null;

  const rpeRaw = await ask('RPE del último entrenamiento (0–10, Enter para omitir)');
  const rpeParsed = parseFloat(rpeRaw);
  const rpeLastSession = !isNaN(rpeParsed) ? rpeParsed : null;

  const sorenessRaw = await ask('Soreness/dolores musculares generales hoy (0–10, Enter para omitir)');
  const sorenessParsed = parseFloat(sorenessRaw);
  const muscleSoreness = !isNaN(sorenessParsed) ? sorenessParsed : null;

  const motivationRaw = await ask('Motivación general hoy (0–10, Enter para omitir)');
  const motivationParsed = parseFloat(motivationRaw);
  const motivation = !isNaN(motivationParsed) ? motivationParsed : null;

  const sleepRaw = await ask('¿Cómo dormiste anoche? (0–10, Enter para omitir)');
  const sleepParsed = parseFloat(sleepRaw);
  const sleepQuality = !isNaN(sleepParsed) ? sleepParsed : null;

  const newPainOrIssue = await ask('¿Algún dolor nuevo o molestia hoy? (Enter para omitir)');

  rl.close();

  return {
    profile,
    checkin: {
      date: today,
      weight,
      rpeLastSession,
      muscleSoreness,
      motivation,
      sleepQuality,
      newPainOrIssue,
    },
  };
}
