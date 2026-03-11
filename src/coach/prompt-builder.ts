import type { AthleteProfile, DailyCheckin, GarminSummary } from './types';

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function formatDays(indices: number[]): string {
  if (!indices || indices.length === 0) return 'no especificado';
  return indices.sort((a, b) => a - b).map(i => DAY_NAMES[i] ?? `día ${i}`).join(', ');
}

export const COACH_SYSTEM_PROMPT = `Eres un coach experto de resistencia (running y triatlón) y fuerza, con profundo conocimiento de:
- Teoría del entrenamiento: periodización, gestión de carga, progresión, tapering
- Fisiología del ejercicio: zonas de FC, umbral de lactato, VO2max, adaptaciones aeróbicas
- Prevención de lesiones y gestión de RED-S
- Nutrición deportiva aplicada al entrenamiento de resistencia

IDIOMA: Responde siempre en español.

REGLAS DE PLANIFICACIÓN:
- Plan para las PRÓXIMAS DOS SEMANAS, sesión por sesión, usando los días disponibles indicados por el atleta
- Cada sesión incluye: deporte, duración, set principal detallado, guía de intensidad (zonas FC/ritmo/potencia), propósito, RPE objetivo, entrada en calor y vuelta a la calma
- Máximo 2–3 sesiones clave/semana; alternancia duro/fácil; sesión larga bien ubicada
- Fuerza integrada para prevención de lesiones y rendimiento
- Si dolor >3/10 o historial de fractura por estrés: rampa gradual, sin sesiones de impacto alto
- Mencioná principios de combustible en sesiones clave (carbos pre/post, proteína)
- Sin déficits calóricos que comprometan el entrenamiento
- Usá el historial de 4 años para identificar el pico máximo del atleta y orientar el plan hacia alcanzarlo y superarlo

FORMATO DE SALIDA (seguir exactamente este orden):
1. **RESUMEN DE DATOS GARMIN** — ventana analizada, métricas disponibles/faltantes
2. **STATUS DEL ATLETA** — Fitness / Fatiga / Readiness / Riesgo lesión (semáforo + criterios)
3. **DIAGNÓSTICO COACH** — evaluación narrativa + análisis de tendencia y distancia al pico histórico
4. **PLAN — SEMANA 1** — layout día a día con todos los campos de cada sesión
5. **PLAN — SEMANA 2** — idem
6. **REGLAS DE AJUSTE** — qué cambiar si HRV bajo, soreness alto, calor, sesión perdida
7. **3 FOCOS DE LAS DOS SEMANAS** — prioridades top

Luego del punto 7, incluí OBLIGATORIAMENTE el siguiente bloque JSON (sin texto adicional entre las etiquetas):

[PLAN_JSON]
{"semana1":{"inicio":"YYYY-MM-DD","dias":[{"dia":"Lunes","fecha":"YYYY-MM-DD","descanso":false,"sesiones":[{"deporte":"running","emoji":"🏃","titulo":"Título breve","duracion":"45 min","intensidad":"Zona 2 (130-145 bpm)","rpe":3,"detalle":"Descripción completa de la sesión incluyendo calentamiento, set principal y vuelta a la calma."}]}]},"semana2":{"inicio":"YYYY-MM-DD","dias":[...]}}
[/PLAN_JSON]

Valores válidos para "deporte": running, cycling, swimming, strength, rest
Emojis por deporte: running=🏃, cycling=🚴, swimming=🏊, strength=🏋️, rest=🛌
Si el día es descanso, usá "descanso":true y "sesiones":[]
Sé firme y práctico. Si los datos son insuficientes, indicá supuestos claramente y continuá.`;

export function buildUserMessage(
  profile: AthleteProfile,
  checkin: DailyCheckin,
  garmin: GarminSummary,
  historyContext?: string,
): string {
  const lines: string[] = [];

  lines.push('# PERFIL DEL ATLETA\n');
  lines.push(`- **Evento:** ${profile.eventName} — ${profile.eventDistance}`);
  lines.push(`- **Fecha del evento:** ${profile.eventDate}`);
  lines.push(`- **Prioridad:** ${profile.eventPriority}`);
  if (profile.secondaryObjective) lines.push(`- **Objetivo secundario:** ${profile.secondaryObjective}`);

  lines.push('\n## Disponibilidad semanal');
  if (profile.runningDays > 0) {
    lines.push(`- Running: ${profile.runningDays} días/semana, máx ${profile.runningMaxMinutes} min/sesión`);
    lines.push(`  Días disponibles: ${formatDays(profile.runningAvailableDays ?? [])}`);
  }
  if (profile.swimmingDays > 0) {
    lines.push(`- Natación: ${profile.swimmingDays} días/semana, máx ${profile.swimmingMaxMinutes} min/sesión`);
    lines.push(`  Días disponibles: ${formatDays(profile.swimmingAvailableDays ?? [])}`);
  }
  if (profile.cyclingDays > 0) {
    lines.push(`- Ciclismo: ${profile.cyclingDays} días/semana, máx ${profile.cyclingMaxMinutes} min/sesión`);
    lines.push(`  Días disponibles: ${formatDays(profile.cyclingAvailableDays ?? [])}`);
  }
  if (profile.gymDays > 0) {
    lines.push(`- Gimnasio: ${profile.gymDays} días/semana, máx ${profile.gymMaxMinutes} min/sesión`);
    lines.push(`  Días disponibles: ${formatDays(profile.gymAvailableDays ?? [])}`);
  }
  lines.push(`- Días sin entrenamiento: ${profile.restDays || 'no especificado'}`);

  lines.push('\n## Nivel de experiencia');
  lines.push(`- Running: ${profile.levelRunning} | Natación: ${profile.levelSwimming} | Ciclismo: ${profile.levelCycling}`);

  lines.push('\n## Estado físico');
  if (profile.activeInjury) {
    lines.push(`- ⚠ LESIÓN ACTIVA: ${profile.injuryDescription} — dolor ${profile.injuryPain}/10`);
  } else {
    lines.push('- Sin lesión activa');
  }
  if (profile.recentInjuries) lines.push(`- Lesiones recientes (últimos 6 meses): ${profile.recentInjuries}`);
  if (profile.weightGoal) lines.push('- Tiene objetivo de composición corporal');
  if (!profile.logsAllActivities) {
    lines.push(`- ⚠ No logea todas las actividades en Garmin. Disciplinas sin registrar: ${profile.missingDisciplines}`);
  }

  lines.push('\n# CHECK-IN DEL DÍA\n');
  lines.push(`- Fecha: ${checkin.date}`);
  if (checkin.weight !== null) lines.push(`- Peso: ${checkin.weight} kg`);
  if (checkin.rpeLastSession !== null) lines.push(`- RPE último entrenamiento: ${checkin.rpeLastSession}/10`);
  if (checkin.muscleSoreness !== null) lines.push(`- Soreness muscular: ${checkin.muscleSoreness}/10`);
  if (checkin.motivation !== null) lines.push(`- Motivación: ${checkin.motivation}/10`);
  if (checkin.sleepQuality !== null) lines.push(`- Calidad de sueño percibida: ${checkin.sleepQuality}/10`);
  if (checkin.newPainOrIssue) lines.push(`- Dolor/molestia nueva: ${checkin.newPainOrIssue}`);

  if (historyContext) {
    lines.push('\n# HISTORIAL DE 4 AÑOS (contexto completo)\n');
    lines.push(historyContext);
    lines.push('\n*Usar este historial para: identificar tendencias, calcular distancia al pico máximo, y orientar la planificación de las próximas semanas.*\n');
  }

  lines.push('\n# DATOS DE GARMIN RECIENTES\n');
  lines.push(`*Ventana: últimos 60 días — consulta: ${garmin.fetchDate}*\n`);

  if (garmin.errors.length > 0) {
    lines.push('## ⚠ Métricas no disponibles');
    garmin.errors.forEach(e => lines.push(`- ${e}`));
  }

  lines.push('\n## Rendimiento');
  if (garmin.vo2max !== null) lines.push(`- VO2Max estimado: ${garmin.vo2max} ml/kg/min`);
  if (garmin.trainingStatus) lines.push(`- Training Status: ${JSON.stringify(garmin.trainingStatus)}`);
  if (garmin.trainingReadiness) lines.push(`- Training Readiness: ${JSON.stringify(garmin.trainingReadiness)}`);
  if (garmin.racePredictions) lines.push(`- Race Predictions: ${JSON.stringify(garmin.racePredictions)}`);
  if (garmin.lactateThreshold) lines.push(`- Umbral de Lactato: ${JSON.stringify(garmin.lactateThreshold)}`);
  if (garmin.personalRecords) lines.push(`- Récords personales: ${JSON.stringify(garmin.personalRecords)}`);

  lines.push('\n## Recuperación (últimos 7 días)');
  if (garmin.avgRestingHR7d !== null) lines.push(`- FC reposo promedio: ${garmin.avgRestingHR7d} bpm`);
  if (garmin.restingHRTrend.length > 0) lines.push(`- Tendencia FC reposo: [${garmin.restingHRTrend.join(', ')}]`);
  if (garmin.hrvToday !== null) lines.push(`- HRV hoy: ${garmin.hrvToday} ms`);
  if (garmin.avgBodyBattery7d !== null) lines.push(`- Body Battery promedio 7d: ${garmin.avgBodyBattery7d}`);
  if (garmin.latestWeight !== null) lines.push(`- Último peso en Garmin: ${garmin.latestWeight} kg`);
  if (garmin.sleepRaw) lines.push(`- Sueño últimos 7d: ${JSON.stringify(garmin.sleepRaw)}`);

  if (garmin.weeklyVolumes.length > 0) {
    lines.push('\n## Volúmenes semanales (últimas 9 semanas)');
    lines.push('| Semana | Run km | Run min | Bike km | Swim m | Gym min | Total min |');
    lines.push('|--------|--------|---------|---------|--------|---------|-----------|');
    garmin.weeklyVolumes.slice(-9).forEach(w => {
      lines.push(`| ${w.weekStart} | ${w.runningKm} | ${w.runningMin} | ${w.cyclingKm} | ${w.swimmingM} | ${w.strengthMin} | ${w.totalMin} |`);
    });
  }

  if (garmin.activities.length > 0) {
    lines.push('\n## Últimas 25 actividades');
    lines.push('| Fecha | Tipo | Km | Min | FC prom | Z1 | Z2 | Z3 | Z4 | Z5 |');
    lines.push('|-------|------|----|----|---------|----|----|----|----|-----|');
    garmin.activities.slice(-25).forEach(a => {
      lines.push(`| ${a.date} | ${a.type} | ${a.distanceKm ?? '-'} | ${a.durationMin} | ${a.avgHR ?? '-'} | ${a.zone1Min} | ${a.zone2Min} | ${a.zone3Min} | ${a.zone4Min} | ${a.zone5Min} |`);
    });
  }

  lines.push('\n---');
  lines.push(`\nFecha actual: ${garmin.fetchDate}. Generá el análisis completo y el plan de DOS SEMANAS detallado, incluyendo el bloque [PLAN_JSON] al final.`);

  return lines.join('\n');
}
