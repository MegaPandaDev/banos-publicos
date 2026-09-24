"""Envío de notificaciones push (Firebase Cloud Messaging).

Igual que turnstile.py: integración opcional que no rompe nada si falta
configurar. Sin FIREBASE_CREDENCIALES_JSON en el entorno, enviar() no hace
nada (se registra en el log y ya está) en vez de fallar la petición que la
llama - por ejemplo, resolver un reporte debe funcionar igual sin push
configurado, solo que nadie recibe el aviso.
"""
import json
import logging
import os

logger = logging.getLogger(__name__)

_app = None
_intentado = False


def _app_firebase():
    global _app, _intentado
    if _intentado:
        return _app
    _intentado = True

    credenciales_json = os.environ.get("FIREBASE_CREDENCIALES_JSON")
    if not credenciales_json:
        return None

    import firebase_admin
    from firebase_admin import credentials

    try:
        cred = credentials.Certificate(json.loads(credenciales_json))
        _app = firebase_admin.initialize_app(cred)
    except Exception as err:
        logger.error("No se pudo inicializar Firebase (revisa FIREBASE_CREDENCIALES_JSON): %s", err)
        _app = None
    return _app


def enviar(token: str, titulo: str, cuerpo: str) -> bool:
    if not _app_firebase():
        logger.info("Push no configurado, se omite el envío (título: %s)", titulo)
        return False

    from firebase_admin import messaging

    mensaje = messaging.Message(
        notification=messaging.Notification(title=titulo, body=cuerpo),
        token=token,
    )
    try:
        messaging.send(mensaje)
        return True
    except Exception as err:
        logger.error("No se pudo enviar la notificación push: %s", err)
        return False
