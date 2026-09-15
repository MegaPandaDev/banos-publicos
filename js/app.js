import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  query,
  where,
  doc,
  runTransaction,
  serverTimestamp,
  enableIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const COLECCION = "banos";
const UMBRAL_REPORTES = 3;
const CLAVE_REPORTADOS = "banos_reportados";
const CENTRO_POR_DEFECTO = [40.4168, -3.7038]; // Madrid, por si no hay geolocalización
const ZOOM_POR_DEFECTO = 6;

// --- Firebase ---
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

try {
  await enableIndexedDbPersistence(db);
} catch (err) {
  console.warn("Persistencia offline no disponible:", err.code);
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

const iconoLavabo = L.divIcon({
  className: "marcador-lavabo",
  html: "🚻",
  iconSize: [36, 36],
  iconAnchor: [18, 30],
  popupAnchor: [0, -28],
});

function centrarEnMiUbicacion() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 15);
    },
    () => {
      /* usuario denegó o falló: nos quedamos con la vista actual */
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
    btn.innerHTML = "📍";
    L.DomEvent.disableClickPropagation(btn);
    btn.addEventListener("click", centrarEnMiUbicacion);
    return btn;
  },
});
map.addControl(new BotonUbicacion());

// --- Marcadores desde Firestore ---
const marcadores = new Map(); // id documento -> L.Marker

function escaparHTML(texto) {
  const div = document.createElement("div");
  div.textContent = texto;
  return div.innerHTML;
}

function crearPopupHTML(id, datos) {
  const nombre = escaparHTML(datos.nombre || "Baño público");
  const descripcion = escaparHTML(datos.descripcion || "Sin instrucciones adicionales.");
  return `
    <div class="popup-lavabo" data-id="${id}">
      <h3>${nombre}</h3>
      <p>${descripcion}</p>
      <div class="popup-acciones">
        <button type="button" class="btn-como-llegar" data-lat="${datos.lat}" data-lng="${datos.lng}">🧭 Cómo llegar</button>
        <button type="button" class="btn-reportar" data-id="${id}">🚩 Reportar</button>
      </div>
    </div>
  `;
}

function configurarBotonesPopup(id) {
  const popupEl = document.querySelector(`.popup-lavabo[data-id="${CSS.escape(id)}"]`);
  if (!popupEl) return;

  const btnLlegar = popupEl.querySelector(".btn-como-llegar");
  btnLlegar.addEventListener("click", () => {
    const { lat, lng } = btnLlegar.dataset;
    window.open(
      `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
      "_blank",
      "noopener"
    );
  });

  const btnReportar = popupEl.querySelector(".btn-reportar");
  btnReportar.addEventListener("click", () => reportarLavabo(id));
}

const lavabosRef = collection(db, COLECCION);
const consultaVisibles = query(lavabosRef, where("oculto", "==", false));

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
        return;
      }

      const datos = cambio.doc.data();
      if (marcadores.has(id)) {
        map.removeLayer(marcadores.get(id));
      }
      const marcador = L.marker([datos.lat, datos.lng], { icon: iconoLavabo }).addTo(map);
      marcador.bindPopup(crearPopupHTML(id, datos));
      marcador.on("popupopen", () => configurarBotonesPopup(id));
      marcadores.set(id, marcador);
    });
  },
  (error) => {
    console.error(error);
    mostrarToast(
      "No se pudieron cargar los baños. Comprueba la configuración de Firebase (js/firebase-config.js).",
      "error"
    );
  }
);

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
  const confirmado = window.confirm(
    "¿Seguro que quieres reportar este baño como falso, inexistente o inaccesible?"
  );
  if (!confirmado) return;

  try {
    const ref = doc(db, COLECCION, id);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const reportesActuales = (snap.data().reportes || 0) + 1;
      tx.update(ref, {
        reportes: reportesActuales,
        oculto: reportesActuales >= UMBRAL_REPORTES,
      });
    });
    marcarComoReportado(id);
    map.closePopup();
    mostrarToast("Gracias, hemos registrado tu reporte.", "success");
  } catch (err) {
    console.error(err);
    mostrarToast("No se pudo enviar el reporte. Inténtalo de nuevo.", "error");
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

btnAñadir.addEventListener("click", () => {
  modoAñadir = !modoAñadir;
  btnAñadir.classList.toggle("activo", modoAñadir);
  avisoModoAñadir.hidden = !modoAñadir;
  mapaEl.classList.toggle("modo-añadir", modoAñadir);
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
  modoAñadir = false;
  btnAñadir.classList.remove("activo");
  avisoModoAñadir.hidden = true;
  mapaEl.classList.remove("modo-añadir");

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

// --- Aviso / toast ---
let toastTimeout;
function mostrarToast(mensaje, tipo = "info") {
  const toast = document.getElementById("toast");
  toast.textContent = mensaje;
  toast.className = `toast toast-${tipo} visible`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 4000);
}

// --- Service worker (PWA) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("SW no registrado:", err));
  });
}
