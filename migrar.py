"""Migra los datos exportados de Firestore a la base de datos nueva (Neon).

Uso (una sola vez):
    python migrar.py ruta/al/export.json

El JSON de entrada tiene la forma {"banos": [...], "comentarios": [...],
"valoraciones": [...]} tal como lo genera el script de exportación ejecutado
contra la web en producción.
"""
import json
import os
import sys
from datetime import datetime

import psycopg
from dotenv import load_dotenv

load_dotenv()


def parsear_fecha(valor):
    if not valor:
        return None
    return datetime.fromisoformat(valor.replace("Z", "+00:00"))


def main():
    if len(sys.argv) != 2:
        print("Uso: python migrar.py ruta/al/export.json")
        sys.exit(1)

    with open(sys.argv[1], encoding="utf-8") as f:
        datos = json.load(f)

    con = psycopg.connect(os.environ["DATABASE_URL"])
    cur = con.cursor()

    mapa_ids = {}  # id de Firestore (string) -> id nuevo (entero)

    for bano in datos["banos"]:
        cur.execute(
            """INSERT INTO banos (nombre, descripcion, lat, lng, reportes, oculto, creado_en, creado_por)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (
                bano.get("nombre") or "Baño público",
                bano.get("descripcion") or "",
                bano["lat"],
                bano["lng"],
                bano.get("reportes", 0),
                bano.get("oculto", False),
                parsear_fecha(bano.get("creadoEn")),
                bano.get("creadoPor") or "migracion",
            ),
        )
        mapa_ids[bano["id"]] = cur.fetchone()[0]

    comentarios_migrados = 0
    for c in datos["comentarios"]:
        nuevo_bano_id = mapa_ids.get(c["banoId"])
        if not nuevo_bano_id:
            continue
        cur.execute(
            "INSERT INTO comentarios (bano_id, texto, creado_en, creado_por) VALUES (%s, %s, %s, %s)",
            (nuevo_bano_id, c["texto"], parsear_fecha(c.get("creadoEn")), c.get("creadoPor") or "migracion"),
        )
        comentarios_migrados += 1

    valoraciones_migradas = 0
    for v in datos["valoraciones"]:
        nuevo_bano_id = mapa_ids.get(v["banoId"])
        if not nuevo_bano_id:
            continue
        cur.execute(
            """INSERT INTO valoraciones (bano_id, visitante_id, estrellas, creado_en)
               VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING""",
            (nuevo_bano_id, v["uid"], v["estrellas"], parsear_fecha(v.get("creadoEn"))),
        )
        valoraciones_migradas += 1

    con.commit()
    con.close()
    print(
        f"Migrados {len(mapa_ids)} baños, {comentarios_migrados} comentarios, "
        f"{valoraciones_migradas} valoraciones."
    )


if __name__ == "__main__":
    main()
