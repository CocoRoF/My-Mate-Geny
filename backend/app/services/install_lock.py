"""Coordinate explicit provider and MCP downloads inside this runtime."""
_owner = None


def claim(owner):
    global _owner
    if _owner is not None:
        return False
    _owner = owner
    return True


def release(owner):
    global _owner
    if _owner is owner:
        _owner = None
