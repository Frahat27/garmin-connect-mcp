import type { AthleteProfile, DailyCheckin, GarminSummary } from './types';
import type { StoredPlan } from './plan-store';
import { planToContext, addDays } from './plan-store';

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

Luego del punto 7, incluí OBLIGATORIAMENTE el siguiente bloque JSON. IMPORTANTE: el JSON va DIRECTAMENTE entre las etiquetas, sin backticks, sin bloques de código, sin texto adicional:

[PLAN_JSON]
{"semana1":{"inicio":"YYYY-MM-DD","dias":[{"dia":"Lunes","fecha":"YYYY-MM-DD","descanso":false,"sesiones":[{"deporte":"running","emoji":"🏃","titulo":"Título breve","duracion":"45 min","intensidad":"Zona 2 (130-145 bpm)","rpe":3,"detalle":"Descripción completa de la sesión incluyendo calentamiento, set principal y vuelta a la calma."}]}]},"semana2":{"inicio":"YYYY-MM-DD","dias":[...]}}
[/PLAN_JSON]

Valores válidos para "deporte": running, cycling, swimming, strength, rest
Emojis por deporte: running=🏃, cycling=🚴, swimming=🏊, strength=🏋️, rest=🛌
Si el día es descanso, usá "descanso":true y "sesiones":[]
El bloque [PLAN_JSON] debe tener los 14 días completos (7 por semana).
Sé firme y práctico. Si los datos son insuficientes, indicá supuestos claramente y continuá.`;

export const REVIEW_SYSTEM_PROMPT = `Eres un coach experto de resistencia y fuerza.

MODO: REVISIÓN DE CUMPLIMIENTO DE PLAN
Tu tarea es cruzar el plan de entrenamiento de las últimas 2 semanas con las actividades reales registradas en Garmin, y puntuar la ejecución.

IDIOMA: Responde siempre en español.

INSTRUCCIONES:
- Cruzá cada sesión planificada con la actividad más cercana en fecha y tipo en Garmin
- Evaluá calidad de ejecución: duración, intensidad (FC/zonas), distancia vs objetivo
- Status: "done" = cumplido ≥80% de lo planificado | "partial" = 40-79% | "missed" = <40% o no registrado
- Score 0-10: calidad de ejecución relativa al objetivo (10 = perfecto)

FORMATO DE SALIDA:
1. **ADHERENCIA GLOBAL** — porcentaje de cumplimiento total + desglose por disciplina
2. **REVISIÓN SESIÓN POR SESIÓN** — tabla: Día | Sesión planificada | Realidad (Garmin) | Status | Score | Observación
3. **DIAGNÓSTICO** — qué funcionó bien, qué no, causas probables
4. **PUNTOS PARA EL PRÓXIMO BLOQUE** — ajustes concretos basados en la realidad

Luego del punto 4, incluí OBLIGATORIAMENTE el bloque [REVIEW_JSON]. El JSON va DIRECTAMENTE entre las etiquetas, sin backticks, sin bloques de código:

[REVIEW_JSON]
{"adherencia":85,"semana1":{"inicio":"YYYY-MM-DD","dias":[{"dia":"Lunes","fecha":"YYYY-MM-DD","descanso":false,"sesiones":[{"deporte":"running","emoji":"🏃","titulo":"Título","duracion":"45 min","intensidad":"Zona 2","rpe":3,"detalle":"Plan original","status":"done","actividad_real":"Corrí 48 min avg 137bpm Z2","score":9}]}]},"semana2":{"inicio":"YYYY-MM-DD","dias":[...]}}
[/REVIEW_JSON]

El bloque [REVIEW_JSON] debe incluir los 14 días completos con todos los campos originales + status, actividad_real y score en cada sesión planificada.`;

export function buildChatSystemPrompt(
  profile: AthleteProfile,
  checkin: DailyCheckin,
  plan: StoredPlan | null,
  today: string,
): string {
  const sportLines: string[] = [];
  if (profile.runningDays > 0) sportLines.push(`Running: ${profile.runningDays}d/sem, máx ${profile.runningMaxMinutes}min — días: ${formatDays(profile.runningAvailableDays ?? [])}`);
  if (profile.swimmingDays > 0) sportLines.push(`Natación: ${profile.swimmingDays}d/sem, máx ${profile.swimmingMaxMinutes}min — días: ${formatDays(profile.swimmingAvailableDays ?? [])}`);
  if (profile.cyclingDays > 0) sportLines.push(`Ciclismo: ${profile.cyclingDays}d/sem, máx ${profile.cyclingMaxMinutes}min — días: ${formatDays(profile.cyclingAvailableDays ?? [])}`);
  if (profile.gymDays > 0) sportLines.push(`Gimnasio: ${profile.gymDays}d/sem, máx ${profile.gymMaxMinutes}min — días: ${formatDays(profile.gymAvailableDays ?? [])}`);

  const injuryLine = profile.activeInjury
    ? `⚠ LESIÓN ACTIVA: ${profile.injuryDescription} — dolor ${profile.injuryPain}/10`
    : 'Sin lesión activa';

  const checkinParts = [
    checkin.muscleSoreness != null ? `soreness ${checkin.muscleSoreness}/10` : null,
    checkin.motivation != null ? `motivación ${checkin.motivation}/10` : null,
    checkin.sleepQuality != null ? `sueño ${checkin.sleepQuality}/10` : null,
    checkin.newPainOrIssue ? `dolor nuevo: ${checkin.newPainOrIssue}` : null,
  ].filter(Boolean).join(', ');

  const planContext = plan ? planToContext(plan) : 'Sin plan activo — el atleta aún no generó un plan.';

  return `Sos Coach Shalo Gazna, triatleta experimentado y coach personal de resistencia y fuerza. Tenés acceso al plan de entrenamiento actual del atleta y a sus datos de perfil.

MODO: CHAT INTERACTIVO
Respondés preguntas, ajustás el plan y dás orientación técnica en tiempo real. Sos directo, motivador y preciso. Respondés siempre en español.

SALUDO INICIAL: Si este es el primer mensaje de la conversación (no hay historial previo), comenzá tu respuesta SIEMPRE con: "Hola, ¿cómo estás? Coach Shalo Gazna te saluda. 💪" y luego respondé normalmente.

FECHA ACTUAL: ${today}

PERFIL DEL ATLETA:
- Evento: ${profile.eventName} — ${profile.eventDistance}
- Fecha del evento: ${profile.eventDate} | Prioridad: ${profile.eventPriority}
${sportLines.map(l => `- ${l}`).join('\n')}
- Estado físico: ${injuryLine}
${profile.recentInjuries ? `- Lesiones recientes: ${profile.recentInjuries}` : ''}
- Nivel: Running ${profile.levelRunning} | Natación ${profile.levelSwimming} | Ciclismo ${profile.levelCycling}

CHECK-IN DE HOY: ${checkinParts || 'sin datos'}

PLAN ACTUAL:
${planContext}

CAPACIDADES:
1. Respondés preguntas sobre el plan, la fisiología, la nutrición y la recuperación.
2. Ajustás sesiones individuales: cambiás día, modificás volumen/intensidad, reemplazás disciplina.
3. Si el atleta pide mover/eliminar/agregar/modificar una sesión, regenerás el plan completo modificado.
4. Cuando hagás un cambio al plan, SIEMPRE incluí el plan COMPLETO (las 14 sesiones con los 14 días) en el bloque [PLAN_JSON] al final de tu respuesta. No incluyas el bloque si no hay cambio al plan.

REGLAS DE MODIFICACIÓN:
- Conservá la carga global semanal al mover sesiones (no acumulés carga en un solo día).
- Respetá los días disponibles del atleta salvo que él mismo pida una excepción.
- Si hay lesión activa, no aumentés impacto ni intensidad.
- Al mover la sesión larga, asegurate de que haya al menos 48h de separación con sesiones clave.
- Explicá brevemente el criterio del ajuste antes de mostrar los cambios.

FORMATO DE SALIDA:
- Respuestas cortas y concretas (máximo 3–4 párrafos salvo que el atleta pida más detalle).
- Si modificás el plan, describí el cambio en 1–2 oraciones y luego el bloque [PLAN_JSON].
- Nunca uses backticks alrededor del bloque JSON.
- El bloque [PLAN_JSON] va al final de la respuesta, sin texto después de [/PLAN_JSON].

Cuando debas incluir el plan actualizado, usá exactamente este formato:

[PLAN_JSON]
{"semana1":{"inicio":"YYYY-MM-DD","dias":[{"dia":"Lunes","fecha":"YYYY-MM-DD","descanso":false,"sesiones":[{"deporte":"running","emoji":"🏃","titulo":"Título breve","duracion":"45 min","intensidad":"Zona 2 (130-145 bpm)","rpe":3,"detalle":"Descripción completa de la sesión."}]}]},"semana2":{"inicio":"YYYY-MM-DD","dias":[...]}}
[/PLAN_JSON]

Valores válidos para "deporte": running, cycling, swimming, strength, rest
Emojis por deporte: running=🏃, cycling=🚴, swimming=🏊, strength=🏋️, rest=🛌
Si el día es descanso, usá "descanso":true y "sesiones":[]`;
}

export const PLANNING_WITH_REVIEW_SYSTEM_PROMPT = `Eres un coach experto de resistencia (running y triatlón) y fuerza.

MODO: REVISIÓN + NUEVO PLAN
Estás a pocos días del fin del plan actual. Tu tarea es:
1. Hacer una revisión de cumplimiento de las últimas 2 semanas
2. Generar el nuevo plan para las siguientes 2 semanas basado en la realidad observada

IDIOMA: Responde siempre en español.

REGLAS DE PLANIFICACIÓN:
- Plan para las PRÓXIMAS DOS SEMANAS, sesión por sesión
- Ajustá la carga según lo que realmente ocurrió (no lo que estaba planificado)
- Cada sesión incluye: deporte, duración, set principal detallado, guía de intensidad, propósito, RPE objetivo, entrada en calor y vuelta a la calma
- Máximo 2–3 sesiones clave/semana; alternancia duro/fácil
- Usá el historial de 4 años para orientar el plan hacia el pico máximo del atleta

FORMATO DE SALIDA:
1. **REVISIÓN DE LAS 2 SEMANAS ANTERIORES** — adherencia %, sesiones clave cumplidas/perdidas, tabla de sesiones con status y score
2. **RESUMEN DE DATOS GARMIN** — métricas disponibles/faltantes
3. **STATUS DEL ATLETA** — Fitness / Fatiga / Readiness / Riesgo lesión
4. **DIAGNÓSTICO COACH** — ajustes para el nuevo bloque basados en la realidad
5. **PLAN — SEMANA 1** — layout día a día
6. **PLAN — SEMANA 2** — idem
7. **REGLAS DE AJUSTE** — qué cambiar si HRV bajo, soreness alto, etc.
8. **3 FOCOS DE LAS DOS SEMANAS** — prioridades top

Luego del punto 8, incluí OBLIGATORIAMENTE el bloque [PLAN_JSON]. El JSON va DIRECTAMENTE entre las etiquetas, sin backticks, sin bloques de código:

[PLAN_JSON]
{"semana1":{"inicio":"YYYY-MM-DD","dias":[{"dia":"Lunes","fecha":"YYYY-MM-DD","descanso":false,"sesiones":[{"deporte":"running","emoji":"🏃","titulo":"Título breve","duracion":"45 min","intensidad":"Zona 2 (130-145 bpm)","rpe":3,"detalle":"Descripción completa de la sesión."}]}]},"semana2":{"inicio":"YYYY-MM-DD","dias":[...]}}
[/PLAN_JSON]

El bloque [PLAN_JSON] debe tener los 14 días completos (7 por semana).
Sé firme y práctico.`;

export function buildUserMessage(
  profile: AthleteProfile,
  checkin: DailyCheckin,
  garmin: GarminSummary,
  historyContext?: string,
  previousPlan?: StoredPlan,
): string {
  const lines: string[] = [];

  if (previousPlan) {
    lines.push('# PLAN DE LAS ÚLTIMAS 2 SEMANAS (contexto para revisión)\n');
    lines.push(planToContext(previousPlan));
    lines.push('\n---\n');
  }

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
  if (previousPlan) {
    lines.push(`\nFecha actual: ${garmin.fetchDate}. Revisá el cumplimiento del plan anterior y generá el nuevo plan de DOS SEMANAS con el bloque [PLAN_JSON] al final.`);
  } else {
    lines.push(`\nFecha actual: ${garmin.fetchDate}. Generá el análisis completo y el plan de DOS SEMANAS detallado, incluyendo el bloque [PLAN_JSON] al final.`);
  }

  return lines.join('\n');
}

export function buildReviewMessage(
  profile: AthleteProfile,
  checkin: DailyCheckin,
  garmin: GarminSummary,
  plan: StoredPlan,
  historyContext?: string,
): string {
  const lines: string[] = [];

  lines.push('# PLAN DE LAS ÚLTIMAS 2 SEMANAS\n');
  lines.push(planToContext(plan));

  lines.push('\n\n# PERFIL DEL ATLETA (resumen)\n');
  lines.push(`- Evento: ${profile.eventName} — ${profile.eventDistance}`);
  lines.push(`- Fecha evento: ${profile.eventDate} | Prioridad: ${profile.eventPriority}`);
  if (profile.activeInjury) lines.push(`- ⚠ LESIÓN ACTIVA: ${profile.injuryDescription} — dolor ${profile.injuryPain}/10`);
  if (profile.recentInjuries) lines.push(`- Lesiones recientes: ${profile.recentInjuries}`);

  lines.push('\n# CHECK-IN DEL DÍA\n');
  lines.push(`- Fecha: ${checkin.date}`);
  if (checkin.muscleSoreness !== null) lines.push(`- Soreness: ${checkin.muscleSoreness}/10`);
  if (checkin.motivation !== null) lines.push(`- Motivación: ${checkin.motivation}/10`);
  if (checkin.sleepQuality !== null) lines.push(`- Sueño: ${checkin.sleepQuality}/10`);
  if (checkin.newPainOrIssue) lines.push(`- Dolor nuevo: ${checkin.newPainOrIssue}`);

  lines.push('\n# ACTIVIDADES REALES — GARMIN\n');
  lines.push(`*Fetch date: ${garmin.fetchDate}*\n`);

  if (garmin.vo2max !== null) lines.push(`- VO2Max: ${garmin.vo2max} ml/kg/min`);
  if (garmin.avgRestingHR7d !== null) lines.push(`- FC reposo prom 7d: ${garmin.avgRestingHR7d} bpm`);
  if (garmin.avgBodyBattery7d !== null) lines.push(`- Body Battery prom 7d: ${garmin.avgBodyBattery7d}`);

  if (garmin.activities.length > 0) {
    const planStart = plan.semana1.inicio;
    const planEnd = addDays(plan.semana2.inicio, 6);
    const inRange = garmin.activities.filter(a => a.date >= planStart && a.date <= planEnd);
    const toShow = inRange.length > 0 ? inRange : garmin.activities.slice(-20);

    lines.push('\n## Actividades en el período del plan');
    lines.push('| Fecha | Tipo | Km | Min | FC prom | Z1 | Z2 | Z3 | Z4 | Z5 |');
    lines.push('|-------|------|----|----|---------|----|----|----|----|-----|');
    toShow.forEach(a => {
      lines.push(`| ${a.date} | ${a.type} | ${a.distanceKm ?? '-'} | ${a.durationMin} | ${a.avgHR ?? '-'} | ${a.zone1Min} | ${a.zone2Min} | ${a.zone3Min} | ${a.zone4Min} | ${a.zone5Min} |`);
    });
  }

  if (historyContext) {
    lines.push('\n# HISTORIAL DE 4 AÑOS\n');
    lines.push(historyContext);
  }

  lines.push(`\n\n---\nFecha actual: ${garmin.fetchDate}. Cruzá el plan con las actividades Garmin y generá la revisión completa con el bloque [REVIEW_JSON] al final.`);

  return lines.join('\n');
}
