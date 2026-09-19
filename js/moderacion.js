import {
  peticionJSON,
  map,
  quitarMarcador,
  mostrarToast,
  confirmarAccion,
  escaparHTML,
  formatearFechaRelativa,
  abrirDetalle,
  abrirFormularioEdicion,
  cerrarDetalle,
  cerrarFormulario,
  cerrarInfo,
  cerrarFiltro,
  modalOverlay,
  activarAccesibilidadHoja,
  registrarCerradorModeracion,
  registrarSelectorIcono,
  registrarObtenerIconoSeleccionado,
  INTERVALO_SONDEO_MS,
} from "./app.js";

// --- Panel de moderación (solo se carga para el moderador) ---
const MOTIVOS_REPORTE_TEXTO = {
  no_existe: "Ya no existe",
  cerrado: "Está cerrado",
  informacion_incorrecta: "Información incorrecta",
  otro: "Otro motivo",
};

const btnModeracion = document.getElementById("btn-moderacion");
const contadorModeracion = document.getElementById("contador-moderacion");
const hojaModeracion = document.getElementById("hoja-moderacion");
const btnCerrarModeracion = document.getElementById("btn-cerrar-moderacion");
const listaModeracionReportados = document.getElementById("lista-moderacion-reportados");
const listaModeracionNuevos = document.getElementById("lista-moderacion-nuevos");
const campoIconoModerador = document.getElementById("campo-icono-moderador");
const selectIconoModerador = document.getElementById("select-icono-moderador");

registrarCerradorModeracion(cerrarModeracion);

// El selector de icono manual solo tiene sentido al editar un baño ya
// existente (no al añadir uno nuevo): se oculta y se resetea a "Automático"
// en ese caso, y se rellena con el valor guardado al editar.
registrarSelectorIcono((datos) => {
  if (!datos) {
    campoIconoModerador.hidden = true;
    selectIconoModerador.value = "";
    return;
  }
  campoIconoModerador.hidden = false;
  selectIconoModerador.value = datos.icono || "";
});
registrarObtenerIconoSeleccionado(() => selectIconoModerador.value);

actualizarContadorModeracion();
setInterval(actualizarContadorModeracion, INTERVALO_SONDEO_MS);

async function actualizarContadorModeracion() {
  try {
    const datos = await peticionJSON("/api/moderacion");
    const pendientes = datos.reportados.length;
    contadorModeracion.textContent = String(pendientes);
    contadorModeracion.hidden = pendientes === 0;
  } catch {
    /* si falla, simplemente no se actualiza el contador */
  }
}

let desactivarAccesibilidadModeracion = null;

function cerrarModeracion() {
  hojaModeracion.hidden = true;
  if (desactivarAccesibilidadModeracion) {
    desactivarAccesibilidadModeracion();
    desactivarAccesibilidadModeracion = null;
  }
}

btnCerrarModeracion.addEventListener("click", cerrarModeracion);

// Igual que el listener de app.js para el resto de hojas: cierra el panel
// al tocar/hacer clic fuera de él (en fase de captura, y solo si no hay un
// modal de confirmación abierto gestionando su propio cierre).
document.addEventListener(
  "click",
  (e) => {
    if (!modalOverlay.hidden) return;
    if (!hojaModeracion.hidden && !hojaModeracion.contains(e.target)) cerrarModeracion();
  },
  true
);

btnModeracion.addEventListener("click", async () => {
  cerrarDetalle();
  cerrarFormulario();
  cerrarInfo();
  cerrarFiltro();
  hojaModeracion.hidden = false;
  desactivarAccesibilidadModeracion = activarAccesibilidadHoja(hojaModeracion, cerrarModeracion);
  listaModeracionReportados.innerHTML = "";
  listaModeracionNuevos.innerHTML = "";
  await recargarModeracion();
});

function irAModeracionItem(id, lat, lng) {
  cerrarModeracion();
  map.panTo([lat, lng]);
  abrirDetalle(String(id));
}

async function recargarModeracion() {
  try {
    const datos = await peticionJSON("/api/moderacion");
    renderizarModeracion(datos);
  } catch (err) {
    console.error(err);
    mostrarToast(err.message || "No se pudo actualizar el panel.", "error");
  }
}

async function eliminarDesdeModeracion(id, nombre) {
  const confirmado = await confirmarAccion(
    `¿Eliminar definitivamente "${nombre}"? Esta acción no se puede deshacer.`
  );
  if (!confirmado) return;
  try {
    await peticionJSON(`/api/banos/${id}`, { method: "DELETE" });
    quitarMarcador(String(id));
    mostrarToast("Baño eliminado.", "success");
    await recargarModeracion();
  } catch (err) {
    console.error(err);
    mostrarToast(err.message || "No se pudo eliminar el baño.", "error");
  }
}

function renderizarModeracion(datos) {
  contadorModeracion.textContent = String(datos.reportados.length);
  contadorModeracion.hidden = datos.reportados.length === 0;

  listaModeracionReportados.innerHTML = datos.reportados.length
    ? datos.reportados
        .map((b) => {
          const detalle = b.detalleReportes
            .map((r) => {
              const texto = MOTIVOS_REPORTE_TEXTO[r.motivo] || r.motivo;
              return r.comentario ? `${texto}: "${escaparHTML(r.comentario)}"` : texto;
            })
            .join(" · ");
          return `
      <div class="item-reportado ${b.oculto ? "item-oculto" : ""}">
        <button type="button" class="item-reportado-cuerpo" data-id="${b.id}" data-lat="${b.lat}" data-lng="${b.lng}">
          <strong>${escaparHTML(b.nombre)}</strong>
          <span>${b.reportes} reporte${b.reportes === 1 ? "" : "s"}${b.oculto ? " · oculto del mapa" : ""}</span>
          ${detalle ? `<span>${detalle}</span>` : ""}
        </button>
        <div class="item-reportado-acciones">
          <button type="button" class="btn-editar-moderacion" data-id="${b.id}">Editar</button>
          <button type="button" class="btn-eliminar-moderacion" data-id="${b.id}" data-nombre="${escaparHTML(b.nombre)}">Eliminar</button>
        </div>
      </div>
    `;
        })
        .join("")
    : `<p class="sin-comentarios">No hay baños reportados.</p>`;

  listaModeracionNuevos.innerHTML = datos.nuevos.length
    ? datos.nuevos
        .map(
          (b) => `
      <button type="button" class="item-moderacion" data-id="${b.id}" data-lat="${b.lat}" data-lng="${b.lng}">
        <strong>${escaparHTML(b.nombre)}</strong>
        <span>${formatearFechaRelativa(b.creadoEn)} · ${b.esSistema ? "puesto por el sistema" : "puesto por un usuario"}</span>
      </button>
    `
        )
        .join("")
    : `<p class="sin-comentarios">No hay baños nuevos todavía.</p>`;

  listaModeracionReportados.querySelectorAll(".item-reportado-cuerpo").forEach((el) => {
    el.addEventListener("click", () =>
      irAModeracionItem(el.dataset.id, parseFloat(el.dataset.lat), parseFloat(el.dataset.lng))
    );
  });
  listaModeracionReportados.querySelectorAll(".btn-editar-moderacion").forEach((btn) => {
    btn.addEventListener("click", () => abrirFormularioEdicion(String(btn.dataset.id)));
  });
  listaModeracionReportados.querySelectorAll(".btn-eliminar-moderacion").forEach((btn) => {
    btn.addEventListener("click", () => eliminarDesdeModeracion(btn.dataset.id, btn.dataset.nombre));
  });
  listaModeracionNuevos.querySelectorAll(".item-moderacion").forEach((el) => {
    el.addEventListener("click", () =>
      irAModeracionItem(el.dataset.id, parseFloat(el.dataset.lat), parseFloat(el.dataset.lng))
    );
  });
}
