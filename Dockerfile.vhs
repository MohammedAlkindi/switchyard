# Render environment for demo.tape — vhs + node + a fleet built from this repo.
#
#   docker build -f Dockerfile.vhs -t vhs-fleet .
#   docker run --rm -v "$PWD:/vhs" vhs-fleet demo.tape
#
# This image exists because the original one did not: demo.tape referenced a
# `vhs-fleet` image that was built ad hoc and never committed, so the demo
# became unrenderable the moment that local image was gone.
#
# fleet is built from the working tree rather than installed from npm, so the
# demo always shows the code in this checkout. Rebuild the image after touching
# src/. The tape mutates global git config, which is why it runs in a container
# and must not be rendered with a bare local vhs.

FROM ghcr.io/charmbracelet/vhs:latest

# JetBrains Mono is the font demo.tape sets; the base image does not ship it.
# Debian bookworm's nodejs is 18.19, which clears the >=18.17 engines floor.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-jetbrains-mono \
      nodejs \
      npm \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm link

WORKDIR /vhs
