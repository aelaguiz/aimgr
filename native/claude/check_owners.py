#!/usr/bin/env python3
"""Read-only native-owner inventory for a stopped identity transition.

The trusted AIM caller holds its EX assignment lock throughout this check and
the subsequent synchronous migration. This process never signals an owner or
prints its arguments/environment. The route helpers' ordinary admission allows
routed survivors; migration must reject those too. This inventory supplements
the lock for owners started before the new lock contract was installed.
"""
import importlib.util
import os
import pathlib
import sys


def main():
    if len(sys.argv) != 3 or sys.platform not in ("darwin", "linux"):
        raise RuntimeError("invalid native-owner check")
    config, executable = (pathlib.Path(value) for value in sys.argv[1:])
    if not all(p.is_absolute() and p.resolve() == p for p in (config, executable)):
        raise RuntimeError("native-owner check requires canonical paths")
    if not config.is_dir() or not executable.is_file():
        raise RuntimeError("native-owner check inputs are unavailable")
    source = pathlib.Path(__file__).resolve().with_name(sys.platform + "_proxy.py")
    spec = importlib.util.spec_from_file_location("aim_native_owner_inventory", source)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    if sys.platform == "linux":
        os.environ["CLAUDE_CONFIG_DIR"] = str(config)
        helper.require_existing_native_owners_routed("migration", str(executable), require_stopped=True)
    else:
        helper.require_existing_owners_routed({"uid": os.getuid()}, {"nativeCommand": str(executable)},
                                             {"CLAUDE_CONFIG_DIR": str(config)}, require_stopped=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) else "native owners could not be verified"
        print("Claude was not started: " + detail + ".", file=sys.stderr)
        sys.exit(125)
