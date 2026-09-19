-- Esquema de la base de datos (Neon / Postgres). Ejecutar una vez sobre la
-- base de datos nueva antes de arrancar el servidor o migrar datos.

CREATE TABLE IF NOT EXISTS banos (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    reportes INTEGER NOT NULL DEFAULT 0,
    oculto BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    creado_por TEXT NOT NULL,
    icono TEXT CHECK (icono IN ('sistema', 'usuario', 'pago')),
    etiquetas TEXT[] NOT NULL DEFAULT '{}' CHECK (
        etiquetas <@ ARRAY[
            'a_pie_de_calle', 'en_parque', 'en_centro_comercial',
            'gratis', 'de_pago', 'precio_desconocido',
            'cambiador_bebes', 'accesible_silla_ruedas'
        ]::text[]
    )
);

CREATE TABLE IF NOT EXISTS reportes (
    bano_id INTEGER NOT NULL REFERENCES banos(id) ON DELETE CASCADE,
    visitante_id TEXT NOT NULL,
    motivo TEXT,
    comentario TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bano_id, visitante_id)
);

CREATE TABLE IF NOT EXISTS valoraciones (
    bano_id INTEGER NOT NULL REFERENCES banos(id) ON DELETE CASCADE,
    visitante_id TEXT NOT NULL,
    estrellas SMALLINT NOT NULL CHECK (estrellas BETWEEN 1 AND 5),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bano_id, visitante_id)
);

CREATE TABLE IF NOT EXISTS comentarios (
    id SERIAL PRIMARY KEY,
    bano_id INTEGER NOT NULL REFERENCES banos(id) ON DELETE CASCADE,
    texto TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    creado_por TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_banos_oculto ON banos(oculto);
CREATE INDEX IF NOT EXISTS idx_comentarios_bano ON comentarios(bano_id);
CREATE INDEX IF NOT EXISTS idx_valoraciones_bano ON valoraciones(bano_id);
