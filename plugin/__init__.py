"""metrics-dashboard Hermes plugin — registration.

Phase 2 ships no agent tools and no hooks: the plugin's value today is the
backend dashboard API (``dashboard/plugin_api.py``, mounted at
``/api/plugins/metrics-dashboard/``) plus the desktop UI half. The hooks
phase will register a ``post_api_request`` hook here to feed token metrics
(``usage`` + ``api_duration`` ride that payload; ``post_llm_call`` carries
no token data), eventually replacing the ``metrics-emit.py`` shell-hook
patch. Core's outbound webhooks (2026-08-02) are a candidate transport for
the same pipeline.

This module must import cleanly with no side effects — it is imported by the
Hermes plugin loader at startup.
"""


def register(ctx):
    """No-op for now — see module docstring. Hooks land in a later phase."""
