#!/bin/bash
docker build --platform linux/amd64 -t tripolskypetr/agent-runtime . -f Dockerfile
docker push tripolskypetr/agent-runtime:latest
