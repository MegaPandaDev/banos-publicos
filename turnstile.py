"""Verificación opcional de Cloudflare Turnstile.

Contrato de comportamiento:
- Integración opcional que "falla abierta": si las claves de Turnstile no están
  configuradas en el entorno, todo funciona igual que si no existiera el captcha
  (nunca se bloquea por falta de configuración).
- Si Cloudflare no responde (timeout, error de red, 5xx) tampoco se bloquea nada:
  se registra el fallo en el log y se deja pasar.
- Solo se rechaza cuando Cloudflare responde explícitamente que el token NO es
  válido, o cuando el captcha está configurado pero no llega ningún token.
"""
import logging
import os

import requests

SITE_KEY = os.environ.get("TURNSTILE_SITE_KEY")
SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY")

logger = logging.getLogger(__name__)


def configurado() -> bool:
    return bool(SITE_KEY)


def clave_sitio():
    return SITE_KEY


def token_valido(token: str | None, ip_remota: str | None = None) -> bool:
    if not SECRET_KEY:
        return True
    if not token:
        return False

    datos = {"secret": SECRET_KEY, "response": token}
    if ip_remota:
        datos["remoteip"] = ip_remota

    try:
        resp = requests.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data=datos,
            timeout=10,
        )
        return bool(resp.json().get("success"))
    except Exception as err:  # red, timeout, JSON inválido, lo que sea: fail-open
        logger.error("Turnstile no respondió, se deja pasar (fail-open): %s", err)
        return True
