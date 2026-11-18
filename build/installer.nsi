Unicode true
SetCompressor zlib

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

!define APP_NAME "萤光笔记"
!define APP_ID "Glimnote"
; 版本号默认与 package.json 保持一致，可用 makensis -DAPP_VERSION=x.y.z 覆盖
!ifndef APP_VERSION
  !define APP_VERSION "0.1.19"
!endif
; VIProductVersion 只接受四段纯数字，预发版（0.1.19-beta.1）要单独传去掉后缀的数字版本：
;   makensis -DAPP_VERSION=0.1.19-beta.1 -DAPP_VERSION_NUM=0.1.19 ...
!ifndef APP_VERSION_NUM
  !define APP_VERSION_NUM "${APP_VERSION}"
!endif
!define APP_EXE "Glimnote.exe"
!define SRC_DIR "../release/win-unpacked"

; 完成页：是否开机启动 / 立即运行
Var FinishAutostart
Var FinishRun

; 当前是否停在「应用正在运行」提示页（决定「取消」按哪种方式退出）
Var RunningActive

Name "${APP_NAME}"
OutFile "../release/Glimnote-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_ID}"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallDir"
RequestExecutionLevel user
BrandingText "${APP_NAME} ${APP_VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VERSION_NUM}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 ${APP_NAME}"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
; 不用 MUI 自带的通用退出确认，换成下面 RunningAbort：
; 「正在运行」页的取消 = 手动关闭，其它页保留一次退出确认
!define MUI_CUSTOMFUNCTION_ABORT RunningAbort

; 首屏先讲产品是什么，再保留安全软件提示（360 / 电脑管家拦截是更新失败的主要原因）
!define MUI_WELCOMEPAGE_TITLE "欢迎使用萤光笔记"
!define MUI_WELCOMEPAGE_TEXT "本地优先的 Markdown 笔记：所有内容都保存在你自己的电脑里，无需服务器，随时可以直接打开、备份和带走。$\r$\n$\r$\n需要多设备时再连接 GitCode / Gitee / GitHub 同步，冲突会保留副本，不会静默覆盖。$\r$\n$\r$\n如果 360 安全卫士 / 电脑管家提示「修改文件」或「有程序正在修改系统」，请选择「允许」，否则安装或更新会中断。安装期间建议暂时退出这类安全软件。"

!insertmacro MUI_PAGE_WELCOME
; 安装前如果程序还开着，先插一页让用户选择怎么关掉（没开着会自动跳过）
Page custom RunningPageCreate RunningPageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
Page custom FinishPageCreate FinishPageLeave

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; 覆盖安装前先处理正在运行的旧版本，否则 Glimnote.exe 被占用会导致文件复制失败。
; 静默升级（electron-updater）没人可以问，直接结束进程；
; 交互安装交给下面的「萤光笔记正在运行」页，让用户选自动关闭还是自己关。
Function .onInit
  ${If} ${Silent}
    nsExec::Exec 'cmd /c taskkill /IM ${APP_EXE} /F >NUL 2>NUL'
    Pop $0
    Sleep 1200
  ${EndIf}
FunctionEnd

; —— 「萤光笔记正在运行」提示页 ——
; 没检测到进程就不显示这一页，直接进入安装。
Function RunningPageCreate
  ClearErrors
  nsExec::ExecToStack 'cmd /c tasklist /NH | find /I "${APP_EXE}" >NUL'
  Pop $0
  Pop $1
  ${If} $0 != 0
    Abort
  ${EndIf}

  StrCpy $RunningActive 1
  !insertmacro MUI_HEADER_TEXT "萤光笔记正在运行" "点「自动关闭」继续安装"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 56u "安装程序需要替换萤光笔记的程序文件，所以要先把它关掉。$\r$\n$\r$\n推荐点右下角「自动关闭」，会自动结束后台进程并继续安装；如果笔记里还有没保存的内容，建议先点「手动关闭」，自己退出后再重新安装。"

  ; 按钮直接复用向导底部的「下一步 / 取消」：位置、大小、对齐都和其他页面一致
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:自动关闭"
  GetDlgItem $0 $HWNDPARENT 3
  SendMessage $0 ${WM_SETTEXT} 0 "STR:手动关闭"
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0

  nsDialogs::Show
FunctionEnd

; 离开这一页时先恢复按钮文字与「上一步」，再负责把程序关掉。
; 不恢复的话，下一屏「选择安装位置」会顶着「自动关闭」的字样。
Function RunningPageLeave
  StrCpy $RunningActive 0

  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 0

  nsExec::ExecToLog 'cmd /c taskkill /IM ${APP_EXE} /F >NUL 2>NUL'
  Pop $0
  Sleep 1500

  ClearErrors
  nsExec::ExecToStack 'cmd /c tasklist /NH | find /I "${APP_EXE}" >NUL'
  Pop $0
  Pop $1
  ${If} $0 == 0
    ; 可能还在退出托盘，再等一会儿
    Sleep 2000
    ClearErrors
    nsExec::ExecToStack 'cmd /c tasklist /NH | find /I "${APP_EXE}" >NUL'
    Pop $0
    Pop $1
  ${EndIf}

  ${If} $0 == 0
    StrCpy $RunningActive 1
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 1
    MessageBox MB_OK|MB_ICONEXCLAMATION "没能自动关闭萤光笔记。$\r$\n$\r$\n请在托盘图标上右键退出，或打开窗口关闭它，再点「自动关闭」。"
    Abort
  ${EndIf}

  ; 成功后再恢复向导按钮，后面的页面照常显示「下一步 / 取消」
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:下一步(&N) >"
  GetDlgItem $0 $HWNDPARENT 3
  SendMessage $0 ${WM_SETTEXT} 0 "STR:取消(&C)"
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 1
FunctionEnd

; 退出确认：「正在运行」页直接说明怎么关，其它页面保留一次确认。
; 这里不要调用 Quit：NSIS 的 Quit 在 .onUserAbort 里会被当成 Abort（NSIS bug #1155），
; 安装程序会停在原页面不退出。直接返回，MUI 的取消流程会自己退出；想留在安装程序里才调用 Abort。
Function RunningAbort
  ${If} $RunningActive == 1
    MessageBox MB_OK|MB_ICONINFORMATION "请先关闭萤光笔记：窗口右上角的关闭按钮，或右键托盘图标选「退出」。$\r$\n$\r$\n确认已经完全退出后，重新双击安装程序即可。本次安装到此结束。"
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION "确定要退出安装吗？$\r$\n$\r$\n尚未安装完成，已复制的文件会保留在安装目录里。" IDYES +2
    Abort
  ${EndIf}
FunctionEnd

; 完成页：默认勾选开机启动 + 立即运行，两项都还能取消
Function FinishPageCreate
  !insertmacro MUI_HEADER_TEXT "安装完成" "萤光笔记已经装好了。"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 38u "安装已完成，笔记保存在你自己的电脑上。$\r$\n$\r$\n下面两项可以按需要勾选，之后也能在设置里修改。"
  Pop $0

  ${NSD_CreateCheckbox} 0 46u 100% 12u "开机时自动启动萤光笔记"
  Pop $FinishAutostart
  ${NSD_Check} $FinishAutostart

  ${NSD_CreateCheckbox} 0 66u 100% 12u "立即运行萤光笔记"
  Pop $FinishRun
  ${NSD_Check} $FinishRun

  ; 最后一页：把「关闭」改成「完成」，并隐藏取消按钮
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0

  nsDialogs::Show
FunctionEnd

Function FinishPageLeave
  ${NSD_GetState} $FinishAutostart $0
  ${If} $0 == 1
    ClearErrors
    ; 让应用自己写系统启动项：值名由 Electron 决定，安装器不手写注册表
    ExecWait '"$INSTDIR\${APP_EXE}" --install-autostart'
  ${Else}
    ; 升级安装时取消勾选也要真的关掉，否则旧版本留下的启动项还在
    ClearErrors
    ExecWait '"$INSTDIR\${APP_EXE}" --remove-autostart'
  ${EndIf}

  ${NSD_GetState} $FinishRun $0
  ${If} $0 == 1
    ; 刚覆盖完文件时句柄和杀毒扫描可能还没让开，稍等一下再启动，避免首次加载 -2
    Sleep 1200
    Exec '"$INSTDIR\${APP_EXE}"'
  ${EndIf}
FunctionEnd

Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${SRC_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${APP_ID}" "Version" "${APP_VERSION}"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "QuietUninstallString" "$\"$INSTDIR\Uninstall.exe$\" /S"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "EstimatedSize" "$0"
SectionEnd

; electron-updater 静默升级会带 --force-run：装完直接拉起新版本。
; 交互安装仍由完成页的「立即运行」负责，不会重复启动。
Function .onInstSuccess
  ${If} ${Silent}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--force-run" $R1
    IfErrors done
    Sleep 1000
    Exec '"$INSTDIR\${APP_EXE}"'
    done:
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current

  ; 先让程序自己删启动项，避免卸载后任务管理器里留下一个失效条目
  ClearErrors
  ExecWait '"$INSTDIR\${APP_EXE}" --remove-autostart'

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  DeleteRegKey HKCU "Software\${APP_ID}"

  RMDir /r "$INSTDIR"
SectionEnd
