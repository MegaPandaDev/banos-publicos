const UMBRAL_ESTRELLAS_BUENO = 3;
const CLAVE_REPORTADOS = "banos_reportados";
const CENTRO_POR_DEFECTO = [40.4168, -3.7038]; // Madrid, por si no hay geolocalización
const ZOOM_POR_DEFECTO = 6;
export const INTERVALO_SONDEO_MS = 30000;

// Etiquetas que se pueden asignar a un baño (ver también CATEGORIAS_ETIQUETAS
// en app.py, que es quien las valida de verdad al guardar).
const ETIQUETAS_TEXTO = {
  a_pie_de_calle: "A pie de calle",
  en_parque: "En un parque",
  en_centro_comercial: "En un centro comercial",
  gratis: "Gratis",
  de_pago: "De pago",
  precio_desconocido: "Precio desconocido",
  cambiador_bebes: "Cambiador de bebés",
  accesible_silla_ruedas: "Accesible en silla de ruedas",
};

// --- Peticiones al servidor propio (app.py) ---
export async function peticionJSON(url, opciones = {}) {
  const resp = await fetch(url, {
    ...opciones,
    headers: { "Content-Type": "application/json", ...(opciones.headers || {}) },
  });
  let datos = null;
  try {
    datos = await resp.json();
  } catch {
    /* respuesta sin cuerpo JSON */
  }
  if (!resp.ok) {
    const error = new Error((datos && datos.error) || "Ha ocurrido un error inesperado.");
    error.status = resp.status;
    throw error;
  }
  return datos;
}

// Vía de acceso oculta para que el moderador recupere el identificador estable de su
// propio dispositivo (sin pantalla de login): abrir la app con "?verid" en la URL.
if (new URLSearchParams(location.search).has("verid")) {
  fetch("/api/verid?verid=1")
    .then((r) => r.json())
    .then((datos) => {
      if (datos.id) window.prompt("Identificador de este dispositivo (cópialo):", datos.id);
    })
    .catch(() => {});
}

// --- Verificación humana (Cloudflare Turnstile) ---
// Opcional de verdad: si el servidor no tiene Turnstile configurado, esto se queda
// en null y las peticiones se mandan sin token (el servidor decide entonces dejar
// pasar, ver turnstile.py). Nunca bloquea el uso de la app por sí solo.
let turnstileSiteKey = null;
let turnstileWidgetId = null;
let turnstileCargaPromesa = null;
let resolverTurnstileActual = null;

fetch("/api/turnstile-site-key")
  .then((r) => r.json())
  .then((datos) => {
    turnstileSiteKey = datos.site_key || null;
  })
  .catch(() => {
    turnstileSiteKey = null;
  });

function cargarScriptTurnstile() {
  if (!turnstileCargaPromesa) {
    turnstileCargaPromesa = new Promise((resolve) => {
      window.onloadTurnstileCallback = resolve;
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    });
  }
  return turnstileCargaPromesa;
}

async function obtenerTokenHumano() {
  if (!turnstileSiteKey) return null;
  await cargarScriptTurnstile();

  // Turnstile no tiene un tamaño "invisible" como reCAPTCHA: se consigue con
  // appearance "interaction-only" (no se ve nada salvo que Cloudflare decida
  // que hace falta interacción) + execution "execute" (no arranca solo al
  // renderizar, hay que llamar a turnstile.execute() cada vez).
  if (turnstileWidgetId === null) {
    turnstileWidgetId = turnstile.render("#turnstile-contenedor", {
      sitekey: turnstileSiteKey,
      appearance: "interaction-only",
      execution: "execute",
      callback: (token) => resolverTurnstileActual && resolverTurnstileActual(token),
      "error-callback": () => resolverTurnstileActual && resolverTurnstileActual(null),
    });
  } else {
    turnstile.reset(turnstileWidgetId);
  }

  // Si Turnstile no responde en un tiempo razonable (red lenta, navegador que
  // bloquea el iframe, lo que sea), no dejamos el botón bloqueado para siempre:
  // seguimos con token null y que decida el servidor (ver turnstile.py).
  return new Promise((resolve) => {
    let resuelto = false;
    const terminar = (token) => {
      if (resuelto) return;
      resuelto = true;
      resolve(token);
    };
    resolverTurnstileActual = terminar;
    setTimeout(() => terminar(null), 8000);
    turnstile.execute(turnstileWidgetId);
  });
}

// Si el servidor tiene Turnstile configurado (turnstileSiteKey no es null) pero
// no conseguimos un token, casi siempre es porque algo en el navegador ha
// impedido cargar el challenge de Cloudflare (Brave con los escudos activados,
// un bloqueador de anuncios/privacidad, red corporativa, etc.), no porque el
// usuario sea un bot. En ese caso avisamos con un mensaje que se puede
// solucionar, en vez de dejar que el servidor responda con el genérico
// "no eres un robot" (que no dice qué hacer y "recargar" no arregla nada).
async function obtenerTokenHumanoOAvisar() {
  const token = await obtenerTokenHumano();
  if (!token && turnstileSiteKey) {
    throw new Error(
      "No se ha podido cargar la verificación de seguridad (Cloudflare). Si usas Brave, " +
        "desactiva los escudos para este sitio; si usas un bloqueador de anuncios o una " +
        "extensión de privacidad, permite challenges.cloudflare.com y vuelve a intentarlo."
    );
  }
  return token;
}

// --- Mapa ---
export const map = L.map("map", { zoomControl: false }).setView(CENTRO_POR_DEFECTO, ZOOM_POR_DEFECTO);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

L.control.zoom({ position: "bottomright" }).addTo(map);

// Tres variantes de icono según quién puso el baño y si es de pago (en ese
// orden de prioridad: un baño de pago siempre se ve amarillo, sea de quien sea).
function crearIconoLavabo(archivo) {
  return L.icon({
    className: "marcador-lavabo",
    iconUrl: `icons/${archivo}`,
    iconSize: [36, 36],
    iconAnchor: [18, 34],
    popupAnchor: [0, -31],
  });
}
const iconoSistema = crearIconoLavabo("marcador-wc.svg");
const iconoUsuario = crearIconoLavabo("marcador-wc-usuario.svg");
const iconoPago = crearIconoLavabo("marcador-wc-pago.svg");

function elegirIcono(datos) {
  if (datos.tipoIcono === "pago") return iconoPago;
  if (datos.tipoIcono === "sistema") return iconoSistema;
  return iconoUsuario;
}

// Agrupa los marcadores en "racimos" cuando están muy juntos (sobre todo con el
// mapa alejado), y los va separando en iconos individuales al hacer zoom — así
// no se pintan a la vez todos los baños del país y el móvil no sufre.
const grupoMarcadores = L.markerClusterGroup({
  maxClusterRadius: 60,
  spiderfyOnMaxZoom: false,
});
map.addLayer(grupoMarcadores);

function centrarEnMiUbicacion(mostrarError = false) {
  if (!navigator.geolocation) {
    if (mostrarError) mostrarToast("Tu navegador no permite obtener la ubicación.", "error");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 15);
    },
    () => {
      if (mostrarError) {
        mostrarToast("No se pudo obtener tu ubicación. Revisa los permisos del navegador.", "error");
      }
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}
centrarEnMiUbicacion();

const BotonUbicacion = L.Control.extend({
  options: { position: "topright" },
  onAdd() {
    const btn = L.DomUtil.create("button", "boton-mapa boton-ubicacion");
    btn.type = "button";
    btn.title = "Centrar en mi ubicación";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = '<img src="icons/ubicacion.svg" class="icono-control-mapa" alt="" />';
    L.DomEvent.disableClickPropagation(btn);
    btn.addEventListener("click", () => centrarEnMiUbicacion(true));
    return btn;
  },
});
map.addControl(new BotonUbicacion());

// --- Marcadores desde el servidor ---
const marcadores = new Map(); // id -> L.Marker
const datosLavabos = new Map(); // id -> datos básicos (nombre, descripcion, lat, lng)
let primeraCargaBanos = true;
let primerIntentoCarga = true;
const avisoCargando = document.getElementById("aviso-cargando");

export function escaparHTML(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}

export function formatearFechaRelativa(fechaISO) {
  if (!fechaISO) return "justo ahora";
  const segundos = Math.floor((Date.now() - new Date(fechaISO).getTime()) / 1000);
  if (segundos < 60) return "justo ahora";
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias < 30) return `hace ${dias} d`;
  const meses = Math.floor(dias / 30);
  if (meses < 12) return `hace ${meses} mes${meses > 1 ? "es" : ""}`;
  const años = Math.floor(dias / 365);
  return `hace ${años} año${años > 1 ? "s" : ""}`;
}

export function quitarMarcador(id) {
  if (marcadores.has(id)) {
    grupoMarcadores.removeLayer(marcadores.get(id));
    marcadores.delete(id);
  }
  datosLavabos.delete(id);
  if (idDetalleActual === id) {
    cerrarDetalle();
    mostrarToast("Este baño ya no está disponible.", "info");
  }
}

function añadirOActualizarMarcador(datos) {
  const id = String(datos.id);
  datosLavabos.set(id, datos);
  if (marcadores.has(id)) {
    const marcador = marcadores.get(id);
    const pos = marcador.getLatLng();
    if (pos.lat !== datos.lat || pos.lng !== datos.lng) marcador.setLatLng([datos.lat, datos.lng]);
    const iconoNuevo = elegirIcono(datos);
    if (marcador.options.icon !== iconoNuevo) marcador.setIcon(iconoNuevo);
  } else {
    const marcador = L.marker([datos.lat, datos.lng], { icon: elegirIcono(datos) });
    marcador.on("click", (e) => {
      L.DomEvent.stop(e);
      abrirDetalle(id);
    });
    grupoMarcadores.addLayer(marcador);
    marcadores.set(id, marcador);
  }
  actualizarVisibilidadMarcador(id);
}

async function cargarBanos() {
  try {
    const lista = await peticionJSON("/api/banos");
    const idsNuevos = new Set(lista.map((b) => String(b.id)));
    for (const id of Array.from(marcadores.keys())) {
      if (!idsNuevos.has(id)) quitarMarcador(id);
    }
    lista.forEach(añadirOActualizarMarcador);

    if (primeraCargaBanos) {
      primeraCargaBanos = false;
      if (marcadores.size === 0) {
        mostrarToast(
          "No hay baños registrados por aquí todavía. ¡Sé el primero en añadir uno con el botón +!",
          "info",
          6000
        );
      }
    }
  } catch (err) {
    console.error(err);
    if (primeraCargaBanos) {
      mostrarToast("No se pudieron cargar los baños. Inténtalo de nuevo más tarde.", "error");
    }
  } finally {
    if (primerIntentoCarga) {
      primerIntentoCarga = false;
      avisoCargando.hidden = true;
    }
  }
}

cargarBanos();
setInterval(cargarBanos, INTERVALO_SONDEO_MS);

// --- Selector de etiquetas (compartido por el formulario y el filtro) ---
// Cada botón es un simple interruptor; los grupos marcados como
// data-exclusivo="true" (ubicación, precio) admiten como mucho uno activo a
// la vez, como botones de radio, y el resto (comodidades) admite varios.
function inicializarSelectorEtiquetas(contenedor) {
  contenedor.querySelectorAll(".etiqueta-boton").forEach((boton) => {
    boton.addEventListener("click", () => {
      const grupo = boton.closest(".etiquetas-grupo");
      const yaActivo = boton.classList.contains("activo");
      if (grupo && grupo.dataset.exclusivo === "true") {
        grupo.querySelectorAll(".etiqueta-boton").forEach((b) => b.classList.remove("activo"));
      }
      boton.classList.toggle("activo", !yaActivo);
    });
  });
}

function obtenerEtiquetasSeleccionadas(contenedor) {
  return Array.from(contenedor.querySelectorAll(".etiqueta-boton.activo")).map((b) => b.dataset.etiqueta);
}

function establecerEtiquetasSeleccionadas(contenedor, etiquetas) {
  const activas = new Set(etiquetas || []);
  contenedor.querySelectorAll(".etiqueta-boton").forEach((b) => {
    b.classList.toggle("activo", activas.has(b.dataset.etiqueta));
  });
}

// --- Hoja de detalle: valoraciones y comentarios ---
const hojaDetalle = document.getElementById("hoja-detalle");
const btnCerrarDetalle = document.getElementById("btn-cerrar-detalle");
const detalleNombre = document.getElementById("detalle-nombre");
const detalleDescripcion = document.getElementById("detalle-descripcion");
const detalleEtiquetas = document.getElementById("detalle-etiquetas");
const detalleBtnLlegar = document.getElementById("detalle-btn-llegar");
const detalleBtnReportar = document.getElementById("detalle-btn-reportar");
const detalleBtnEditar = document.getElementById("detalle-btn-editar");
const detalleBtnEliminar = document.getElementById("detalle-btn-eliminar");
const detallePromedio = document.getElementById("detalle-promedio");
const detalleEstrellasUsuario = document.getElementById("detalle-estrellas-usuario");
const listaComentarios = document.getElementById("lista-comentarios");
const formComentario = document.getElementById("form-comentario");

let idDetalleActual = null;

// Hook opcional: si el panel de moderación está cargado (solo para el
// moderador), se registra aquí para poder cerrarse solo al abrir una ficha
// o el formulario. Para el resto de usuarios, js/moderacion.js no se carga
// y esto se queda en null.
let alAbrirDetalleOFormulario = null;
export function registrarCerradorModeracion(fn) {
  alAbrirDetalleOFormulario = fn;
}

// Hooks opcionales para el selector de icono manual del formulario (solo
// para el moderador, ver js/moderacion.js). "prepararSelectorIcono" se llama
// con los datos del baño al editar (o null al añadir uno nuevo, para
// ocultarlo); "obtenerIconoSeleccionado" se consulta al guardar una edición.
let prepararSelectorIcono = null;
export function registrarSelectorIcono(fn) {
  prepararSelectorIcono = fn;
}
let obtenerIconoSeleccionado = null;
export function registrarObtenerIconoSeleccionado(fn) {
  obtenerIconoSeleccionado = fn;
}

// --- Accesibilidad compartida por todas las hojas ---
// Al abrir: mueve el foco dentro de la hoja y atrapa el Tab/Shift+Tab para
// que no se escape hacia el mapa de detrás; Escape ejecuta el cierre que se
// le pase. Al cerrar (llamando a la función que esto devuelve): libera el
// atrapa-foco y devuelve el foco a quien tenía el foco antes de abrirla.
// Es exactamente el mismo patrón que ya usaba el modal de confirmación.
const SELECTOR_ENFOCABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function activarAccesibilidadHoja(hoja, alPulsarEscape) {
  const disparador = document.activeElement;
  const primero = hoja.querySelector(SELECTOR_ENFOCABLE);
  if (primero) primero.focus({ preventScroll: true });

  const onTecla = (e) => {
    if (e.key === "Escape") {
      alPulsarEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const enfocables = Array.from(hoja.querySelectorAll(SELECTOR_ENFOCABLE)).filter(
      (el) => el.offsetParent !== null
    );
    if (enfocables.length === 0) return;
    const inicio = enfocables[0];
    const fin = enfocables[enfocables.length - 1];
    if (e.shiftKey && document.activeElement === inicio) {
      e.preventDefault();
      fin.focus();
    } else if (!e.shiftKey && document.activeElement === fin) {
      e.preventDefault();
      inicio.focus();
    }
  };
  document.addEventListener("keydown", onTecla);

  return function desactivar() {
    document.removeEventListener("keydown", onTecla);
    if (disparador instanceof HTMLElement) disparador.focus({ preventScroll: true });
  };
}

let desactivarAccesibilidadDetalle = null;

function renderizarEtiquetasDetalle(etiquetas) {
  if (!etiquetas || etiquetas.length === 0) {
    detalleEtiquetas.innerHTML = "";
    detalleEtiquetas.hidden = true;
    return;
  }
  detalleEtiquetas.hidden = false;
  detalleEtiquetas.innerHTML = etiquetas
    .map((e) => `<span class="etiqueta-chip">${escaparHTML(ETIQUETAS_TEXTO[e] || e)}</span>`)
    .join("");
}

export async function abrirDetalle(id) {
  const yaEstabaAbierta = !hojaDetalle.hidden;
  cerrarFormulario();
  cerrarInfo();
  cerrarFiltro();
  salirModoAñadir();
  if (alAbrirDetalleOFormulario) alAbrirDetalleOFormulario();
  idDetalleActual = id;

  // Si ya lo teníamos cargado (está visible en el mapa), lo mostramos al
  // instante; si no (p. ej. un baño oculto abierto desde el panel de
  // moderación), cargarDetalle() rellena estos mismos campos igualmente.
  const datosBasicos = datosLavabos.get(id);
  detalleNombre.textContent = datosBasicos ? datosBasicos.nombre || "Baño público" : "";
  detalleDescripcion.textContent = datosBasicos ? datosBasicos.descripcion || "Sin instrucciones adicionales." : "";
  renderizarEtiquetasDetalle(datosBasicos ? datosBasicos.etiquetas : []);
  if (datosBasicos) {
    detalleBtnLlegar.dataset.lat = datosBasicos.lat;
    detalleBtnLlegar.dataset.lng = datosBasicos.lng;
  }
  detalleBtnEditar.hidden = true;
  detalleBtnEliminar.hidden = true;

  hojaDetalle.hidden = false;
  if (!yaEstabaAbierta) {
    desactivarAccesibilidadDetalle = activarAccesibilidadHoja(hojaDetalle, cerrarDetalle);
  }
  actualizarBarraAnuncio();
  await cargarDetalle(id);
}

export function cerrarDetalle() {
  hojaDetalle.hidden = true;
  idDetalleActual = null;
  if (desactivarAccesibilidadDetalle) {
    desactivarAccesibilidadDetalle();
    desactivarAccesibilidadDetalle = null;
  }
  actualizarBarraAnuncio();
}

btnCerrarDetalle.addEventListener("click", cerrarDetalle);

// --- Información sobre la app (icono "?" en el mapa) ---
const hojaInfo = document.getElementById("hoja-info");
const btnCerrarInfo = document.getElementById("btn-cerrar-info");

let desactivarAccesibilidadInfo = null;

export function cerrarInfo() {
  hojaInfo.hidden = true;
  if (desactivarAccesibilidadInfo) {
    desactivarAccesibilidadInfo();
    desactivarAccesibilidadInfo = null;
  }
  actualizarBarraAnuncio();
}

btnCerrarInfo.addEventListener("click", cerrarInfo);

function abrirInfo() {
  cerrarDetalle();
  cerrarFormulario();
  cerrarFiltro();
  if (alAbrirDetalleOFormulario) alAbrirDetalleOFormulario();
  hojaInfo.hidden = false;
  desactivarAccesibilidadInfo = activarAccesibilidadHoja(hojaInfo, cerrarInfo);
  actualizarBarraAnuncio();
}

const BotonInfo = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("button", "boton-mapa boton-info");
    btn.type = "button";
    btn.title = "Información sobre la app";
    btn.setAttribute("aria-label", btn.title);
    btn.textContent = "?";
    L.DomEvent.disableClickPropagation(btn);
    btn.addEventListener("click", abrirInfo);
    return btn;
  },
});

document.getElementById("btn-pie-acerca").addEventListener("click", abrirInfo);
map.addControl(new BotonInfo());

// --- Filtrar baños por etiquetas ---
const hojaFiltro = document.getElementById("hoja-filtro");
const btnCerrarFiltro = document.getElementById("btn-cerrar-filtro");
const btnLimpiarFiltro = document.getElementById("btn-limpiar-filtro");
inicializarSelectorEtiquetas(hojaFiltro);

let desactivarAccesibilidadFiltro = null;
let etiquetasFiltroActivas = [];
let contadorFiltro = null; // se crea al construir el botón del mapa

function marcadorCumpleFiltro(datos) {
  return etiquetasFiltroActivas.every((e) => (datos.etiquetas || []).includes(e));
}

function actualizarVisibilidadMarcador(id) {
  const marcador = marcadores.get(id);
  const datos = datosLavabos.get(id);
  if (!marcador || !datos) return;
  const debeVerse = marcadorCumpleFiltro(datos);
  const visible = grupoMarcadores.hasLayer(marcador);
  if (debeVerse && !visible) grupoMarcadores.addLayer(marcador);
  if (!debeVerse && visible) grupoMarcadores.removeLayer(marcador);
}

function aplicarFiltroATodos() {
  for (const id of marcadores.keys()) actualizarVisibilidadMarcador(id);
}

function actualizarBadgeFiltro() {
  if (!contadorFiltro) return;
  contadorFiltro.textContent = String(etiquetasFiltroActivas.length);
  contadorFiltro.hidden = etiquetasFiltroActivas.length === 0;
}

function alCambiarFiltro() {
  etiquetasFiltroActivas = obtenerEtiquetasSeleccionadas(hojaFiltro);
  aplicarFiltroATodos();
  actualizarBadgeFiltro();
}
hojaFiltro.querySelectorAll(".etiqueta-boton").forEach((b) => b.addEventListener("click", alCambiarFiltro));

btnLimpiarFiltro.addEventListener("click", () => {
  establecerEtiquetasSeleccionadas(hojaFiltro, []);
  alCambiarFiltro();
});

export function cerrarFiltro() {
  hojaFiltro.hidden = true;
  if (desactivarAccesibilidadFiltro) {
    desactivarAccesibilidadFiltro();
    desactivarAccesibilidadFiltro = null;
  }
}

btnCerrarFiltro.addEventListener("click", cerrarFiltro);

const BotonFiltro = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("button", "boton-mapa boton-filtro");
    btn.type = "button";
    btn.title = "Filtrar por etiquetas";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = '<img src="icons/lupa.svg" class="icono-control-mapa icono-lupa" alt="" />';
    contadorFiltro = document.createElement("span");
    contadorFiltro.className = "contador-moderacion";
    contadorFiltro.hidden = true;
    btn.appendChild(contadorFiltro);
    L.DomEvent.disableClickPropagation(btn);
    btn.addEventListener("click", () => {
      cerrarDetalle();
      cerrarFormulario();
      cerrarInfo();
      if (alAbrirDetalleOFormulario) alAbrirDetalleOFormulario();
      hojaFiltro.hidden = false;
      desactivarAccesibilidadFiltro = activarAccesibilidadHoja(hojaFiltro, cerrarFiltro);
    });
    return btn;
  },
});
map.addControl(new BotonFiltro());

detalleBtnLlegar.addEventListener("click", (e) => {
  const { lat, lng } = e.currentTarget.dataset;
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, "_blank", "noopener");
});

detalleBtnReportar.addEventListener("click", () => {
  if (idDetalleActual) reportarLavabo(idDetalleActual);
});

detalleBtnEditar.addEventListener("click", () => {
  if (idDetalleActual) abrirFormularioEdicion(idDetalleActual);
});

detalleBtnEliminar.addEventListener("click", async () => {
  if (!idDetalleActual) return;
  const confirmado = await confirmarAccion(
    "¿Eliminar definitivamente este baño? Esta acción no se puede deshacer."
  );
  if (!confirmado) return;
  const id = idDetalleActual;
  detalleBtnEliminar.disabled = true;
  try {
    await peticionJSON(`/api/banos/${id}`, { method: "DELETE" });
    quitarMarcador(id);
    mostrarToast("Baño eliminado.", "success");
    cerrarDetalle();
  } catch (err) {
    console.error(err);
    mostrarToast(err.message || "No se pudo eliminar el baño.", "error");
  } finally {
    detalleBtnEliminar.disabled = false;
  }
});

let ultimosComentarios = [];
let comentarioEditandoId = null;
let ultimoDetalleCargado = null; // respaldo para editar baños ocultos (no están en datosLavabos)

async function cargarDetalle(id) {
  comentarioEditandoId = null;
  try {
    const detalle = await peticionJSON(`/api/banos/${id}`);
    if (idDetalleActual !== id) return; // se cambió de baño mientras cargaba

    ultimoDetalleCargado = detalle;
    detalleNombre.textContent = detalle.nombre || "Baño público";
    detalleDescripcion.textContent = detalle.descripcion || "Sin instrucciones adicionales.";
    renderizarEtiquetasDetalle(detalle.etiquetas);
    detalleBtnLlegar.dataset.lat = detalle.lat;
    detalleBtnLlegar.dataset.lng = detalle.lng;
    detalleBtnEditar.hidden = !detalle.esModerador;
    detalleBtnEliminar.hidden = !detalle.esModerador;
    pintarPromedio(detalle.promedio, detalle.totalValoraciones);
    pintarEstrellasUsuario(id, detalle.miValoracion);
    ultimosComentarios = detalle.comentarios;
    renderizarComentarios(id);
  } catch (err) {
    console.error(err);
    mostrarToast(err.message || "No se pudo cargar este baño.", "error");
  }
}

function pintarPromedio(promedio, total) {
  if (total === 0) {
    detallePromedio.textContent = "Aún sin valoraciones. ¡Sé el primero!";
    detallePromedio.removeAttribute("aria-label");
    detallePromedio.classList.remove("promedio-bueno", "promedio-malo");
    return;
  }

  // Redondeado a 1 decimal para evitar arrastrar errores de coma flotante
  // (p.ej. 12/5 = 2.4000000000000004) al calcular cuántos iconos enteros mostrar.
  const valor = Math.round(promedio * 10) / 10;
  const esBueno = valor > UMBRAL_ESTRELLAS_BUENO;
  const emoji = esBueno ? "🌸" : "💩";

  const enteros = Math.floor(valor);
  const fraccion = valor - enteros;

  let iconosHTML = "";
  for (let i = 0; i < enteros; i++) {
    iconosHTML += `<span class="icono-valoracion">${emoji}</span>`;
  }
  if (fraccion > 0.05) {
    const relleno = Math.round(fraccion * 100);
    iconosHTML += `<span class="icono-parcial" style="--relleno:${relleno}%"><span class="icono-valoracion">${emoji}</span></span>`;
  }

  // Los emojis son puramente decorativos (💩/🌸 repetidos); para quien usa
  // lector de pantalla dejamos en su lugar una frase clara con aria-label.
  detallePromedio.innerHTML = `
    <span class="iconos-valoracion" aria-hidden="true">${iconosHTML}</span>
    <span aria-hidden="true">${valor.toFixed(1)} (${total})</span>
  `;
  detallePromedio.setAttribute(
    "aria-label",
    `Valoración media: ${valor.toFixed(1)} sobre 5, ${esBueno ? "buena" : "mala"}, con ${total} valoracion${total === 1 ? "" : "es"}`
  );
  detallePromedio.classList.toggle("promedio-bueno", esBueno);
  detallePromedio.classList.toggle("promedio-malo", !esBueno);
}

function pintarEstrellasUsuario(id, valorActual) {
  detalleEstrellasUsuario.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "estrella-boton";
    btn.textContent = i <= valorActual ? "★" : "☆";
    btn.title = `Puntuar con ${i} estrella${i > 1 ? "s" : ""}`;
    btn.setAttribute("aria-label", btn.title);
    btn.addEventListener("click", () => enviarValoracion(id, i));
    detalleEstrellasUsuario.appendChild(btn);
  }
}

async function enviarValoracion(id, estrellas) {
  const botones = detalleEstrellasUsuario.querySelectorAll("button");
  botones.forEach((b) => (b.disabled = true));
  try {
    await peticionJSON(`/api/banos/${id}/valoraciones`, {
      method: "PUT",
      body: JSON.stringify({ estrellas }),
    });
    await cargarDetalle(id);
  } catch (err) {
    console.error(err);
    mostrarToast(err.message || "No se pudo guardar tu puntuación.", "error");
  } finally {
    botones.forEach((b) => (b.disabled = false));
  }
}

function renderizarComentarios(id) {
  if (ultimosComentarios.length === 0) {
    listaComentarios.innerHTML = `<p class="sin-comentarios">Todavía no hay comentarios.</p>`;
    return;
  }

  listaComentarios.innerHTML = ultimosComentarios
    .map((c) => {
      if (String(c.id) === String(comentarioEditandoId)) {
        return `
          <div class="comentario-editando">
            <textarea class="input-editar-comentario" maxlength="400" rows="2">${escaparHTML(c.texto)}</textarea>
            <div class="editar-comentario-acciones">
              <button type="button" class="btn-cancelar-comentario" data-id="${c.id}">Cancelar</button>
              <button type="button" class="btn-guardar-comentario" data-id="${c.id}">Guardar</button>
            </div>
          </div>
        `;
      }
      return `
        <div class="comentario">
          <div class="comentario-cuerpo">
            <p>${escaparHTML(c.texto)}</p>
            <span class="comentario-fecha">${formatearFechaRelativa(c.creadoEn)}</span>
          </div>
          ${
            c.esPropio
              ? `<div class="comentario-acciones-propias">
                   <button type="button" class="btn-editar-comentario" data-id="${c.id}">Editar</button>
                   <button type="button" class="btn-borrar-comentario" data-id="${c.id}">Eliminar</button>
                 </div>`
              : ""
          }
        </div>
      `;
    })
    .join("");

  listaComentarios.querySelectorAll(".btn-borrar-comentario").forEach((btn) => {
    btn.addEventListener("click", () => borrarComentario(id, btn.dataset.id));
  });
  listaComentarios.querySelectorAll(".btn-editar-comentario").forEach((btn) => {
    btn.addEventListener("click", () => {
      comentarioEditandoId = btn.dataset.id;
      renderizarComentarios(id);
    });
  });
  listaComentarios.querySelectorAll(".btn-cancelar-comentario").forEach((btn) => {
    btn.addEventListener("click", () => {
      comentarioEditandoId = null;
      renderizarComentarios(id);
    });
  });
  listaComentarios.querySelectorAll(".btn-guardar-comentario").forEach((btn) => {
    btn.addEventListener("click", (e) => guardarEdicionComentario(id, btn.dataset.id, e.currentTarget));
  });
}

async function guardarEdicionComentario(idBano, idComentario, btnGuardar) {
  const contenedor = btnGuardar.closest(".comentario-editando");
  const nuevoTexto = contenedor.querySelector("textarea").value.trim();
  if (!nuevoTexto) return;

  btnGuardar.disabled = true;
  try {
    const turnstile_token = await obtenerTokenHumanoOAvisar();
    await peticionJSON(`/api/banos/${idBano}/comentarios/${idComentario}`, {
      method: "PUT",
      body: JSON.stringify({ texto: nuevoTexto, turnstile_token }),
    });
    await cargarDetalle(idBano);
  } catch (err) {
    console.error(err);
    mostrarToast(err.message || "No se pudo editar el comentario.", "error");
    btnGuardar.disabled = false;
  }
}

async function borrarComentario(idBano, idComentario) {
  const confirmado = await confirmarAccion("¿Eliminar este comentario?");
  if (!confirmado) return;
  try {
    await peticionJSON(`/api/banos/${idBano}/comentarios/${idComentario}`, { method: "DELETE" });
    await cargarDetalle(idBano);
  } catch (err) {
    console.error(err);
    mostrarToast(err.message || "No se pudo eliminar el comentario.", "error");
  }
}

formComentario.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!idDetalleActual) return;

  const texto = formComentario.elements["comentario"].value.trim();
  if (!texto) return;

  const btnEnviar = formComentario.querySelector("button[type=submit]");
  btnEnviar.disabled = true;
  try {
    const turnstile_token = await obtenerTokenHumanoOAvisar();
    await peticionJSON(`/api/banos/${idDetalleActual}/comentarios`, {
      method: "POST",
      body: JSON.stringify({ texto, turnstile_token }),
    });
    formComentario.reset();
    await cargarDetalle(idDetalleActual);
  } catch (err) {
    console.error(err);
    mostrarToast(err.message || "No se pudo publicar el comentario.", "error");
  } finally {
    btnEnviar.disabled = false;
  }
});

// --- Reportar como falso/inaccesible ---
function listaReportados() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_REPORTADOS) || "[]");
  } catch {
    return [];
  }
}

function yaReportado(id) {
  return listaReportados().includes(id);
}

function marcarComoReportado(id) {
  const lista = listaReportados();
  lista.push(id);
  localStorage.setItem(CLAVE_REPORTADOS, JSON.stringify(lista));
}

const hojaMotivoReporte = document.getElementById("hoja-motivo-reporte");
const btnCancelarMotivo = document.getElementById("btn-cancelar-motivo");
const btnEnviarMotivo = document.getElementById("btn-enviar-motivo");
const motivoComentario = document.getElementById("motivo-comentario");

function elegirMotivoReporte() {
  return new Promise((resolve) => {
    // Se oculta la ficha del baño mientras se elige el motivo: al ser las
    // dos hojas de altura distinta y ambas fijas al borde inferior, tenerlas
    // abiertas a la vez dejaba la cabecera de la ficha asomando por encima
    // (muy visible en pantallas de móvil, con menos alto disponible). Como
    // esto oculta hojaDetalle sin pasar por cerrarDetalle(), su atrapa-foco
    // se desactiva y reactiva aquí a mano para que no queden dos a la vez.
    hojaDetalle.hidden = true;
    if (desactivarAccesibilidadDetalle) {
      desactivarAccesibilidadDetalle();
      desactivarAccesibilidadDetalle = null;
    }
    actualizarBarraAnuncio();
    hojaMotivoReporte.hidden = false;
    motivoComentario.value = "";
    btnEnviarMotivo.disabled = true;
    let motivoSeleccionado = null;
    const botones = hojaMotivoReporte.querySelectorAll(".motivo-boton");
    botones.forEach((b) => b.classList.remove("activo"));

    const limpiar = (resultado) => {
      hojaMotivoReporte.hidden = true;
      desactivarAccesibilidadMotivo();
      hojaDetalle.hidden = false;
      desactivarAccesibilidadDetalle = activarAccesibilidadHoja(hojaDetalle, cerrarDetalle);
      actualizarBarraAnuncio();
      botones.forEach((b) => b.removeEventListener("click", onClickMotivo));
      btnEnviarMotivo.removeEventListener("click", onEnviar);
      btnCancelarMotivo.removeEventListener("click", onCancelar);
      resolve(resultado);
    };
    const onClickMotivo = (e) => {
      motivoSeleccionado = e.currentTarget.dataset.motivo;
      botones.forEach((b) => b.classList.toggle("activo", b === e.currentTarget));
      btnEnviarMotivo.disabled = false;
    };
    const onEnviar = () => {
      if (!motivoSeleccionado) return;
      limpiar({ motivo: motivoSeleccionado, comentario: motivoComentario.value.trim() });
    };
    const onCancelar = () => limpiar(null);
    const desactivarAccesibilidadMotivo = activarAccesibilidadHoja(hojaMotivoReporte, onCancelar);

    botones.forEach((b) => b.addEventListener("click", onClickMotivo));
    btnEnviarMotivo.addEventListener("click", onEnviar);
    btnCancelarMotivo.addEventListener("click", onCancelar);
  });
}

async function reportarLavabo(id) {
  if (yaReportado(id)) {
    mostrarToast("Ya has reportado este baño anteriormente.", "info");
    return;
  }
  const resultado = await elegirMotivoReporte();
  if (!resultado) return;

  detalleBtnReportar.disabled = true;
  try {
    const turnstile_token = await obtenerTokenHumanoOAvisar();
    await peticionJSON(`/api/banos/${id}/reportar`, {
      method: "POST",
      body: JSON.stringify({ ...resultado, turnstile_token }),
    });
    marcarComoReportado(id);
    quitarMarcador(id);
    mostrarToast("Gracias, hemos registrado tu reporte.", "success");
  } catch (err) {
    if (err.status === 409) {
      marcarComoReportado(id);
      mostrarToast("Ya has reportado este baño anteriormente.", "info");
      return;
    }
    console.error(err);
    mostrarToast(err.message || "No se pudo enviar el reporte. Inténtalo de nuevo.", "error");
  } finally {
    detalleBtnReportar.disabled = false;
  }
}

// --- Añadir un baño nuevo ---
const btnAñadir = document.getElementById("btn-añadir");
const avisoModoAñadir = document.getElementById("aviso-modo-añadir");
const hojaFormulario = document.getElementById("hoja-formulario");
const formLavabo = document.getElementById("form-lavabo");
const btnCancelarForm = document.getElementById("btn-cancelar-form");
const btnUsarUbicacion = document.getElementById("btn-usar-ubicacion");
const mapaEl = document.getElementById("map");
const formularioTitulo = document.getElementById("form-lavabo-titulo");
const formularioBtnGuardar = formLavabo.querySelector("button[type=submit]");
inicializarSelectorEtiquetas(formLavabo);

let modoAñadir = false;
let marcadorTemporal = null;
let modoEdicionId = null;

function salirModoAñadir() {
  modoAñadir = false;
  btnAñadir.classList.remove("activo");
  avisoModoAñadir.hidden = true;
  mapaEl.classList.remove("modo-añadir");
}

btnAñadir.addEventListener("click", () => {
  modoAñadir = !modoAñadir;
  btnAñadir.classList.toggle("activo", modoAñadir);
  avisoModoAñadir.hidden = !modoAñadir;
  mapaEl.classList.toggle("modo-añadir", modoAñadir);
  if (modoAñadir) {
    cerrarDetalle();
    cerrarInfo();
    cerrarFiltro();
  }
});

map.on("click", (e) => {
  if (!modoAñadir) return;
  abrirFormulario(e.latlng);
});

btnUsarUbicacion.addEventListener("click", () => {
  if (!navigator.geolocation) {
    mostrarToast("Tu navegador no permite obtener la ubicación.", "error");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => abrirFormulario(L.latLng(pos.coords.latitude, pos.coords.longitude)),
    () => mostrarToast("No se pudo obtener tu ubicación.", "error"),
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

let desactivarAccesibilidadFormulario = null;

function abrirFormulario(latlng) {
  const yaEstabaAbierta = !hojaFormulario.hidden;
  salirModoAñadir();
  cerrarInfo();
  cerrarFiltro();
  modoEdicionId = null;
  formularioTitulo.textContent = "Añadir baño público";
  formularioBtnGuardar.textContent = "Guardar";

  if (marcadorTemporal) map.removeLayer(marcadorTemporal);
  marcadorTemporal = L.marker(latlng, {
    icon: iconoSistema,
    draggable: true,
    opacity: 0.85,
  }).addTo(map);

  formLavabo.dataset.lat = latlng.lat;
  formLavabo.dataset.lng = latlng.lng;

  marcadorTemporal.on("dragend", () => {
    const pos = marcadorTemporal.getLatLng();
    formLavabo.dataset.lat = pos.lat;
    formLavabo.dataset.lng = pos.lng;
  });

  formLavabo.reset();
  establecerEtiquetasSeleccionadas(formLavabo, []);
  if (prepararSelectorIcono) prepararSelectorIcono(null);
  hojaFormulario.hidden = false;
  if (!yaEstabaAbierta) {
    desactivarAccesibilidadFormulario = activarAccesibilidadHoja(hojaFormulario, cerrarFormulario);
  }
}

export async function abrirFormularioEdicion(id) {
  const yaEstabaAbierta = !hojaFormulario.hidden;
  let datos = datosLavabos.get(id) || (ultimoDetalleCargado && String(ultimoDetalleCargado.id) === id ? ultimoDetalleCargado : null);
  if (!datos) {
    // Ej: un baño oculto abierto para editar directamente desde el panel de
    // moderación, sin haber visto antes su ficha.
    try {
      datos = await peticionJSON(`/api/banos/${id}`);
    } catch (err) {
      mostrarToast(err.message || "No se pudo cargar este baño.", "error");
      return;
    }
  }

  cerrarDetalle();
  cerrarFiltro();
  cerrarInfo();
  if (alAbrirDetalleOFormulario) alAbrirDetalleOFormulario();
  salirModoAñadir();
  modoEdicionId = id;
  formularioTitulo.textContent = "Editar baño público";
  formularioBtnGuardar.textContent = "Guardar cambios";

  const latlng = L.latLng(datos.lat, datos.lng);
  if (marcadorTemporal) map.removeLayer(marcadorTemporal);
  marcadorTemporal = L.marker(latlng, {
    icon: elegirIcono(datos),
    draggable: true,
    opacity: 0.85,
  }).addTo(map);
  map.panTo(latlng);

  formLavabo.dataset.lat = latlng.lat;
  formLavabo.dataset.lng = latlng.lng;

  marcadorTemporal.on("dragend", () => {
    const pos = marcadorTemporal.getLatLng();
    formLavabo.dataset.lat = pos.lat;
    formLavabo.dataset.lng = pos.lng;
  });

  formLavabo.reset();
  formLavabo.elements["nombre"].value = datos.nombre || "";
  formLavabo.elements["descripcion"].value = datos.descripcion || "";
  establecerEtiquetasSeleccionadas(formLavabo, datos.etiquetas);
  if (prepararSelectorIcono) prepararSelectorIcono(datos);
  hojaFormulario.hidden = false;
  if (!yaEstabaAbierta) {
    desactivarAccesibilidadFormulario = activarAccesibilidadHoja(hojaFormulario, cerrarFormulario);
  }
}

export function cerrarFormulario() {
  hojaFormulario.hidden = true;
  modoEdicionId = null;
  if (marcadorTemporal) {
    map.removeLayer(marcadorTemporal);
    marcadorTemporal = null;
  }
  if (desactivarAccesibilidadFormulario) {
    desactivarAccesibilidadFormulario();
    desactivarAccesibilidadFormulario = null;
  }
}

btnCancelarForm.addEventListener("click", cerrarFormulario);

formLavabo.addEventListener("submit", async (e) => {
  e.preventDefault();

  const nombre = formLavabo.elements["nombre"].value.trim();
  const descripcion = formLavabo.elements["descripcion"].value.trim();
  const lat = parseFloat(formLavabo.dataset.lat);
  const lng = parseFloat(formLavabo.dataset.lng);
  const etiquetas = obtenerEtiquetasSeleccionadas(formLavabo);

  if (!nombre || Number.isNaN(lat) || Number.isNaN(lng)) return;

  const btnGuardar = formLavabo.querySelector("button[type=submit]");
  btnGuardar.disabled = true;
  try {
    if (modoEdicionId) {
      const cuerpo = { nombre, descripcion, lat, lng, etiquetas };
      if (obtenerIconoSeleccionado) cuerpo.icono = obtenerIconoSeleccionado();
      const resultado = await peticionJSON(`/api/banos/${modoEdicionId}`, {
        method: "PUT",
        body: JSON.stringify(cuerpo),
      });
      añadirOActualizarMarcador({
        id: modoEdicionId,
        nombre,
        descripcion,
        lat,
        lng,
        icono: resultado.icono,
        tipoIcono: resultado.tipoIcono,
        etiquetas: resultado.etiquetas,
      });
      if (idDetalleActual === String(modoEdicionId)) renderizarEtiquetasDetalle(resultado.etiquetas);
      mostrarToast("Baño actualizado.", "success");
    } else {
      const turnstile_token = await obtenerTokenHumanoOAvisar();
      const resultado = await peticionJSON("/api/banos", {
        method: "POST",
        body: JSON.stringify({ nombre, descripcion, lat, lng, etiquetas, turnstile_token }),
      });
      añadirOActualizarMarcador({
        id: resultado.id,
        nombre,
        descripcion,
        lat,
        lng,
        icono: resultado.icono,
        tipoIcono: resultado.tipoIcono,
        etiquetas: resultado.etiquetas,
      });
      mostrarToast("¡Gracias! El baño se ha añadido al mapa.", "success");
    }
    cerrarFormulario();
  } catch (err) {
    console.error(err);
    mostrarToast(err.message || "No se pudo guardar. Comprueba tu conexión e inténtalo de nuevo.", "error");
  } finally {
    btnGuardar.disabled = false;
  }
});

// --- Aviso / toast / confirmación ---
let toastTimeout;
// La duración por defecto escala con la longitud del mensaje (mínimo 4s):
// los avisos cortos de siempre no cambian, pero uno largo como el de
// Turnstile bloqueado (~240 caracteres) se queda visible el tiempo de
// leerlo en vez de desaparecer a los 4 segundos.
export function mostrarToast(mensaje, tipo = "info", duracion = Math.max(4000, mensaje.length * 60)) {
  const toast = document.getElementById("toast");
  toast.textContent = mensaje;
  toast.className = `toast toast-${tipo} visible`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), duracion);
}

export const modalOverlay = document.getElementById("modal-overlay");
const modalTexto = document.getElementById("modal-texto");
const modalBtnCancelar = document.getElementById("modal-btn-cancelar");
const modalBtnConfirmar = document.getElementById("modal-btn-confirmar");

export function confirmarAccion(mensaje) {
  return new Promise((resolve) => {
    const disparador = document.activeElement;
    modalTexto.textContent = mensaje;
    modalOverlay.hidden = false;
    modalBtnCancelar.focus();

    const limpiar = (resultado) => {
      modalOverlay.hidden = true;
      modalBtnConfirmar.removeEventListener("click", onConfirmar);
      modalBtnCancelar.removeEventListener("click", onCancelar);
      modalOverlay.removeEventListener("click", onClicFuera);
      document.removeEventListener("keydown", onTecla);
      if (disparador instanceof HTMLElement) disparador.focus();
      resolve(resultado);
    };
    const onConfirmar = () => limpiar(true);
    const onCancelar = () => limpiar(false);
    const onClicFuera = (e) => {
      if (e.target === modalOverlay) limpiar(false);
    };
    const onTecla = (e) => {
      if (e.key === "Escape") {
        limpiar(false);
        return;
      }
      // Trampa de foco sencilla: solo hay dos botones, así que Tab/Shift+Tab
      // se limita a alternar entre ellos en vez de escapar del modal.
      if (e.key === "Tab") {
        e.preventDefault();
        const enCancelar = document.activeElement === modalBtnCancelar;
        (enCancelar ? modalBtnConfirmar : modalBtnCancelar).focus();
      }
    };

    modalBtnConfirmar.addEventListener("click", onConfirmar);
    modalBtnCancelar.addEventListener("click", onCancelar);
    modalOverlay.addEventListener("click", onClicFuera);
    document.addEventListener("keydown", onTecla);
  });
}

// --- Cerrar hojas al tocar/hacer clic fuera de ellas ---
// Se escucha en fase de captura (el 3er argumento "true") para que esto se
// resuelva ANTES que el propio click que abre otra hoja (p. ej. tocar un
// marcador distinto mientras hay una ficha abierta): así se cierra la hoja
// vieja primero y luego el propio manejador del marcador abre la nueva, en
// vez de abrirla y que este listener la cierre justo después por error.
// Si hay un modal de confirmación abierto, se deja que él gestione su
// propio cierre al tocar fuera.
function esClicEnMarcadorTemporal(objetivo) {
  const el = marcadorTemporal && marcadorTemporal.getElement();
  return !!el && el.contains(objetivo);
}

document.addEventListener(
  "click",
  (e) => {
    if (!modalOverlay.hidden) return;
    if (esClicEnMarcadorTemporal(e.target)) return; // arrastrar el pin del formulario no debe cerrarlo
    if (!hojaDetalle.hidden && !hojaDetalle.contains(e.target)) cerrarDetalle();
    if (!hojaFormulario.hidden && !hojaFormulario.contains(e.target)) cerrarFormulario();
    if (!hojaInfo.hidden && !hojaInfo.contains(e.target)) cerrarInfo();
    if (!hojaFiltro.hidden && !hojaFiltro.contains(e.target)) cerrarFiltro();
    if (!hojaMotivoReporte.hidden && !hojaMotivoReporte.contains(e.target)) {
      btnCancelarMotivo.click();
    }
  },
  true
);

// --- Cookies / anuncios ---
// De momento AD_SENSE_CLIENTE es null (aún no hay cuenta de AdSense aprobada), así que
// esta sección no hace nada visible hasta que se rellene con el ID real
// (ca-pub-XXXXXXXXXXXXXXXX) y se complete cargarAnuncioEnBarra()/cargarAnuncioEnContenido()
// con el bloque de anuncio correspondiente.
//
// Hay dos huecos de anuncio, con reglas distintas para no repetir el motivo de rechazo de
// AdSense ("anuncios en pantallas sin contenido de editor"):
//  - la barra fija de abajo (#espacio-anuncio) solo se muestra mientras hay una hoja con
//    contenido real abierta (la ficha de un baño o "Sobre Meaquí"); se oculta en cuanto se
//    cierran, así nunca queda flotando sobre el mapa desnudo.
//  - el anuncio en medio del texto "¿Por qué he creado esta app?" (#anuncio-contenido) se
//    activa una sola vez, al dar el consentimiento, porque ahí el contenido de alrededor es
//    siempre el mismo.
const AD_SENSE_CLIENTE = null;
const CLAVE_CONSENTIMIENTO_ANUNCIOS = "consentimiento_anuncios";

const avisoCookies = document.getElementById("aviso-cookies");
const btnAceptarCookies = document.getElementById("btn-aceptar-cookies");
const btnRechazarCookies = document.getElementById("btn-rechazar-cookies");
const espacioAnuncio = document.getElementById("espacio-anuncio");
const anuncioContenido = document.getElementById("anuncio-contenido");

let anunciosPermitidos = false;
let barraAnuncioCargada = false;

function cargarAnuncioEnContenido() {
  if (!AD_SENSE_CLIENTE) return;
  anuncioContenido.hidden = false;
  // TODO: insertar aquí el <ins class="adsbygoogle"> del anuncio en el texto.
}

// Se llama cada vez que se abre o se cierra la ficha de un baño o "Sobre Meaquí", para que
// la barra aparezca y desaparezca con ellas en vez de quedarse fija todo el rato.
function actualizarBarraAnuncio() {
  if (!AD_SENSE_CLIENTE || !anunciosPermitidos) return;
  const hayContenidoAbierto = !hojaDetalle.hidden || !hojaInfo.hidden;
  espacioAnuncio.hidden = !hayContenidoAbierto;
  document.body.classList.toggle("con-anuncio", hayContenidoAbierto);
  if (hayContenidoAbierto && !barraAnuncioCargada) {
    barraAnuncioCargada = true;
    // TODO: insertar aquí el <ins class="adsbygoogle"> de la barra.
  }
}

function activarAnuncios() {
  anunciosPermitidos = true;
  cargarAnuncioEnContenido();
  actualizarBarraAnuncio();
}

if (AD_SENSE_CLIENTE) {
  const consentimiento = localStorage.getItem(CLAVE_CONSENTIMIENTO_ANUNCIOS);
  if (consentimiento === "aceptado") {
    activarAnuncios();
  } else if (consentimiento !== "rechazado") {
    avisoCookies.hidden = false;
  }
}

btnAceptarCookies.addEventListener("click", () => {
  localStorage.setItem(CLAVE_CONSENTIMIENTO_ANUNCIOS, "aceptado");
  avisoCookies.hidden = true;
  activarAnuncios();
});

btnRechazarCookies.addEventListener("click", () => {
  localStorage.setItem(CLAVE_CONSENTIMIENTO_ANUNCIOS, "rechazado");
  avisoCookies.hidden = true;
});

// --- Service worker (PWA) ---
const avisoActualizacion = document.getElementById("aviso-actualizacion");
const btnRecargarActualizacion = document.getElementById("btn-recargar-actualizacion");

btnRecargarActualizacion.addEventListener("click", () => window.location.reload());

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((registro) => {
        registro.addEventListener("updatefound", () => {
          const nuevoWorker = registro.installing;
          if (!nuevoWorker) return;
          nuevoWorker.addEventListener("statechange", () => {
            if (nuevoWorker.state === "installed" && navigator.serviceWorker.controller) {
              avisoActualizacion.hidden = false;
            }
          });
        });
      })
      .catch((err) => console.warn("SW no registrado:", err));
  });
}
