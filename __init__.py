"""Chat Backgrounds — desktop half only.

The plugin is pure renderer: it tints each chat surface with its session colour
and registers one settings page. It ships no tools, hooks, routes, middleware or
secrets, so this module exists only to make the package loadable and versioned
like every other Hermes plugin.
"""

from __future__ import annotations

__version__ = "1.0.1"


def register(ctx) -> None:  # noqa: ARG001 — nothing to register by design
    """Called once at startup; this plugin contributes no tools or hooks."""
    return None
