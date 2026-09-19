"""Script de mantenimiento (se ejecuta a mano, no forma parte de la app en
producción). Revisa los baños "del sistema" (importados de OpenStreetMap) que
hay en la base de datos y los que aún no, para quedarnos solo con los que
están a pie de calle, en un parque o en un centro comercial -y no dentro de
un negocio privado, oficina u otro edificio que OSM etiqueta igual como
amenity=toilets pero que no es de verdad "público"-.

Para cada baño (existente o nuevo candidato):
  1. Si su propia etiqueta "access" es "customers" o "private", se excluye
     directamente (hace falta ser cliente/tener permiso).
  2. Si no, se consulta a Overpass qué áreas (edificios, parques, centros
     comerciales...) contienen ese punto:
       - Si alguna es leisure=park -> "parque" (se incluye).
       - Si alguna es shop=mall/department_store -> "centro_comercial" (se
         incluye).
       - Si alguna es building=* (y no es lo anterior) -> "excluido" (está
         dentro de otro edificio: oficina, restaurante, tienda...).
       - Si no hay ninguna área que lo contenga -> "calle" (se incluye).

Los baños "del sistema" ya existentes que salgan "excluido" se borran (con
copia de seguridad previa en JSON). Los baños nuevos de OpenStreetMap que
salgan calle/parque/centro_comercial y no coincidan con ninguno ya existente
(a menos de 30m) se añaden como nuevos.

Uso:
    python3 depurar_wc_publicos.py --muestra 15   # solo probar, sin tocar la BD
    python3 depurar_wc_publicos.py --aplicar       # ejecutar de verdad
"""

import argparse
import json
import math
import os
import sys
import time
from datetime import datetime, timezone

import psycopg
import requests
from dotenv import load_dotenv
from psycopg.rows import dict_row

try:
    import osmium
except ImportError:  # solo hace falta si se usa --desde-pbf
    osmium = None

load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]
ID_SISTEMA_IMPORTACION = "xL75ooYx35a0RPoipF0GXBqIQWC2"
IDS_SISTEMA = {"xL75ooYx35a0RPoipF0GXBqIQWC2", "9LTmP4ZlJEcrLfMVLWwDgf8rPw33"}
AREA_MADRID = 3605326784  # relation 5326784 (Madrid, España - Wikidata Q2807)
RELATION_MADRID_CIUDAD = 5326784
UMBRAL_DUPLICADO_M = 30

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
CABECERAS = {"User-Agent": "Meaqui/1.0 (depuracion de baños; proyecto personal)"}


def overpass(query, intentos=4, timeout_http=45):
    ultimo_error = None
    for intento in range(intentos):
        for url in OVERPASS_URLS:
            try:
                resp = requests.post(url, data={"data": query}, headers=CABECERAS, timeout=timeout_http)
                if resp.status_code == 200:
                    return resp.json()
                ultimo_error = f"{url} -> {resp.status_code}"
            except requests.RequestException as err:
                ultimo_error = f"{url} -> {err}"
        time.sleep(3 * (intento + 1))
    raise RuntimeError(f"Overpass falló tras varios intentos: {ultimo_error}")


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def obtener_baños_osm():
    query = f"""
    [out:json][timeout:120];
    area({AREA_MADRID})->.madrid;
    (
      node["amenity"="toilets"](area.madrid);
      way["amenity"="toilets"](area.madrid);
      relation["amenity"="toilets"](area.madrid);
    );
    out center tags;
    """
    datos = overpass(query)
    resultado = []
    for el in datos.get("elements", []):
        if el["type"] == "node":
            lat, lon = el["lat"], el["lon"]
        else:
            centro = el.get("center")
            if not centro:
                continue
            lat, lon = centro["lat"], centro["lon"]
        resultado.append(
            {
                "osm_type": el["type"],
                "osm_id": el["id"],
                "lat": lat,
                "lon": lon,
                "tags": el.get("tags", {}),
            }
        )
    return resultado


def punto_en_poligono(lat, lon, vertices):
    """Ray casting clásico: vertices es una lista de (lat, lon) del anillo."""
    dentro = False
    n = len(vertices)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        yi, xi = vertices[i]
        yj, xj = vertices[j]
        if (yi > lat) != (yj > lat):
            x_interseccion = (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi
            if lon < x_interseccion:
                dentro = not dentro
        j = i
    return dentro


def anillos_exteriores(el):
    """Devuelve una lista de anillos (cada uno, una lista de (lat, lon))."""
    if el["type"] == "way":
        geom = el.get("geometry") or []
        return [[(p["lat"], p["lon"]) for p in geom]] if geom else []
    if el["type"] == "relation":
        anillos = []
        for m in el.get("members", []):
            if m.get("role") == "outer" and m.get("geometry"):
                anillos.append([(p["lat"], p["lon"]) for p in m["geometry"]])
        return anillos
    return []


def obtener_parques(area_id):
    # Los parques (sobre todo los grandes, tipo Casa de Campo o Juan Carlos
    # I) pueden ser enormes: un punto en su interior puede estar a cientos
    # de metros de su borde. Por eso no se busca "cerca de cada baño" con un
    # radio pequeño, sino que se trae la geometría de TODOS los parques de
    # la ciudad de una vez y se comprueba la contención en local.
    query = f"""
    [out:json][timeout:180];
    area({area_id})->.a;
    (
      way["leisure"="park"](area.a);
      relation["leisure"="park"](area.a);
    );
    out geom;
    """
    datos = overpass(query, timeout_http=200)
    return datos.get("elements", [])


def obtener_centros_comerciales(area_id):
    query = f"""
    [out:json][timeout:120];
    area({area_id})->.a;
    (
      way["shop"~"^(mall|department_store)$"](area.a);
      relation["shop"~"^(mall|department_store)$"](area.a);
    );
    out geom;
    """
    datos = overpass(query, timeout_http=140)
    return datos.get("elements", [])


def punto_en_alguno(lat, lon, elementos):
    for el in elementos:
        if any(punto_en_poligono(lat, lon, a) for a in anillos_exteriores(el)):
            return True
    return False


def hay_edificio_cerca(lat, lon, radio=100):
    # Para "algún otro edificio" sí basta un radio pequeño: si el baño no
    # está en un parque ni en un centro comercial (ya descartado antes), lo
    # único que queda por distinguir es si está metido dentro de un
    # edificio normal (oficina, tienda, restaurante...) o suelto en la
    # calle, y esos edificios son de tamaño mucho más modesto.
    query = f"""
    [out:json][timeout:25];
    way(around:{radio},{lat},{lon})["building"];
    out geom;
    """
    datos = overpass(query)
    elementos = datos.get("elements", [])
    return any(punto_en_poligono(lat, lon, a) for el in elementos for a in anillos_exteriores(el))


def clasificar_por_contencion(lat, lon, parques, centros):
    if punto_en_alguno(lat, lon, parques):
        return "parque"
    if punto_en_alguno(lat, lon, centros):
        return "centro_comercial"
    if hay_edificio_cerca(lat, lon):
        return "excluido"
    return "calle"


def clasificar(baño_osm, parques, centros):
    access = baño_osm["tags"].get("access")
    if access in ("customers", "private"):
        return "excluido", f"access={access}"
    tipo = clasificar_por_contencion(baño_osm["lat"], baño_osm["lon"], parques, centros)
    return tipo, None


def clasificar_desde_pbf(ruta_pbf):
    # Alternativa a Overpass: todo se calcula en local a partir de un
    # extracto .osm.pbf de la región (por ejemplo, descargado de
    # download.geofabrik.de). No hace ninguna petición de red, así que es
    # muchísimo más rápido y no depende de que la API pública esté ocupada.
    if osmium is None:
        raise RuntimeError("Falta el paquete 'osmium' (pip install osmium) para usar --desde-pbf.")

    class Recolector(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.baños = []
            self.parques = []
            self.centros = []
            self.edificios = []
            self.limite_ciudad = None

        def node(self, n):
            tags = dict(n.tags)
            if tags.get("amenity") == "toilets":
                self.baños.append(
                    {
                        "osm_type": "node",
                        "osm_id": n.id,
                        "lat": n.location.lat,
                        "lon": n.location.lon,
                        "tags": tags,
                    }
                )

        def area(self, a):
            tags = dict(a.tags)
            if a.orig_id() == RELATION_MADRID_CIUDAD and not a.from_way():
                # El límite administrativo real de la ciudad (no de toda la
                # Comunidad de Madrid, que es lo que cubre el extracto): se
                # usa después para descartar baños de otros municipios
                # cercanos (Pozuelo, Alcorcón...) que también salen en el
                # mismo archivo.
                try:
                    self.limite_ciudad = [
                        [(n.lat, n.lon) for n in anillo] for anillo in a.outer_rings()
                    ]
                except (RuntimeError, osmium.InvalidLocationError):
                    pass
                return
            es_parque = tags.get("leisure") == "park"
            es_centro = tags.get("shop") in ("mall", "department_store")
            es_edificio = "building" in tags
            if not (es_parque or es_centro or es_edificio):
                return
            anillos = []
            try:
                for anillo in a.outer_rings():
                    anillos.append([(n.lat, n.lon) for n in anillo])
            except (RuntimeError, osmium.InvalidLocationError):
                return
            if not anillos:
                return
            entrada = {"tags": tags, "anillos": anillos}
            if es_parque:
                self.parques.append(entrada)
            elif es_centro:
                self.centros.append(entrada)
            elif es_edificio:
                self.edificios.append(entrada)

    print(f"Leyendo {ruta_pbf} (una sola pasada, todo en local)...", flush=True)
    recolector = Recolector()
    # apply_file() detecta que la clase tiene un método area() y hace ella
    # sola las dos pasadas necesarias (relaciones primero, luego ensamblado
    # de áreas con las posiciones de nodo ya resueltas).
    recolector.apply_file(ruta_pbf, locations=True)

    print(
        f"  {len(recolector.baños)} baños, {len(recolector.parques)} parques, "
        f"{len(recolector.centros)} centros comerciales, {len(recolector.edificios)} edificios.",
        flush=True,
    )

    def contenido_en(lat, lon, elementos):
        for el in elementos:
            if any(punto_en_poligono(lat, lon, anillo) for anillo in el["anillos"]):
                return True
        return False

    if recolector.limite_ciudad:
        baños_en_ciudad = [
            b for b in recolector.baños if contenido_en(b["lat"], b["lon"], [{"anillos": recolector.limite_ciudad}])
        ]
        print(
            f"  {len(baños_en_ciudad)} de esos baños están dentro del límite de la ciudad de Madrid "
            f"(se descartan {len(recolector.baños) - len(baños_en_ciudad)} de otros municipios de la Comunidad).",
            flush=True,
        )
    else:
        print("  Aviso: no se encontró el límite de la ciudad en el archivo; no se filtra por municipio.", flush=True)
        baños_en_ciudad = recolector.baños

    clasificados = []
    for b in baños_en_ciudad:
        access = b["tags"].get("access")
        if access in ("customers", "private"):
            tipo, motivo = "excluido", f"access={access}"
        elif contenido_en(b["lat"], b["lon"], recolector.parques):
            tipo, motivo = "parque", None
        elif contenido_en(b["lat"], b["lon"], recolector.centros):
            tipo, motivo = "centro_comercial", None
        elif contenido_en(b["lat"], b["lon"], recolector.edificios):
            tipo, motivo = "excluido", "dentro de otro edificio"
        else:
            tipo, motivo = "calle", None
        clasificados.append({**b, "tipo": tipo, "motivo_exclusion": motivo})

    return clasificados


def construir_descripcion(tags):
    partes = []
    fee = tags.get("fee")
    if fee == "yes":
        partes.append("De pago.")
    elif fee == "no":
        partes.append("Gratuito.")
    if tags.get("wheelchair") == "yes":
        partes.append("Accesible para sillas de ruedas.")
    partes.append("Ubicación según datos abiertos de OpenStreetMap.")
    return " ".join(partes)


def obtener_baños_sistema_bd(cur):
    cur.execute(
        "SELECT id, nombre, descripcion, lat, lng, creado_por FROM banos WHERE creado_por = ANY(%s)",
        (list(IDS_SISTEMA),),
    )
    return cur.fetchall()


def obtener_todos_los_baños_bd(cur):
    cur.execute("SELECT id, lat, lng FROM banos")
    return cur.fetchall()


def emparejar_por_cercania(lat, lng, candidatos, umbral_m=UMBRAL_DUPLICADO_M):
    # Los baños de la BD usan la clave "lng" y los de OSM usan "lon"; esta
    # función recibe listas de ambos tipos según desde dónde se llame.
    for c in candidatos:
        lng_c = c["lng"] if "lng" in c else c["lon"]
        if haversine_m(lat, lng, c["lat"], lng_c) <= umbral_m:
            return c
    return None


RUTA_CACHE_POR_DEFECTO = os.path.join(os.environ.get("TEMP", "."), "clasificacion_wc_cache.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--muestra", type=int, default=0, help="Solo clasifica los N primeros y no toca la BD")
    parser.add_argument("--aplicar", action="store_true", help="Aplica los cambios de verdad en la base de datos")
    parser.add_argument(
        "--desde-cache",
        metavar="ARCHIVO",
        help="Reutiliza una clasificación ya guardada en vez de volver a consultar Overpass",
    )
    parser.add_argument(
        "--sin-cache",
        action="store_true",
        help="No guardar la clasificación en un archivo de caché al terminar",
    )
    parser.add_argument(
        "--desde-pbf",
        metavar="ARCHIVO.osm.pbf",
        help="Clasifica en local a partir de un extracto .osm.pbf en vez de consultar Overpass (mucho más rápido)",
    )
    args = parser.parse_args()

    if args.desde_pbf:
        clasificados = clasificar_desde_pbf(args.desde_pbf)
        if args.muestra:
            clasificados = clasificados[: args.muestra]
        if not args.sin_cache:
            with open(RUTA_CACHE_POR_DEFECTO, "w", encoding="utf-8") as f:
                json.dump(clasificados, f, ensure_ascii=False)
            print(f"Clasificación guardada en caché: {RUTA_CACHE_POR_DEFECTO}", flush=True)
    elif args.desde_cache:
        print(f"Cargando clasificación ya calculada desde {args.desde_cache}...", flush=True)
        with open(args.desde_cache, "r", encoding="utf-8") as f:
            clasificados = json.load(f)
        print(f"  {len(clasificados)} baños cargados de la caché.", flush=True)
    else:
        print("Consultando Overpass (baños en Madrid)...", flush=True)
        baños_osm = obtener_baños_osm()
        print(f"  {len(baños_osm)} baños encontrados en OpenStreetMap.", flush=True)

        print("Consultando parques de Madrid (una sola vez, con geometría completa)...", flush=True)
        parques = obtener_parques(AREA_MADRID)
        print(f"  {len(parques)} parques encontrados.", flush=True)

        print("Consultando centros comerciales de Madrid...", flush=True)
        centros = obtener_centros_comerciales(AREA_MADRID)
        print(f"  {len(centros)} centros comerciales encontrados.", flush=True)

        if args.muestra:
            baños_osm = baños_osm[: args.muestra]
            print(f"  (modo muestra: solo se procesan los primeros {len(baños_osm)})", flush=True)

        print("Clasificando cada uno (building=* se consulta por punto; parque/centro ya están en memoria)...", flush=True)
        clasificados = []
        errores = 0
        for i, b in enumerate(baños_osm, 1):
            try:
                tipo, motivo = clasificar(b, parques, centros)
            except Exception as err:  # noqa: BLE001 - un fallo puntual no debe tirar todo el proceso
                tipo, motivo = "error", str(err)
                errores += 1
            clasificados.append({**b, "tipo": tipo, "motivo_exclusion": motivo})
            print(f"  [{i}/{len(baños_osm)}] {tipo:16} osm_{b['osm_type']}/{b['osm_id']}", flush=True)
            time.sleep(0.3)
        if errores:
            print(f"  ({errores} puntos fallaron y quedaron marcados como 'error', sin tocar)", flush=True)

        if not args.sin_cache:
            with open(RUTA_CACHE_POR_DEFECTO, "w", encoding="utf-8") as f:
                json.dump(clasificados, f, ensure_ascii=False)
            print(f"Clasificación guardada en caché: {RUTA_CACHE_POR_DEFECTO}", flush=True)
            print("(si algo falla a partir de aquí, se puede repetir con --desde-cache sin volver a consultar Overpass)", flush=True)

    conteo = {}
    for c in clasificados:
        conteo[c["tipo"]] = conteo.get(c["tipo"], 0) + 1
    print("Resumen de clasificación:", conteo, flush=True)

    if not args.aplicar:
        print("\nModo de solo consulta (usa --aplicar para tocar la base de datos). Ejemplos:")
        for c in clasificados[:15]:
            print(
                f"  [{c['tipo']:16}] osm_{c['osm_type']}/{c['osm_id']} "
                f"({c['lat']:.5f},{c['lon']:.5f}) tags={c['tags']} motivo={c.get('motivo_exclusion')}"
            )
        return

    con = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    with con, con.cursor() as cur:
        existentes_sistema = obtener_baños_sistema_bd(cur)
        todos_existentes = obtener_todos_los_baños_bd(cur)
        print(f"\n{len(existentes_sistema)} baños 'del sistema' ya en la base de datos.")

        # 1) Baños del sistema ya existentes que ahora clasifican como "excluido"
        a_borrar = []
        no_encontrados = []
        for existente in existentes_sistema:
            emparejado = emparejar_por_cercania(existente["lat"], existente["lng"], clasificados)
            if not emparejado:
                no_encontrados.append(existente)
                continue
            if emparejado["tipo"] == "excluido":
                a_borrar.append({**existente, "motivo": emparejado.get("motivo_exclusion") or "dentro de otro edificio"})

        # 2) Baños nuevos de OSM (calle/parque/centro comercial) que no están ya en la BD
        a_insertar = []
        for c in clasificados:
            if c["tipo"] in ("excluido", "error"):
                continue
            if emparejar_por_cercania(c["lat"], c["lon"], todos_existentes):
                continue
            a_insertar.append(c)

        print(f"A borrar (ya no cumplen el criterio): {len(a_borrar)}")
        print(f"A insertar (nuevos): {len(a_insertar)}")
        print(f"No encontrados en OSM (sin tocar, revisar a mano si hace falta): {len(no_encontrados)}")

        if a_borrar:
            marca_tiempo = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            ruta_backup = os.path.join(
                os.environ.get("TEMP", "."), f"backup_banos_borrados_{marca_tiempo}.json"
            )
            with open(ruta_backup, "w", encoding="utf-8") as f:
                json.dump(a_borrar, f, ensure_ascii=False, indent=2, default=str)
            print(f"Copia de seguridad de los borrados: {ruta_backup}")

            ids_borrar = [b["id"] for b in a_borrar]
            cur.execute("DELETE FROM banos WHERE id = ANY(%s)", (ids_borrar,))
            print(f"  Borrados {cur.rowcount} baños.")

        for c in a_insertar:
            descripcion = construir_descripcion(c["tags"])
            nombre = c["tags"].get("name") or "Baño público"
            cur.execute(
                """INSERT INTO banos (nombre, descripcion, lat, lng, creado_por)
                   VALUES (%s, %s, %s, %s, %s)""",
                (nombre, descripcion, c["lat"], c["lon"], ID_SISTEMA_IMPORTACION),
            )
        if a_insertar:
            print(f"  Insertados {len(a_insertar)} baños nuevos.")

        con.commit()

    if no_encontrados:
        print("\nBaños del sistema no encontrados en la consulta actual de OSM (sin tocar):")
        for b in no_encontrados[:20]:
            print(f"  id={b['id']} {b['nombre']!r} ({b['lat']}, {b['lng']})")


if __name__ == "__main__":
    main()
