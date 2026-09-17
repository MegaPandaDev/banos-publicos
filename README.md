# 🚻 Meaquí

App web (PWA) para encontrar lavabos públicos en un mapa. Cualquier usuario puede:

- Ver los baños cercanos en un mapa (OpenStreetMap).
- Tocar un icono para ver instrucciones de acceso y pedir "Cómo llegar" (abre Google Maps).
- Añadir un baño nuevo tocando el mapa o usando su ubicación actual.
- Valorar y comentar cada baño.
- Reportar un baño como falso/inexistente; si varias personas lo reportan, se oculta automáticamente.

No necesita cuentas de usuario ni contraseñas: cada persona se identifica de forma anónima y automática (una cookie técnica, sin datos personales).

## ¿Qué es una PWA?

Es una página web normal que, además, se puede "instalar" en el móvil (icono en la pantalla de inicio, se abre a pantalla completa como una app) sin pasar por la App Store ni Google Play. Se actualiza sola cada vez que la abres.

## Arquitectura

- **Servidor**: Python (Flask), en [`app.py`](app.py). Sirve la web y expone la API (`/api/...`) que crea/edita/borra baños, valoraciones y comentarios.
- **Base de datos**: [Neon](https://neon.tech) (Postgres), esquema en [`schema.sql`](schema.sql).
- **Antibots**: [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) (opcional: si no se configura, la app funciona igual, solo que sin esa comprobación — ver [`turnstile.py`](turnstile.py)).
- **Hosting**: [Render](https://render.com), como *Web Service* (no *Static Site*, porque ahora hay un servidor de verdad).

## Requisitos

- Python 3.11+ instalado.
- Una cuenta gratuita en [neon.tech](https://neon.tech) (base de datos).
- Opcional: una cuenta gratuita en [Cloudflare](https://dash.cloudflare.com) para Turnstile.

## 1. Crear la base de datos en Neon

1. Ve a [neon.tech](https://neon.tech), crea una cuenta y un proyecto nuevo.
2. Copia la **cadena de conexión** ("Connection string") que te da el panel.
3. Copia [`.env.example`](.env.example) a un archivo nuevo llamado `.env` (no se sube al repositorio) y pega ahí tu cadena en `DATABASE_URL`.
4. Aplica el esquema una vez:

   ```bash
   python -c "from dotenv import load_dotenv; load_dotenv(); import os, psycopg; con = psycopg.connect(os.environ['DATABASE_URL']); con.cursor().execute(open('schema.sql', encoding='utf-8').read()); con.commit()"
   ```

## 2. Instalar dependencias y probar en local

```bash
pip install -r requirements.txt
python app.py
```

Abre <http://localhost:8000>. Concede permiso de ubicación cuando te lo pida para centrar el mapa.

## 3. Publicarla en Render

1. Sube el proyecto a un repositorio de GitHub.
2. En [Render](https://dashboard.render.com), **New > Web Service**, conecta el repositorio.
3. Configuración:
   - **Runtime**: Python
   - **Build command**: `pip install -r requirements.txt`
   - **Start command**: `gunicorn app:app`
4. En la pestaña **Environment**, añade las variables:
   - `DATABASE_URL`: tu cadena de conexión de Neon.
   - `MODERADOR_ID`: déjala vacía por ahora (ver más abajo cómo obtenerla).
   - `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`: opcional, si activas Cloudflare Turnstile.
5. Despliega. Las cabeceras de seguridad (CSP, etc.) ya están en el propio código (`app.py`), no hace falta configurarlas en Render.

## 4. Ser moderador (editar/eliminar cualquier baño)

No hay pantalla de login: en su lugar, cada dispositivo tiene un identificador anónimo estable (una cookie).

1. Visita la web ya desplegada añadiendo `?verid` a la URL, por ejemplo `https://tu-app.onrender.com/?verid`.
2. Aparecerá un cuadro con tu identificador. Cópialo.
3. En Render, pon ese valor en la variable de entorno `MODERADOR_ID` y vuelve a desplegar.

A partir de ahí, en ese mismo dispositivo/navegador verás botones de "Editar" y "Eliminar" en cualquier baño.

## 5. Instalar la app en el móvil

- **Android (Chrome)**: abre la URL de la app, pulsa el menú (⋮) y elige **"Añadir a pantalla de inicio"**.
- **iPhone (Safari)**: abre la URL, pulsa el icono de compartir (□↑) y elige **"Añadir a pantalla de inicio"**.

## Cómo funciona la moderación automática

- Cada baño nuevo se guarda con `reportes = 0` y `oculto = false`.
- Cuando alguien pulsa "Reportar", se suma 1 al contador (cada visitante solo puede reportar un mismo baño una vez).
- Al llegar a **3 reportes**, el baño pasa a `oculto = true` y desaparece del mapa de todos los usuarios automáticamente. Puedes cambiar este número editando `UMBRAL_REPORTES` en [`app.py`](app.py).
- Los datos nunca se borran solos: si quieres revisar baños ocultos, puedes consultarlos directamente en Neon (tabla `banos`, columna `oculto`).

## Protección antibots (Cloudflare Turnstile)

Es opcional y "falla abierta": si no configuras `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`, la app funciona exactamente igual, sin ninguna comprobación. Para activarla:

1. Crea un sitio en [Cloudflare Turnstile](https://dash.cloudflare.com) (modo "Invisible") para tu dominio.
2. Pon la clave de sitio y la clave secreta en las variables de entorno correspondientes.

## Ideas para el futuro (no incluidas todavía)

- Fotos del lugar.
- Filtros: accesible para sillas de ruedas, gratuito/de pago, con cambiador de bebés, horario.
- Valoración de limpieza.
- Panel de administración para revisar baños ocultos.
