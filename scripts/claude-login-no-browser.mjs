#!/usr/bin/env node
// Native Claude invokes BROWSER for its loopback flow. AIM relays the separately
// printed manual URL and accepts its callback, so opening that URL is a no-op.
process.exit(0);
