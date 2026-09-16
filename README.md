# 🚻 Meaquí

App web (PWA) para encontrar lavabos públicos en un mapa. Cualquier usuario puede:

- Ver los baños cercanos en un mapa (OpenStreetMap).
- Tocar un icono para ver instrucciones de acceso y pedir "Cómo llegar" (abre Google Maps).
- Añadir un baño nuevo tocando el mapa o usando su ubicación actual.
- Reportar un baño como falso/inexistente; si varias personas lo reportan, se oculta automáticamente.

No necesita cuentas de usuario ni contraseñas: cada persona se identifica de forma anónima y automática.

## ¿Qué es una PWA?

Es una página web normal que, además, se puede "instalar" en el móvil (icono en la pantalla de inicio, se abre a pantalla completa como una app) sin pasar por la App Store ni Google Play. Se actualiza sola cada vez que la abres.

## Requisitos

- Un navegador moderno (Chrome, Edge, Safari...).
- Una cuenta de Google gratuita para crear el proyecto de Firebase (la base de datos).
- **No hace falta instalar Node.js** para usar o publicar esta app tal cual está.

## 1. Crear el proyecto de Firebase (la base de datos)

1. Ve a [https://console.firebase.google.com](https://console.firebase.google.com) e inicia sesión con tu cuenta de Google.
2. Pulsa **"Agregar proyecto"**, dale un nombre (p. ej. `banos-publicos`) y créalo (puedes desactivar Google Analytics, no hace falta).
3. Dentro del proyecto, en el menú lateral entra en **Compilación > Firestore Database** y pulsa **"Crear base de datos"**. Elige una ubicación (p. ej. `eur3 (europe-west)`) y modo **producción**.
4. Ve a la pestaña **Reglas** de Firestore, borra el contenido y pega el de este proyecto: [`firestore.rules`](firestore.rules). Pulsa **Publicar**.
5. En el menú lateral entra en **Compilación > Authentication**, pulsa **"Comenzar"**, y en la pestaña **Sign-in method** activa el proveedor **Anónimo**.
6. Vuelve a la página principal del proyecto (icono de casa), pulsa el icono **`</>`** ("Agregar app" > Web), dale un apodo y pulsa **"Registrar app"**. Firebase te mostrará un bloque `firebaseConfig` con varias claves.

## 2. Configurar la app con tus claves

Abre [`js/firebase-config.js`](js/firebase-config.js) y sustituye los valores de ejemplo por los que te dio Firebase en el paso anterior:

```js
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
};
```

Guarda el archivo.

## 3. Probar la app en tu ordenador

Los navegadores no dejan abrir `index.html` haciendo doble clic (bloquean los módulos y el modo offline). Hace falta un pequeño servidor local. Como tienes Python instalado, basta con:

```bash
python -m http.server 8000
```

Ejecútalo dentro de la carpeta del proyecto y abre <http://localhost:8000> en el navegador. Concede permiso de ubicación cuando te lo pida para centrar el mapa.

## 4. Publicarla gratis en internet

### Opción recomendada: GitHub Pages (no necesita Node.js)

1. Sube esta carpeta a un repositorio de GitHub (puedes usar `git init`, `git add`, `git commit` y crear el repo en GitHub).
2. En GitHub, entra en **Settings > Pages**, y en "Build and deployment" elige rama `main` y carpeta `/ (root)`.
3. En unos minutos tu app estará disponible en `https://tu-usuario.github.io/tu-repositorio/`.

### Alternativa: Firebase Hosting

Requiere instalar Node.js y Firebase CLI (`npm install -g firebase-tools`, `firebase login`, `firebase init hosting`, `firebase deploy`). Es una buena opción si más adelante quieres añadir funciones de servidor.

## 5. Instalar la app en el móvil

- **Android (Chrome)**: abre la URL de la app, pulsa el menú (⋮) y elige **"Añadir a pantalla de inicio"**.
- **iPhone (Safari)**: abre la URL, pulsa el icono de compartir (□↑) y elige **"Añadir a pantalla de inicio"**.

## Cómo funciona la moderación

- Cada baño nuevo se guarda con `reportes: 0` y `oculto: false`.
- Cuando alguien pulsa "Reportar", se suma 1 al contador `reportes` (cada dispositivo solo puede reportar un mismo baño una vez, se recuerda en el propio móvil).
- Al llegar a **3 reportes**, el baño pasa a `oculto: true` y desaparece del mapa de todos los usuarios automáticamente. Puedes cambiar este número editando `UMBRAL_REPORTES` en [`js/app.js`](js/app.js).
- Los datos nunca se borran: si en el futuro quieres revisar o restaurar baños ocultos, puedes hacerlo manualmente desde la consola de Firebase (Firestore Database > colección `banos`).

## Ideas para el futuro (no incluidas todavía)

- Fotos del lugar.
- Filtros: accesible para sillas de ruedas, gratuito/de pago, con cambiador de bebés, horario.
- Valoración de limpieza.
- Panel de administración para revisar baños ocultos.
