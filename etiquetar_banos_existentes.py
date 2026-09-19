"""Script de mantenimiento (se ejecuta a mano, no forma parte de la app en
producción). Rellena la columna "etiquetas" de los baños que ya estaban
guardados antes de que existiera, para que las nuevas etiquetas (ubicación,
precio, comodidades) no se queden vacías solo en los baños nuevos.

Cómo se decide cada etiqueta:
  - Precio: se busca "de pago"/"gratis"/"gratuito" en la descripción (así es
    como ya se redactaban las descripciones, tanto las escritas a mano como
    las generadas al importar de OpenStreetMap). Si no hay ninguna pista, se
    marca "precio_desconocido": es lo más honesto que se puede afirmar.
  - Comodidades: "cambiador" / "accesible" + "silla"/"ruedas" en la
    descripción.
  - Ubicación: se comprueba si el punto cae dentro de un parque o de un
    centro comercial usando el extracto local de OpenStreetMap (mismo
    mecanismo que depurar_wc_publicos.py --desde-pbf, sin red). Si no cae en
    ninguno de los dos Y el baño es uno de los importados automáticamente
    desde OpenStreetMap (que, tras la limpieza de depurar_wc_publicos.py, ya
    solo contiene calle/parque/centro comercial: nunca uno dentro de un
    negocio privado), se marca "a_pie_de_calle". Para los baños añadidos por
    usuarios no se asume nada por descarte: podrían estar dentro de un bar o
    una tienda, así que si no caen en un parque/centro comercial se dejan
    sin etiqueta de ubicación.

Uso:
    python3 etiquetar_banos_existentes.py --pbf RUTA/AL/EXTRACTO.osm.pbf [--aplicar]

Sin --aplicar solo se muestra un resumen, sin tocar la base de datos.
"""

import argparse
import os

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

try:
    import osmium
except ImportError:
    osmium = None

load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]
IDS_SISTEMA = {"xL75ooYx35a0RPoipF0GXBqIQWC2", "9LTmP4ZlJEcrLfMVLWwDgf8rPw33"}


def punto_en_poligono(lat, lon, vertices):
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


def cargar_parques_y_centros(ruta_pbf):
    if osmium is None:
        raise RuntimeError("Falta el paquete 'osmium' (pip install osmium).")

    class Recolector(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.parques = []
            self.centros = []

        def area(self, a):
            tags = dict(a.tags)
            es_parque = tags.get("leisure") == "park"
            es_centro = tags.get("shop") in ("mall", "department_store")
            if not (es_parque or es_centro):
                return
            anillos = []
            try:
                for anillo in a.outer_rings():
                    anillos.append([(n.lat, n.lon) for n in anillo])
            except (RuntimeError, osmium.InvalidLocationError):
                return
            if not anillos:
                return
            (self.parques if es_parque else self.centros).append(anillos)

    print(f"Leyendo {ruta_pbf}...", flush=True)
    recolector = Recolector()
    recolector.apply_file(ruta_pbf, locations=True)
    print(f"  {len(recolector.parques)} parques, {len(recolector.centros)} centros comerciales.", flush=True)
    return recolector.parques, recolector.centros


def dentro_de_alguno(lat, lon, poligonos):
    return any(punto_en_poligono(lat, lon, anillo) for anillos in poligonos for anillo in anillos)


def calcular_etiquetas(descripcion, lat, lng, creado_por, parques, centros):
    texto = (descripcion or "").lower()
    etiquetas = []

    if dentro_de_alguno(lat, lng, parques):
        etiquetas.append("en_parque")
    elif dentro_de_alguno(lat, lng, centros):
        etiquetas.append("en_centro_comercial")
    elif creado_por in IDS_SISTEMA:
        etiquetas.append("a_pie_de_calle")

    if "de pago" in texto:
        etiquetas.append("de_pago")
    elif "gratuito" in texto or "gratis" in texto:
        etiquetas.append("gratis")
    else:
        etiquetas.append("precio_desconocido")

    if "cambiador" in texto:
        etiquetas.append("cambiador_bebes")
    if "accesible" in texto and ("silla" in texto or "ruedas" in texto):
        etiquetas.append("accesible_silla_ruedas")

    return etiquetas


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pbf", required=True, metavar="ARCHIVO.osm.pbf", help="Extracto local de OpenStreetMap")
    parser.add_argument("--aplicar", action="store_true", help="Guarda los cambios de verdad en la base de datos")
    args = parser.parse_args()

    parques, centros = cargar_parques_y_centros(args.pbf)

    con = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    with con, con.cursor() as cur:
        cur.execute("SELECT id, descripcion, lat, lng, creado_por FROM banos WHERE etiquetas = '{}'")
        banos = cur.fetchall()
        print(f"\n{len(banos)} baños sin etiquetas todavía.")

        conteo = {}
        actualizaciones = []
        for b in banos:
            etiquetas = calcular_etiquetas(b["descripcion"], b["lat"], b["lng"], b["creado_por"], parques, centros)
            actualizaciones.append((etiquetas, b["id"]))
            for e in etiquetas:
                conteo[e] = conteo.get(e, 0) + 1

        print("Resumen de etiquetas que se asignarían:", conteo)

        if not args.aplicar:
            print("\nModo de solo consulta (usa --aplicar para guardar). Ejemplos:")
            for etiquetas, bano_id in actualizaciones[:15]:
                print(f"  id={bano_id}: {etiquetas}")
            return

        cur.executemany("UPDATE banos SET etiquetas = %s WHERE id = %s", actualizaciones)
        con.commit()
        print(f"\nActualizados {len(actualizaciones)} baños.")


if __name__ == "__main__":
    main()
