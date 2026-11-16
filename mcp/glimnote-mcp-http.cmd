@echo off
setlocal
rem 萤光笔记 MCP · HTTP 常驻（默认 http://127.0.0.1:8765/mcp）
set "HERE=%~dp0"
if exist "%HERE%..\..\Glimnote.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%HERE%..\..\Glimnote.exe" "%HERE%server.mjs" --http --port 8765 %*
) else (
  node "%HERE%server.mjs" --http --port 8765 %*
)
