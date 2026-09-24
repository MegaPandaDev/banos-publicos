import csv
import io
import os
import secrets

from dotenv import load_dotenv

load_dotenv()

from flask import Flask, Response, abort, g, jsonify, render_template, request, send_from_directory
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
import psycopg
from psycopg.rows import dict_row

import turnstile

DATABASE_URL = os.environ["DATABASE_URL"]
MODERADOR_ID = os.environ.get("MODERADOR_ID", "")
UMBRAL_REPORTES = 3
COOKIE_VISITANTE = "visitante_id"
MENSAJE_ROBOT = "No se ha podido verificar que no eres un robot. Recarga la página e inténtalo de nuevo."
MOTIVOS_REPORTE = {"no_existe", "cerrado", "informacion_incorrecta", "otro"}
TIPOS_ICONO = {"sistema", "usuario", "pago"}

# Etiquetas que se pueden asignar a un baño al crearlo o editarlo. Se agrupan
# por categoría para la interfaz (ver templates/index.html); "ubicacion" y
# "precio" son excluyentes entre sí (como mucho una etiqueta de cada una),
# "comodidades" admite varias a la vez.
CATEGORIAS_ETIQUETAS = {
    "ubicacion": ["a_pie_de_calle", "en_parque", "en_centro_comercial"],
    "precio": ["gratis", "de_pago", "precio_desconocido"],
    "comodidades": ["cambiador_bebes", "accesible_silla_ruedas"],
}
CATEGORIAS_ETIQUETAS_EXCLUSIVAS = {"ubicacion", "precio"}
ETIQUETAS_VALIDAS = {e for lista in CATEGORIAS_ETIQUETAS.values() for e in lista}
CATEGORIA_DE_ETIQUETA = {e: cat for cat, lista in CATEGORIAS_ETIQUETAS.items() for e in lista}

# Identificadores "del sistema" (tú o yo) de antes de que existiera MODERADOR_ID:
# el UID de Firebase del moderador previo a la migración, y la sesión usada para
# importar los baños de Madrid desde OpenStreetMap. Se usan solo para decidir
# qué icono mostrar en el mapa (blanco = sistema, azul = usuario cualquiera).
IDS_SISTEMA_HISTORICOS = {
    "9LTmP4ZlJEcrLfMVLWwDgf8rPw33",
    "xL75ooYx35a0RPoipF0GXBqIQWC2",
}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# static_folder=None desactiva la ruta estática automática de Flask (que serviría
# CUALQUIER archivo bajo la raíz del proyecto sin restricción alguna, ignorando
# por completo la lista blanca de abajo). Los estáticos se sirven a mano en la
# vista "estaticos" de más abajo.
app = Flask(__name__, static_folder=None)

# Render (como la mayoría de PaaS) pone la app detrás de un proxy inverso:
# sin esto, request.remote_addr sería siempre la IP interna del proxy (igual
# para todo el mundo), lo que dejaría el límite de peticiones por IP inútil
# -o peor, bloquearía a todos los visitantes a la vez en cuanto uno solo lo
# alcanzase- y haría que request.is_secure (usado para la cookie "Secure")
# diera siempre falso aunque el sitio se sirva por HTTPS.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["300 per hour"],
    storage_uri="memory://",
)


@app.errorhandler(429)
def limite_excedido(e):
    return jsonify({"error": "Has hecho demasiadas peticiones seguidas. Espera un poco e inténtalo de nuevo."}), 429


CSP = (
    "default-src 'self'; "
    "script-src 'self' https://unpkg.com https://challenges.cloudflare.com "
    "https://*.googlesyndication.com https://*.googletagmanager.com "
    "https://*.googleadservices.com https://*.doubleclick.net "
    "https://*.adtrafficquality.google https://fundingchoicesmessages.google.com; "
    "style-src 'self' https://unpkg.com https://fonts.googleapis.com 'unsafe-inline'; "
    "img-src 'self' data: https:; "
    "connect-src 'self' https://challenges.cloudflare.com https://*.googleapis.com "
    "https://*.google.com https://*.googlesyndication.com https://*.google-analytics.com "
    "https://*.doubleclick.net https://*.adtrafficquality.google "
    "https://fundingchoicesmessages.google.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    "manifest-src 'self'; worker-src 'self'; frame-src 'self' https:; "
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)


@app.after_request
def añadir_cabeceras_seguridad(resp):
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return resp


def conectar():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def es_moderador(visitante_id: str) -> bool:
    return bool(MODERADOR_ID) and visitante_id == MODERADOR_ID


def es_sistema(creado_por: str) -> bool:
    return creado_por == MODERADOR_ID or creado_por in IDS_SISTEMA_HISTORICOS


def es_de_pago(descripcion: str) -> bool:
    return "de pago" in (descripcion or "").lower()


def calcular_tipo_icono(icono_manual: str | None, descripcion: str, creado_por: str) -> str:
    # El moderador puede forzar un icono concreto desde el panel de editar;
    # si no hay override, se usa la clasificación automática de siempre.
    if icono_manual in TIPOS_ICONO:
        return icono_manual
    if es_de_pago(descripcion):
        return "pago"
    if es_sistema(creado_por):
        return "sistema"
    return "usuario"


def validar_lavabo(datos: dict):
    nombre = str(datos.get("nombre") or "").strip()
    descripcion = str(datos.get("descripcion") or "").strip()
    lat = datos.get("lat")
    lng = datos.get("lng")

    if not nombre or len(nombre) > 80:
        return None, "El nombre no es válido."
    if len(descripcion) > 300:
        return None, "La descripción no es válida."
    if not isinstance(lat, (int, float)) or isinstance(lat, bool) or not (-90 <= lat <= 90):
        return None, "La latitud no es válida."
    if not isinstance(lng, (int, float)) or isinstance(lng, bool) or not (-180 <= lng <= 180):
        return None, "La longitud no es válida."
    return {"nombre": nombre, "descripcion": descripcion, "lat": lat, "lng": lng}, None


def validar_etiquetas(valor):
    if valor is None:
        return [], None
    if not isinstance(valor, list) or not all(isinstance(e, str) for e in valor):
        return None, "Las etiquetas no son válidas."

    etiquetas = []
    conteo_categoria = {}
    for e in valor:
        if e not in ETIQUETAS_VALIDAS:
            return None, "Las etiquetas no son válidas."
        if e in etiquetas:
            continue
        categoria = CATEGORIA_DE_ETIQUETA[e]
        if categoria in CATEGORIAS_ETIQUETAS_EXCLUSIVAS:
            conteo_categoria[categoria] = conteo_categoria.get(categoria, 0) + 1
            if conteo_categoria[categoria] > 1:
                return None, "Solo puede haber una etiqueta de ubicación y una de precio."
        etiquetas.append(e)
    return etiquetas, None


@app.before_request
def cargar_visitante():
    g.visitante_id = request.cookies.get(COOKIE_VISITANTE) or secrets.token_urlsafe(24)
    g.cookie_nueva = COOKIE_VISITANTE not in request.cookies


@app.after_request
def guardar_cookie_visitante(resp):
    if getattr(g, "cookie_nueva", False):
        resp.set_cookie(
            COOKIE_VISITANTE,
            g.visitante_id,
            max_age=60 * 60 * 24 * 365 * 5,
            httponly=True,
            samesite="Lax",
            secure=request.is_secure,
        )
    return resp


# --- Identidad / Turnstile ---
@app.route("/api/verid")
def api_verid():
    # Vía oculta para que el moderador recupere su propio identificador estable
    # (sin pantalla de login): abrir la app con "?verid" en la URL.
    if "verid" not in request.args:
        return jsonify({"error": "No encontrado."}), 404
    return jsonify({"id": g.visitante_id})


@app.route("/api/turnstile-site-key")
def api_turnstile_site_key():
    return jsonify({"site_key": turnstile.clave_sitio()})


@app.route("/api/yo")
def api_yo():
    return jsonify({"esModerador": es_moderador(g.visitante_id)})


# --- Baños ---
@app.route("/api/banos", methods=["GET"])
def listar_banos():
    # El cliente sincroniza el mapa con un fetch completo cada 30s (ver
    # cargarBanos en app.js), así que no hay paginación real todavía; este
    # límite es solo un tope de seguridad para que la respuesta nunca crezca
    # sin control (con las ~300 filas actuales no cambia nada).
    with conectar() as con, con.cursor() as cur:
        cur.execute(
            """SELECT id, nombre, descripcion, lat, lng, creado_por, icono, etiquetas FROM banos
               WHERE oculto = false ORDER BY id LIMIT 5000"""
        )
        filas = cur.fetchall()
    return jsonify(
        [
            {
                "id": f["id"],
                "nombre": f["nombre"],
                "descripcion": f["descripcion"],
                "lat": f["lat"],
                "lng": f["lng"],
                "icono": f["icono"],
                "tipoIcono": calcular_tipo_icono(f["icono"], f["descripcion"], f["creado_por"]),
                "etiquetas": f["etiquetas"],
            }
            for f in filas
        ]
    )


@app.route("/api/banos", methods=["POST"])
@limiter.limit("10 per hour")
def crear_bano():
    cuerpo = request.get_json(force=True, silent=True) or {}
    datos, error = validar_lavabo(cuerpo)
    if error:
        return jsonify({"error": error}), 400

    etiquetas, error = validar_etiquetas(cuerpo.get("etiquetas"))
    if error:
        return jsonify({"error": error}), 400

    if not turnstile.token_valido(cuerpo.get("turnstile_token"), request.remote_addr):
        return jsonify({"error": MENSAJE_ROBOT}), 400

    with conectar() as con, con.cursor() as cur:
        cur.execute(
            """INSERT INTO banos (nombre, descripcion, lat, lng, creado_por, etiquetas)
               VALUES (%(nombre)s, %(descripcion)s, %(lat)s, %(lng)s, %(creado_por)s, %(etiquetas)s)
               RETURNING id""",
            {**datos, "creado_por": g.visitante_id, "etiquetas": etiquetas},
        )
        nuevo_id = cur.fetchone()["id"]
        con.commit()
    return jsonify(
        {
            "id": nuevo_id,
            "icono": None,
            "tipoIcono": calcular_tipo_icono(None, datos["descripcion"], g.visitante_id),
            "etiquetas": etiquetas,
        }
    )


@app.route("/api/banos/<int:bano_id>", methods=["GET"])
def detalle_bano(bano_id):
    with conectar() as con, con.cursor() as cur:
        cur.execute("SELECT * FROM banos WHERE id = %s", (bano_id,))
        bano = cur.fetchone()
        if not bano:
            return jsonify({"error": "No existe."}), 404

        cur.execute("SELECT estrellas FROM valoraciones WHERE bano_id = %s", (bano_id,))
        estrellas = [f["estrellas"] for f in cur.fetchall()]

        cur.execute(
            "SELECT estrellas FROM valoraciones WHERE bano_id = %s AND visitante_id = %s",
            (bano_id, g.visitante_id),
        )
        mia = cur.fetchone()

        cur.execute(
            "SELECT id, texto, creado_en, creado_por FROM comentarios WHERE bano_id = %s ORDER BY creado_en DESC",
            (bano_id,),
        )
        comentarios = cur.fetchall()

    total = len(estrellas)
    return jsonify(
        {
            "id": bano["id"],
            "nombre": bano["nombre"],
            "descripcion": bano["descripcion"],
            "lat": bano["lat"],
            "lng": bano["lng"],
            "icono": bano["icono"],
            "tipoIcono": calcular_tipo_icono(bano["icono"], bano["descripcion"], bano["creado_por"]),
            "etiquetas": bano["etiquetas"],
            "promedio": (sum(estrellas) / total) if total else 0,
            "totalValoraciones": total,
            "miValoracion": mia["estrellas"] if mia else 0,
            "esModerador": es_moderador(g.visitante_id),
            "comentarios": [
                {
                    "id": c["id"],
                    "texto": c["texto"],
                    "creadoEn": c["creado_en"].isoformat(),
                    "esPropio": c["creado_por"] == g.visitante_id,
                }
                for c in comentarios
            ],
        }
    )


@app.route("/api/banos/<int:bano_id>", methods=["PUT"])
def editar_bano(bano_id):
    if not es_moderador(g.visitante_id):
        return jsonify({"error": "No autorizado."}), 403
    cuerpo = request.get_json(force=True, silent=True) or {}
    datos, error = validar_lavabo(cuerpo)
    if error:
        return jsonify({"error": error}), 400

    etiquetas, error = validar_etiquetas(cuerpo.get("etiquetas"))
    if error:
        return jsonify({"error": error}), 400

    icono = cuerpo.get("icono") or None
    if icono is not None and icono not in TIPOS_ICONO:
        return jsonify({"error": "El icono no es válido."}), 400

    with conectar() as con, con.cursor() as cur:
        cur.execute(
            """UPDATE banos SET nombre=%(nombre)s, descripcion=%(descripcion)s,
               lat=%(lat)s, lng=%(lng)s, icono=%(icono)s, etiquetas=%(etiquetas)s WHERE id=%(id)s
               RETURNING creado_por""",
            {**datos, "icono": icono, "etiquetas": etiquetas, "id": bano_id},
        )
        fila = cur.fetchone()
        con.commit()
    return jsonify(
        {
            "ok": True,
            "icono": icono,
            "tipoIcono": calcular_tipo_icono(icono, datos["descripcion"], fila["creado_por"]),
            "etiquetas": etiquetas,
        }
    )


@app.route("/api/banos/<int:bano_id>", methods=["DELETE"])
def eliminar_bano(bano_id):
    if not es_moderador(g.visitante_id):
        return jsonify({"error": "No autorizado."}), 403
    with conectar() as con, con.cursor() as cur:
        cur.execute("DELETE FROM banos WHERE id = %s", (bano_id,))
        con.commit()
    return jsonify({"ok": True})


@app.route("/api/banos/<int:bano_id>/reportar", methods=["POST"])
@limiter.limit("15 per hour")
def reportar(bano_id):
    cuerpo = request.get_json(force=True, silent=True) or {}
    motivo = cuerpo.get("motivo")
    if motivo not in MOTIVOS_REPORTE:
        return jsonify({"error": "Indica un motivo válido para el reporte."}), 400
    comentario = str(cuerpo.get("comentario") or "").strip()[:400] or None

    if not turnstile.token_valido(cuerpo.get("turnstile_token"), request.remote_addr):
        return jsonify({"error": MENSAJE_ROBOT}), 400

    with conectar() as con, con.cursor() as cur:
        cur.execute("SELECT reportes FROM banos WHERE id = %s FOR UPDATE", (bano_id,))
        fila = cur.fetchone()
        if not fila:
            return jsonify({"error": "Este baño ya no existe."}), 404

        try:
            cur.execute(
                "INSERT INTO reportes (bano_id, visitante_id, motivo, comentario) VALUES (%s, %s, %s, %s)",
                (bano_id, g.visitante_id, motivo, comentario),
            )
        except psycopg.errors.UniqueViolation:
            con.rollback()
            return jsonify({"error": "Ya has reportado este baño anteriormente."}), 409

        nuevos_reportes = fila["reportes"] + 1
        cur.execute(
            "UPDATE banos SET reportes = %s, oculto = %s WHERE id = %s",
            (nuevos_reportes, nuevos_reportes >= UMBRAL_REPORTES, bano_id),
        )
        con.commit()
    return jsonify({"ok": True})


@app.route("/api/moderacion")
def moderacion():
    if not es_moderador(g.visitante_id):
        return jsonify({"error": "No autorizado."}), 403

    with conectar() as con, con.cursor() as cur:
        cur.execute(
            """SELECT id, nombre, descripcion, lat, lng, creado_en, creado_por
               FROM banos ORDER BY creado_en DESC LIMIT 30"""
        )
        nuevos = cur.fetchall()

        cur.execute(
            """SELECT id, nombre, lat, lng, reportes, oculto
               FROM banos WHERE reportes > 0 ORDER BY reportes DESC, id DESC"""
        )
        reportados = cur.fetchall()

        reportes_por_bano = {}
        ids_reportados = [b["id"] for b in reportados]
        if ids_reportados:
            cur.execute(
                """SELECT bano_id, motivo, comentario FROM reportes
                   WHERE bano_id = ANY(%s) ORDER BY creado_en DESC""",
                (ids_reportados,),
            )
            for fila in cur.fetchall():
                reportes_por_bano.setdefault(fila["bano_id"], []).append(
                    {"motivo": fila["motivo"], "comentario": fila["comentario"]}
                )

    return jsonify(
        {
            "nuevos": [
                {
                    "id": b["id"],
                    "nombre": b["nombre"],
                    "descripcion": b["descripcion"],
                    "lat": b["lat"],
                    "lng": b["lng"],
                    "creadoEn": b["creado_en"].isoformat(),
                    "esSistema": es_sistema(b["creado_por"]),
                }
                for b in nuevos
            ],
            "reportados": [
                {
                    "id": b["id"],
                    "nombre": b["nombre"],
                    "lat": b["lat"],
                    "lng": b["lng"],
                    "reportes": b["reportes"],
                    "oculto": b["oculto"],
                    "detalleReportes": reportes_por_bano.get(b["id"], []),
                }
                for b in reportados
            ],
        }
    )


@app.route("/api/moderacion/exportar")
def exportar_moderacion():
    if not es_moderador(g.visitante_id):
        return jsonify({"error": "No autorizado."}), 403

    with conectar() as con, con.cursor() as cur:
        cur.execute(
            """SELECT id, nombre, descripcion, lat, lng, reportes, oculto, creado_en
               FROM banos WHERE reportes > 0 ORDER BY reportes DESC, id DESC"""
        )
        banos = cur.fetchall()

        reportes_por_bano = {}
        ids = [b["id"] for b in banos]
        if ids:
            cur.execute(
                """SELECT bano_id, motivo, comentario FROM reportes
                   WHERE bano_id = ANY(%s) ORDER BY creado_en DESC""",
                (ids,),
            )
            for fila in cur.fetchall():
                reportes_por_bano.setdefault(fila["bano_id"], []).append(fila)

    salida = io.StringIO()
    escritor = csv.writer(salida)
    escritor.writerow(
        ["id", "nombre", "descripcion", "lat", "lng", "reportes", "oculto", "creado_en", "detalle_reportes"]
    )
    for b in banos:
        detalle = "; ".join(
            (r["motivo"] or "sin_motivo") + (f' ({r["comentario"]})' if r["comentario"] else "")
            for r in reportes_por_bano.get(b["id"], [])
        )
        escritor.writerow(
            [
                b["id"],
                b["nombre"],
                b["descripcion"],
                b["lat"],
                b["lng"],
                b["reportes"],
                b["oculto"],
                b["creado_en"].isoformat(),
                detalle,
            ]
        )

    resp = Response(salida.getvalue(), mimetype="text/csv")
    resp.headers["Content-Disposition"] = "attachment; filename=banos_reportados.csv"
    return resp


# --- Valoraciones ---
@app.route("/api/banos/<int:bano_id>/valoraciones", methods=["PUT"])
@limiter.limit("30 per hour")
def valorar(bano_id):
    cuerpo = request.get_json(force=True, silent=True) or {}
    estrellas = cuerpo.get("estrellas")
    if not isinstance(estrellas, int) or isinstance(estrellas, bool) or not (1 <= estrellas <= 5):
        return jsonify({"error": "La valoración no es válida."}), 400
    with conectar() as con, con.cursor() as cur:
        cur.execute(
            """INSERT INTO valoraciones (bano_id, visitante_id, estrellas)
               VALUES (%s, %s, %s)
               ON CONFLICT (bano_id, visitante_id)
               DO UPDATE SET estrellas = EXCLUDED.estrellas, creado_en = now()""",
            (bano_id, g.visitante_id, estrellas),
        )
        con.commit()
    return jsonify({"ok": True})


# --- Comentarios ---
@app.route("/api/banos/<int:bano_id>/comentarios", methods=["POST"])
@limiter.limit("20 per hour")
def crear_comentario(bano_id):
    cuerpo = request.get_json(force=True, silent=True) or {}
    texto = str(cuerpo.get("texto") or "").strip()
    if not texto or len(texto) > 400:
        return jsonify({"error": "El comentario no es válido."}), 400

    if not turnstile.token_valido(cuerpo.get("turnstile_token"), request.remote_addr):
        return jsonify({"error": MENSAJE_ROBOT}), 400

    with conectar() as con, con.cursor() as cur:
        cur.execute(
            "INSERT INTO comentarios (bano_id, texto, creado_por) VALUES (%s, %s, %s) RETURNING id",
            (bano_id, texto, g.visitante_id),
        )
        nuevo_id = cur.fetchone()["id"]
        con.commit()
    return jsonify({"id": nuevo_id})


@app.route("/api/banos/<int:bano_id>/comentarios/<int:comentario_id>", methods=["PUT"])
@limiter.limit("20 per hour")
def editar_comentario(bano_id, comentario_id):
    cuerpo = request.get_json(force=True, silent=True) or {}
    texto = str(cuerpo.get("texto") or "").strip()
    if not texto or len(texto) > 400:
        return jsonify({"error": "El comentario no es válido."}), 400

    with conectar() as con, con.cursor() as cur:
        cur.execute(
            "SELECT creado_por FROM comentarios WHERE id = %s AND bano_id = %s", (comentario_id, bano_id)
        )
        fila = cur.fetchone()
        if not fila:
            return jsonify({"error": "El comentario ya no existe."}), 404
        if fila["creado_por"] != g.visitante_id:
            return jsonify({"error": "No autorizado."}), 403
        cur.execute("UPDATE comentarios SET texto = %s WHERE id = %s", (texto, comentario_id))
        con.commit()
    return jsonify({"ok": True})


@app.route("/api/banos/<int:bano_id>/comentarios/<int:comentario_id>", methods=["DELETE"])
@limiter.limit("20 per hour")
def borrar_comentario(bano_id, comentario_id):
    with conectar() as con, con.cursor() as cur:
        cur.execute(
            "SELECT creado_por FROM comentarios WHERE id = %s AND bano_id = %s", (comentario_id, bano_id)
        )
        fila = cur.fetchone()
        if not fila:
            return jsonify({"error": "El comentario ya no existe."}), 404
        if fila["creado_por"] != g.visitante_id and not es_moderador(g.visitante_id):
            return jsonify({"error": "No autorizado."}), 403
        cur.execute("DELETE FROM comentarios WHERE id = %s", (comentario_id,))
        con.commit()
    return jsonify({"ok": True})


# --- Estáticos (la web en sí) ---
# Esta ruta sirve archivos directamente desde la raíz del proyecto (ahí viven
# css/, js/, icons/, manifest.json...), así que sin esta lista blanca
# cualquiera podría pedir /app.py, /.env, /schema.sql o incluso /.git/HEAD y
# se serviría tal cual. Solo se permite lo que la propia web carga en el navegador.
ARCHIVOS_ESTATICOS_PERMITIDOS = {
    "manifest.json",
    "sw.js",
    "privacidad.html",
    "robots.txt",
    "sitemap.xml",
    "ads.txt",
}
PREFIJOS_ESTATICOS_PERMITIDOS = ("css/", "js/", "icons/")


@app.route("/")
def index():
    return render_template("index.html", es_moderador=es_moderador(g.visitante_id))


@app.route("/<path:ruta>")
def estaticos(ruta):
    permitido = ruta in ARCHIVOS_ESTATICOS_PERMITIDOS or ruta.startswith(PREFIJOS_ESTATICOS_PERMITIDOS)
    if not permitido:
        abort(404)
    return send_from_directory(BASE_DIR, ruta)


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 8000)), debug=True)
