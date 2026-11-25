// Measures how many characters the MCP tools return for a typical set of student questions, against
// an in-memory FIXTURE store (never real data, no disk, no network). Goal §4 "Cheaper answers".
//   node scripts/measure-output.ts          → table
//   node scripts/measure-output.ts --json   → JSON
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../shared/mcp/server.ts";
import type { DataStore, StoredFile } from "../shared/mcp/store.ts";
import type { CalendarEvent, Assignment, ForumPost, Resource, Snapshot } from "../shared/types.ts";

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/** "15 de enero" for a date N days from now (Madrid-ish; exact hour irrelevant). */
const fecha = (days: number) => {
  const d = new Date((now + days * DAY) * 1000);
  return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
};

// Deterministic pseudo-random (mulberry32) so the fixture is identical on every run.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const courses = [
  { id: 101, shortname: "DCIV1", fullname: "Derecho Civil I", url: "https://campusvirtual.uniovi.es/course/view.php?id=101" },
  { id: 102, shortname: "DPEN", fullname: "Derecho Penal: Parte General", url: "https://campusvirtual.uniovi.es/course/view.php?id=102" },
  { id: 103, shortname: "DCONS", fullname: "Derecho Constitucional", url: "https://campusvirtual.uniovi.es/course/view.php?id=103" },
  { id: 104, shortname: "DROM", fullname: "Derecho Romano", url: "https://campusvirtual.uniovi.es/course/view.php?id=104" },
];

const VOCAB: Record<number, string[]> = {
  101: ["el contrato", "la obligación", "el consentimiento", "la capacidad de obrar", "el negocio jurídico", "la prescripción", "la buena fe", "el Código Civil", "la persona física", "la nulidad"],
  102: ["el delito", "la culpabilidad", "el dolo", "la imprudencia", "la tipicidad", "la antijuridicidad", "la pena", "el Código Penal", "la tentativa", "la legítima defensa"],
  103: ["la Constitución", "el Tribunal Constitucional", "los derechos fundamentales", "las Cortes Generales", "el Gobierno", "la soberanía nacional", "el recurso de amparo", "la ley orgánica", "el Estado social", "la reforma constitucional"],
  104: ["la stipulatio", "el pretor", "la actio", "el ius civile", "la propiedad quiritaria", "la manumisión", "el contrato consensual", "la compraventa", "el mandato", "la usucapio"],
};
const VERBS = ["regula", "exige", "presupone", "excluye", "determina", "condiciona", "se distingue de", "debe interpretarse junto con", "constituye el fundamento de", "limita"];
const TAILS = [
  "según reiterada jurisprudencia del Tribunal Supremo.",
  "conforme a lo dispuesto en el artículo correspondiente.",
  "tal y como señala la doctrina mayoritaria.",
  "sin perjuicio de las excepciones legalmente previstas.",
  "lo que tiene importantes consecuencias prácticas en el examen.",
  "como se verá en el tema siguiente.",
  "a efectos de su validez y eficacia frente a terceros.",
];

/** Plausible, repetitive legal prose of about `chars` characters, with PDF page markers. */
function legalText(courseId: number, title: string, chars: number, seed: number): string {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const v = VOCAB[courseId]!;
  const out: string[] = [];
  let len = 0;
  let page = 1;
  let pageLen = 0;
  out.push(`--- page ${page} ---\n${title.toUpperCase()}\n`);
  while (len < chars) {
    let para = "";
    const n = 3 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const s = `${pick(v)} ${pick(VERBS)} ${pick(v)}, ${pick(TAILS)}`;
      para += s.charAt(0).toUpperCase() + s.slice(1) + " ";
    }
    if (r() < 0.12) para = `Epígrafe ${Math.floor(r() * 9) + 1}. Régimen jurídico de ${pick(v)}.\n` + para;
    out.push(para.trim() + "\n");
    len += para.length;
    pageLen += para.length;
    if (pageLen > 2800) {
      page++;
      pageLen = 0;
      out.push(`\n--- page ${page} ---\n`);
    }
  }
  return out.join("\n");
}

// ~15 materials; sizes in characters of extracted text.
const materials: Array<{ courseId: number; section: string; name: string; filename: string; chars: number; mime: string }> = [
  { courseId: 101, section: "Tema 1. La persona", name: "Tema 1 - La persona física", filename: "tema1_persona.pdf", chars: 24_000, mime: "application/pdf" },
  { courseId: 101, section: "Tema 2. El negocio jurídico", name: "Tema 2 - Negocio jurídico y contrato", filename: "tema2_negocio_juridico.pdf", chars: 118_000, mime: "application/pdf" },
  { courseId: 101, section: "Tema 3. La obligación", name: "Tema 3 - Teoría general de la obligación", filename: "tema3_obligaciones.pdf", chars: 72_000, mime: "application/pdf" },
  { courseId: 101, section: "Prácticas", name: "Casos prácticos contratos", filename: "casos_contratos.docx", chars: 9_000, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { courseId: 102, section: "Tema 1. Teoría del delito", name: "Tema 1 - Concepto de delito", filename: "tema1_delito.pdf", chars: 65_000, mime: "application/pdf" },
  { courseId: 102, section: "Tema 2. Tipicidad", name: "Tema 2 - Tipicidad y dolo", filename: "tema2_tipicidad.pptx", chars: 14_000, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  { courseId: 102, section: "Tema 3. Culpabilidad", name: "Tema 3 - Culpabilidad", filename: "tema3_culpabilidad.pdf", chars: 40_000, mime: "application/pdf" },
  { courseId: 102, section: "Prácticas", name: "Sentencias para comentar", filename: "sentencias.pdf", chars: 30_000, mime: "application/pdf" },
  { courseId: 103, section: "Tema 1. La Constitución", name: "Tema 1 - La Constitución de 1978", filename: "tema1_constitucion.pdf", chars: 90_000, mime: "application/pdf" },
  { courseId: 103, section: "Tema 2. Derechos fundamentales", name: "Tema 2 - Derechos fundamentales", filename: "tema2_derechos.pdf", chars: 61_000, mime: "application/pdf" },
  { courseId: 103, section: "Tema 3. Órganos constitucionales", name: "Tema 3 - Cortes y Gobierno", filename: "tema3_organos.pptx", chars: 12_000, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  { courseId: 104, section: "Tema 1. Fuentes", name: "Tema 1 - Fuentes del Derecho romano", filename: "tema1_fuentes.pdf", chars: 35_000, mime: "application/pdf" },
  { courseId: 104, section: "Tema 2. Contratos", name: "Tema 2 - Contratos consensuales", filename: "tema2_contratos.pdf", chars: 80_000, mime: "application/pdf" },
  { courseId: 104, section: "Tema 3. Propiedad", name: "Tema 3 - Propiedad y posesión", filename: "tema3_propiedad.pdf", chars: 28_000, mime: "application/pdf" },
  { courseId: 104, section: "Guía docente", name: "Guía docente Derecho Romano", filename: "guia_docente.pdf", chars: 6_000, mime: "application/pdf" },
];

const resources: Resource[] = [];
const texts = new Map<string, string>();
const index: Record<string, StoredFile> = {};
materials.forEach((m, i) => {
  const cmid = 5000 + i;
  const r: Resource = {
    key: `${cmid}:/${m.filename}`,
    cmid,
    courseId: m.courseId,
    section: m.section,
    name: m.name,
    modname: "resource",
    url: `https://campusvirtual.uniovi.es/pluginfile.php/${90000 + i}/mod_resource/content/1/${m.filename}`,
    filename: m.filename,
    mimetype: m.mime,
    filesize: Math.round(m.chars * 1.6),
    timemodified: now - (40 - i) * DAY,
  };
  resources.push(r);
  const shortname = courses.find((c) => c.id === m.courseId)!.shortname;
  const f: StoredFile = {
    key: r.key,
    path: `files/${shortname}/${m.section}/${m.filename}`,
    size: r.filesize!,
    contentType: m.mime,
    timemodified: r.timemodified!,
    storedAt: now - DAY,
    resource: r,
  };
  index[r.key] = f;
  texts.set(r.key, legalText(m.courseId, m.name, m.chars, 1000 + i));
});
// A couple of non-downloadable entries (links / archives), as real courses have.
resources.push(
  { key: "6001:/apuntes.zip", cmid: 6001, courseId: 101, section: "Prácticas", name: "Apuntes comprimidos", modname: "resource", url: "https://campusvirtual.uniovi.es/pluginfile.php/1/apuntes.zip", filename: "apuntes.zip", mimetype: "application/zip", filesize: 2_000_000, timemodified: now - 30 * DAY },
  { key: "6002:", cmid: 6002, courseId: 103, section: "Tema 1. La Constitución", name: "Texto de la Constitución (BOE)", modname: "url", url: "https://campusvirtual.uniovi.es/mod/url/view.php?id=6002" },
);

const post = (id: number, courseId: number, forumName: string, subject: string, author: string, daysAgo: number, message: string): ForumPost => ({
  id,
  discussionId: id - 1000,
  courseId,
  forumName,
  subject,
  author,
  created: now - daysAgo * DAY,
  message,
  url: `https://campusvirtual.uniovi.es/mod/forum/discuss.php?d=${id - 1000}#p${id}`,
});
const filler =
  " Os recuerdo que debéis traer el DNI o la tarjeta universitaria. Cualquier duda podéis plantearla en tutorías, los martes de 10:00 a 12:00 en el despacho 2.14, o por correo electrónico. Un saludo cordial.";
const posts: ForumPost[] = [
  post(2001, 101, "Avisos", "Fecha del examen final", "María Fernández López", 2, `Estimados alumnos: el examen final será el ${fecha(51)} a las 10:00 en el Aula Magna. Entrarán los temas 1 a 8.${filler}`),
  post(2002, 101, "Avisos", "Entrega del caso práctico", "María Fernández López", 5, `La entrega del caso práctico sobre contratos será el ${fecha(9)} a las 23:59 a través del campus.${filler}`),
  post(2003, 101, "Avisos", "Tutorías de diciembre", "María Fernández López", 12, `Durante diciembre las tutorías se trasladan a los jueves.${filler}`),
  post(2004, 101, "Foro de dudas", "Duda sobre capacidad de obrar", "Pablo García", 3, "Profesora, ¿la emancipación entra en el parcial? Gracias."),
  post(2005, 101, "Foro de dudas", "Re: Duda sobre capacidad de obrar", "María Fernández López", 3, `Sí, entra en el parcial del ${fecha(16)}. Revisad el tema 1, epígrafes 3 y 4.${filler}`),
  post(2006, 102, "Avisos", "Examen parcial de Penal", "Javier Suárez Álvarez", 1, `El examen parcial de Derecho Penal tendrá lugar el ${fecha(12)} a las 16:00 en el aula B-3. Será tipo test con 40 preguntas.${filler}`),
  post(2007, 102, "Avisos", "Material nuevo: sentencias", "Javier Suárez Álvarez", 4, `He subido al campus las sentencias que comentaremos en las prácticas del ${fecha(6)}.${filler}`),
  post(2008, 102, "Avisos", "Convocatoria ordinaria", "Javier Suárez Álvarez", 20, `El examen final de la convocatoria ordinaria será el ${fecha(58)} a las 9:30.${filler}`),
  post(2009, 102, "Foro de dudas", "Tentativa inidónea", "Lucía Martínez", 6, "¿Alguien tiene apuntes de la clase sobre tentativa inidónea? No pude asistir."),
  post(2010, 102, "Foro de dudas", "Re: Tentativa inidónea", "Javier Suárez Álvarez", 6, `Está en el tema 3, páginas 12 a 18 de la presentación.${filler}`),
  post(2011, 103, "Avisos", "Examen de Constitucional", "Ana Rodríguez Menéndez", 3, `Os informo de que el examen final será el ${fecha(54)} a las 12:00. La revisión será el ${fecha(64)}.${filler}`),
  post(2012, 103, "Avisos", "Seminario sobre el recurso de amparo", "Ana Rodríguez Menéndez", 8, `El seminario será el ${fecha(10)} a las 17:00 en el Salón de Grados. La asistencia cuenta para la evaluación continua.${filler}`),
  post(2013, 103, "Avisos", "Entrega del comentario", "Ana Rodríguez Menéndez", 15, `El plazo para entregar el comentario de la STC termina el ${fecha(4)}.${filler}`),
  post(2014, 103, "Foro de dudas", "Bibliografía", "Diego Pérez", 9, "¿Qué manual recomienda para el tema 2?"),
  post(2015, 103, "Foro de dudas", "Re: Bibliografía", "Ana Rodríguez Menéndez", 9, `Cualquiera de los de la guía docente; recomiendo el de Balaguer.${filler}`),
  post(2016, 104, "Avisos", "Calendario de exámenes", "Carlos Álvarez Prieto", 2, `El examen final de Derecho Romano será el ${fecha(49)} a las 10:00 en el aula A-1. El examen de recuperación será en junio.${filler}`),
  post(2017, 104, "Avisos", "Clase recuperada", "Carlos Álvarez Prieto", 7, `La clase del lunes se recupera el ${fecha(3)} a las 18:00.${filler}`),
  post(2018, 104, "Avisos", "Prueba de evaluación continua", "Carlos Álvarez Prieto", 11, `La prueba de evaluación continua sobre contratos consensuales será el ${fecha(8)} durante la clase.${filler}`),
  post(2019, 104, "Foro de dudas", "Stipulatio", "Sara Iglesias", 1, "¿La stipulatio es un contrato verbal o formal? Gracias."),
  post(2020, 104, "Foro de dudas", "Re: Stipulatio", "Carlos Álvarez Prieto", 1, `Es un contrato verbal (verbis). Lo explicamos en el tema 2.${filler}`),
  post(2021, 101, "Avisos", "Bienvenida", "María Fernández López", 60, `Bienvenidos a Derecho Civil I.${filler}`),
];

const assignments: Assignment[] = [
  { id: 3001, cmid: 7001, courseId: 101, name: "Caso práctico: contratos", dueDate: now + 9 * DAY, intro: "Resolved el caso práctico adjunto sobre la nulidad del contrato.", url: "https://campusvirtual.uniovi.es/mod/assign/view.php?id=7001" },
  { id: 3002, cmid: 7002, courseId: 103, name: "Comentario de la STC 31/2010", dueDate: now + 4 * DAY, intro: "Comentario de 3 a 5 páginas.", url: "https://campusvirtual.uniovi.es/mod/assign/view.php?id=7002" },
  { id: 3003, cmid: 7003, courseId: 102, name: "Comentario de sentencia sobre dolo eventual", dueDate: now + 20 * DAY, intro: "Analizad la sentencia publicada en el campus.", url: "https://campusvirtual.uniovi.es/mod/assign/view.php?id=7003" },
];
const events: CalendarEvent[] = [
  { id: 4001, courseId: 101, name: "Caso práctico: contratos vence", type: "due", module: "assign", time: now + 9 * DAY, description: "", url: assignments[0]!.url },
  { id: 4002, courseId: 103, name: "Comentario de la STC 31/2010 vence", type: "due", module: "assign", time: now + 4 * DAY, description: "", url: assignments[1]!.url },
  { id: 4003, courseId: 102, name: "Cuestionario tema 2", type: "close", module: "quiz", time: now + 6 * DAY, description: "Cuestionario de autoevaluación sobre tipicidad.", url: "https://campusvirtual.uniovi.es/mod/quiz/view.php?id=7100" },
  { id: 4004, courseId: 104, name: "Cuestionario de fuentes", type: "close", module: "quiz", time: now + 13 * DAY, description: "", url: "https://campusvirtual.uniovi.es/mod/quiz/view.php?id=7101" },
  { id: 4005, name: "Festivo: Día de la Constitución", type: "site", time: now + 11 * DAY, description: "No lectivo." },
];

const snapshot: Snapshot = {
  syncedAt: now - 3600,
  siteUrl: "https://campusvirtual.uniovi.es",
  courses,
  resources,
  posts,
  assignments,
  events,
  warnings: ["mod_assign_get_assignments: servicenotavailable", "core_course_get_contents: servicenotavailable"],
};

const store: DataStore = {
  snapshot: async () => snapshot,
  index: async () => index,
  bytes: async (f) => {
    throw new Error(`fixture has no bytes for ${f.key}`);
  },
  readText: async (f) => texts.get(f.key) ?? null,
  writeText: async (f, t) => {
    texts.set(f.key, t);
  },
};

const longest = materials.reduce((a, m, i) => (m.chars > materials[a]!.chars ? i : a), 0);
const longestKey = `${5000 + longest}:/${materials[longest]!.filename}`;

const server = createMcpServer(store, { remote: true });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "measure", version: "1" });
await client.connect(b);
const { tools } = await client.listTools();
const have = new Set(tools.map((t) => t.name));

const calls: Array<[string, Record<string, unknown>]> = [
  ["list_courses", {}],
  ["get_deadlines", { daysAhead: 14 }],
  ["get_exam_dates", { includeDeadlines: true }],
  ["search_forums", { sinceDays: 7 }],
  ["search_forums", { query: "examen" }],
  ["list_materials", { query: "tema" }],
  ["search_materials", { query: "contrato" }],
  ["read_material", { key: longestKey }],
  ["search", { query: "examen" }],
  ["sync_status", {}],
];

const rows: Array<{ call: string; chars: number }> = [];
for (const [name, args] of calls) {
  const label = `${name} ${JSON.stringify(args)}`;
  if (!have.has(name)) {
    rows.push({ call: `${label} (missing)`, chars: 0 });
    continue;
  }
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const chars = res.content.reduce((n, c) => n + (c.type === "text" ? (c.text ?? "").length : 0), 0);
  rows.push({ call: res.isError ? `${label} (ERROR)` : label, chars });
}
await client.close();

const total = rows.reduce((n, r) => n + r.chars, 0);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ rows, total }, null, 2));
} else {
  const w = Math.max(...rows.map((r) => r.call.length), 5);
  for (const r of rows) console.log(`${r.call.padEnd(w)}  ${String(r.chars).padStart(8)}`);
  console.log(`${"TOTAL".padEnd(w)}  ${String(total).padStart(8)}`);
}
