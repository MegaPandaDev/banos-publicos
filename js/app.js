import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  doc,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const COLECCION = "banos";
const UMBRAL_REPORTES = 3;
const UMBRAL_ESTRELLAS_BUENO = 3;
const CLAVE_REPORTADOS = "banos_reportados";
const CENTRO_POR_DEFECTO = [40.4168, -3.7038]; // Madrid, por si no hay geolocalización
const ZOOM_POR_DEFECTO = 6;

// --- Firebase ---
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

let db;
try {
  db = initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (err) {
  console.warn("Persistencia offline no disponible:", err);
  db = getFirestore(firebaseApp);
}

let uidActual = null;
onAuthStateChanged(auth, (user) => {
  uidActual = user ? user.uid : null;
});
signInAnonymously(auth).catch((err) => {
  console.error(err);
  mostrarToast("No se pudo conectar. Revisa tu conexión a internet.", "error");
});

// --- Mapa ---
const map = L.map("map", { zoomControl: false }).setView(CENTRO_POR_DEFECTO, ZOOM_POR_DEFECTO);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

L.control.zoom({ position: "bottomright" }).addTo(map);

const iconoLavabo = L.icon({
  className: "marcador-lavabo",
  iconUrl: "icons/marcador-wc.svg",
  iconSize: [36, 36],
  iconAnchor: [18, 34],
  popupAnchor: [0, -31],
});

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
    btn.innerHTML = "📍";
    L.DomEvent.disableClickPropagation(btn);
    btn.addEventListener("click", () => centrarEnMiUbicacion(true));
    return btn;
  },
});
map.addControl(new BotonUbicacion());

// --- Marcadores desde Firestore ---
const marcadores = new Map(); // id documento -> L.Marker
const datosLavabos = new Map(); // id documento -> datos del documento

function escaparHTML(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}

const lavabosRef = collection(db, COLECCION);
const consultaVisibles = query(lavabosRef, where("oculto", "==", false));
let primerSnapshotBanos = true;

onSnapshot(
  consultaVisibles,
  (snapshot) => {
    snapshot.docChanges().forEach((cambio) => {
      const id = cambio.doc.id;

      if (cambio.type === "removed") {
        if (marcadores.has(id)) {
          map.removeLayer(marcadores.get(id));
          marcadores.delete(id);
        }
        datosLavabos.delete(id);
        if (idDetalleActual === id) {
          cerrarDetalle();
          mostrarToast("Este baño ya no está disponible.", "info");
        }
        return;
      }

      const datos = cambio.doc.data();
      datosLavabos.set(id, datos);

      if (marcadores.has(id)) {
        map.removeLayer(marcadores.get(id));
      }
      const marcador = L.marker([datos.lat, datos.lng], { icon: iconoLavabo }).addTo(map);
      marcador.on("click", (e) => {
        L.DomEvent.stop(e);
        abrirDetalle(id);
      });
      marcadores.set(id, marcador);
    });

    if (primerSnapshotBanos) {
      primerSnapshotBanos = false;
      if (marcadores.size === 0) {
        mostrarToast(
          "No hay baños registrados por aquí todavía. ¡Sé el primero en añadir uno con el botón +!",
          "info",
          6000
        );
      }
    }
  },
  (error) => {
    console.error(error);
    mostrarToast(
      "No se pudieron cargar los baños. Comprueba la configuración de Firebase (js/firebase-config.js).",
      "error"
    );
  }
);

// --- Hoja de detalle: valoraciones y comentarios ---
const hojaDetalle = document.getElementById("hoja-detalle");
const btnCerrarDetalle = document.getElementById("btn-cerrar-detalle");
const detalleNombre = document.getElementById("detalle-nombre");
const detalleDescripcion = document.getElementById("detalle-descripcion");
const detalleBtnLlegar = document.getElementById("detalle-btn-llegar");
const detalleBtnReportar = document.getElementById("detalle-btn-reportar");
const detallePromedio = document.getElementById("detalle-promedio");
const detalleEstrellasUsuario = document.getElementById("detalle-estrellas-usuario");
const listaComentarios = document.getElementById("lista-comentarios");
const formComentario = document.getElementById("form-comentario");

let idDetalleActual = null;
let unsubValoraciones = null;
let unsubComentarios = null;

function abrirDetalle(id) {
  const datos = datosLavabos.get(id);
  if (!datos) return;

  cerrarFormulario();
  salirModoAñadir();
  idDetalleActual = id;
  detalleNombre.textContent = datos.nombre || "Baño público";
  detalleDescripcion.textContent = datos.descripcion || "Sin instrucciones adicionales.";
  detalleBtnLlegar.dataset.lat = datos.lat;
  detalleBtnLlegar.dataset.lng = datos.lng;

  cargarValoraciones(id);
  cargarComentarios(id);

  hojaDetalle.hidden = false;
}

function cerrarDetalle() {
  hojaDetalle.hidden = true;
  idDetalleActual = null;
  if (unsubValoraciones) {
    unsubValoraciones();
    unsubValoraciones = null;
  }
  if (unsubComentarios) {
    unsubComentarios();
    unsubComentarios = null;
  }
}

btnCerrarDetalle.addEventListener("click", cerrarDetalle);

detalleBtnLlegar.addEventListener("click", (e) => {
  const { lat, lng } = e.currentTarget.dataset;
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, "_blank", "noopener");
});

detalleBtnReportar.addEventListener("click", () => {
  if (idDetalleActual) reportarLavabo(idDetalleActual);
});

function cargarValoraciones(id) {
  if (unsubValoraciones) unsubValoraciones();
  const ref = collection(db, COLECCION, id, "valoraciones");
  unsubValoraciones = onSnapshot(ref, (snap) => {
    let suma = 0;
    let miValor = 0;
    snap.forEach((d) => {
      suma += d.data().estrellas;
      if (d.id === uidActual) miValor = d.data().estrellas;
    });
    const total = snap.size;
    const promedio = total ? suma / total : 0;
    pintarPromedio(promedio, total);
    pintarEstrellasUsuario(id, miValor);
  });
}

function pintarPromedio(promedio, total) {
  if (total === 0) {
    detallePromedio.textContent = "Aún sin valoraciones. ¡Sé el primero!";
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

  detallePromedio.innerHTML = `
    <span class="iconos-valoracion">${iconosHTML}</span>
    <span>${valor.toFixed(1)} (${total})</span>
  `;
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
  if (!uidActual) return;
  const botones = detalleEstrellasUsuario.querySelectorAll("button");
  botones.forEach((b) => (b.disabled = true));
  try {
    await setDoc(doc(db, COLECCION, id, "valoraciones", uidActual), {
      estrellas,
      creadoEn: serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
    mostrarToast("No se pudo guardar tu puntuación.", "error");
    botones.forEach((b) => (b.disabled = false));
  }
}

let ultimosComentarios = [];
let comentarioEditandoId = null;

function cargarComentarios(id) {
  if (unsubComentarios) unsubComentarios();
  comentarioEditandoId = null;
  const ref = query(collection(db, COLECCION, id, "comentarios"), orderBy("creadoEn", "desc"));
  unsubComentarios = onSnapshot(
    ref,
    (snap) => {
      ultimosComentarios = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderizarComentarios(id);
    },
    (err) => console.error(err)
  );
}

function renderizarComentarios(id) {
  if (ultimosComentarios.length === 0) {
    listaComentarios.innerHTML = `<p class="sin-comentarios">Todavía no hay comentarios.</p>`;
    return;
  }

  listaComentarios.innerHTML = ultimosComentarios
    .map((c) => {
      if (c.id === comentarioEditandoId) {
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
      const esPropio = c.creadoPor === uidActual;
      return `
        <div class="comentario">
          <p>${escaparHTML(c.texto)}</p>
          ${
            esPropio
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
    await updateDoc(doc(db, COLECCION, idBano, "comentarios", idComentario), { texto: nuevoTexto });
    comentarioEditandoId = null;
    renderizarComentarios(idBano);
  } catch (err) {
    console.error(err);
    mostrarToast("No se pudo editar el comentario.", "error");
    btnGuardar.disabled = false;
  }
}

async function borrarComentario(idBano, idComentario) {
  const confirmado = await confirmarAccion("¿Eliminar este comentario?");
  if (!confirmado) return;
  try {
    await deleteDoc(doc(db, COLECCION, idBano, "comentarios", idComentario));
  } catch (err) {
    console.error(err);
    mostrarToast("No se pudo eliminar el comentario.", "error");
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
    await addDoc(collection(db, COLECCION, idDetalleActual, "comentarios"), {
      texto,
      creadoEn: serverTimestamp(),
      creadoPor: uidActual,
    });
    formComentario.reset();
  } catch (err) {
    console.error(err);
    mostrarToast("No se pudo publicar el comentario.", "error");
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

async function reportarLavabo(id) {
  if (yaReportado(id)) {
    mostrarToast("Ya has reportado este baño anteriormente.", "info");
    return;
  }
  const confirmado = await confirmarAccion(
    "¿Seguro que quieres reportar este baño como falso, inexistente o inaccesible?"
  );
  if (!confirmado) return;

  detalleBtnReportar.disabled = true;
  try {
    const ref = doc(db, COLECCION, id);
    const refReporte = doc(db, COLECCION, id, "reportes", uidActual);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const reportesActuales = (snap.data().reportes || 0) + 1;
      tx.set(refReporte, { creadoEn: serverTimestamp() });
      tx.update(ref, {
        reportes: reportesActuales,
        oculto: reportesActuales >= UMBRAL_REPORTES,
      });
    });
    marcarComoReportado(id);
    if (idDetalleActual === id) cerrarDetalle();
    mostrarToast("Gracias, hemos registrado tu reporte.", "success");
  } catch (err) {
    if (err.code === "permission-denied") {
      marcarComoReportado(id);
      mostrarToast("Ya has reportado este baño anteriormente.", "info");
      return;
    }
    console.error(err);
    mostrarToast("No se pudo enviar el reporte. Inténtalo de nuevo.", "error");
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

let modoAñadir = false;
let marcadorTemporal = null;

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
  if (modoAñadir) cerrarDetalle();
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

function abrirFormulario(latlng) {
  salirModoAñadir();

  if (marcadorTemporal) map.removeLayer(marcadorTemporal);
  marcadorTemporal = L.marker(latlng, {
    icon: iconoLavabo,
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
  hojaFormulario.hidden = false;
}

function cerrarFormulario() {
  hojaFormulario.hidden = true;
  if (marcadorTemporal) {
    map.removeLayer(marcadorTemporal);
    marcadorTemporal = null;
  }
}

btnCancelarForm.addEventListener("click", cerrarFormulario);

formLavabo.addEventListener("submit", async (e) => {
  e.preventDefault();

  const nombre = formLavabo.elements["nombre"].value.trim();
  const descripcion = formLavabo.elements["descripcion"].value.trim();
  const lat = parseFloat(formLavabo.dataset.lat);
  const lng = parseFloat(formLavabo.dataset.lng);

  if (!nombre || Number.isNaN(lat) || Number.isNaN(lng)) return;

  const btnGuardar = formLavabo.querySelector("button[type=submit]");
  btnGuardar.disabled = true;
  try {
    await addDoc(collection(db, COLECCION), {
      nombre,
      descripcion,
      lat,
      lng,
      reportes: 0,
      oculto: false,
      creadoEn: serverTimestamp(),
      creadoPor: uidActual,
    });
    mostrarToast("¡Gracias! El baño se ha añadido al mapa.", "success");
    cerrarFormulario();
  } catch (err) {
    console.error(err);
    mostrarToast("No se pudo guardar. Comprueba tu conexión e inténtalo de nuevo.", "error");
  } finally {
    btnGuardar.disabled = false;
  }
});

// --- Aviso / toast / confirmación ---
let toastTimeout;
function mostrarToast(mensaje, tipo = "info", duracion = 4000) {
  const toast = document.getElementById("toast");
  toast.textContent = mensaje;
  toast.className = `toast toast-${tipo} visible`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), duracion);
}

const modalOverlay = document.getElementById("modal-overlay");
const modalTexto = document.getElementById("modal-texto");
const modalBtnCancelar = document.getElementById("modal-btn-cancelar");
const modalBtnConfirmar = document.getElementById("modal-btn-confirmar");

function confirmarAccion(mensaje) {
  return new Promise((resolve) => {
    modalTexto.textContent = mensaje;
    modalOverlay.hidden = false;

    const limpiar = (resultado) => {
      modalOverlay.hidden = true;
      modalBtnConfirmar.removeEventListener("click", onConfirmar);
      modalBtnCancelar.removeEventListener("click", onCancelar);
      modalOverlay.removeEventListener("click", onClicFuera);
      resolve(resultado);
    };
    const onConfirmar = () => limpiar(true);
    const onCancelar = () => limpiar(false);
    const onClicFuera = (e) => {
      if (e.target === modalOverlay) limpiar(false);
    };

    modalBtnConfirmar.addEventListener("click", onConfirmar);
    modalBtnCancelar.addEventListener("click", onCancelar);
    modalOverlay.addEventListener("click", onClicFuera);
  });
}

// --- Cookies / anuncios ---
// De momento AD_SENSE_CLIENTE es null (aún no hay cuenta de AdSense aprobada), así que
// esta sección no hace nada visible: no se muestra el aviso de cookies ni el hueco de
// anuncio hasta que se rellene con el ID real (ca-pub-XXXXXXXXXXXXXXXX) y se complete
// cargarAnuncio() con el bloque de anuncio correspondiente.
const AD_SENSE_CLIENTE = null;
const CLAVE_CONSENTIMIENTO_ANUNCIOS = "consentimiento_anuncios";

const avisoCookies = document.getElementById("aviso-cookies");
const btnAceptarCookies = document.getElementById("btn-aceptar-cookies");
const btnRechazarCookies = document.getElementById("btn-rechazar-cookies");
const espacioAnuncio = document.getElementById("espacio-anuncio");

function cargarAnuncio() {
  if (!AD_SENSE_CLIENTE) return;
  espacioAnuncio.hidden = false;
  document.body.classList.add("con-anuncio");
  // TODO: insertar aquí el <ins class="adsbygoogle"> con el bloque de anuncio.
}

if (AD_SENSE_CLIENTE) {
  const consentimiento = localStorage.getItem(CLAVE_CONSENTIMIENTO_ANUNCIOS);
  if (consentimiento === "aceptado") {
    cargarAnuncio();
  } else if (consentimiento !== "rechazado") {
    avisoCookies.hidden = false;
  }
}

btnAceptarCookies.addEventListener("click", () => {
  localStorage.setItem(CLAVE_CONSENTIMIENTO_ANUNCIOS, "aceptado");
  avisoCookies.hidden = true;
  cargarAnuncio();
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
