// A small mock Uniovi Virtual (Moodle 4, Boost theme, Onetopic course format) for
// scripts/shots/verify-collector.mjs. Same restrictions as the real site (verified 2026-11-17):
// course contents, forum discussions and assignment web services are disabled.
// Made-up course and people: no real campus data.

const page = (body) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Campus</title></head>
<body><nav class="navbar"><a href="/my/">Área personal</a> <a href="/user/profile.php">Perfil</a></nav>
<div id="page"><div id="region-main" role="main">${body}</div></div>
<footer><a href="https://www.uniovi.es">Universidad de Oviedo</a></footer><script>var x = "script text";</script></body></html>`;

const tabs = `<ul class="nav nav-tabs"><li><a href="/course/view.php?id=7&section=0">General</a></li><li><a href="/course/view.php?id=7&section=1">Tema 1</a></li></ul>`;
const act = (mod, id, name, label) =>
  `<li class="activity"><a href="/mod/${mod}/view.php?id=${id}"><span class="instancename">${name}<span class="accesshide"> ${label}</span></span></a></li>`;

export const pages = {
  "/course/view.php?id=7": page(`${tabs}
    <li class="section" data-for="section"><h3 class="sectionname">General</h3>
      <div class="summary"><p>Profesora responsable: <strong>Ana Fernández López</strong> (tutorías martes 10:00-12:00, despacho 2.14).</p>
      <p>Evaluación: examen final 70 %, prácticas 30 %. Es necesario un 4 en el examen para hacer media.</p>
      <p>Guía docente: <a href="https://guias.example.es/derecho-civil-i">consultar aquí</a></p></div>
      <ul>${act("forum", 30, "Avisos", "Foro")}${act("resource", 13, "Programa", "Archivo")}</ul></li>`),
  "/course/view.php?id=7&section=0": "same as above",
  "/course/view.php?id=7&section=1": page(`${tabs}
    <li class="section" data-for="section"><h3 class="sectionname">Tema 1</h3>
      <div class="summary"><p>Tema 1: la persona y su capacidad.</p></div>
      <ul>${act("quiz", 21, "Test del tema 1", "Cuestionario")}${act("assign", 22, "Comentario de sentencia", "Tarea")}${act("page", 11, "Lecturas recomendadas", "Página")}</ul></li>`),
  "/course/resources.php?id=7": page(`<table class="generaltable"><tbody>
      <tr><td>General</td><td><a href="/mod/resource/view.php?id=13">Programa</a></td></tr>
      <tr><td>Tema 1</td><td><a href="/mod/page/view.php?id=11">Lecturas recomendadas</a></td></tr>
      <tr><td></td><td><a href="/mod/url/view.php?id=12">Código Civil (BOE)</a></td></tr>
      <tr><td></td><td><a href="/mod/book/view.php?id=14">Apuntes del tema 1</a></td></tr></tbody></table>`),
  "/mod/forum/index.php?id=7": page(`<table class="generaltable"><tbody></tbody></table>`),
  "/mod/page/view.php?id=11&forceview=1": page(`<h2>Lecturas recomendadas</h2>
      <p>Leer antes de clase:</p><ul><li>Díez-Picazo, Sistema de Derecho Civil, vol. I, cap. 12</li><li>STS 145/2020 sobre capacidad</li></ul>
      <table><tr><th>Semana</th><th>Lectura</th></tr><tr><td>1</td><td>Capítulo 12</td></tr></table>
      <p>Material adicional: <a href="/pluginfile.php/555/mod_page/content/3/esquema-tema1.pdf">esquema del tema</a></p>`),
  "/mod/url/view.php?id=12&forceview=1": page(`<h2>Código Civil (BOE)</h2><div class="urlworkaround">Haga clic en el enlace
      <a href="https://www.boe.es/buscar/act.php?id=BOE-A-1889-4763">https://www.boe.es/buscar/act.php?id=BOE-A-1889-4763</a> para abrir el recurso.</div>`),
  "/mod/book/tool/print/index.php?id=14": page(`<h1>Apuntes del tema 1</h1>
      <h2>1. Concepto de persona</h2><p>La personalidad se adquiere en el momento del nacimiento con vida (art. 30 CC).</p>
      <h2>2. Capacidad jurídica</h2><p>Aptitud para ser titular de derechos y obligaciones.</p>`),
  "/mod/quiz/view.php?id=21&forceview=1": page(`<h2>Test del tema 1</h2>
      <div class="activity-dates"><div><strong>Apertura:</strong> lunes, 1 de diciembre de 2026, 09:00</div><div><strong>Cierre:</strong> viernes, 5 de diciembre de 2026, 23:59</div></div>
      <div class="activity-description"><p>20 preguntas tipo test. Las respuestas incorrectas restan 0,25.</p></div>
      <p>Límite de tiempo: 30 minutos</p><p>Intentos permitidos: 1</p><button>Intentar resolver el cuestionario ahora</button>`),
  "/mod/assign/view.php?id=22&forceview=1": page(`<h2>Comentario de sentencia</h2>
      <div class="activity-dates"><div><strong>Apertura:</strong> 20 de noviembre de 2026</div><div><strong>Fecha de entrega:</strong> 10 de diciembre de 2026, 23:59</div></div>
      <div class="activity-description"><p>Comenta la sentencia adjunta en un máximo de 3 páginas. Se valorará la argumentación jurídica.</p>
      <a href="/pluginfile.php/777/mod_assign/introattachment/0/sentencia.pdf?forcedownload=1">sentencia.pdf</a></div>
      <table class="generaltable"><tr><th>Estado de la entrega</th><td>No entregado</td></tr><tr><th>Tiempo restante</th><td>15 días</td></tr></table>`),
};
pages["/course/view.php?id=7&section=0"] = pages["/course/view.php?id=7"];

// Grade report as seen live (2026-11-25): item names in .rowtitle under a .dimmed_text kind label,
// categories as th.category by level, totals with class baggt, an action menu inside quiz grade cells.
const menu = `<div class="action-menu moodle-actionmenu"><a href="/grade/report/grader/analysis.php">Análisis de calificaciones</a><div class="dropdown-menu">Análisis de calificaciones</div></div>`;
const gitem = (level, name, kind, grade, pct, total = false) =>
  `<tr><th class="level${level} ${total ? "baggt" : "item"} b1b column-itemname"><div><span class="d-block dimmed_text">${kind}</span><div class="rowtitle"><span class="gradeitemheader">${name}</span></div></div></th>
   <td class="level${level} column-grade"><div><div>${grade}</div>${kind === "Cuestionario" ? menu : ""}</div></td><td class="column-range">0–10</td><td class="column-percentage">${pct}</td>
   <td class="column-feedback">${grade === "7,50" ? "Buen análisis del caso." : ""}</td><td class="column-contributiontocoursetotal">-</td></tr>`;
pages["/grade/report/user/index.php?id=7"] = page(`<table class="generaltable user-grade"><thead><tr><th>Elemento de calificación</th><th>Calificación</th></tr></thead><tbody>
  <tr><th class="level1 category column-itemname" colspan="8">Derecho Civil I</th></tr><tr><td class="level1"></td></tr>
  <tr><th class="level2 category column-itemname" colspan="7">Teoría</th></tr>
  ${gitem(3, "Parcial 1", "Elemento manual", "7,50", "75,00 %")}
  ${gitem(3, "Test del tema 1", "Cuestionario", "-", "-")}
  ${gitem(2, "Total Teoría", "Cálculo total", "7,50", "75,00 %", true)}
  <tr><th class="level2 category column-itemname" colspan="7">Prácticas</th></tr>
  ${gitem(3, "Comentario de sentencia", "Tarea", "6,00", "60,00 %")}
  ${gitem(1, "Total del curso", "Cálculo total", "-", "-", true)}
</tbody></table>`);

// Participants: roleid=3 lists the teacher; roleid=4 matches nobody, so the page ignores the filter
// and lists everyone (as live): the students here must never reach the snapshot.
const person = (id, name, role, groups) =>
  `<tr><td class="c0"><input type="checkbox"></td><th class="c1"><a href="/user/view.php?id=${id}&course=7">${name}</a></th><td class="c2">${role}</td><td class="c3">${groups}</td><td class="c4">1 hora</td></tr>`;
const participants = (rows) => page(`<table id="participants" class="generaltable"><thead><tr><th class="c0">Seleccionar todos</th><th class="c1">Nombre / Apellido(s)</th><th class="c2">Roles</th><th class="c3">Grupos</th><th class="c4">Último acceso al curso</th></tr></thead>
  <tbody>${rows}<tr class="emptyrow"><td></td></tr></tbody></table>`);
pages["/user/index.php?id=7&roleid=3&perpage=5000"] = participants(person(501, "FERNÁNDEZ LÓPEZ,ANA", "Profesor", "PA-01, PA-02, TE-01"));
pages["/user/index.php?id=7&roleid=4&perpage=5000"] = participants(
  person(501, "FERNÁNDEZ LÓPEZ,ANA", "Profesor", "PA-01, PA-02, TE-01") +
    person(502, "COMPAÑERA PRIVADA,LUCÍA", "Estudiante", "PA-02, TE-01") +
    person(503, "GARCÍA RUIZ,PEDRO", "Profesor sin permiso de edición", "PA-01") +
    person(504, "COMPAÑERO PRIVADO,MARCOS", "Estudiante", "No hay grupos"),
);
// The student's own course profile (no id): "Grupo" with links.
pages["/user/view.php?course=7"] = page(`<section><dl><dt>Dirección de correo</dt><dd>UO000000@uniovi.es</dd></dl>
  <dl><dt>Roles</dt><dd>Estudiante</dd></dl><dl><dt>Grupo</dt><dd> <a href="/group/1">PA-02</a>, <a href="/group/2">TE-01</a></dd></dl></section>`);

export const ws = {
  core_course_get_enrolled_courses_by_timeline_classification: {
    courses: [{ id: 7, shortname: "DCI", fullname: "Derecho Civil I", viewurl: "https://campus.test/course/view.php?id=7" }],
  },
  core_calendar_get_action_events_by_timesort: { events: [] },
  core_calendar_get_calendar_upcoming_view: { events: [] },
};
