@echo off
call docker build --platform linux/amd64 -t tripolskypetr/agent-runtime . -f Dockerfile
call docker push tripolskypetr/agent-runtime:latest
