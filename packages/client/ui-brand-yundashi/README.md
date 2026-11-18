---
description: "云大师 Agent sidebar and blank-home brand artwork."
kind: "package-reference"
---

# @yundashi/dsh-client-ui-brand

English | [中文](README.zh.md)

## Overview

This package owns the 云大师 Agent browser identity. It fills the sidebar brand slots, the blank-home brand mark slot, and the home frame layer so the default decorative artwork never appears. The artwork is cropped from the 云大师 website screenshots; no vector source was available.

## Use this package

Register this package instead of the official brand package. Slot occupancy is the only composition path: the brand identity is not configurable.

## Build

The browser title is a build-time value, not a slot. Build the Web client with the title override and without any client build profile:

```sh
DSH_CLIENT_TITLE="云大师 Agent" pnpm dsh web
```

Do not set `DSH_BUILD_CLIENT_PROFILE`: a named profile drops inherited title overrides and the official profile hard-codes its own title.

## Known limitations

The artwork is raster-only. The favicon and installer assets live in the web and desktop applications rather than in this package.
