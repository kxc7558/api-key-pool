Option Explicit
Dim fso, sh, dir, nodeExe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then
  MsgBox "未找到 Node.js：" & nodeExe & vbCrLf & vbCrLf & "请先安装 Node.js 18 或更高版本，或修改本脚本里的 node 路径。", 48, "API Key 代理池 - 启动失败"
  WScript.Quit 1
End If

' 直接用 Chr(34) 拼引号运行 node，绕开 cmd /c 的引号剥离规则（旧版 cmd /c 会拆坏命令导致 node 起不来）
sh.Run Chr(34) & nodeExe & Chr(34) & " server.js", 0, False
WScript.Sleep 1500
sh.Run "http://127.0.0.1:8787/admin", 1, False
