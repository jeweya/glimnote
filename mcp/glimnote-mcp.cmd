@echo off
setlocal
rem 萤光笔记 MCP · stdio（由 AI 客户端拉起）
set "HERE=%~dp0"
if exist "%HERE%..\..\Glimnote.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%HERE%..\..\Glimnote.exe" "%HERE%server.mjs" --stdio %*
) else (
  node "%HERE%server.mjs" --stdio %*
)
